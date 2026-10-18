'use strict';

const assert = require('assert');
const StreamWatchdog = require('../wasm/platform/stream_watchdog.js');

const KEY = 'moonlightStreamHeartbeat';

function createHarness(options) {
  options = options || {};
  const store = options.store || {};
  const logs = [];
  const timers = [];
  const clock = { wall: Date.parse('2026-10-18T10:00:00.000Z'), perf: 5000 };
  let health = 'video=10/5ms audio=10/5ms mainCalls=0 mainCallMaxMs=0 mainCallBlockedMs=0 heap=64MB/128MB';

  const watchdog = StreamWatchdog.create({
    now: () => clock.wall,
    perfNow: () => clock.perf,
    setInterval: (callback, delay) => { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; },
    clearInterval: (timer) => { timer.cleared = true; },
    storage: options.storage || {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
    },
    getHealth: () => { if (options.healthThrows) throw new Error('module not ready'); return health; },
    getMemory: () => 'jsHeap=40MB/60MB',
    log: (line) => logs.push(line),
  });

  return {
    watchdog, store, logs, timers, clock,
    setHealth(value) { health = value; },
    advance(ms) { clock.wall += ms; clock.perf += ms; },
    tick(ms) { this.advance(ms === undefined ? 1000 : ms); timers[timers.length - 1].callback(); },
    heartbeat() { return JSON.parse(store[KEY]); },
  };
}

function testHeartbeatIsStoredEverySecondWhileStreaming() {
  const h = createHarness();
  h.watchdog.start({ host: '192.168.0.5' });
  assert.strictEqual(h.timers.length, 1);
  assert.strictEqual(h.timers[0].delay, 1000);
  assert.strictEqual(h.heartbeat().state, 'streaming', 'streaming is recorded immediately');

  h.setHealth('video=600/9ms audio=1200/4ms mainCalls=3 mainCallMaxMs=2 mainCallBlockedMs=0 heap=70MB/128MB');
  h.tick();
  h.tick();
  const beat = h.heartbeat();
  assert.strictEqual(beat.state, 'streaming');
  assert.strictEqual(beat.upSeconds, 2);
  assert.strictEqual(beat.wall, h.clock.wall);
  assert(beat.health.includes('video=600/9ms'));
  assert(beat.memory.includes('jsHeap=40MB/60MB'));
  assert.strictEqual(JSON.stringify(beat).includes('192.168.0.5'), false, 'the heartbeat must not store the host address');
}

function testHealthIsLoggedEveryTenSecondsAndOnTheFirstTick() {
  const h = createHarness();
  h.watchdog.start({});
  for (let i = 0; i < 25; i += 1) h.tick();
  const healthLines = h.logs.filter((line) => line.startsWith('StreamHealth '));
  assert.strictEqual(healthLines.length, 3, 'ticks 1, 11 and 21 log the health line');
  assert(healthLines[0].includes('up=1s') && healthLines[0].includes('video=10/5ms'));
}

function testMainThreadStallIsReportedWithTheHealthAtThatMoment() {
  const h = createHarness();
  h.watchdog.start({});
  h.tick();
  h.setHealth('video=40/3900ms audio=40/3900ms mainCalls=9 mainCallMaxMs=3800 mainCallBlockedMs=0 heap=70MB/128MB');
  h.tick(4800); // the timer fired 4.8 s after the previous tick
  const stall = h.logs.find((line) => line.startsWith('Main thread stalled'));
  assert(stall, 'a long gap between ticks is reported');
  assert(stall.includes('4800 ms'), stall);
  assert(stall.includes('video=40/3900ms'), 'the report carries the native health');

  h.logs.length = 0;
  h.tick(1200); // slightly late, but within the tolerated jitter
  assert.strictEqual(h.logs.some((line) => line.startsWith('Main thread stalled')), false);
}

