'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const diagnostics = require('../wasm/platform/diagnostic_logs.js');

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

assert.strictEqual(
  diagnostics.redactDiagnosticText('Please enter PIN: 1234'),
  'Please enter PIN: [REDACTED]'
);
assert.strictEqual(
  diagnostics.redactDiagnosticText('https://user:pass@example.test/path?token=abc&frame=42'),
  'https://[REDACTED]@example.test/path?token=[REDACTED]&frame=42'
);
assert.strictEqual(
  diagnostics.redactDiagnosticText('host=192.168.1.10 frame=42'),
  'host=192.168.1.10 frame=42'
);

const trimmed = diagnostics.trimDiagnosticLog('first\nsecond\nthird\n', 14);
assert(byteLength(trimmed) <= 14);
assert(trimmed.startsWith('[truncated]\n'));
assert(!trimmed.includes('first'));

assert.throws(() => diagnostics.validateDiagnosticDestination('http://host', '48150'));
assert.throws(() => diagnostics.validateDiagnosticDestination('host/path', '48150'));
assert.throws(() => diagnostics.validateDiagnosticDestination('', '48150'));
assert.throws(() => diagnostics.validateDiagnosticDestination('host', '0'));
assert.throws(() => diagnostics.validateDiagnosticDestination('host', '65536'));
assert.deepStrictEqual(
  diagnostics.validateDiagnosticDestination('192.168.1.10', '48150'),
  {host: '192.168.1.10', port: 48150}
);

const exported = diagnostics.buildDiagnosticExport(
  'Current session',
  'frame=42\n',
  {host: '192.168.1.10', startedAt: '2026-07-21T20:00:00.000Z'}
);
assert(/^[A-Za-z0-9_.-]+\.log$/.test(exported.filename));
assert(exported.body.includes('Moonlight diagnostic export v1'));
assert(exported.body.endsWith('frame=42\n'));

const html = fs.readFileSync(path.join(__dirname, '..', 'wasm', 'index.html'), 'utf8');
[
  'diagnosticSettings',
  'diagnosticCurrentSessionBtn',
  'diagnosticPreviousSessionBtn',
  'diagnosticFilter',
  'diagnosticLogViewport',
  'diagnosticHost',
  'diagnosticPort',
  'sendDiagnosticLogsBtn',
  'clearDiagnosticLogsBtn',
  'diagnosticLogsEnabledSwitch'
].forEach((id) => {
  assert.strictEqual((html.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id);
});
assert.strictEqual(html.includes('id="diagnosticSessionSelect"'), false, 'native session select should be removed');
assert(/<button[^>]*id="diagnosticCurrentSessionBtn"/.test(html));
assert(/<button[^>]*id="diagnosticPreviousSessionBtn"/.test(html));
const portInput = html.match(/<input[^>]*id="diagnosticPort"[^>]*>/);
assert(portInput, 'diagnostic port input should exist');
assert(/type="text"/.test(portInput[0]), 'port should use plain text input');
assert(/inputmode="numeric"/.test(portInput[0]), 'port should request the numeric keyboard');
assert(/pattern="\[0-9\]\*"/.test(portInput[0]), 'port should accept digits only');
assert(/value="48150"/.test(portInput[0]), 'default port should remain 48150');
assert(
  html.indexOf('id="diagnosticHost"') < html.indexOf('id="diagnosticLogViewport"'),
  'export controls should be above the log viewport'
);
assert(
  html.indexOf('platform/diagnostic_logs.js') < html.indexOf('platform/index.js'),
  'diagnostic module must load before index.js'
);

console.log('diagnostic_logs_js_tests: PASS');
