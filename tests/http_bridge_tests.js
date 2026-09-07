const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const {
  cancelAsyncRequest,
  createMessageBridge,
} = require('../wasm/platform/messages.js');

const indexSource = fs.readFileSync('wasm/platform/index.js', 'utf8');
const mainSource = fs.readFileSync('wasm/main.cpp', 'utf8');
const httpSource = fs.readFileSync('wasm/http.cpp', 'utf8');
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
assert.ok(
  (mainSource.match(/if\s*\(!m_Dispatcher\.post_job\(/g) || []).length >= 2,
  'STUN and pairing requests must reject when dispatcher submissions close',
);
assert.match(mainSource, /Request dispatcher is unavailable\./);
assert.match(httpSource, /if\s*\(!m_Dispatcher\.post_job\(/);
assert.match(httpSource, /m_HttpRequests\.Remove\(callbackId\);/);

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

  const openUrlCalls = [];
  const boxArtError = new Error('box art request failed');
  const utilsContext = {
    console: { log() {}, warn() {}, error() {} },
    navigator: { getGamepads: () => [] },
    window: { btoa: () => '', atob: () => '' },
    tizen: {
      filesystem: {
        openFile() { throw new Error('cache miss'); },
      },
    },
    sendMessage(method, params) {
      openUrlCalls.push({ method, params });
      return Promise.reject(boxArtError);
    },
    Blob,
    FileReader: function() {},
    Uint8Array,
    Int32Array,
    Uint32Array,
    Set,
    Promise,
    Math,
  };
  vm.runInNewContext(fs.readFileSync('wasm/static/js/utils.js', 'utf8'), utilsContext);
  const boxArtHost = new utilsContext.NvHTTP('host', 'client');
  boxArtHost._baseUrlHttps = 'https://host:47984';

  const boxArtOutcome = await Promise.race([
    boxArtHost.getBoxArt(42, false).then(
      () => ({ status: 'resolved' }),
      (error) => ({ status: 'rejected', error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout' }), 100)),
  ]);
  assert.strictEqual(boxArtOutcome.status, 'rejected', 'a failed box-art fetch settles by rejection');
  assert.strictEqual(boxArtOutcome.error, boxArtError);
  assert.strictEqual(openUrlCalls[0].method, 'openUrl');
  assert.match(openUrlCalls[0].params[0], /\/appasset\?.*appid=42/);
  assert.strictEqual(openUrlCalls[0].params[1], null);
  assert.strictEqual(openUrlCalls[0].params[2], true);
  assert.strictEqual(openUrlCalls[0].params[3], 10000,
    'box-art retrieval supplies an explicit HTTP timeout');

  console.log('http_bridge_tests: PASS');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
