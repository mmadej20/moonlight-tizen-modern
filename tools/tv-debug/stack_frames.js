// Static stack analysis of the module from its disassembly (wasm-dis): frame size of every function, dynamic stack
// allocations, and the heaviest chain of direct calls. Indirect calls are not followed, so a chain through a callback
// is not counted: the result is a lower bound for the depth, and exact for the biggest single frames.
// Usage: node stack_frames.js <module.wat> <named.wasm | -> [stack pointer global, default $global$6]
// <module.wat> comes from wasm-dis, <named.wasm> is a build of the same code with function names (the module of a
// release build has none: pass - and read the $index names). The stack pointer is the mutable global that starts at the
// end of the static data and is moved at the entry of every function that has locals in memory.
const fs = require('fs');

const [watFile, namedWasm, stackGlobalArg] = process.argv.slice(2);
const stackGlobal = (stackGlobalArg || '$global$6').replace(/\$/g, '\\$');

function readNames(file) {
  if (!file || file === '-') return {};
  const bytes = fs.readFileSync(file);
  let position = 8;
  const leb = () => { let result = 0, shift = 0, byte; do { byte = bytes[position++]; result += (byte & 0x7f) * Math.pow(2, shift); shift += 7; } while (byte & 0x80); return result; };
  const names = {};
  while (position < bytes.length) {
    const id = bytes[position++];
    const size = leb();
    const end = position + size;
    if (id === 0) {
      const length = leb();
      const sectionName = bytes.toString('utf8', position, position + length);
      position += length;
      if (sectionName === 'name') {
        while (position < end) {
          const sub = bytes[position++];
          const subSize = leb();
          const subEnd = position + subSize;
          if (sub === 1) {
            const count = leb();
            for (let i = 0; i < count; i++) { const index = leb(); const len = leb(); names[index] = bytes.toString('utf8', position, position + len); position += len; }
          }
          position = subEnd;
        }
      }
    }
    position = end;
  }
  return names;
}

const names = readNames(namedWasm);
const text = fs.readFileSync(watFile, 'utf8');
const lines = text.split('\n');

