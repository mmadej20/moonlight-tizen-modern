// Forensics for the heap corruption that kills a Moonlight worker thread inside malloc()/free() (see
// docs/2026-10-18-stream-hang-investigation.md). Differences from the first, simpler version of this watcher:
// - the dlmalloc chunk-chain walker (heap_walker.js) is injected into the page and every worker,
// - the heap is checked every HEAP_CHECK_MS while the page answers; a break that persists for a second pass is logged in
//   full, so the corruption is timed before the thread that trips over it dies,
// - at a wasm trap the trapped worker STAYS PAUSED (the process stays alive, the heap stays as it was), the wasm locals are
//   expanded and the heap is walked on the spot,
// - after a freeze the process does not exit: it keeps the connection and executes commands from CMD_FILE, so the frozen
//   heap can be examined.
// Usage: node forensics.js <host:port/devtools/page/ID> <output file> [command file]
const fs = require('fs');
const walkerSource = require('./heap_walker.js');

const [target, outFile, cmdFile] = process.argv.slice(2);
const FREEZE_MS = 8000;
const PROBE_MS = 2000;
const HEAP_CHECK_MS = 15000;
const HEAP_OK_EVERY = 4;

const out = fs.createWriteStream(outFile, { flags: 'a' });
function log(text, show) {
  const line = new Date().toISOString() + ' ' + text;
  out.write(line + '\n');
  if (show) console.log(line);
}

let nextId = 0;
const pending = new Map();
const sessions = new Map(); // sessionId -> name
const pausedFrames = new Map(); // sessionId|'main' -> call frames
let ws;
let lastMainAnswer = Date.now();
let frozen = false;
let trapSeen = false;
let heapChecks = 0;
let lastReportedBreak = null;

function send(method, params, sessionId, timeoutMs) {
  return new Promise((resolve) => {
    const id = ++nextId;
    const message = { id, method, params: params || {} };
    if (sessionId) message.sessionId = sessionId;
    const timer = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, timeoutMs || 5000);
    pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
    try { ws.send(JSON.stringify(message)); } catch (error) { clearTimeout(timer); pending.delete(id); resolve({ error: String(error) }); }
  });
}

function argText(arg) {
  if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  return arg.description || arg.type;
}

function describeFrames(frames) {
  return frames.map((frame, index) => {
    const url = (frame.url || '').split('/').slice(-2).join('/');
    return '    #' + index + ' ' + (frame.functionName || '(anonymous)') + ' ' + url + ':' + frame.location.lineNumber + ':' + frame.location.columnNumber;
  }).join('\n');
}

function hexAscii(bytes, base) {
  const rows = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const hex = chunk.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    rows.push('      ' + (base + i).toString(16).padStart(8, '0') + '  ' + hex.padEnd(47) + '  ' + ascii);
  }
  return rows.join('\n');
}

// Evaluates an expression in a thread: on a paused call frame when one is given, otherwise as a plain evaluation
async function evaluate(sessionId, expression, callFrameId, timeoutMs) {
  const response = callFrameId
    ? await send('Debugger.evaluateOnCallFrame', { callFrameId, expression, returnByValue: true }, sessionId, timeoutMs || 8000)
    : await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId, timeoutMs || 8000);
  const result = response.result && response.result.result;
  if (response.result && response.result.exceptionDetails) return { error: JSON.stringify(response.result.exceptionDetails).slice(0, 300) };
  if (!result) return { error: JSON.stringify(response).slice(0, 300) };
  return { value: result.value };
}

async function runWalker(sessionId, callFrameId) {
  const call = 'JSON.stringify(__heapWalk({ maxMs: 4000 }))';
  let answer = await evaluate(sessionId, call, callFrameId, 10000);
  if (answer.error && /__heapWalk is not defined/.test(answer.error)) {
    await evaluate(sessionId, 'globalThis.__heapWalk = ' + walkerSource + '; 0', callFrameId, 5000);
    answer = await evaluate(sessionId, call, callFrameId, 10000);
  }
  if (answer.error) return { error: answer.error };
  try { return JSON.parse(answer.value); } catch (error) { return { error: 'unparsable ' + String(answer.value).slice(0, 200) }; }
}

function describeWalk(report) {
  if (report.error) return 'heap walk failed: ' + report.error;
  return 'heap start=' + report.start + ' top=' + report.heapTop + ' chunks=' + report.chunks + ' used=' + report.usedBytes +
    ' free=' + report.freeBytes + ' topChunk=' + report.topChunk + ' ms=' + report.ms + (report.timedOut ? ' TIMED OUT' : '') +
    (report.break ? ' BREAK ' + report.break.reason + ' at ' + report.break.at : ' consistent');
}

