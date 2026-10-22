(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.LagWatchSupport = api;
    root.LagWatch = api.create();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // A timer that is late says that the main thread of the page was kept from running. During a stream it is a sign that
  // something else took the processor (the system, a bar over the video), so the diagnostic log gets one line for a second in
  // which timers were late, and no line for the other seconds.
  //
  // env: {now(), setInterval, clearInterval, log(text)}; intervalMs and lateMs have the defaults below
  var INTERVAL_MS = 50;
  var LATE_MS = 40;
  var WINDOW_MS = 1000;

  function LagWatch(env) {
    this.env = env || {};
    this.timer = null;
    this.reset(0);
  }

  LagWatch.prototype.reset = function(now) {
    this.lastTick = now;
    this.windowStart = now;
    this.late = 0;
    this.worst = 0;
  };

  LagWatch.prototype.tick = function() {
    var now = this.env.now();
    var interval = this.env.intervalMs || INTERVAL_MS;
    var delay = now - this.lastTick - interval;
    this.lastTick = now;
    if (delay >= (this.env.lateMs || LATE_MS)) {
      this.late += 1;
      this.worst = Math.max(this.worst, delay);
    }
    if (now - this.windowStart >= WINDOW_MS) {
      if (this.late > 0 && typeof this.env.log === 'function') {
        this.env.log('Main thread: ' + this.late + ' late timers in ' + (now - this.windowStart) + ' ms, the worst by ' + Math.round(this.worst) + ' ms');
      }
      this.windowStart = now;
      this.late = 0;
      this.worst = 0;
    }
  };

  LagWatch.prototype.start = function() {
    if (this.timer !== null) {
      return;
    }
    this.reset(this.env.now());
    var self = this;
    this.timer = this.env.setInterval(function() { self.tick(); }, this.env.intervalMs || INTERVAL_MS);
  };

  LagWatch.prototype.stop = function() {
    if (this.timer === null) {
      return;
    }
    this.env.clearInterval(this.timer);
    this.timer = null;
  };

  return {
    INTERVAL_MS: INTERVAL_MS,
    LATE_MS: LATE_MS,
    WINDOW_MS: WINDOW_MS,
    LagWatch: LagWatch,
    create: function(env) {
      return new LagWatch(env || {
        now: function() { return performance.now(); },
        setInterval: function(callback, delay) { return setInterval(callback, delay); },
        clearInterval: function(timer) { clearInterval(timer); },
        log: function(text) {
          if (typeof logDiagnostic === 'function') {
            logDiagnostic(text);
          }
        }
      });
    }
  };
}));
