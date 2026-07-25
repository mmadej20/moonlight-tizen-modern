'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const cmake = fs.readFileSync(path.join(root, 'CMakeLists.txt'), 'utf8');
const platformHeader = fs.readFileSync(
  path.join(root, 'moonlight-common-c', 'src', 'Platform.h'),
  'utf8'
);
const connectionListener = fs.readFileSync(
  path.join(root, 'wasm', 'connectionlistener.cpp'),
  'utf8'
);

assert.match(
  cmake,
  /target_compile_definitions\(moonlight-common-c PUBLIC[\s\S]*?\bLC_LOG\b[\s\S]*?\)/,
  'moonlight-common-c must compile with LC_LOG so Limelog uses the registered listener'
);

assert.match(
  platformHeader,
  /ListenerCallbacks\.logMessage\("%s",\s*message\);/,
  'preformatted Limelog text must be forwarded as data, not as a second format string'
);

assert.match(
  connectionListener,
  /DiagnosticLogTryAppend\(LiGetMillis\(\),\s*message\);/,
  'the connection listener must append received common-library logs to diagnostics'
);

console.log('common_log_capture_wiring_tests: PASS');