function testCleanStopRecordsIdleAndStopsTheTimer() {
  const h = createHarness();
  h.watchdog.start({});
  h.tick();
  h.watchdog.stop('stream terminated 0');
  assert.strictEqual(h.timers[0].cleared, true);
  const beat = h.heartbeat();
  assert.strictEqual(beat.state, 'idle');
  assert.strictEqual(beat.endedBecause, 'stream terminated 0');

  h.watchdog.stop('again'); // stopping twice is harmless and keeps the first reason
  assert.strictEqual(h.heartbeat().endedBecause, 'stream terminated 0');
}

function testUncleanExitIsReportedOnceAfterARestart() {
  const first = createHarness();
  first.watchdog.start({});
  first.setHealth('video=900/12000ms audio=900/12000ms mainCalls=5 mainCallMaxMs=11000 mainCallBlockedMs=11000 heap=126MB/128MB');
  first.tick();
  first.tick();
  first.tick(); // the application froze after the third second and was killed

  const second = createHarness({ store: first.store });
  second.clock.wall = first.clock.wall + 95000; // restarted 95 s later
  second.watchdog.reportUncleanExit();
  assert.strictEqual(second.logs.length, 1);
  const report = second.logs[0];
  assert(report.startsWith('Previous run ended while streaming'), report);
  assert(report.includes('2026-10-18T10:00:03.000Z'), 'it names the last heartbeat');
  assert(report.includes('3 s'), 'it names how long the stream had been running');
  assert(report.includes('95 s'), 'it names how long ago that was');
  assert(report.includes('mainCallBlockedMs=11000'), 'it carries the last native health');
  assert.strictEqual(second.heartbeat().state, 'idle', 'the marker is consumed');

  const third = createHarness({ store: first.store });
  third.watchdog.reportUncleanExit();
  assert.strictEqual(third.logs.length, 0, 'a clean marker is not reported twice');
}

function testNothingIsReportedAfterACleanStopOrOnFirstRun() {
  const fresh = createHarness();
  fresh.watchdog.reportUncleanExit();
  assert.strictEqual(fresh.logs.length, 0);

  const clean = createHarness();
  clean.watchdog.start({});
  clean.tick();
  clean.watchdog.stop('apps view');
  const after = createHarness({ store: clean.store });
  after.watchdog.reportUncleanExit();
  assert.strictEqual(after.logs.length, 0);
}

function testBrokenStorageAndMissingHealthNeverBreakTheStream() {
  const corrupt = createHarness({ store: { [KEY]: '{not json' } });
  corrupt.watchdog.reportUncleanExit();
  assert.strictEqual(corrupt.logs.length, 0, 'a corrupt record is ignored');

  const throwingStorage = createHarness({
    storage: { getItem() { throw new Error('quota'); }, setItem() { throw new Error('quota'); } },
  });
  throwingStorage.watchdog.reportUncleanExit();
  throwingStorage.watchdog.start({});
  throwingStorage.tick();
  throwingStorage.watchdog.stop('x');

  const noModule = createHarness({ healthThrows: true });
  noModule.watchdog.start({});
  noModule.tick();
  assert.strictEqual(noModule.heartbeat().health, 'unavailable');
}

function testStartingAgainReplacesThePreviousTimer() {
  const h = createHarness();
  h.watchdog.start({});
  h.watchdog.start({});
  assert.strictEqual(h.timers.length, 2);
  assert.strictEqual(h.timers[0].cleared, true, 'only one heartbeat timer may run');
  assert.strictEqual(h.timers[1].cleared, false);
}

testHeartbeatIsStoredEverySecondWhileStreaming();
testHealthIsLoggedEveryTenSecondsAndOnTheFirstTick();
testMainThreadStallIsReportedWithTheHealthAtThatMoment();
testCleanStopRecordsIdleAndStopsTheTimer();
testUncleanExitIsReportedOnceAfterARestart();
testNothingIsReportedAfterACleanStopOrOnFirstRun();
testBrokenStorageAndMissingHealthNeverBreakTheStream();
testStartingAgainReplacesThePreviousTimer();
console.log('stream_watchdog_tests: PASS');
