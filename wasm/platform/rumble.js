(function(root, factory) {
  var exported = factory();
  root.RumbleThrottle = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
}(typeof window !== 'undefined' ? window : this, function() {
  'use strict';

  // The host asks for a new rumble strength up to 56 times per second during a drive. Starting an effect is a call
  // into the platform and, for a Bluetooth controller, into its radio. The throttle keeps the latest value of every
  // controller and applies it at most once per interval. A start from silence and a stop are never delayed, because
  // the effect lasts 5 s and a lost stop would leave the controller buzzing.

  var DEFAULT_INTERVAL_MS = 50;
  var DEFAULT_EPSILON = 0.02;

  function create(options) {
    var now = options.now;
    var schedule = options.setTimeout;
    var cancel = options.clearTimeout;
    var play = options.play;
    var interval = options.minIntervalMs === undefined ? DEFAULT_INTERVAL_MS : options.minIntervalMs;
    var epsilon = options.epsilon === undefined ? DEFAULT_EPSILON : options.epsilon;
    var pads = {};
    var counters = {received: 0, played: 0, coalesced: 0, errors: 0};

    function pad(index) {
      if (!pads[index]) {
        pads[index] = {weak: 0, strong: 0, playedAt: 0, pending: null, timer: null};
      }
      return pads[index];
    }

    function isSilent(weak, strong) {
      return weak === 0 && strong === 0;
    }

    function differs(state, weak, strong) {
      return Math.abs(state.weak - weak) >= epsilon || Math.abs(state.strong - strong) >= epsilon;
    }

    function apply(index, state, weak, strong) {
      state.weak = weak;
      state.strong = strong;
      state.playedAt = now();
      counters.played += 1;
      try {
        var result = play(index, weak, strong);
        if (result && typeof result.then === 'function') {
          result.then(null, function() {
            counters.errors += 1;
          });
        }
      } catch (error) {
        counters.errors += 1;
      }
    }

    function clearPending(state) {
      state.pending = null;
      if (state.timer !== null) {
        cancel(state.timer);
        state.timer = null;
      }
    }

    function flush(index) {
      var state = pad(index);
      state.timer = null;
      var pending = state.pending;
      state.pending = null;
      if (pending && differs(state, pending.weak, pending.strong)) {
        apply(index, state, pending.weak, pending.strong);
      }
    }

    function update(index, weak, strong) {
      counters.received += 1;
      var state = pad(index);

      if (isSilent(weak, strong)) {
        clearPending(state);
        if (isSilent(state.weak, state.strong)) {
          counters.coalesced += 1;
          return;
        }
        apply(index, state, 0, 0);
        return;
      }

      if (isSilent(state.weak, state.strong)) {
        clearPending(state);
        apply(index, state, weak, strong);
        return;
      }

      if (!differs(state, weak, strong)) {
        clearPending(state);
        counters.coalesced += 1;
        return;
      }

      var wait = state.playedAt + interval - now();
      if (wait <= 0) {
        clearPending(state);
        apply(index, state, weak, strong);
        return;
      }

      if (state.pending) {
        counters.coalesced += 1;
      }
      state.pending = {weak: weak, strong: strong};
      if (state.timer === null) {
        state.timer = schedule(function() {
          flush(index);
        }, wait);
      }
    }

    // The stream is over: silence every controller that still vibrates and drop the values that were waiting
    function stopAll() {
      Object.keys(pads).forEach(function(key) {
        var state = pads[key];
        clearPending(state);
        if (!isSilent(state.weak, state.strong)) {
          apply(Number(key), state, 0, 0);
        }
      });
    }

    function stats() {
      return {
        received: counters.received,
        played: counters.played,
        coalesced: counters.coalesced,
        errors: counters.errors
      };
    }

    function describe() {
      return 'Rumble: received=' + counters.received + ' played=' + counters.played +
        ' coalesced=' + counters.coalesced + ' errors=' + counters.errors;
    }

    return {
      update: update,
      stopAll: stopAll,
      stats: stats,
      describe: describe
    };
  }

  return {
    create: create
  };
}));
