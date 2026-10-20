(function(root, factory) {
  var exported = factory();
  root.FutexGuard = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
}(typeof window !== 'undefined' ? window : this, function() {
  'use strict';

  // The freezes of a long stream leave the lock of the allocator locked with nobody inside it (docs/2026-10-18-stream-
  // hang-investigation.md, section 10): the lock word says "locked, somebody waits", every thread that wants to allocate
  // sleeps on it, and nothing ever unlocks it. Clearing that word by hand woke the application at once.
  //
  // musl locks a normal mutex by storing EBUSY in its lock word, which is 10 in this libc (__WASI_ERRNO_BUSY), and a
  // thread that has to wait sets bit 31 as well. The word of a held lock that somebody waits for is therefore exactly
  // 0x8000000A. The main thread does not sleep on a futex, it spins in a loop of its own (the patched
  // emscripten_futex_wait of the module) that asks this guard on every turn. A critical section of the allocator lasts
  // microseconds, so a main thread that has waited seconds on the same unchanged word is waiting for a holder that is
  // gone, and the guard releases the lock.
  //
  // Only the lock of the allocator is released: the address of its lock word is found in the linked module at build
  // time (tools/find-malloc-lock.js) and a mutex of the application is never touched.

  var LOCKED_WITH_WAITERS = (0x80000000 | 10) | 0;
  var DEFAULT_STUCK_MS = 3000;

  function create(options) {
    options = options || {};
    var lockWordAddress = options.lockWordAddress | 0;
    var stuckMs = options.stuckMs || DEFAULT_STUCK_MS;
    var log = options.log || function() {};
    var breaks = 0;
    var lastWaitedMs = 0;

    // Called on every turn of the main thread's wait: addr and expected are what it waits for, startMs when this wait
    // began. Returns true after the lock word was cleared; the caller then wakes the waiters and leaves the wait.
    function check(addr, expected, startMs, nowMs, heap32) {
      if (lockWordAddress === 0 || addr !== lockWordAddress || expected !== LOCKED_WITH_WAITERS) {
        return false;
      }
      if (nowMs - startMs < stuckMs) {
        return false;
      }
      // Only while the word is still the one that was waited for: a lock that has changed hands is not stuck
      if (Atomics.compareExchange(heap32, addr >> 2, expected, 0) !== expected) {
        return false;
      }
      breaks++;
      lastWaitedMs = Math.round(nowMs - startMs);
      try {
        log('The allocator lock was held for ' + lastWaitedMs + ' ms with nobody inside and was released (break ' + breaks + ').');
      } catch (error) {
        // A failing log must not keep the main thread in the wait
      }
      return true;
    }

    function describe() {
      return ' lockBreaks=' + breaks + (breaks > 0 ? ' lastLockWaitMs=' + lastWaitedMs : '');
    }

    function stats() {
      return { breaks: breaks, lastWaitedMs: lastWaitedMs };
    }

    return {
      check: check,
      describe: describe,
      stats: stats
    };
  }

  // Hangs the guard on the Module that the patched emscripten_futex_wait of the module looks up on every turn
  function install(moduleObject, options) {
    var guard = create(options);
    moduleObject.mainFutexGuard = guard.check;
    return guard;
  }

  return {
    LOCKED_WITH_WAITERS: LOCKED_WITH_WAITERS,
    DEFAULT_STUCK_MS: DEFAULT_STUCK_MS,
    create: create,
    install: install
  };
}));
