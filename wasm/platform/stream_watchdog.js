(function(root, factory) {
  var exported = factory();
  root.StreamWatchdog = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
}(typeof window !== 'undefined' ? window : this, function() {
  'use strict';

  // Why this exists: the diagnostic log is written by the main thread, so when the main thread
  // freezes the log simply stops and looks the same as a crash. The heartbeat is a tiny record that
  // is rewritten every second while streaming. After the application is killed, the next start
  // reads it and reports when the stream last proved to be alive and what the native side saw.

  var HEARTBEAT_KEY = 'moonlightStreamHeartbeat';
  var INTERVAL_MS = 1000;
  var STALL_THRESHOLD_MS = 2500;
  var HEALTH_LOG_EVERY_TICKS = 10;

  function create(options) {
    var now = options.now;
    var perfNow = options.perfNow;
    var storage = options.storage;
    var log = options.log;
    var timer = null;
    var running = false;
    var startedWall = 0;
    var lastTickPerf = 0;
    var ticks = 0;
    var windowLatenessMs = 0;

    function readRecord() {
      try {
        var raw = storage.getItem(HEARTBEAT_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        return null;
      }
    }

    function writeRecord(record) {
      try {
        storage.setItem(HEARTBEAT_KEY, JSON.stringify(record));
      } catch (error) {
        // The heartbeat is a diagnostic aid. Storage problems must never affect the stream.
      }
    }

    function describe(provider) {
      try {
        var value = provider();
        return value ? String(value) : 'unavailable';
      } catch (error) {
        return 'unavailable';
      }
    }

    function snapshot(state, extra) {
      var record = {
        v: 1,
        state: state,
        startedWall: startedWall,
        wall: now(),
        upSeconds: Math.round((now() - startedWall) / 1000),
        tick: ticks,
        health: describe(options.getHealth),
        memory: options.getMemory ? describe(options.getMemory) : 'unavailable'
      };
      for (var key in extra) {
        record[key] = extra[key];
      }
      return record;
    }

    function tick() {
      ticks += 1;
      var currentPerf = perfNow();
      var gap = currentPerf - lastTickPerf;
      lastTickPerf = currentPerf;

      // A tick that arrives late shows how long the main thread was busy. The worst one of each window is logged.
      var lateness = gap - INTERVAL_MS;
      if (lateness > windowLatenessMs) {
        windowLatenessMs = lateness;
      }

      var record = snapshot('streaming', {});
      if (gap > STALL_THRESHOLD_MS) {
        log('Main thread stalled for ' + Math.round(gap) + ' ms (heartbeat expected every ' +
          INTERVAL_MS + ' ms). ' + record.health + ' ' + record.memory);
      }
      if ((ticks - 1) % HEALTH_LOG_EVERY_TICKS === 0) {
        log('StreamHealth up=' + record.upSeconds + 's ' + record.health + ' ' + record.memory +
          ' mainJitterMaxMs=' + Math.round(windowLatenessMs));
        windowLatenessMs = 0;
      }
      writeRecord(record);
    }

    function start() {
      if (timer !== null) {
        options.clearInterval(timer);
      }
      running = true;
      startedWall = now();
      lastTickPerf = perfNow();
      ticks = 0;
      windowLatenessMs = 0;
      writeRecord(snapshot('streaming', {}));
      timer = options.setInterval(tick, INTERVAL_MS);
    }

    function stop(reason) {
      if (!running) {
        return;
      }
      running = false;
      if (timer !== null) {
        options.clearInterval(timer);
        timer = null;
      }
      writeRecord(snapshot('idle', {endedBecause: String(reason || 'unknown')}));
    }

    function reportUncleanExit() {
      var record = readRecord();
      if (!record || record.state !== 'streaming') {
        return;
      }

      var lastBeat = new Date(record.wall).toISOString();
      var agoSeconds = Math.round((now() - record.wall) / 1000);
      log('Previous run ended while streaming: last heartbeat ' + lastBeat + ', the stream had been running ' +
        record.upSeconds + ' s, ' + agoSeconds + ' s ago. Last health: ' + record.health + ' ' +
        (record.memory || ''));
      writeRecord({
        v: 1,
        state: 'idle',
        wall: record.wall,
        upSeconds: record.upSeconds,
        endedBecause: 'reported as an unexpected end of the previous run'
      });
    }

    return {
      start: start,
      stop: stop,
      reportUncleanExit: reportUncleanExit
    };
  }

  return {
    create: create,
    HEARTBEAT_KEY: HEARTBEAT_KEY
  };
}));
