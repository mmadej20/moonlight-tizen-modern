'use strict';

const assert = require('assert');
const fs = require('fs');
const StartTimeline = require('../wasm/platform/start_timeline.js');

function createTimeline() {
  const clock = { now: 10000 };
  const timeline = StartTimeline.create({ now: () => clock.now });
  return { timeline, clock, advance(ms) { clock.now += ms; } };
}

// The stages of a stream start are timed from the press to the moment the connection is up, so the log says where
// the seconds go: the host (launching the game), the network, or the TV (setting up the media pipeline).
function testStagesAreTimedFromThePress() {
  const t = createTimeline();
  t.timeline.begin();
  t.advance(210);
  t.timeline.mark('server info');
  t.advance(90);
  t.timeline.mark('app lookup');
  t.advance(4650);
  t.timeline.mark('launch');
  t.advance(120);
  t.timeline.mark('native start');
  t.advance(2400);
  t.timeline.mark('connection');
  assert.strictEqual(t.timeline.finish(),
    'Stream start took 7470 ms: server info 210 ms, app lookup 90 ms, launch 4650 ms, native start 120 ms, connection 2400 ms');
}

function testFinishReportsOnceAndClosesTheMeasurement() {
  const t = createTimeline();
  t.timeline.begin();
  t.advance(100);
  t.timeline.mark('launch');
  assert.strictEqual(t.timeline.finish(), 'Stream start took 100 ms: launch 100 ms');
  assert.strictEqual(t.timeline.finish(), null, 'a second finish has nothing to report');
  t.timeline.mark('connection'); // a late mark after the report changes nothing
  assert.strictEqual(t.timeline.finish(), null);
}

function testNothingIsReportedWithoutABeginning() {
  const t = createTimeline();
  t.timeline.mark('launch');
  assert.strictEqual(t.timeline.finish(), null, 'a connection that was not started by a press has no timeline');
}

function testBeginningAgainStartsOver() {
  const t = createTimeline();
  t.timeline.begin();
  t.advance(500);
  t.timeline.mark('server info');
  // the first attempt failed and the user tries again
  t.advance(3000);
  t.timeline.begin();
  t.advance(70);
  t.timeline.mark('server info');
  assert.strictEqual(t.timeline.finish(), 'Stream start took 70 ms: server info 70 ms');
}

function testAStageThatRepeatsIsCountedOnce() {
  const t = createTimeline();
  t.timeline.begin();
  t.advance(10);
  t.timeline.mark('launch');
  t.advance(90);
  t.timeline.mark('launch'); // a duplicate mark (for example from a second code path) is ignored
  assert.strictEqual(t.timeline.finish(), 'Stream start took 10 ms: launch 10 ms');
}

function testCancelDropsTheMeasurement() {
  const t = createTimeline();
  t.timeline.begin();
  t.advance(10);
  t.timeline.mark('server info');
  t.timeline.cancel();
  assert.strictEqual(t.timeline.finish(), null, 'a start that failed does not leave a stale measurement behind');
}

testStagesAreTimedFromThePress();
testFinishReportsOnceAndClosesTheMeasurement();
testNothingIsReportedWithoutABeginning();
testBeginningAgainStartsOver();
testAStageThatRepeatsIsCountedOnce();
testCancelDropsTheMeasurement();
console.log('start_timeline_tests: PASS');
