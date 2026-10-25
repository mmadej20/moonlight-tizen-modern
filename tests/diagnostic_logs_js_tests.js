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
  'diagnosticLogViewport',
  'diagnosticHost',
  'diagnosticPort',
  'sendDiagnosticLogsBtn',
  'clearDiagnosticLogsBtn',
  'diagnosticLogsEnabledSwitch',
  'diagnosticLogsEnabledBtn',
  'diagnosticOptions'
].forEach((id) => {
  assert.strictEqual((html.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id);
});
assert.strictEqual(html.includes('id="diagnosticSessionSelect"'), false, 'native session select should be removed');
assert(/<button[^>]*id="diagnosticCurrentSessionBtn"/.test(html));
assert(/<button[^>]*id="diagnosticPreviousSessionBtn"/.test(html));
// The receiver is set with the keys of the remote: four numbers for the host and five digits for the port, with no field of text
// (the keyboard of the TV did not open for one)
const hostCells = html.match(/<div id="diagnosticHost" class="diagnostic-cells"[^>]*>([\s\S]*?)<\/div>/);
const portCells = html.match(/<div id="diagnosticPort" class="diagnostic-cells"[^>]*>([\s\S]*?)<\/div>/);
assert(hostCells && portCells, 'the host and the port are groups of cells');
assert.strictEqual((hostCells[1].match(/class="diagnostic-cell"/g) || []).length, 4, 'four numbers for the host');
assert.strictEqual((portCells[1].match(/class="diagnostic-cell"/g) || []).length, 5, 'five digits for the port');
assert.strictEqual(portCells[1].replace(/<[^>]*>/g, '').trim(), '48150', 'default port should remain 48150');
assert(!/<input[^>]*id="diagnostic(Host|Port)"/.test(html), 'no field of text for the receiver');

assert.deepStrictEqual(diagnostics.parseIpv4Octets('192.168.1.10'), [192, 168, 1, 10]);
assert.deepStrictEqual(diagnostics.parseIpv4Octets(' 10.0.0.5 '), [10, 0, 0, 5]);
for (const text of ['gaming-pc.local', '256.1.1.1', '1.2.3', '1.2.3.4.5', '', undefined, '1.2.3.-4']) {
  assert.strictEqual(diagnostics.parseIpv4Octets(text), null, String(text) + ' is not an address of four numbers');
}
assert.strictEqual(diagnostics.stepCellValue(255, 1, 256), 0, 'a number comes around at the top');
assert.strictEqual(diagnostics.stepCellValue(0, -1, 256), 255, 'and at the bottom');
assert.strictEqual(diagnostics.stepCellValue(9, 1, 10), 0);
assert.strictEqual(diagnostics.stepCellValue(0, -1, 10), 9);
assert.strictEqual(diagnostics.portDigits(48150), '48150');
assert.strictEqual(diagnostics.portDigits(80), '00080', 'a short port is shown with five digits');
assert.strictEqual(diagnostics.stepPortDigit(48150, 0, 1), 58150, 'the first digit counts ten thousands');
assert.strictEqual(diagnostics.stepPortDigit(48150, 4, -1), 48159, 'a digit comes around without touching the next');
assert.strictEqual(diagnostics.stepPortDigit(48159, 4, 1), 48150);
assert.strictEqual(diagnostics.clampPort(0), 1);
assert.strictEqual(diagnostics.clampPort(99999), 65535);
assert.strictEqual(diagnostics.clampPort(48150), 48150);
{
  const manager = diagnostics.createManager(new diagnostics.MemoryStorage());
  assert.deepStrictEqual(manager.receiver, {octets: [192, 168, 0, 0], port: 48150}, 'the receiver starts where a host starts');
  manager.setDefaultHost('10.1.2.3');
  assert.deepStrictEqual(manager.receiver.octets, [10, 1, 2, 3], 'the streaming PC is offered as the host');
  manager.setDefaultHost('gaming-pc.local');
  assert.deepStrictEqual(manager.receiver.octets, [10, 1, 2, 3], 'a name that cells cannot show leaves the address as it was');
  manager.stepReceiverCell('diagnosticHost', 3, 1);
  manager.stepReceiverCell('diagnosticHost', 0, -1);
  assert.deepStrictEqual(manager.receiver.octets, [9, 1, 2, 4]);
  manager.stepReceiverCell('diagnosticHost', 9, 1);
  assert.deepStrictEqual(manager.receiver.octets, [9, 1, 2, 4], 'a cell that does not exist changes nothing');
  manager.stepReceiverCell('diagnosticPort', 0, 1);
  manager.stepReceiverCell('diagnosticPort', 0, 1);
  assert.strictEqual(manager.receiver.port, 68150, 'five digits can say more than a port');
  manager.finishReceiverEdit();
  assert.strictEqual(manager.receiver.port, 65535, 'and the port is brought into its range when the typing ends');
}
assert.strictEqual(html.includes('diagnosticFilter'), false, 'the filter of the log is gone');
assert(
  html.indexOf('id="diagnosticLogsEnabledSwitch"') < html.indexOf('id="diagnosticOptions"') &&
  html.indexOf('id="diagnosticOptions"') < html.indexOf('id="diagnosticHost"'),
  'the switch is on top and the rest is under it, in a container that the switch hides'
);
assert(
  html.indexOf('id="diagnosticHost"') < html.indexOf('id="diagnosticLogViewport"'),
  'export controls should be above the log viewport'
);
assert(
  html.indexOf('platform/diagnostic_logs.js') < html.indexOf('platform/index.js'),
  'diagnostic module must load before index.js'
);

console.log('diagnostic_logs_js_tests: PASS');
