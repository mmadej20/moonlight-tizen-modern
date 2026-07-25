(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.createSubnetScanner = api.createSubnetScanner;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  var MAX_CONCURRENCY = 8;
  var PROBE_TIMEOUT_MS = 3000;

  function normalizeConcurrency(value) {
    if (typeof value !== 'number' || !isFinite(value) || value <= 0) {
      return MAX_CONCURRENCY;
    }
    var normalized = Math.floor(value);
    return normalized > 0 ? Math.min(normalized, MAX_CONCURRENCY) : MAX_CONCURRENCY;
  }

  function cancelResponseBody(response) {
    try {
      if (response && response.body && typeof response.body.cancel === 'function') {
        var cancellation = response.body.cancel();
        if (cancellation && typeof cancellation.catch === 'function') {
          cancellation.catch(function() {});
        }
      }
    } catch (error) {
      // Body cleanup failures must not stop subnet discovery.
    }
  }

  function createSubnetScanner(options) {
    options = options || {};
    var fetchImpl = options.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    var onFound = options.onFound || function() {};
    var concurrency = normalizeConcurrency(options.concurrency);
    var AbortControllerImpl = options.AbortController ||
      (typeof AbortController !== 'undefined' ? AbortController : null);
    var setTimeoutImpl = options.setTimeout || setTimeout;
    var clearTimeoutImpl = options.clearTimeout || clearTimeout;
    var currentGeneration = 0;
    var activeControllers = [];

    function removeActiveController(controller) {
      var index = activeControllers.indexOf(controller);
      if (index !== -1) {
        activeControllers.splice(index, 1);
      }
    }

    function cancel() {
      currentGeneration += 1;
      var controllers = activeControllers.slice();
      activeControllers.length = 0;
      controllers.forEach(function(controller) {
        try {
          controller.abort();
        } catch (error) {
          // A failed abort must not prevent cancellation of other probes.
        }
      });
    }

    function start(subnetPrefix) {
      cancel();
      var scanGeneration = currentGeneration;
      var addresses = [];
      var nextAddress = 0;
      var workers = [];
      var workerCount;
      var address;

      for (address = 1; address <= 254; address += 1) {
        addresses.push(subnetPrefix + '.' + address);
      }

      workerCount = Math.min(concurrency, addresses.length);
      for (var workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
        workers.push((async function() {
          while (scanGeneration === currentGeneration && nextAddress < addresses.length) {
            var ip = addresses[nextAddress++];
            var controller = AbortControllerImpl ? new AbortControllerImpl() : null;
            var timeoutId = setTimeoutImpl(function() {
              if (controller) {
                controller.abort();
              }
            }, PROBE_TIMEOUT_MS);

            if (controller) {
              activeControllers.push(controller);
            }

            var response = null;
            try {
              response = await fetchImpl(
                'http://' + ip + ':47989/serverinfo',
                controller ? { signal: controller.signal } : {}
              );
              if (response.ok && scanGeneration === currentGeneration) {
                onFound(ip);
              }
            } catch (error) {
              // Probe, AbortError, and callback failures must not stop a worker.
            } finally {
              clearTimeoutImpl(timeoutId);
              if (controller) {
                removeActiveController(controller);
              }
              cancelResponseBody(response);
            }
          }
        })());
      }

      return Promise.all(workers).then(function() {});
    }

    return {
      start: start,
      cancel: cancel,
      generation: function() {
        return currentGeneration;
      },
    };
  }

  return {
    createSubnetScanner: createSubnetScanner,
  };
});
