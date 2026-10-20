'use strict';

const assert = require('assert');
const { patchFutexWait, ORIGINAL, PATCHED } = require('../tools/patch-futex-wait.js');
const FutexGuard = require('../wasm/platform/futex_guard.js');

// emscripten_futex_wait of the Samsung Emscripten 1.39.4.7 as the generated moonlight-wasm.js has it. The patch has to
// find the loop of the main thread in exactly this text.
const FUTEX_WAIT =
  'function _emscripten_futex_wait(addr,val,timeout){if(addr<=0||addr>HEAP8.length||addr&3!=0)return-28;' +
  'if(ENVIRONMENT_IS_WORKER){var ret=Atomics.wait(HEAP32,addr>>2,val,timeout);if(ret==="timed-out")return-73;' +
  'if(ret==="not-equal")return-6;if(ret==="ok")return 0;throw"Atomics.wait returned an unexpected value "+ret}' +
  'else{const oldAddr=Atomics.exchange(HEAP32,__main_thread_futex_wait_address>>2,addr);' +
  'var loadedVal=Atomics.load(HEAP32,addr>>2);if(val!=loadedVal){Atomics.store(HEAP32,__main_thread_futex_wait_address>>2,oldAddr);return-6}' +
  'var tNow=performance.now();var tEnd=tNow+timeout;var ourWaitAddress=addr;' +
  'while(addr==ourWaitAddress){tNow=performance.now();if(tNow>tEnd){Atomics.store(HEAP32,__main_thread_futex_wait_address>>2,oldAddr);return-73}' +
  '_emscripten_main_thread_process_queued_calls();addr=Atomics.load(HEAP32,__main_thread_futex_wait_address>>2)}return 0}}';

const SOURCE = 'var a=1;' + FUTEX_WAIT + 'function __fillGamepadEventData(eventStruct,e){}';

// The loop is found once and only once; a changed toolchain must fail the build instead of dropping the protection
assert(SOURCE.includes(ORIGINAL), 'the fixture contains the loop that the patch looks for');
const patched = patchFutexWait(SOURCE);
assert(patched.includes(PATCHED));
assert(!patched.includes(ORIGINAL));
assert(patched.startsWith('var a=1;') && patched.endsWith('function __fillGamepadEventData(eventStruct,e){}'), 'the rest of the file is untouched');
assert.throws(() => patchFutexWait(patched), /already patched/);
assert.throws(() => patchFutexWait('var nothing=1;'), /found 0 times/);
assert.throws(() => patchFutexWait(SOURCE + SOURCE), /found 2 times/);
// A replacement string must not be read as a pattern ($& and the like)
assert.doesNotThrow(() => new Function(patched.replace('var a=1;', 'var a=1;var HEAP8,HEAP32,Atomics,performance,Module,__main_thread_futex_wait_address,ENVIRONMENT_IS_WORKER,_emscripten_main_thread_process_queued_calls,_emscripten_futex_wake;') + ';'));

// What the patched loop does, run against a fake clock and a fake heap
const LOCK = 256;
const STUCK = FutexGuard.LOCKED_WITH_WAITERS;
const SLOT_ADDRESS = 512;

function createWorld(patchedSource, guardOptions) {
  const heap = new Int32Array(new SharedArrayBuffer(4096));
  const world = {
    heap,
    clock: 1000,
    wakes: [],
    queuedCalls: 0,
    onQueuedCall: null,
    moduleObject: {}
  };
  if (guardOptions) FutexGuard.install(world.moduleObject, guardOptions);
  const factory = new Function('HEAP8', 'HEAP32', 'Atomics', 'performance', 'Module', '__main_thread_futex_wait_address',
    'ENVIRONMENT_IS_WORKER', '_emscripten_main_thread_process_queued_calls', '_emscripten_futex_wake',
    patchedSource + ';return _emscripten_futex_wait;');
  world.wait = factory(
    new Int8Array(heap.buffer), heap, Atomics, { now: () => world.clock }, world.moduleObject, SLOT_ADDRESS, false,
    () => {
      world.queuedCalls++;
      world.clock += 100; // every turn of the loop takes time
      if (world.onQueuedCall) world.onQueuedCall(world);
    },
    (addr, count) => { world.wakes.push([addr, count]); return 0; });
  return world;
}

// A stuck lock: the main thread waits on it, nobody wakes it, and after the limit the guard releases it
{
  const world = createWorld(patched, { lockWordAddress: LOCK, stuckMs: 3000 });
  world.heap[LOCK >> 2] = STUCK;
  const result = world.wait(LOCK, STUCK, Infinity);
  assert.strictEqual(result, 0, 'the wait ends as a wake-up, so the caller tries the lock again');
  assert.strictEqual(world.heap[LOCK >> 2], 0, 'the lock word is clear');
  assert.deepStrictEqual(world.wakes, [[LOCK, 2147483647]], 'every thread that waits on the lock is woken');
  assert(world.clock - 1000 >= 3000, 'after at least the limit: ' + (world.clock - 1000));
  assert(world.clock - 1000 < 3300, 'and not much later');
  assert.strictEqual(world.heap[SLOT_ADDRESS >> 2], 0, 'the main thread no longer says that it waits on the address');
  assert.strictEqual(world.moduleObject.mainFutexGuard !== undefined, true);
}

// Without a guard the loop behaves as before: it ends at the timeout and leaves the lock alone
{
  const world = createWorld(patched, null);
  world.heap[LOCK >> 2] = STUCK;
  assert.strictEqual(world.wait(LOCK, STUCK, 5000), -73);
  assert.strictEqual(world.heap[LOCK >> 2], STUCK);
  assert.deepStrictEqual(world.wakes, []);
}

// Another address, however long the wait: nothing is released
{
  const world = createWorld(patched, { lockWordAddress: LOCK, stuckMs: 3000 });
  world.heap[(LOCK + 64) >> 2] = STUCK;
  assert.strictEqual(world.wait(LOCK + 64, STUCK, 10000), -73);
  assert.strictEqual(world.heap[(LOCK + 64) >> 2], STUCK);
  assert.deepStrictEqual(world.wakes, []);
}

// A thread that wakes the main thread the normal way (the slot is reset to zero) ends the wait without the guard
{
  const world = createWorld(patched, { lockWordAddress: LOCK, stuckMs: 3000 });
  world.heap[LOCK >> 2] = STUCK;
  world.onQueuedCall = (w) => { if (w.queuedCalls === 3) w.heap[SLOT_ADDRESS >> 2] = 0; };
  assert.strictEqual(world.wait(LOCK, STUCK, Infinity), 0);
  assert.strictEqual(world.heap[LOCK >> 2], STUCK, 'a normal wake-up leaves the word to its owner');
  assert.deepStrictEqual(world.wakes, []);
  assert.strictEqual(world.moduleObject.mainFutexGuard !== undefined, true);
}

// A value that has already changed is reported at once, as it was
{
  const world = createWorld(patched, { lockWordAddress: LOCK, stuckMs: 3000 });
  world.heap[LOCK >> 2] = 0;
  assert.strictEqual(world.wait(LOCK, STUCK, Infinity), -6);
  assert.strictEqual(world.queuedCalls, 0);
}

console.log('futex patch tests passed');
