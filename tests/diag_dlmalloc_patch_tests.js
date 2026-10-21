'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const { patch, PRELUDE } = require('../tools/patch-diag-dlmalloc.js');

// The lines of the dlmalloc of the toolchain that the patch looks at (Emscripten fastcomp, dlmalloc 2.8.6)
const source = [
  '/* XXX Emscripten XXX */',
  '#if __EMSCRIPTEN__',
  '#ifndef DLMALLOC_DEBUG',
  '/* dlmalloc has many checks, calls to abort() increase code size,',
  '   leave them only in debug builds */',
  '#define ABORT __builtin_unreachable()',
  '#endif',
  '#if __EMSCRIPTEN_PTHREADS__',
  '#define USE_LOCKS 1',
  '#define USE_SPIN_LOCKS 0 // Ensure we use pthread_mutex_t.',
  '#endif',
  '#endif',
  '#if USE_LOCKS',
  '#define PREACTION(M)  ((use_lock(M))? ACQUIRE_LOCK(&(M)->mutex) : 0)',
  '#define POSTACTION(M) { if (use_lock(M)) RELEASE_LOCK(&(M)->mutex); }',
  '#endif',
  ''
].join('\n');

const patched = patch(source);

// The checks are on: DLMALLOC_DEBUG is defined before the toolchain's own test of it, and ABORT stops the thread
assert(patched.indexOf('#define DLMALLOC_DEBUG 1') < patched.indexOf('#ifndef DLMALLOC_DEBUG'));
assert(/#define ABORT diag_dlmalloc_abort\(__LINE__\)/.test(patched));
assert(/__builtin_trap\(\);/.test(PRELUDE));
assert(/a check failed at line/.test(PRELUDE));

// The lock of the main state goes through the functions that record the owner
assert(/#define PREACTION\(M\)  \(\(use_lock\(M\)\)\? diag_acquire\(&\(M\)->mutex\) : 0\)/.test(patched));
assert(/#define POSTACTION\(M\) \{ if \(use_lock\(M\)\) diag_release\(&\(M\)->mutex\); \}/.test(patched));
assert(!/ACQUIRE_LOCK\(&\(M\)->mutex\)/.test(patched));
assert(/got the lock while thread/.test(PRELUDE));
assert(/releases the lock that thread/.test(PRELUDE));
assert(/pthread_mutex_lock\(lk\)/.test(PRELUDE) && /pthread_mutex_unlock\(lk\)/.test(PRELUDE), 'the lock itself is the one of the original');

// The rest of the source is untouched: the prelude, then the source with the two lines of the lock changed
const expected = source
  .replace('((use_lock(M))? ACQUIRE_LOCK(&(M)->mutex) : 0)', '((use_lock(M))? diag_acquire(&(M)->mutex) : 0)')
  .replace('{ if (use_lock(M)) RELEASE_LOCK(&(M)->mutex); }', '{ if (use_lock(M)) diag_release(&(M)->mutex); }');
assert.strictEqual(patched, PRELUDE + expected);

// A source that is not the expected one is refused, so that a toolchain update cannot produce a copy without the checks
assert.throws(() => patch(source.replace('#define ABORT __builtin_unreachable()', '#define ABORT abort()')), /ABORT/);
assert.throws(() => patch(source.replace('#define USE_SPIN_LOCKS 0 // Ensure we use pthread_mutex_t.', '')), /USE_LOCKS/);
assert.throws(() => patch(source.replace('#define POSTACTION(M) { if (use_lock(M)) RELEASE_LOCK(&(M)->mutex); }', '')), /exactly one/);
assert.throws(() => patch(source + source.split('\n').filter((l) => /define PREACTION/.test(l)).join('\n')), /exactly one/);

// Both CRLF and LF sources are accepted
assert.doesNotThrow(() => patch(source.replace(/\n/g, '\r\n')));

// The Docker build, CMake and the context filter are wired to it, and it is off by default
const docker = read('Dockerfile');
const cmake = read('CMakeLists.txt');
const dockerignore = read('.dockerignore');
assert(/ARG DIAG_MALLOC=OFF/.test(docker));
assert(/-DMOONLIGHT_DIAG_MALLOC=\$\{DIAG_MALLOC\}/.test(docker));
assert(/if \[ "\$DIAG_MALLOC" = "ON" \]/.test(docker));
assert(/patch-diag-dlmalloc\.js[\s\S]*?system\/lib\/dlmalloc\.c[\s\S]*?wasm\/diag_dlmalloc\.c/.test(docker));
assert(docker.indexOf('ARG DIAG_MALLOC=OFF') < docker.indexOf('RUN cmake'), 'the copy is made before CMake looks for it');
assert(/option\(MOONLIGHT_DIAG_MALLOC [^)]*OFF\)/.test(cmake), 'off by default');
assert(/target_sources\(moonlight-wasm PRIVATE wasm\/diag_dlmalloc\.c\)/.test(cmake));
assert(/set_source_files_properties\(wasm\/diag_dlmalloc\.c PROPERTIES COMPILE_FLAGS "-s USE_PTHREADS=1"\)/.test(cmake), 'the pthreads lock is on in the copy');
assert(/^!tools\/patch-diag-dlmalloc\.js$/m.test(dockerignore));
assert(!fs.existsSync(path.join(root, 'wasm', 'diag_dlmalloc.c')), 'the copy exists only in the Docker build, it is not committed');

console.log('diag dlmalloc patch tests passed');
