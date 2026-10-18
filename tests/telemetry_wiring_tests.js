'use strict';

// Where the interface writes the new telemetry lines: the stages of a stream start, the summary of each app list
// (cached and downloaded pictures), and the answer to the request that starts the stream, which nothing handled before.

const assert = require('assert');
const fs = require('fs');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, 'Missing function ' + name);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('Unbalanced braces in ' + name);
}

const html = read('wasm/index.html');
const index = read('wasm/platform/index.js');
const messages = read('wasm/platform/messages.js');

// The timeline script loads before the code that uses it.
const timelineAt = html.indexOf('platform/start_timeline.js');
assert(timelineAt > 0, 'start_timeline.js is part of the page');
assert(timelineAt < html.indexOf('platform/index.js'), 'it loads before index.js');

// Stream start stages.
assert(/var startTimeline = StartTimeline\.create\(/.test(index));
const startGame = extractFunction(index, 'startGame');
assert(startGame.indexOf('startTimeline.begin()') >= 0 && startGame.indexOf('startTimeline.begin()') < startGame.indexOf('refreshServerInfo()'),
  'the measurement starts with the press');
for (const stage of ['server info', 'app lookup', 'launch', 'native start']) {
  assert(startGame.includes("startTimeline.mark('" + stage + "')"), 'stage "' + stage + '" is timed');
}
assert.strictEqual((startGame.match(/startTimeline\.mark\('launch'\)/g) || []).length, 2,
  'both ways to start (launching and resuming the app) time the launch stage');
assert.strictEqual((startGame.match(/startTimeline\.mark\('native start'\)/g) || []).length, 2);

// The answer to the start request is handled: it used to be dropped, so a rejection by the native side left no trace.
assert.strictEqual((startGame.match(/Stream start request was rejected/g) || []).length, 2,
  'a rejected start request is written to the log on both paths');

// The connection ends the measurement and the line goes to the log.
const finish = extractFunction(index, 'finishStartTimeline');
assert(/startTimeline\.mark\('connection'\)/.test(finish));
assert(/logDiagnostic\(summary\)/.test(finish));
assert(/finishStartTimeline\(\)/.test(messages.slice(messages.indexOf("msg === 'Connection Established'"),
  messages.indexOf("msg.indexOf('ProgressMsg: ')"))), 'the connection message closes the measurement');

// App list: the summary of the pictures is reset with each list and written when they have all settled.
const showApps = extractFunction(index, 'showApps');
assert(showApps.indexOf('resetBoxArtStats()') > 0 && showApps.indexOf('resetBoxArtStats()') < showApps.indexOf('sortedAppList.forEach'),
  'every list starts its own summary');
const settled = showApps.slice(showApps.indexOf('Promise.all(settledPromises).then('));
assert(/logDiagnostic\(describeBoxArtStats\(\)\)/.test(settled), 'the summary is written when every picture has settled');
assert(settled.indexOf('describeBoxArtStats') < settled.indexOf('isCurrent(appsGeneration)'),
  'it is written even when the list was left before the pictures finished');

console.log('telemetry wiring tests passed');