function logBreak(where, report) {
  const b = report.break;
  log('[' + where + '] HEAP CHAIN BREAK: ' + b.reason + ' at ' + b.at + ' (0x' + b.at.toString(16) + ') head=0x' + b.head.toString(16) +
    ' size=' + b.size + ' cinuse=' + b.cinuse + ' pinuse=' + b.pinuse, true);
  log('    previous chunks (oldest first): ' + b.previous.map((p) => p.addr + '(0x' + p.addr.toString(16) + ') size=' + p.size + (p.free ? ' free' : ' used')).join(' | '));
  log('    chunk walk: ' + describeWalk(report));
  log('    hex around the break:\n' + b.dump.split('\n').map((l) => '      ' + l).join('\n'));
  if (b.tailOfPrevious) log('    last 64 bytes before the break (the end of the previous chunk):\n' + b.tailOfPrevious.split('\n').map((l) => '      ' + l).join('\n'));
}

async function heapCheck() {
  if (frozen) return;
  heapChecks++;
  const first = await runWalker(null, null);
  if (first.error) { log('heap check failed: ' + first.error); return; }
  if (!first.break) {
    if (heapChecks % HEAP_OK_EVERY === 1) log('heap ok: ' + describeWalk(first));
    lastReportedBreak = null;
    return;
  }
  // A concurrent allocation can look like a break for an instant: only a break that is still there counts
  await new Promise((resolve) => setTimeout(resolve, 250));
  const second = await runWalker(null, null);
  if (second.break && second.break.at === first.break.at && second.break.reason === first.break.reason) {
    if (lastReportedBreak !== second.break.at) {
      lastReportedBreak = second.break.at;
      log('HEAP CORRUPTION DETECTED while the application still runs', true);
      logBreak('main', second);
    } else {
      log('heap still broken at ' + second.break.at);
    }
  } else {
    log('heap check: transient inconsistency ignored (' + first.break.reason + ' at ' + first.break.at + ')');
  }
}