const funcs = new Map(); // index -> { name, frame, dynamic: [], calls: Set }
let current = null;
const funcStart = /^\s*\(func (\$\S+) \(; (\d+) ;\)/;
const framePattern = new RegExp('\\(global\\.set ' + stackGlobal + '\\s*$');
const aliasByName = new Map(); // wat name -> index

for (let i = 0; i < lines.length; i++) {
  const m = funcStart.exec(lines[i]);
  if (m) { aliasByName.set(m[1], Number(m[2])); }
}

// Second pass: per function body
for (let i = 0; i < lines.length; i++) {
  const m = funcStart.exec(lines[i]);
  if (m) {
    current = { index: Number(m[2]), watName: m[1], frame: 0, dynamicCalls: 0, calls: new Set(), indirect: 0 };
    funcs.set(current.index, current);
    continue;
  }
  if (!current) continue;
  const line = lines[i];
  const call = /\(call (\$\S+)/.exec(line);
  if (call) { const target = aliasByName.get(call[1]); if (target !== undefined) current.calls.add(target); }
  if (/call_indirect/.test(line)) current.indirect++;
  // (global.set $sp (i32.add (global.get $sp) (i32.const N)))
  if (framePattern.test(line) && i + 4 < lines.length) {
    const block = lines.slice(i + 1, i + 6).join(' ').replace(/\s+/g, ' ');
    const constant = new RegExp('^ ?\\(i32\\.add \\(global\\.get ' + stackGlobal + '\\) \\(i32\\.const (-?\\d+)\\)').exec(block);
    if (constant) { const size = Number(constant[1]); if (size > 0) current.frame += size; }
    // The same, written as a subtraction of a negative constant
    const subtraction = new RegExp('^ ?\\(i32\\.sub \\(global\\.get ' + stackGlobal + '\\) \\(i32\\.const (-\\d+)\\)').exec(block);
    if (subtraction) current.frame += -Number(subtraction[1]);
  }
}

function label(index) { return (names[index] || funcs.get(index).watName) + ' [' + index + ']'; }

// Every other way the stack pointer moves: a restore from a local is normal, anything else is a dynamic allocation
// (alloca, a variable length array) whose size is known only at run time
{
  const dynamic = [];
  let currentIndex = null;
  let restores = 0;
  let constants = 0;
  for (let i = 0; i < lines.length; i++) {
    const fm = funcStart.exec(lines[i]);
    if (fm) { currentIndex = Number(fm[2]); continue; }
    if (currentIndex === null || !framePattern.test(lines[i])) continue;
    const block = lines.slice(i + 1, i + 12).join(' ').replace(/\s+/g, ' ');
    if (new RegExp('^ ?\\(i32\\.add \\(global\\.get ' + stackGlobal + '\\) \\(i32\\.const -?\\d+\\)').test(block)) { constants++; continue; }
    if (new RegExp('^ ?\\(i32\\.sub \\(global\\.get ' + stackGlobal + '\\) \\(i32\\.const -?\\d+\\)').test(block)) { constants++; continue; }
    if (/^ ?\(local\.get \$\d+\)/.test(block) || /^ ?\(i32\.const \d+\)/.test(block)) { restores++; continue; }
    dynamic.push({ index: currentIndex, head: block.slice(0, 140) });
  }
  console.log('stack pointer writes: constant frames=' + constants + ' restores=' + restores + ' dynamic=' + dynamic.length);
  const seen = new Set();
  for (const d of dynamic) {
    if (seen.has(d.index)) continue;
    seen.add(d.index);
    if (seen.size <= 40) console.log('  dynamic: ' + (names[d.index] || '$' + d.index) + ' [' + d.index + ']  ' + d.head);
  }
  console.log('functions with a dynamic stack allocation: ' + seen.size);
}

// Dynamic allocations go through a helper that adds its argument to the stack pointer: find it, then its callers
const helper = [...funcs.values()].find((f) => /^_?stackAlloc$/.test(names[f.index] || ''));
console.log('functions:', funcs.size, ' functions with a static frame:', [...funcs.values()].filter((f) => f.frame > 0).length);
console.log('stackAlloc helper:', helper ? label(helper.index) : '(not found)');
if (helper) {
  const callers = [...funcs.values()].filter((f) => f.calls.has(helper.index));
  console.log('functions that allocate dynamically (alloca):', callers.length);
  console.log('  ' + callers.slice(0, 25).map((f) => label(f.index) + ' frame=' + f.frame).join('\n  '));
}

const byFrame = [...funcs.values()].filter((f) => f.frame > 0).sort((a, b) => b.frame - a.frame);
console.log('\nbiggest static frames:');
for (const f of byFrame.slice(0, 30)) console.log('  ' + String(f.frame).padStart(8) + '  ' + label(f.index));

// Heaviest chain of direct calls (frame sizes summed), with cycle detection
const memo = new Map();
const onStack = new Set();
const cycles = [];
function depth(index) {
  if (memo.has(index)) return memo.get(index);
  if (onStack.has(index)) { cycles.push(index); return { total: 0, path: [] }; }
  onStack.add(index);
  const f = funcs.get(index);
  let best = { total: 0, path: [] };
  for (const callee of f.calls) {
    if (!funcs.has(callee)) continue;
    const sub = depth(callee);
    if (sub.total > best.total) best = sub;
  }
  onStack.delete(index);
  const result = { total: f.frame + best.total, path: [index].concat(best.path) };
  memo.set(index, result);
  return result;
}

const roots = process.argv.slice(5).length ? process.argv.slice(5) : ['_ThreadProc'];
const nameToIndex = new Map(Object.entries(names).map(([index, name]) => [name, Number(index)]));
console.log('\nrecursive cycles found among direct calls: ' + new Set(cycles).size);
for (const index of new Set(cycles).values()) console.log('  ' + label(index));

const entries = [
  '_VideoReceiveThreadProc', '_controlReceiveThreadFunc', '_AudioReceiveThreadProc', '_VideoDecoderThreadProc',
  '_lossStatsThreadFunc', '_asyncCallbackThreadFunc', '_invalidateRefFramesFunc', '_requestIdrFrameFunc',
  '_inputSendThreadProc', '__ZN17MoonlightInstance15InputThreadFuncEPv', '__ZN10Dispatcher15dispatcher_funcEv',
  '_VideoPingThreadProc', '_AudioPingThreadProc', '__ZN17MoonlightInstance18ConnectionThreadFuncEPv',
];
console.log('\nheaviest chain of direct calls from each thread entry (lower bound of the stack depth, bytes):');
for (const name of entries) {
  const index = nameToIndex.get(name);
  if (index === undefined || !funcs.has(index)) { console.log('  ' + name + ': (not in this module)'); continue; }
  const d = depth(index);
  console.log('  ' + String(d.total).padStart(8) + '  ' + name + '  via ' + d.path.slice(0, 8).map((p) => (names[p] || '$' + p)).join(' > ') + (d.path.length > 8 ? ' > ...(' + d.path.length + ')' : ''));
}
