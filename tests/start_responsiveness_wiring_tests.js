'use strict';

const assert = require('assert');
const fs = require('fs');

function read(path) {
  return fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
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

const index = read('wasm/platform/index.js');

// The app list tells the box art downloads when it is outdated, so queued downloads are dropped.
const showApps = extractFunction(index, 'showApps');
assert.match(
  showApps,
  /host\.getBoxArt\(app\.id, _isSmartHubSupported, function\(\) \{\s*return !appsGenerationGate\.isCurrent\(appsGeneration\);\s*\}\)/,
  'box art downloads must stop when the app list is replaced');

// Entering the stream view invalidates the list and cancels the downloads that still run, so the
// request that starts the stream does not wait for them.
const streamMode = extractFunction(index, 'showStreamMode');
assert.match(streamMode, /appsGenerationGate\.cancel\(\);/);
assert.match(streamMode, /cancelBoxArtDownloads\(\)/);

// The first thing a press on an app does is tell the user that something is happening: the
// server info request below can take a moment on a slow network, and the spinner only appears after it.
const startGame = extractFunction(index, 'startGame');
const feedbackAt = startGame.indexOf("snackbarLog('Starting %1$s...'");
const refreshAt = startGame.indexOf('host.refreshServerInfo().then(');
assert(feedbackAt >= 0, 'startGame announces that the app is starting');
assert(refreshAt > feedbackAt, 'the announcement comes before the first network request');

console.log('start_responsiveness_wiring_tests: PASS');
