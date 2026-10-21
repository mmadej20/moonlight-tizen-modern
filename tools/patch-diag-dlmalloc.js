// Makes the diagnostic copy of the allocator of the toolchain (docs/2026-10-18-stream-hang-investigation.md, section 17).
//
// The dlmalloc of the Emscripten release build defines ABORT as __builtin_unreachable(), so every check that finds a
// damaged heap (a free of a block that is not in use, a next chunk that does not agree with this one, an address outside
// of the heap) is dead code for the compiler, and a damaged heap goes on until something far away traps. The copy made
// here keeps the algorithm and the lock of the original and changes three things (a bare comma in the JavaScript of an
// EM_ASM_ would split the macro arguments, so the code below declares one variable per statement):
//   - a failed check stops the thread (a wasm trap, which the watcher of tools/tv-debug catches with the stack) and
//     tells the line of the check on the console;
//   - the lock of the main allocator state records its owner, and a thread that gets the lock while another one is
//     recorded as inside, or releases a lock that another one is recorded to own, says so on the console;
//   - the checks of dlmalloc for DEBUG builds are on, and every 16th entry into the allocator, under its lock, validates
//     the whole state (every chunk of the heap, the bins, the trees). The first entry that finds the state damaged stops
//     the thread and tells the last 64 entries (number, thread, line of the entry in dlmalloc, and for malloc and free the size or pointer), so that the operation that
//     damaged the heap is among them.
//
// Usage: node patch-diag-dlmalloc.js <dlmalloc.c of the toolchain> <output file>
// Runs on the Node of the Emscripten SDK (version 12), so it keeps to old syntax. Fails when the source is not the one
// that this was written for, so that a toolchain update does not silently produce a copy without the checks.
'use strict';

var fs = require('fs');

var PRELUDE = [
  '/* Diagnostic copy of the dlmalloc of the toolchain, made by tools/patch-diag-dlmalloc.js. */',
  '#define DLMALLOC_DEBUG 1',
  '#define DEBUG 1',
  '#include <emscripten.h>',
  '#include <pthread.h>',
  '#include <stdint.h>',
  '#define DIAG_RING 256',
  '#define DIAG_CHECK_EVERY 16',
  'typedef struct { unsigned int seq; int thread; int line; int kind; unsigned int arg; } diag_entry;',
  'static diag_entry diag_ring[DIAG_RING];',
  'static unsigned int diag_seq;',
  'static void diag_periodic_check(void);',
  'static void diag_dlmalloc_abort(int line) {',
  '  EM_ASM_({ console.error("dlmalloc: a check failed at line " + $0 + " of the diagnostic copy, thread " + $1); },',
  '           line, (int)(intptr_t)pthread_self());',
  '  EM_ASM_({',
  '    var base = $0 >> 2;',
  '    var seq = $1;',
  '    var n = $2;',
  '    var out = [];',
  '    for (var s = seq; s > 0 && s > seq - 64; s--) {',
  '      var e = base + (s % n) * 5;',
  '      if (HEAPU32[e] !== s) break;',
  '      var kind = HEAP32[e + 3];',
  '      var what = kind == 1 ? " malloc(" + HEAPU32[e + 4] + ")" : (kind == 2 ? " free(0x" + HEAPU32[e + 4].toString(16) + ")" : "");',
  '      out.push(s + ":" + (HEAP32[e + 1] >>> 0).toString(16) + "@" + HEAP32[e + 2] + what);',
  '    }',
  '    console.error("dlmalloc: last entries into the allocator, newest first (number:thread@line): " + out.join(" "));',
  '  }, (int)(intptr_t)diag_ring, diag_seq, DIAG_RING);',
  '  __builtin_trap();',
  '}',
  '#define ABORT diag_dlmalloc_abort(__LINE__)',
  'static volatile int diag_owner;',
  'static int diag_acquire(pthread_mutex_t* lk, int line, int kind, unsigned int arg) {',
  '  int r = pthread_mutex_lock(lk);',
  '  if (r == 0) {',
  '    int me = (int)(intptr_t)pthread_self();',
  '    int previous = __atomic_exchange_n(&diag_owner, me, __ATOMIC_SEQ_CST);',
  '    if (previous != 0) {',
  '      EM_ASM_({ console.error("dlmalloc: thread " + $0 + " got the lock while thread " + $1 + " is still inside"); },',
  '               me, previous);',
  '    }',
  '    {',
  '      unsigned int number = ++diag_seq;',
  '      diag_ring[number % DIAG_RING].seq = number;',
  '      diag_ring[number % DIAG_RING].thread = me;',
  '      diag_ring[number % DIAG_RING].line = line;',
  '      diag_ring[number % DIAG_RING].kind = kind;',
  '      diag_ring[number % DIAG_RING].arg = arg;',
  '      if (number % DIAG_CHECK_EVERY == 0) {',
  '        diag_periodic_check();',
  '      }',
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
  '// Asked by wasm/platform/wasm_exception_recorder.js when an exported function throws on the main thread: the thread that',
  '// asks holds the lock of the allocator only if the exception cut a critical section of the allocator short',
  'EMSCRIPTEN_KEEPALIVE int diag_dlmalloc_owner_is_calling_thread(void) {',
  '  return diag_owner == (int)(intptr_t)pthread_self();',
  '}',
  ''
].join('\n');

