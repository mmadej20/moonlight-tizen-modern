'use strict';

const assert = require('assert');
const RumbleThrottle = require('../wasm/platform/rumble.js');

// The host asks for a new rumble strength up to 56 times per second during a drive. Every request used to start a
// new effect of 5 s on the controller (a call into the platform, over Bluetooth) and wrote two lines to the console.
// The throttle keeps the latest value per controller and applies it at most every 50 ms, but never delays a start
// from silence or a stop.

function createHarness(options) {
  options = options || {};
  const clock = { now: 1000 };
  const timers = [];
  const played = [];
  const throttle = RumbleThrottle.create({
    now: () => clock.now,
    setTimeout: (callback, delay) => {
      const timer = { callback, at: clock.now + delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { if (timer) timer.cancelled = true; },
    play: (index, weak, strong) => {
      played.push({ at: clock.now, index, weak, strong });
      if (options.play) return options.play(index, weak, strong);
      return undefined;
    },
  });
  function advance(ms) {
    const end = clock.now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && !t.fired && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock.now = due.at;
      due.fired = true;
      due.callback();
    }
    clock.now = end;
  }
  return { throttle, clock, played, advance, timers };
}

function testAStartFromSilenceIsAppliedAtOnce() {
  const h = createHarness();
  h.throttle.update(0, 0.5, 0.25);
  assert.deepStrictEqual(h.played, [{ at: 1000, index: 0, weak: 0.5, strong: 0.25 }]);
}

function testRapidChangesAreCoalescedIntoTheLatestValue() {
  const h = createHarness();
  h.throttle.update(0, 0.5, 0.5); // played at once
  h.advance(10);
  h.throttle.update(0, 0.6, 0.5);
  h.advance(10);
  h.throttle.update(0, 0.7, 0.5);
  h.advance(10);
  h.throttle.update(0, 0.8, 0.5);
  assert.strictEqual(h.played.length, 1, 'nothing is played inside the interval');
  h.advance(30); // 50 ms after the first effect
  assert.strictEqual(h.played.length, 2);
  assert.deepStrictEqual(h.played[1], { at: 1050, index: 0, weak: 0.8, strong: 0.5 }, 'the latest value wins');
  h.advance(200);
  assert.strictEqual(h.played.length, 2, 'no stray timer remains');
  assert.deepStrictEqual(h.throttle.stats(), { received: 4, played: 2, coalesced: 2, errors: 0 });
}

function testAStopIsNeverDelayedAndCancelsThePendingValue() {
  const h = createHarness();
  h.throttle.update(0, 0.5, 0.5);
  h.advance(10);
  h.throttle.update(0, 0.9, 0.9); // pending
  h.advance(10);
  h.throttle.update(0, 0, 0); // stop
  assert.deepStrictEqual(h.played[1], { at: 1020, index: 0, weak: 0, strong: 0 }, 'the stop is applied at once');
  h.advance(500);
  assert.strictEqual(h.played.length, 2, 'the pending value is dropped, otherwise the controller would start again');
}

function testAStopForAControllerThatIsSilentIsNotApplied() {
  const h = createHarness();
  h.throttle.update(0, 0, 0);
  assert.strictEqual(h.played.length, 0);
  assert.strictEqual(h.throttle.stats().coalesced, 1);
}

function testAStartAfterAStopIsAppliedAtOnceEvenInsideTheInterval() {
  const h = createHarness();
  h.throttle.update(0, 0.5, 0.5);
  h.advance(5);
  h.throttle.update(0, 0, 0);
  h.advance(5);
  h.throttle.update(0, 0.5, 0.5);
  assert.strictEqual(h.played.length, 3, 'start, stop and start again are all applied immediately');
}

function testChangesBelowTwoPercentAreIgnored() {
  const h = createHarness();
  h.throttle.update(0, 0.5, 0.5);
  h.advance(60);
  h.throttle.update(0, 0.505, 0.495);
  h.advance(200);
  assert.strictEqual(h.played.length, 1, 'a change of 1% is not worth a new effect');
  h.throttle.update(0, 0.53, 0.5);
  assert.strictEqual(h.played.length, 2, 'a change of 3% is applied');
}

function testAPendingValueThatEndsUpEqualIsNotAppliedAtTheEnd() {
  const h = createHarness();
  h.throttle.update(0, 0.5, 0.5);
  h.advance(10);
  h.throttle.update(0, 0.9, 0.9); // pending ...
  h.advance(10);
  h.throttle.update(0, 0.5, 0.5); // ... and back to what is playing
  h.advance(100);
  assert.strictEqual(h.played.length, 1, 'there is nothing to apply when the value returned to the one that plays');
}

function testControllersAreIndependent() {
  const h = createHarness();
  h.throttle.update(0, 0.5, 0.5);
  h.throttle.update(1, 0.2, 0.2); // a different controller is not held back by the first
  assert.deepStrictEqual(h.played.map((p) => p.index), [0, 1]);
  h.advance(10);
  h.throttle.update(0, 0.9, 0.5);
  h.throttle.update(1, 0.8, 0.2);
  h.advance(60);
  assert.deepStrictEqual(h.played.map((p) => p.index + ':' + p.weak), ['0:0.5', '1:0.2', '0:0.9', '1:0.8']);
}

function testPlatformErrorsNeverBreakTheStream() {
  let calls = 0;
  const h = createHarness({
    play: () => {
      calls += 1;
      if (calls === 1) throw new Error('actuator is gone');
      return Promise.reject(new Error('rejected'));
    },
  });
  h.throttle.update(0, 0.5, 0.5); // throws
  h.advance(100);
  h.throttle.update(0, 0.9, 0.5); // returns a rejected promise
  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    assert.strictEqual(h.throttle.stats().errors, 2);
    assert.strictEqual(h.throttle.stats().played, 2, 'an attempt counts as played');
  });
}

function testStopAllSilencesWhatPlaysAndCancelsTimers() {
  const h = createHarness();
  h.throttle.update(0, 0.5, 0.5);
  h.throttle.update(1, 0.4, 0.4);
  h.advance(10);
  h.throttle.update(0, 0.9, 0.9); // pending
  h.throttle.stopAll();
  assert.deepStrictEqual(h.played.slice(2).map((p) => p.index + ':' + p.weak + ':' + p.strong).sort(), ['0:0:0', '1:0:0']);
  h.advance(500);
  assert.strictEqual(h.played.length, 4, 'no timer fires after the stream is over');
  h.throttle.stopAll();
  assert.strictEqual(h.played.length, 4, 'stopping again changes nothing');
}

function testStatsAreDescribedForTheLog() {
  const h = createHarness();
  h.throttle.update(0, 0.5, 0.5);
  h.advance(10);
  h.throttle.update(0, 0.7, 0.5);
  h.advance(100);
  assert.strictEqual(h.throttle.describe(), 'Rumble: received=2 played=2 coalesced=0 errors=0');
}

(async () => {
  testAStartFromSilenceIsAppliedAtOnce();
  testRapidChangesAreCoalescedIntoTheLatestValue();
  testAStopIsNeverDelayedAndCancelsThePendingValue();
  testAStopForAControllerThatIsSilentIsNotApplied();
  testAStartAfterAStopIsAppliedAtOnceEvenInsideTheInterval();
  testChangesBelowTwoPercentAreIgnored();
  testAPendingValueThatEndsUpEqualIsNotAppliedAtTheEnd();
  testControllersAreIndependent();
  await testPlatformErrorsNeverBreakTheStream();
  testStopAllSilencesWhatPlaysAndCancelsTimers();
  testStatsAreDescribedForTheLog();
  console.log('rumble_throttle_tests: PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
