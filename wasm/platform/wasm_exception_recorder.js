(function(root, factory) {
  var exported = factory();
  root.WasmExceptionRecorder = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
}(typeof window !== 'undefined' ? window : this, function() {
  'use strict';

  // The freezes of a long stream leave the lock of the allocator locked with nobody inside it, and the diagnostic copy
  // of dlmalloc (tools/patch-diag-dlmalloc.js) records the last thread that took it: the main thread. The main thread
  // can leave a critical section of the allocator without unlocking it only through an exception, and the code that
  // calls into the module catches exceptions (the diagnostic log drain, for one), so nothing showed it.
  //
  // Every function that the module exports is wrapped here, and the main thread asks the module, when one of them throws,
  // whether it still holds the lock of the allocator. This is only for the build with the diagnostic dlmalloc: without
  // the question function nothing is wrapped.

  var OWNER_QUESTION = 'diag_dlmalloc_owner_is_calling_thread';
  var MAX_STACK_LINES = 14;
  var MAX_QUIET_REPORTS = 40;

  function create(options) {
    options = options || {};
    var log = options.log || function() {};
    var reports = 0;
    var leaks = 0;
    var seen = 0;
    var last = null;

    function stackOf(error) {
      var stack = error && error.stack ? String(error.stack) : '';
      return stack.split('\n').slice(0, MAX_STACK_LINES).join(' | ');
    }

    // Called with the name of the export that threw and what it threw; asked is the question of the module
    function record(exportName, error, ask) {
      seen++;
      var holds = -1;
      try {
        holds = ask ? ask() : -1;
      } catch (askError) {
        // The question itself failing must not hide the exception
      }
      var leaked = holds === 1;
      if (leaked) {
        leaks++;
      }
      last = {
        export: exportName,
        name: error && error.name ? String(error.name) : typeof error,
        message: error && error.message ? String(error.message) : String(error),
        holdsLock: holds,
        stack: stackOf(error)
      };
      if (leaked || reports < MAX_QUIET_REPORTS) {
        reports++;
        try {
          log('[wasm-exception] ' + last.export + ' threw ' + last.name + ': ' + last.message +
            (leaked ? ' | THE MAIN THREAD LEFT THE ALLOCATOR WITH ITS LOCK TAKEN' : '') + ' | stack: ' + last.stack);
        } catch (logError) {
          // A failing log must not change what the caller sees
        }
      }
      return last;
    }

    // A copy of the exports in which every function reports what it throws and throws it again
    function wrapExports(exportsObject) {
      var ask = typeof exportsObject[OWNER_QUESTION] === 'function' ? exportsObject[OWNER_QUESTION] : null;
      if (!ask) {
        return exportsObject;
      }
      var wrapped = {};
      Object.keys(exportsObject).forEach(function(key) {
        var original = exportsObject[key];
        if (typeof original !== 'function' || key === OWNER_QUESTION) {
          wrapped[key] = original;
          return;
        }
        wrapped[key] = function() {
          try {
            return original.apply(null, arguments);
          } catch (error) {
            record(key, error, ask);
            throw error;
          }
        };
      });
      return wrapped;
    }

    // Replaces the exports that the module looks up (Module.asm) once the runtime is up
    function install(moduleObject) {
      if (!moduleObject || !moduleObject.asm) {
        return false;
      }
      var wrapped = wrapExports(moduleObject.asm);
      if (wrapped === moduleObject.asm) {
        return false;
      }
      moduleObject.asm = wrapped;
      return true;
    }

    function stats() {
      return { seen: seen, reports: reports, leaks: leaks, last: last };
    }

    return {
      wrapExports: wrapExports,
      install: install,
      record: record,
      stats: stats
    };
  }

  return {
    OWNER_QUESTION: OWNER_QUESTION,
    create: create
  };
}));
