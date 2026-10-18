'use strict';

// At every start the application swept the whole /24 network: 254 probes, 8 at a time, up to 3 s each on a quiet
// address, which is a minute and a half of radio and main thread work with the polling of the known hosts paused. That
// is needed to find a host that is new or has a new address, and not when every known host answered a moment ago.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

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

const index = read('wasm/platform/index.js');
const context = {};
vm.runInNewContext(extractFunction(index, 'shouldRunStartupSubnetScan'), context);
const shouldScan = context.shouldRunStartupSubnetScan;

assert.strictEqual(shouldScan({}), true, 'with no known host the first one has to be found');
assert.strictEqual(shouldScan({ a: { online: false } }), true, 'a known host that does not answer may have a new address');
assert.strictEqual(shouldScan({ a: { online: true }, b: { online: false } }), true,
  'one host that does not answer is enough to look for it');
assert.strictEqual(shouldScan({ a: { online: true } }), false, 'every known host answered, nothing to look for');
assert.strictEqual(shouldScan({ a: { online: true }, b: { online: true } }), false);
assert.strictEqual(shouldScan({ a: null, b: { online: true } }), false, 'empty entries are ignored');
assert.strictEqual(shouldScan(null), true, 'a missing host list is treated as no known host');

// The start-up code asks, records why it did or did not scan, and never leaves the wait for the scan open.
const start = index.indexOf('startPollingHosts().then(() => {');
assert(start >= 0, 'the start-up polling code is present');
const startup = index.slice(start, start + 2600);
assert(/shouldRunStartupSubnetScan\(hosts\)/.test(startup), 'the start-up code applies the policy');
const skipAt = startup.indexOf('isSubnetScanFinished = true;');
assert(skipAt >= 0 && skipAt < startup.indexOf('startSubnetScanner().then'),
  'when the scan is skipped the flag that others wait for is set at once');
assert(/Subnet scan skipped/.test(startup), 'the skip is written to the diagnostic log');
assert(/Subnet scan started/.test(startup), 'the start of a scan is written to the diagnostic log');
assert(/Subnet scan finished in/.test(startup), 'the duration of a scan is written to the diagnostic log');
assert(startup.indexOf('startSubnetScanner().then') > startup.indexOf('stopPollingHosts();'),
  'polling still pauses while a scan runs');

console.log('subnet scan policy tests passed');
