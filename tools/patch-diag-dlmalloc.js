// Makes the diagnostic copy of the allocator of the toolchain (docs/2026-10-18-stream-hang-investigation.md, section 17).
//
// The dlmalloc of the Emscripten release build defines ABORT as __builtin_unreachable(), so every check that finds a
// damaged heap (a free of a block that is not in use, a next chunk that does not agree with this one, an address outside
// of the heap) is dead code for the compiler, and a damaged heap goes on until something far away traps. The copy made
// here keeps the algorithm and the lock of the original and changes two things:
//   - a failed check stops the thread (a wasm trap, which the watcher of tools/tv-debug catches with the stack) and
//     tells the line of the check on the console;
//   - the lock of the main allocator state records its owner, and a thread that gets the lock while another one is
//     recorded as inside, or releases a lock that another one is recorded to own, says so on the console.
//
// Usage: node patch-diag-dlmalloc.js <dlmalloc.c of the toolchain> <output file>
// Runs on the Node of the Emscripten SDK (version 12), so it keeps to old syntax. Fails when the source is not the one
// that this was written for, so that a toolchain update does not silently produce a copy without the checks.
'use strict';

var fs = require('fs');

var PRELUDE = [
  '/* Diagnostic copy of the dlmalloc of the toolchain, made by tools/patch-diag-dlmalloc.js. */',
  '#define DLMALLOC_DEBUG 1',
  '#include <emscripten.h>',
  '#include <pthread.h>',
  '#include <stdint.h>',
  'static void diag_dlmalloc_abort(int line) {',
  '  EM_ASM_({ console.error("dlmalloc: a check failed at line " + $0 + " of the diagnostic copy, thread " + $1); },',
  '           line, (int)(intptr_t)pthread_self());',
  '  __builtin_trap();',
  '}',
  '#define ABORT diag_dlmalloc_abort(__LINE__)',
  'static volatile int diag_owner;',
  'static int diag_acquire(pthread_mutex_t* lk) {',
  '  int r = pthread_mutex_lock(lk);',
  '  if (r == 0) {',
  '    int me = (int)(intptr_t)pthread_self();',
  '    int previous = __atomic_exchange_n(&diag_owner, me, __ATOMIC_SEQ_CST);',
  '    if (previous != 0) {',
  '      EM_ASM_({ console.error("dlmalloc: thread " + $0 + " got the lock while thread " + $1 + " is still inside"); },',
  '               me, previous);',
  '    }',
  '  }',
  '  return r;',
  '}',
  'static int diag_release(pthread_mutex_t* lk) {',
  '  int me = (int)(intptr_t)pthread_self();',
  '  int previous = __atomic_exchange_n(&diag_owner, 0, __ATOMIC_SEQ_CST);',
  '  if (previous != me) {',
  '    EM_ASM_({ console.error("dlmalloc: thread " + $0 + " releases the lock that thread " + $1 + " is recorded to own"); },',
  '             me, previous);',
  '  }',
  '  return pthread_mutex_unlock(lk);',
  '}',
  ''
].join('\n');

var REPLACEMENTS = [
  [
    '#define PREACTION(M)  ((use_lock(M))? ACQUIRE_LOCK(&(M)->mutex) : 0)',
    '#define PREACTION(M)  ((use_lock(M))? diag_acquire(&(M)->mutex) : 0)'
  ],
  [
    '#define POSTACTION(M) { if (use_lock(M)) RELEASE_LOCK(&(M)->mutex); }',
    '#define POSTACTION(M) { if (use_lock(M)) diag_release(&(M)->mutex); }'
  ]
];

function patch(source) {
  var text = source.replace(/\r\n/g, '\n');
  var i;
  if (text.indexOf('#ifndef DLMALLOC_DEBUG') < 0 || text.indexOf('#define ABORT __builtin_unreachable()') < 0) {
    throw new Error('this is not the dlmalloc of the Emscripten release build that the patch was written for (ABORT)');
  }
  if (text.indexOf('#define USE_LOCKS 1') < 0 || text.indexOf('#define USE_SPIN_LOCKS 0') < 0) {
    throw new Error('this dlmalloc does not use pthread mutexes (USE_LOCKS)');
  }
  for (i = 0; i < REPLACEMENTS.length; i++) {
    var pieces = text.split(REPLACEMENTS[i][0]);
    if (pieces.length !== 2) {
      throw new Error('expected exactly one: ' + REPLACEMENTS[i][0]);
    }
    text = pieces.join(REPLACEMENTS[i][1]);
  }
  return PRELUDE + text;
}

module.exports = { patch: patch, PRELUDE: PRELUDE };

if (require.main === module) {
  var args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('usage: node patch-diag-dlmalloc.js <dlmalloc.c> <output>');
    process.exit(2);
  }
  fs.writeFileSync(args[1], patch(fs.readFileSync(args[0], 'utf8')));
  console.log('wrote ' + args[1]);
}
