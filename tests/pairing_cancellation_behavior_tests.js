'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function deferred() {
  const entry = {};
  entry.promise = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
  entry.promise.cancel = () => { entry.cancelled = true; };
  return entry;
}
function harness() {
  const requests = [];
  const context = {
    console: { log() {}, warn() {}, error() {} },
    cancelAsyncRequest: promise => {
      if (!promise) return false;
      promise.cancel();
      return true;
    },
    sendMessage: (type, args) => {
      const request = Object.assign(deferred(), { type, args });
      requests.push(request);
      return request.promise;
    },
  };
  vm.runInNewContext(fs.readFileSync('wasm/static/js/utils.js', 'utf8') + '\nthis.Host = NvHTTP;', context);
  const host = new context.Host('192.0.2.1', 'existing-client-id');
  host.address = '192.0.2.1';
  host.httpPort = 47989;
  host.serverMajorVersion = 7;
  host.refreshServerInfo = () => Promise.resolve(true);
  host._parseXML = value => ({ find: () => ({ html: () => value }) });
  return { host, requests };
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
async function main() {
  {
    const { host, requests } = harness();
    const refresh = deferred();
    host.refreshServerInfo = () => refresh.promise;
    const pending = host.pair('1234');
    const rejected = assert.rejects(pending);
    host.cancelPairingRequest();
    refresh.resolve(true);
    await flush();
    assert.strictEqual(requests.length, 0, 'cancellation during host refresh must prevent PIN request');
    await rejected;
  }
  {
    const { host, requests } = harness();
    const old = host.pair('1234');
    const oldRejected = assert.rejects(old);
    await flush();
    host.cancelPairingRequest();
    assert.strictEqual(requests[0].cancelled, true);
    const next = host.pair('5678');
    await flush();
    requests[0].resolve('stale-certificate');
    await oldRejected;
    assert.strictEqual(requests.length, 2, 'old response must not start another challenge');
    assert.strictEqual(host._pairingRequest, requests[1].promise, 'old cleanup must preserve new cancellation target');
    requests[1].resolve('current-certificate');
    await flush();
    assert.strictEqual(requests[2].args[3], 0, 'PIN challenge must have no transfer deadline');
    requests[2].resolve('1');
    assert.strictEqual(await next, true);
    assert.strictEqual(host.ppkstr, 'current-certificate');
    assert.strictEqual(host.paired, true);
    assert.strictEqual(host._pairingRequest, null);
  }
  {
    const { host, requests } = harness();
    const pending = host.pair('1234');
    const rejected = assert.rejects(pending);
    await flush();
    requests[0].resolve('certificate');
    await flush();
    host.cancelPairingRequest();
    requests[1].resolve('1');
    await rejected;
    assert.strictEqual(host.paired, false, 'cancelled challenge must not mark host paired');
    assert.notStrictEqual(host.ppkstr, 'certificate');
  }
  {
    const { host, requests } = harness();
    const pending = host.pair('0000');
    const rejected = assert.rejects(pending, /pair/i);
    await flush();
    requests[0].resolve('certificate');
    await flush();
    requests[1].resolve('0');
    await rejected;
    assert.strictEqual(host.paired, false, 'host refusal must not appear as success');
  }
  console.log('pairing_cancellation_behavior_tests: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
