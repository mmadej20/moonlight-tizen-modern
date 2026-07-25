(function(root, factory) {
  var exported = factory();
  root.OperationGuard = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
}(typeof window !== 'undefined' ? window : this, function() {
  'use strict';

  function createGenerationGate() {
    var generation = 0;

    return {
      begin: function() {
        generation += 1;
        return generation;
      },
      cancel: function() {
        generation += 1;
      },
      isCurrent: function(token) {
        return token === generation;
      },
      current: function() {
        return generation;
      }
    };
  }

  function parseStoredJson(value, onError) {
    if (value === null || value === undefined) {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch (error) {
      if (typeof onError === 'function') {
        try {
          onError(error);
        } catch (loggerError) {
          // Storage recovery must not depend on diagnostic logging succeeding.
        }
      }
      return null;
    }
  }

  function createStaleOperationError() {
    var error = new Error('Operation was superseded');
    error.code = 'STALE_OPERATION';
    return error;
  }

  function isStaleOperationError(error) {
    return !!error && error.code === 'STALE_OPERATION';
  }

  return {
    createGenerationGate: createGenerationGate,
    parseStoredJson: parseStoredJson,
    createStaleOperationError: createStaleOperationError,
    isStaleOperationError: isStaleOperationError
  };
}));
