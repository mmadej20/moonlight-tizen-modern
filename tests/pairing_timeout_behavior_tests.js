'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('wasm/static/js/utils.js', 'utf8');
const requests = [];
const context = {
  console: {
    log: function() {},
    warn: function() {},
    error: function() {},
  },
  Promise,
  Set,
  Uint8Array,
  Uint32Array,
  Int32Array,
  ArrayBuffer,
  Math,
  cancelAsyncRequest: function() { return false; },
  sendMessage: function(type, args) {
    requests.push({ type, args });
    if (type === 'pair') return Promise.resolve('test-certificate');
    if (type === 'openUrl') return Promise.resolve('paired');
    return Promise.reject(new Error('Unexpected request type: ' + type));
  },
};

vm.runInNewContext(source + '\nthis.NvHTTPExport = NvHTTP;', context);

async function main() {
  const host = new context.NvHTTPExport('192.0.2.1', 'client-id');
  host.address = '192.0.2.1';
  host.httpPort = 47989;
  host.serverMajorVersion = 7;
  host._baseUrlHttps = 'https://192.0.2.1:47984';
  host.refreshServerInfo = function() {
    return Promise.resolve(true);
  };
  host._parseXML = function() {
    return {
      find: function() {
        return {
          html: function() {
            return '1';
          },
        };
      },
    };
  };

  const paired = await host.pair('1234');
  assert.strictEqual(paired, true);

  const challenge = requests.find(function(request) {
    return request.type === 'openUrl' &&
      request.args[0].indexOf('phrase=pairchallenge') !== -1;
  });
  assert(challenge, 'pairing challenge request was not sent');
  assert.strictEqual(
    challenge.args[3],
    0,
    'pairing challenge must wait for user input without a transfer deadline',
  );

  console.log('pairing_timeout_behavior_tests: PASS');
}

main().catch(function(error) {
  console.error(error);
  process.exitCode = 1;
});