var REPLACEMENTS = [
  [
    '#define PREACTION(M)  ((use_lock(M))? ACQUIRE_LOCK(&(M)->mutex) : 0)',
    '#define PREACTION(M)  ((use_lock(M))? diag_acquire(&(M)->mutex, __LINE__, 0, 0) : 0)\n' +
    '#define PREACTION_OP(M, KIND, ARG)  ((use_lock(M))? diag_acquire(&(M)->mutex, __LINE__, (KIND), (ARG)) : 0)'
  ],
  [
    '#define POSTACTION(M) { if (use_lock(M)) RELEASE_LOCK(&(M)->mutex); }',
    '#define POSTACTION(M) { if (use_lock(M)) diag_release(&(M)->mutex); }'
  ]
];

// The first entry of these two functions says which operation it is and on what: malloc of so many bytes, free of that pointer
var OPERATIONS = [
  ['void* dlmalloc(size_t bytes) {', 'PREACTION(gm)', 'PREACTION_OP(gm, 1, (unsigned int)bytes)'],
  ['void dlfree(void* mem) {', 'PREACTION(fm)', 'PREACTION_OP(fm, 2, (unsigned int)(uintptr_t)mem)']
];

// Appended after the original: the validation of the whole state needs the types and the global state defined there
var APPENDIX = [
  '',
  '/* Added by tools/patch-diag-dlmalloc.js: validates every chunk, bin and tree; runs under the lock of the allocator. */',
  'static void diag_periodic_check(void) {',
  '  do_check_malloc_state(gm);',
  '}',
  ''
].join('\n');

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
  for (i = 0; i < OPERATIONS.length; i++) {
    var start = text.split(OPERATIONS[i][0]);
    if (start.length !== 2) {
      throw new Error('expected exactly one: ' + OPERATIONS[i][0]);
    }
    var after = start[1];
    var at = after.indexOf(OPERATIONS[i][1]);
    if (at < 0) {
      throw new Error('no ' + OPERATIONS[i][1] + ' after: ' + OPERATIONS[i][0]);
    }
    text = start[0] + OPERATIONS[i][0] + after.slice(0, at) + OPERATIONS[i][2] + after.slice(at + OPERATIONS[i][1].length);
  }
  return PRELUDE + text + APPENDIX;
}

module.exports = { patch: patch, PRELUDE: PRELUDE, APPENDIX: APPENDIX };

if (require.main === module) {
  var args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('usage: node patch-diag-dlmalloc.js <dlmalloc.c> <output>');
    process.exit(2);
  }
  fs.writeFileSync(args[1], patch(fs.readFileSync(args[0], 'utf8')));
  console.log('wrote ' + args[1]);
}
