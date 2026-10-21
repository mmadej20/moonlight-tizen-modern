'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WasmExceptionRecorder = require('../wasm/platform/wasm_exception_recorder.js');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');

// Without the question of the diagnostic allocator nothing is wrapped: a normal build keeps its exports untouched
{
  const exportsObject = { malloc() { return 1; }, memory: {} };
  const recorder = WasmExceptionRecorder.create({ log() { throw new Error('nothing to log'); } });
  assert.strictEqual(recorder.wrapExports(exportsObject), exportsObject);
  const moduleObject = { asm: exportsObject };
  assert.strictEqual(recorder.install(moduleObject), false);
  assert.strictEqual(moduleObject.asm, exportsObject);
  assert.strictEqual(recorder.install({}), false);
}

// An exception is reported with the export that threw it, whether the thread still holds the lock, and goes on
{
  const lines = [];
  let holds = 0;
  const boom = new RangeError('Maximum call stack size exceeded');
  const exportsObject = {
    diag_dlmalloc_owner_is_calling_thread() { return holds; },
    fine(a, b) { return a + b; },
    bad() { throw boom; },
    memory: { buffer: 1 }
  };
  const recorder = WasmExceptionRecorder.create({ log: (line) => lines.push(line) });
  const moduleObject = { asm: exportsObject };
  assert.strictEqual(recorder.install(moduleObject), true);
  const wrapped = moduleObject.asm;
  assert.notStrictEqual(wrapped, exportsObject);

  assert.strictEqual(wrapped.fine(2, 3), 5, 'arguments and results go through');
  assert.strictEqual(wrapped.memory, exportsObject.memory, 'what is not a function is the same');
  assert.strictEqual(lines.length, 0);

  assert.throws(() => wrapped.bad(), (error) => error === boom, 'the same exception is thrown again');
  assert.strictEqual(lines.length, 1);
  assert(/\[wasm-exception\] bad threw RangeError: Maximum call stack size exceeded/.test(lines[0]));
  assert(!/LEFT THE ALLOCATOR/.test(lines[0]), 'the lock is not held');

  holds = 1;
  assert.throws(() => wrapped.bad(), (error) => error === boom);
  assert.strictEqual(lines.length, 2);
  assert(/THE MAIN THREAD LEFT THE ALLOCATOR WITH ITS LOCK TAKEN/.test(lines[1]));

  const stats = recorder.stats();
  assert.strictEqual(stats.seen, 2);
  assert.strictEqual(stats.leaks, 1);
  assert.strictEqual(stats.last.export, 'bad');
  assert.strictEqual(stats.last.holdsLock, 1);
}

// A thrown value that is not an Error (a string, as the glue of Emscripten throws) is reported too, and the question may fail
{
  const lines = [];
  const exportsObject = {
    diag_dlmalloc_owner_is_calling_thread() { throw new Error('cannot ask'); },
    odd() { throw 'Atomics.notify returned an unexpected value -1'; }
  };
  const recorder = WasmExceptionRecorder.create({ log: (line) => lines.push(line) });
  const wrapped = recorder.wrapExports(exportsObject);
  assert.throws(() => wrapped.odd(), (error) => error === 'Atomics.notify returned an unexpected value -1');
  assert.strictEqual(lines.length, 1);
  assert(/odd threw string: Atomics\.notify returned an unexpected value -1/.test(lines[0]));
  assert.strictEqual(recorder.stats().last.holdsLock, -1);
}

// The quiet reports are limited, but a lock that is left taken is always reported
{
  const lines = [];
  let holds = 0;
  const exportsObject = {
    diag_dlmalloc_owner_is_calling_thread() { return holds; },
    bad() { throw new Error('x'); }
  };
  const recorder = WasmExceptionRecorder.create({ log: (line) => lines.push(line) });
  const wrapped = recorder.wrapExports(exportsObject);
  for (let i = 0; i < 100; i++) {
    assert.throws(() => wrapped.bad());
  }
  assert.strictEqual(lines.length, 40);
  holds = 1;
  assert.throws(() => wrapped.bad());
  assert.strictEqual(lines.length, 41);
  assert(/LEFT THE ALLOCATOR/.test(lines[40]));
  assert.strictEqual(recorder.stats().seen, 101);
}

// A failing log does not change what the caller sees
{
  const exportsObject = {
    diag_dlmalloc_owner_is_calling_thread() { return 0; },
    bad() { throw new Error('original'); }
  };
  const recorder = WasmExceptionRecorder.create({ log() { throw new Error('log failed'); } });
  const wrapped = recorder.wrapExports(exportsObject);
  assert.throws(() => wrapped.bad(), /original/);
}

// The wiring: the recorder is loaded before common.js, installed when the runtime is up, and the module has the question
const html = read('wasm/index.html');
const common = read('wasm/platform/common.js');
const patcher = read('tools/patch-diag-dlmalloc.js');
const recorderPosition = html.indexOf('src="platform/wasm_exception_recorder.js"');
assert(recorderPosition > 0 && recorderPosition < html.indexOf('src="platform/common.js"'));
assert(/WasmExceptionRecorder\.create\(\{/.test(common) && /window\.wasmExceptionRecorder\.install\(Module\);/.test(common));
assert(common.indexOf('wasmExceptionRecorder.install(Module)') < common.indexOf('window.moduleDidLoad();'), 'before the application calls the module');
assert(new RegExp(WasmExceptionRecorder.OWNER_QUESTION).test(patcher), 'the diagnostic allocator exports the function that the recorder asks');

console.log('wasm_exception_recorder_tests: PASS');
