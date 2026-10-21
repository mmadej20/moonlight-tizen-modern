'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('wasm/index.html');
const common = read('wasm/platform/common.js');
const index = read('wasm/platform/index.js');
const dockerfile = read('Dockerfile');
const stub = read('wasm/platform/malloc_lock.js');

// The address of the lock and the guard are loaded before the code that creates the Module
const scripts = ['platform/malloc_lock.js', 'platform/futex_guard.js', 'platform/common.js'].map((file) => html.indexOf('src="' + file + '"'));
assert(scripts.every((position) => position > 0), 'the three scripts are in index.html');
assert(scripts[0] < scripts[2] && scripts[1] < scripts[2], 'the guard is loaded before common.js creates the Module');

// common.js hangs the guard on the Module with the address of the lock
assert(/FutexGuard\.install\(Module, \{/.test(common));
assert(/lockWordAddress: MALLOC_LOCK_WORD_ADDRESS/.test(common));
assert(common.indexOf('FutexGuard.install') < common.indexOf('script.src = "moonlight-wasm.js"'), 'before the module is loaded');

// Outside Docker the address is 0, which switches the guard off
assert(/var MALLOC_LOCK_WORD_ADDRESS = 0;/.test(stub));

// The health line carries how often the lock was released
assert(/getExtra: function\(\) \{ return rumbleThrottle\.describe\(\) \+ describeFutexGuard\(\); \}/.test(index));
assert(/function describeFutexGuard\(\) \{\s+return window\.futexGuard \? window\.futexGuard\.describe\(\) : '';/.test(index));

// The Docker build finds the lock in the linked module and patches the wait loop, after the install step that copies
// the stub, and fails when either does not work
assert(/COPY --chown=moonlight tools\/find-malloc-lock\.js tools\/patch-futex-wait\.js tools\/patch-embind-string\.js \.\/moonlight-tizen\/tools\//.test(dockerfile));
const install = dockerfile.indexOf('RUN cmake --install build --prefix build');
const find = dockerfile.indexOf('find-malloc-lock.js build/module.wat build/widget/platform/malloc_lock.js');
const patch = dockerfile.indexOf('patch-futex-wait.js build/widget/moonlight-wasm.js');
assert(install > 0 && find > install && patch > find, 'install, then find the lock, then patch');
assert(/fastcomp\/bin\/wasm-dis build\/widget\/moonlight-wasm\.wasm -o build\/module\.wat/.test(dockerfile));
assert(/node\/12\.9\.1_64bit\/bin\/node/.test(dockerfile), 'the tools run on the Node of the Emscripten SDK');

console.log('futex guard wiring tests passed');
