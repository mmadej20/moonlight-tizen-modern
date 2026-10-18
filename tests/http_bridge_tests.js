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
  (mainSource.match(/if\s*\(!(?:m_Dispatcher\.post_job|PostHttpJob)\(/g) || []).length >= 2,
  'STUN and pairing requests must reject when dispatcher submissions close',
);
assert.match(mainSource, /Request dispatcher is unavailable\./);
assert.match(httpSource, /if\s*\(!PostHttpJob\(/);
assert.match(httpSource, /const bool posted = m_Dispatcher\.post_job\(/,
  'the shared helper must hand a closed dispatcher back to the caller, which rejects the promise');
assert.match(httpSource, /return posted;/);
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
  const nativeCalls = [];
  const nativeCancels = [];
  const messagesContext = {
    console: { log() {}, warn() {} },
    Module: {
      openUrl(...args) { nativeCalls.push(args); },
      cancelRequest(id) { nativeCancels.push(id); return { type: 'resolve', ret: true }; },
    },
  };
  const messagesSource = fs.readFileSync('wasm/platform/messages.js', 'utf8');
  assert.doesNotMatch(messagesSource, /_httpLock/, 'HTTP requests must not share an upstream global lock');
  vm.runInNewContext(messagesSource, messagesContext);
  const pinRequest = messagesContext.sendMessage('openUrl', ['https://host/pair', 'cert', false, 0]);
  const appsRequest = messagesContext.sendMessage('openUrl', ['https://host/applist', 'cert', false, 10000]);
  assert.deepStrictEqual(nativeCalls, [
    [1, 'https://host/pair', 'cert', false, 0],
    [2, 'https://host/applist', 'cert', false, 10000],
  ], 'ordinary requests dispatch while pairing is pending and keep the fifth timeout argument');
  await appsRequest.cancel();
  assert.deepStrictEqual(nativeCancels, [2], 'only the selected request is cancelled');
  messagesContext.handlePromiseMessage(2, 'reject', 'cancelled');
  await assert.rejects(appsRequest, (error) => error === 'cancelled');
  messagesContext.handlePromiseMessage(1, 'resolve', 'paired');
  assert.strictEqual(await pinRequest, 'paired', 'cancelling another request leaves pairing alive');
  assert.strictEqual(messagesContext.messageBridge.pendingCount(), 0);
  assert.strictEqual(messagesContext.handlePromiseMessage(2, 'resolve', 'late'), false);

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
