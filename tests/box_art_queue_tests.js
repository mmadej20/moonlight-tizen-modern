'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// Box art shares one HTTP thread with every other request. These tests pin the rules that keep a cold
// cache (one download per app) from delaying the request that starts a stream.

function createHarness(options) {
  const settings = options || {};
  const sent = [];
  const cancelled = [];

  function TestFileReader() {}
  TestFileReader.prototype.readAsDataURL = function() {
    this.result = 'data:image/png;base64,iVBORw0KGgo=';
    if (this.onload) this.onload();
  };

  const context = {
    console: { log() {}, warn() {}, error() {} },
    navigator: { getGamepads: () => [] },
    window: { previewPromises: [] },
    tizen: {
      filesystem: {
        createDirectory() {},
        openFile(path, mode) {
          if (mode === 'r' && settings.cached) {
            return { readBlob() { return new Blob([new Uint8Array([1, 2, 3])]); }, close() {} };
          }
          if (mode === 'r') throw new Error('cache miss');
          return { writeData() {}, close() {} };
        },
        listDirectory(path, onSuccess) { onSuccess([]); },
        deleteDirectory() {},
        deleteFile() {},
      },
    },
    sendMessage(method, params) {
      const request = {};
      request.promise = new Promise((resolve, reject) => { request.resolve = resolve; request.reject = reject; });
      request.url = params[0];
      sent.push(request);
      return request.promise;
    },
    cancelAsyncRequest(promise) {
      cancelled.push(promise);
      const request = sent.find((entry) => entry.promise === promise);
      request.reject(new Error('cancelled'));
      return true;
    },
    Blob,
    FileReader: TestFileReader,
    Uint8Array, Int32Array, Uint32Array, Set, Promise, Math,
    atob(value) { return Buffer.from(value, 'base64').toString('binary'); },
    btoa(value) { return Buffer.from(value, 'binary').toString('base64'); },
  };
  context.window.atob = context.atob;
  context.window.btoa = context.btoa;
  vm.runInNewContext(fs.readFileSync('wasm/static/js/utils.js', 'utf8'), context);

  const host = new context.NvHTTP('host-a', 'client');
  host.serverUid = 'server-a';
  host._baseUrlHttps = 'https://192.0.2.1:47984';
  return { context, host, sent, cancelled };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function testAtMostTwoDownloadsRunAtOnceInOrder() {
  const { host, sent } = createHarness();
  const results = [1, 2, 3, 4, 5, 6].map((id) => host.getBoxArt(id, false));
  await flush();
  assert.strictEqual(sent.length, 2, 'only two downloads start while the others wait');
  assert(sent[0].url.includes('appid=1') && sent[1].url.includes('appid=2'));

  sent[0].resolve(new Uint8Array([1]));
  await flush();
  assert.strictEqual(sent.length, 3, 'a finished download frees a slot for the next app');
  assert(sent[2].url.includes('appid=3'), 'downloads start in the order the apps were requested');

  for (let i = 1; i < 6; i += 1) {
    await flush();
    sent[i].resolve(new Uint8Array([i]));
  }
  const settled = await Promise.all(results);
  assert.strictEqual(settled.length, 6);
  assert.strictEqual(sent.length, 6);
}

async function testFailedDownloadFreesItsSlot() {
  const { host, sent } = createHarness();
  const first = host.getBoxArt(1, false).catch((error) => error);
  const second = host.getBoxArt(2, false);
  const third = host.getBoxArt(3, false);
  await flush();
  assert.strictEqual(sent.length, 2);

  sent[0].reject(new Error('timeout'));
  await flush();
  assert.strictEqual(sent.length, 3, 'a failed download must not hold its slot');
  assert.strictEqual((await first).message, 'timeout');
  sent[1].resolve(new Uint8Array([2]));
  sent[2].resolve(new Uint8Array([3]));
  await Promise.all([second, third]);
}

async function testQueuedDownloadsOfAnOutdatedListNeverReachTheNetwork() {
  const { host, sent } = createHarness();
  let outdated = false;
  const isStale = () => outdated;
  const results = [1, 2, 3, 4].map((id) => host.getBoxArt(id, false, isStale).catch((error) => error));
  await flush();
  assert.strictEqual(sent.length, 2);

  outdated = true; // the user left the list
  sent[0].resolve(new Uint8Array([1]));
  sent[1].resolve(new Uint8Array([2]));
  const settled = await Promise.all(results);
  assert.strictEqual(sent.length, 2, 'queued downloads of an outdated list are dropped without a request');
  assert.strictEqual(typeof settled[0], 'string', 'downloads that were already running still finish');
  assert.strictEqual(settled[2].code, 'STALE_OPERATION');
  assert.strictEqual(settled[3].code, 'STALE_OPERATION');
}

async function testStartingAStreamCancelsRunningAndQueuedDownloads() {
  const { context, host, sent, cancelled } = createHarness();
  const results = [1, 2, 3, 4, 5].map((id) => host.getBoxArt(id, false).catch((error) => error));
  await flush();
  assert.strictEqual(sent.length, 2);

  context.cancelBoxArtDownloads();
  const settled = await Promise.all(results);
  assert.strictEqual(cancelled.length, 2, 'both running downloads are cancelled natively');
  assert.strictEqual(sent.length, 2, 'nothing new is requested after the cancel');
  assert.strictEqual(settled[0].message, 'cancelled');
  assert.strictEqual(settled[4].code, 'STALE_OPERATION');

  // The limiter is reusable afterwards: the next list downloads normally.
  const again = host.getBoxArt(9, false);
  await flush();
  assert.strictEqual(sent.length, 3);
  sent[2].resolve(new Uint8Array([9]));
  await again;
}

// Telemetry: how long the app list takes to get its pictures, and where the time goes. The summary is written to the
// diagnostic log after every list, so a slow list can be told apart from a slow host or a full queue.
async function testBoxArtStatsCountSourcesAndTimes() {
  const { context, host, sent } = createHarness();
  let now = 1000;
  context.boxArtNow = () => now;
  context.resetBoxArtStats();

  const results = [1, 2, 3].map((id) => host.getBoxArt(id, false).catch((error) => error));
  await flush();
  assert.strictEqual(sent.length, 2, 'two downloads start at once');

  now = 1500;
  sent[0].resolve(new Uint8Array([1])); // took 500 ms
  await flush();
  assert.strictEqual(sent.length, 3, 'the third download waited 500 ms for a slot and starts now');

  now = 2500;
  sent[1].resolve(new Uint8Array([2])); // took 1500 ms
  await flush();

  now = 2700;
  sent[2].reject(new Error('boom')); // failed after 1200 ms
  await Promise.all(results);

  now = 3000;
  assert.strictEqual(context.describeBoxArtStats(),
    'Box art: 3 requested in 2000 ms: cached=0 downloaded=2 failed=1 dropped=0; ' +
    'downloads avg 1000 ms max 1500 ms, waited for a slot avg 167 ms max 500 ms');

  context.resetBoxArtStats();
  assert.match(context.describeBoxArtStats(), /^Box art: 0 requested in 0 ms: cached=0 downloaded=0 failed=0 dropped=0; downloads avg 0 ms max 0 ms/,
    'a new list starts from zero');
}

async function testBoxArtStatsCountCachedPictures() {
  const { context, host, sent } = createHarness({ cached: true });
  context.boxArtNow = () => 5000;
  context.resetBoxArtStats();
  const art = await host.getBoxArt(7, false);
  assert.match(art, /^data:image\/png;base64,/);
  assert.strictEqual(sent.length, 0, 'a cached picture needs no download');
  assert.match(context.describeBoxArtStats(), /1 requested in 0 ms: cached=1 downloaded=0 failed=0 dropped=0/);
}

async function testBoxArtStatsCountDroppedPicturesApart() {
  const { context, host, sent } = createHarness();
  context.boxArtNow = () => 100;
  context.resetBoxArtStats();
  let outdated = false;
  const results = [1, 2, 3, 4].map((id) => host.getBoxArt(id, false, () => outdated).catch((error) => error));
  await flush();
  outdated = true;
  sent[0].resolve(new Uint8Array([1]));
  sent[1].resolve(new Uint8Array([2]));
  await Promise.all(results);
  assert.match(context.describeBoxArtStats(), /4 requested.*cached=0 downloaded=2 failed=0 dropped=2/,
    'pictures of a list that the user left are dropped, not failed');
}

async function main() {
  await testBoxArtStatsCountSourcesAndTimes();
  await testBoxArtStatsCountCachedPictures();
  await testBoxArtStatsCountDroppedPicturesApart();
  await testAtMostTwoDownloadsRunAtOnceInOrder();
  await testFailedDownloadFreesItsSlot();
  await testQueuedDownloadsOfAnOutdatedListNeverReachTheNetwork();
  await testStartingAStreamCancelsRunningAndQueuedDownloads();
  console.log('box_art_queue_tests: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
