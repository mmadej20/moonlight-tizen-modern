'use strict';

const assert = require('assert');
const FutexGuard = require('../wasm/platform/futex_guard.js');

// A held lock of the allocator that somebody waits for has this lock word: EBUSY (10 in this libc) plus bit 31
const STUCK = FutexGuard.LOCKED_WITH_WAITERS;
assert.strictEqual(STUCK, -2147483638);

const LOCK_ADDRESS = 256;

function createHeap() {
  return new Int32Array(new SharedArrayBuffer(1024));
}

function createGuard(extra) {
  const messages = [];
  const guard = FutexGuard.create(Object.assign({ lockWordAddress: LOCK_ADDRESS, stuckMs: 3000, log: (line) => messages.push(line) }, extra));
  return { guard, messages };
}

// A wait that has lasted less than the limit never releases anything
{
  const heap = createHeap();
  heap[LOCK_ADDRESS >> 2] = STUCK;
  const { guard, messages } = createGuard();
  assert.strictEqual(guard.check(LOCK_ADDRESS, STUCK, 1000, 3999, heap), false);
  assert.strictEqual(heap[LOCK_ADDRESS >> 2], STUCK);
  assert.strictEqual(messages.length, 0);
  assert.strictEqual(guard.describe(), ' lockBreaks=0');
}

// A stuck lock that the main thread has waited for long enough is released, once
{
  const heap = createHeap();
  heap[LOCK_ADDRESS >> 2] = STUCK;
  const { guard, messages } = createGuard();
  assert.strictEqual(guard.check(LOCK_ADDRESS, STUCK, 1000, 4000, heap), true);
  assert.strictEqual(heap[LOCK_ADDRESS >> 2], 0);
  assert.strictEqual(messages.length, 1);
  assert(/3000 ms/.test(messages[0]), 'the log says how long the lock was held: ' + messages[0]);
  assert.deepStrictEqual(guard.stats(), { breaks: 1, lastWaitedMs: 3000 });
  assert.strictEqual(guard.describe(), ' lockBreaks=1 lastLockWaitMs=3000');
  // The word is clear now, so a second look finds nothing to release
  assert.strictEqual(guard.check(LOCK_ADDRESS, STUCK, 1000, 5000, heap), false);
  assert.strictEqual(guard.stats().breaks, 1);
}

// A lock that has changed hands in the meantime is not stuck: the word is left alone
{
  const heap = createHeap();
  heap[LOCK_ADDRESS >> 2] = 10; // locked again by somebody who has no waiters yet
  const { guard } = createGuard();
  assert.strictEqual(guard.check(LOCK_ADDRESS, STUCK, 0, 10000, heap), false);
  assert.strictEqual(heap[LOCK_ADDRESS >> 2], 10);
  assert.strictEqual(guard.stats().breaks, 0);
}

// Only the lock word of the allocator and only the value of a held lock with waiters count; every other mutex and
// every other wait is left alone however long it lasts
{
  const heap = createHeap();
  const { guard } = createGuard();
  heap[(LOCK_ADDRESS + 64) >> 2] = STUCK;
  assert.strictEqual(guard.check(LOCK_ADDRESS + 64, STUCK, 0, 100000, heap), false, 'another address');
  assert.strictEqual(heap[(LOCK_ADDRESS + 64) >> 2], STUCK);
  heap[LOCK_ADDRESS >> 2] = 7;
  assert.strictEqual(guard.check(LOCK_ADDRESS, 7, 0, 100000, heap), false, 'another value');
  assert.strictEqual(heap[LOCK_ADDRESS >> 2], 7);
  heap[LOCK_ADDRESS >> 2] = 2;
  assert.strictEqual(guard.check(LOCK_ADDRESS, 2, 0, 100000, heap), false, 'a condition variable of the same address');
}

// Address 0 means that the build could not find the lock: the guard is off
{
  const heap = createHeap();
  heap[0] = STUCK;
  const guard = FutexGuard.create({ lockWordAddress: 0 });
  assert.strictEqual(guard.check(0, STUCK, 0, 100000, heap), false);
  assert.strictEqual(heap[0], STUCK);
  assert.strictEqual(FutexGuard.create({}).check(0, STUCK, 0, 100000, heap), false);
}

// A log that throws must not keep the main thread in the wait
{
  const heap = createHeap();
  heap[LOCK_ADDRESS >> 2] = STUCK;
  const guard = FutexGuard.create({ lockWordAddress: LOCK_ADDRESS, stuckMs: 100, log: () => { throw new Error('console is gone'); } });
  assert.strictEqual(guard.check(LOCK_ADDRESS, STUCK, 0, 200, heap), true);
  assert.strictEqual(heap[LOCK_ADDRESS >> 2], 0);
}

// The default limit is seconds, far above any critical section of the allocator
assert(FutexGuard.DEFAULT_STUCK_MS >= 2000);
{
  const heap = createHeap();
  heap[LOCK_ADDRESS >> 2] = STUCK;
  const guard = FutexGuard.create({ lockWordAddress: LOCK_ADDRESS });
  assert.strictEqual(guard.check(LOCK_ADDRESS, STUCK, 0, FutexGuard.DEFAULT_STUCK_MS - 1, heap), false);
  assert.strictEqual(guard.check(LOCK_ADDRESS, STUCK, 0, FutexGuard.DEFAULT_STUCK_MS, heap), true);
}

// install puts the check where the patched wait loop looks it up
{
  const moduleObject = {};
  const guard = FutexGuard.install(moduleObject, { lockWordAddress: LOCK_ADDRESS });
  assert.strictEqual(moduleObject.mainFutexGuard, guard.check);
}

console.log('futex guard tests passed');
