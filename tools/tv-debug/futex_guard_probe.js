'use strict';

// Checks on the TV that the guard of wasm/platform/futex_guard.js releases a stuck lock of the allocator. It writes the
// lock word of a held lock that somebody waits for (what the freezes leave behind) and calls malloc on the main thread,
// which then waits on the lock until the guard releases it. Run it against an idle application: the call blocks the
// page for the limit of the guard (3 s).
//
// Usage: node futex_guard_probe.js <host:port/devtools/page/ID> [rounds=2]
const target = process.argv[2];
const rounds = Number(process.argv[3] || 2);

const PROBE = `(function () {
  var address = typeof MALLOC_LOCK_WORD_ADDRESS === 'number' ? MALLOC_LOCK_WORD_ADDRESS : 0;
  if (!address || typeof Module.mainFutexGuard !== 'function' || !window.futexGuard) {
    return JSON.stringify({ error: 'the guard is not installed', address: address });
  }
  if (Atomics.load(HEAP32, address >> 2) !== 0) {
    return JSON.stringify({ error: 'the lock word is not 0, the application is busy', word: Atomics.load(HEAP32, address >> 2) });
  }
  var before = window.futexGuard.stats().breaks;
  Atomics.store(HEAP32, address >> 2, FutexGuard.LOCKED_WITH_WAITERS);
  var started = performance.now();
  var pointer = Module._malloc(16);
  var waitedMs = Math.round(performance.now() - started);
  Module._free(pointer);
  return JSON.stringify({
    address: address,
    waitedMs: waitedMs,
    gotMemory: pointer !== 0,
    wordAfter: Atomics.load(HEAP32, address >> 2),
    breaksAdded: window.futexGuard.stats().breaks - before,
    stats: window.futexGuard.stats(),
    health: window.futexGuard.describe()
  });
})()`;

const ws = new WebSocket('ws://' + target);
let nextId = 0;
const pending = new Map();
function send(method, params, timeoutMs) {
  return new Promise((resolve) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, timeoutMs || 10000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
};
ws.onerror = () => { console.log('websocket error'); process.exit(1); };
ws.onopen = async () => {
  let failed = false;
  for (let round = 1; round <= rounds; round++) {
    const response = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, 20000);
    const value = response.result && response.result.result && response.result.result.value;
    console.log('round ' + round + ': ' + (value || JSON.stringify(response).slice(0, 300)));
    let parsed = null;
    try { parsed = JSON.parse(value); } catch (error) { /* printed above */ }
    // The call must have returned after about the limit of the guard, with memory, and the guard must have counted it
    if (!parsed || parsed.error || !parsed.gotMemory || parsed.breaksAdded !== 1 || parsed.waitedMs < 2900 || parsed.waitedMs > 6000 || parsed.wordAfter !== 0) {
      failed = true;
    }
  }
  console.log(failed ? 'GUARD CHECK FAILED' : 'GUARD CHECK PASSED');
  process.exit(failed ? 1 : 0);
};
