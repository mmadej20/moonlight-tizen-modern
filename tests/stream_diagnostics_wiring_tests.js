'use strict';

const assert = require('assert');
const fs = require('fs');

function read(path) {
  return fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const main = read('wasm/main.cpp');
const http = read('wasm/http.cpp');

// HTTP: every dispatcher request goes through the helper that logs queue waits.
assert.match(http, /PostHttpJob\(\s*HttpUrlPathForLog\(url\)/);
assert.match(main, /PostHttpJob\(\s*"pair"/);
assert.doesNotMatch(http, /m_Dispatcher\.post_job\(\s*\[this, callbackId, url/);
assert.match(http, /ShouldLogWait\(waited\)/);
assert.match(http, /ShouldLogSlow\(ran\)/);

console.log('stream_diagnostics_wiring_tests: PASS');