// Locals of a wasm frame: V8 hands out each local as an object whose "value" property holds the number
async function expandLocals(sessionId, frame, frameIndex, candidates) {
  for (const scope of frame.scopeChain || []) {
    if (!scope.object || !scope.object.objectId || scope.type !== 'local') continue;
    const props = await send('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true }, sessionId, 4000);
    const items = (props.result && props.result.result) || [];
    const shown = [];
    for (const p of items.slice(0, 48)) {
      let value = p.value && p.value.value;
      if (value === undefined && p.value && p.value.objectId) {
        const inner = await send('Runtime.getProperties', { objectId: p.value.objectId, ownProperties: true }, sessionId, 3000);
        const innerItems = (inner.result && inner.result.result) || [];
        const holder = innerItems.find((q) => q.name === 'value') || innerItems.find((q) => q.value && q.value.value !== undefined);
        value = holder && holder.value ? (holder.value.value !== undefined ? holder.value.value : holder.value.description) : '?';
        if (value === '?' && shown.length === 0) log('    (first wasm local, raw) ' + JSON.stringify(inner).slice(0, 400));
      }
      if (typeof value === 'number' && Number.isInteger(value) && value >= 4096 && value < 134217728 && candidates.size < 8 && frameIndex < 2) {
        candidates.set(value, 'frame #' + frameIndex + ' ' + p.name);
      }
      shown.push(p.name + '=' + (typeof value === 'number' ? value + '(0x' + (value >>> 0).toString(16) + ')' : value));
    }
    log('    frame #' + frameIndex + ' wasm locals: ' + shown.join(' ').slice(0, 1500));
  }
}

async function recordTrap(sessionId, where, frames) {
  trapSeen = true;
  log('[' + where + '] WASM TRAP at pause; the thread stays paused. Recording forensics', true);
  const candidates = new Map();
  for (let frameIndex = 0; frameIndex < Math.min(3, frames.length); frameIndex++) {
    await expandLocals(sessionId, frames[frameIndex], frameIndex, candidates);
  }
  const report = await runWalker(sessionId, frames[0].callFrameId);
  log('[' + where + '] heap at the trap: ' + describeWalk(report), true);
  if (report.break) logBreak(where, report);
  for (const [value, label] of candidates) {
    const from = Math.max(0, value - 64);
    const answer = await evaluate(sessionId, 'Array.prototype.slice.call(HEAPU8.subarray(' + from + ',' + (value + 128) + '))', frames[0].callFrameId, 4000);
    if (Array.isArray(answer.value)) log('    heap around ' + value + ' (0x' + value.toString(16) + ', ' + label + '), the pointer is at offset 64:\n' + hexAscii(answer.value, from));
  }
  log('[' + where + '] forensics recorded; waiting for the freeze to be detected', true);
}

// With FORENSICS_MAIN_EXCEPTIONS=1 the main thread pauses on every exception, caught or not, and the exception and the top
// of its stack are logged before it goes on. A critical section of the allocator that the main thread leaves without
// unlocking can only be left by an exception. Each distinct exception is logged in full a few times, then counted.
const MAIN_EXCEPTIONS = process.env.FORENSICS_MAIN_EXCEPTIONS === '1';
const mainExceptionCounts = new Map();

function logMainException(description, frames) {
  const first = String(description).split('\n')[0].slice(0, 200);
  const top = frames[0] ? (frames[0].functionName || '(anonymous)') + ':' + frames[0].location.lineNumber : '?';
  const key = first + ' @ ' + top;
  const seen = (mainExceptionCounts.get(key) || 0) + 1;
  mainExceptionCounts.set(key, seen);
  if (seen <= 5) {
    log('[main] EXCEPTION PAUSE #' + seen + ' ' + first + '\n' + describeFrames(frames.slice(0, 12)), true);
  } else if (seen % 100 === 0) {
    log('[main] EXCEPTION PAUSE seen ' + seen + ' times: ' + key, true);
  }
}

function onEvent(message) {
  const sessionId = message.sessionId || null;
  const where = sessionId ? (sessions.get(sessionId) || sessionId) : 'main';
  switch (message.method) {
    case 'Runtime.consoleAPICalled': {
      const p = message.params;
      const text = p.args.map(argText).join(' ');
      const quiet = /No error|Failed to sample gamepad|setsockopt\(/.test(text);
      const important = !quiet && (p.type === 'error' || p.type === 'warning' || p.type === 'assert' || /abort|exception|crash/i.test(text));
      log('[' + where + '] console.' + p.type + ' ' + text.replace(/\s+/g, ' ').slice(0, 600), important);
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = message.params.exceptionDetails;
      log('[' + where + '] EXCEPTION ' + (d.exception && d.exception.description || d.text) + ' at ' + (d.url || '') + ':' + d.lineNumber, true);
      break;
    }
    case 'Log.entryAdded': {
      const e = message.params.entry;
      log('[' + where + '] log.' + e.level + ' ' + e.source + ' ' + e.text.slice(0, 400), e.level === 'error');
      break;
    }
    case 'Target.attachedToTarget': {
      const info = message.params.targetInfo;
      const id = message.params.sessionId;
      sessions.set(id, info.type + ':' + info.targetId.slice(0, 6));
      log('attached ' + info.type + ' ' + info.url);
      (async () => {
        await send('Runtime.enable', {}, id, 4000);
        await send('Log.enable', {}, id, 4000);
        if (/worker/.test(info.type)) {
          await send('Runtime.evaluate', { expression: 'globalThis.__heapWalk = ' + walkerSource + '; 0' }, id, 4000);
          await send('Debugger.enable', {}, id, 6000);
          await send('Debugger.setPauseOnExceptions', { state: 'all' }, id, 4000);
        }
        await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, id, 4000);
        await send('Runtime.runIfWaitingForDebugger', {}, id, 4000);
      })();
      break;
    }
    case 'Target.detachedFromTarget':
      log('detached ' + (sessions.get(message.params.sessionId) || message.params.sessionId));
      break;
    case 'Debugger.paused': {
      const p = message.params;
      const frames = p.callFrames;
      const description = (p.data && (p.data.description || p.data.value)) || '';
      const isWasmTrap = p.reason === 'exception' && /memory access out of bounds|unreachable|divide by zero|integer overflow|table index/i.test(String(description));
      if (isWasmTrap && !pausedFrames.has('trap:' + sessionId)) {
        pausedFrames.set(sessionId || 'main', frames);
        pausedFrames.set('trap:' + sessionId, frames);
        log('[' + where + '] PAUSED on exception: ' + String(description).split('\n')[0] + '\n' + describeFrames(frames), true);
        recordTrap(sessionId, where, frames); // no resume: the thread is kept as it died
      } else if (p.reason === 'exception') {
        // Not the trap we are after (the Emscripten glue throws and catches by design), or the same trap re-thrown: go on
        if (isWasmTrap) log('[' + where + '] same trap seen again while the first one is held; resuming this pause');
        if (MAIN_EXCEPTIONS && !sessionId) logMainException(description, frames);
        send('Debugger.resume', {}, sessionId, 4000);
      } else if (p.reason === 'promiseRejection' && !frozen) {
        // Pausing on all exceptions also stops the thread at a rejected promise; that is not a freeze, go on
        if (MAIN_EXCEPTIONS && !sessionId) logMainException('promise rejection: ' + description, frames);
        send('Debugger.resume', {}, sessionId, 4000);
      } else {
        pausedFrames.set(sessionId || 'main', frames);
        log('[' + where + '] PAUSED (' + p.reason + ')\n' + describeFrames(frames), true);
      }
      break;
    }
    case 'Inspector.targetCrashed':
      log('[' + where + '] TARGET CRASHED', true);
      break;
    default:
      break;
  }
}

async function handleFreeze() {
  frozen = true;
  log('FREEZE: the main thread did not answer for ' + FREEZE_MS + ' ms; pausing JavaScript' + (trapSeen ? ' (after a wasm trap)' : ''), true);
  const main = await send('Debugger.pause', {}, null, 8000);
  log('Debugger.pause (main) -> ' + JSON.stringify(main).slice(0, 200), true);
  for (const [sessionId, name] of sessions) {
    if (!/worker/.test(name)) continue;
    await send('Debugger.pause', {}, sessionId, 3000);
  }
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const mainFrames = pausedFrames.get('main');
  if (mainFrames) {
    const report = await runWalker(null, mainFrames[0].callFrameId);
    log('heap on the frozen main thread: ' + describeWalk(report), true);
    if (report.break) logBreak('main', report);
  }
  log('FREEZE REPORT DONE; stacks captured for ' + pausedFrames.size + ' paused threads. The process stays attached: do NOT close the application until the analysis is finished', true);
}

// Commands from the analyst: one JSON object {"thread":"main"|"<worker name prefix>","expression":"..."} per file
async function pollCommand() {
  if (!cmdFile || !fs.existsSync(cmdFile)) return;
  let command;
  try { command = JSON.parse(fs.readFileSync(cmdFile, 'utf8')); } catch (error) { log('[cmd] unreadable command file: ' + error); return; }
  try { fs.unlinkSync(cmdFile); } catch (error) { /* a second poll may race with this one */ }
  let sessionId = null;
  let frames = pausedFrames.get('main');
  if (command.thread && command.thread !== 'main') {
    for (const [id, name] of sessions) {
      if (name.indexOf(command.thread) !== -1) { sessionId = id; frames = pausedFrames.get(id); break; }
    }
  }
  const answer = await evaluate(sessionId, command.expression, frames && frames[0] ? frames[0].callFrameId : null, command.timeoutMs || 15000);
  const text = answer.error ? 'ERROR ' + answer.error : (typeof answer.value === 'string' ? answer.value : JSON.stringify(answer.value));
  log('[cmd ' + (command.thread || 'main') + '] ' + String(command.expression).slice(0, 160) + '\n' + String(text).slice(0, 60000), true);
}

function start() {
  ws = new WebSocket('ws://' + target);
  ws.onopen = async () => {
    log('connected to ' + target, true);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method) {
        onEvent(message);
      }
    };
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Debugger.enable');
    if (MAIN_EXCEPTIONS) await send('Debugger.setPauseOnExceptions', { state: 'all' });
    await send('Runtime.evaluate', { expression: 'globalThis.__heapWalk = ' + walkerSource + '; 0' });
    const attach = await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    log('setAutoAttach -> ' + JSON.stringify(attach).slice(0, 200), true);
    setInterval(async () => {
      if (frozen) return;
      const answer = await send('Runtime.evaluate', { expression: 'performance.now()' }, null, FREEZE_MS + 2000);
      if (answer.result && answer.result.result) lastMainAnswer = Date.now();
    }, PROBE_MS);
    setInterval(() => {
      if (!frozen && Date.now() - lastMainAnswer > FREEZE_MS) handleFreeze();
    }, 1000);
    setInterval(() => { heapCheck().catch((error) => log('heap check error ' + error)); }, HEAP_CHECK_MS);
    setInterval(() => { pollCommand().catch((error) => log('[cmd] error ' + error)); }, 1000);
  };
  ws.onclose = () => {
    log('WEBSOCKET CLOSED (the page was closed or the application was killed)', true);
    setTimeout(() => process.exit(frozen ? 0 : 2), 500);
  };
  ws.onerror = (error) => log('websocket error ' + (error.message || ''), true);
}

start();
