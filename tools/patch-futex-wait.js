'use strict';

// Patches the generated moonlight-wasm.js so that the loop in which the main thread simulates a futex wait asks the
// guard of wasm/platform/futex_guard.js whether the lock it waits for is stuck (see that file for why). The patch is
// applied by the Docker build after the module is linked; it fails when the loop does not look as expected, so that a
// toolchain update cannot silently drop it.
//
// Usage: node tools/patch-futex-wait.js <moonlight-wasm.js>
// Runs on the Node 12 that ships with the Emscripten SDK, so it sticks to old syntax.

const fs = require('fs');

// The wait loop of the main thread in the output of the Samsung Emscripten 1.39.4.7 (emscripten_futex_wait of
// library_pthread.js), as the generated, unminified file has it
const ORIGINAL =
  'var tNow=performance.now();var tEnd=tNow+timeout;var ourWaitAddress=addr;' +
  'while(addr==ourWaitAddress){tNow=performance.now();if(tNow>tEnd){';

const PATCHED =
  'var tNow=performance.now();var tEnd=tNow+timeout;var tStart=tNow;var ourWaitAddress=addr;' +
  'while(addr==ourWaitAddress){tNow=performance.now();' +
  'if(Module["mainFutexGuard"]&&Module["mainFutexGuard"](ourWaitAddress,val,tStart,tNow,HEAP32)){' +
  '_emscripten_futex_wake(ourWaitAddress,2147483647);' +
  'Atomics.store(HEAP32,__main_thread_futex_wait_address>>2,oldAddr);return 0}' +
  'if(tNow>tEnd){';

function occurrences(source, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at < 0) return count;
    count++;
    from = at + needle.length;
  }
}

function patchFutexWait(source) {
  const found = occurrences(source, ORIGINAL);
  if (found !== 1) {
    throw new Error('the wait loop of the main thread was found ' + found + ' times, expected exactly once' +
      (occurrences(source, 'mainFutexGuard') > 0 ? ' (the file is already patched)' : ''));
  }
  return source.replace(ORIGINAL, function() { return PATCHED; });
}

module.exports = { patchFutexWait, ORIGINAL, PATCHED };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node patch-futex-wait.js <moonlight-wasm.js>');
    process.exit(2);
  }
  try {
    fs.writeFileSync(file, patchFutexWait(fs.readFileSync(file, 'utf8')));
    console.log('patched the futex wait loop of ' + file);
  } catch (error) {
    console.error('cannot patch ' + file + ': ' + error.message);
    process.exit(1);
  }
}
