const assert = require('assert');
const fs = require('fs');

const {
  cancelAsyncRequest,
  createMessageBridge,
} = require('../wasm/platform/messages.js');

const indexSource = fs.readFileSync('wasm/platform/index.js', 'utf8');
const mainSource = fs.readFileSync('wasm/main.cpp', 'utf8');
const indexLogCalls =
  indexSource.match(/console\.(?:log|warn|error)\([\s\S]*?\);/g) || [];
const nativeLogCalls =
  mainSource.match(/(?:PostToJs|ClLogMessage)\([\s\S]*?\);/g) || [];
const secretLogViolations = [];

if (indexLogCalls.some((call) => /\brandomNumber\b/.test(call))) {
  secretLogViolations.push('pairing PIN');
}
if (nativeLogCalls.some((call) => /\brikey(?:id)?\b/.test(call))) {
  secretLogViolations.push('remote input key');
}

assert.deepStrictEqual(secretLogViolations, []);

const cancelledIds = [];
const bridge = createMessageBridge(
  {
    cancelRequest: (requestId) => {
      cancelledIds.push(requestId);
      return {type: 'resolve', ret: true};
    },
  },
  {
    openUrl: () => {},
  },
  {
    warn: () => {},
  },
);

async function run() {
  const request = bridge.sendMessage(
    'openUrl',
    ['http://host', null, false, 5000],
  );
  assert.strictEqual(request.requestId, 1);
  request.cancel();
  assert.deepStrictEqual(cancelledIds, [1]);
  bridge.resolve(1, 'ok');
  assert.strictEqual(await request, 'ok');
  assert.strictEqual(bridge.pendingCount(), 0);
  assert.doesNotThrow(() => bridge.resolve(1, 'late'));

  const second = bridge.sendMessage(
    'openUrl',
    ['http://host/apps', null, false, 10000],
  );
  assert.strictEqual(cancelAsyncRequest(second), true);
  assert.strictEqual(cancelAsyncRequest(second), false);
  assert.deepStrictEqual(cancelledIds, [1, 2]);
  bridge.reject(2, 'cancelled');
  await assert.rejects(second, (error) => error === 'cancelled');
  assert.strictEqual(bridge.pendingCount(), 0);

  console.log('http_bridge_tests: PASS');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
