const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function createContext(options) {
  const opened = [];
  const deleted = [];
  const writes = [];
  const sent = [];
  const listedFiles = options.listedFiles || [];

  function TestFileReader() {}
  TestFileReader.prototype.readAsDataURL = function(blob) {
    if (options.fileReaderError) {
      this.error = new Error('reader failed');
      if (this.onerror) this.onerror();
      return;
    }
    this.result = options.dataUrl || 'data:image/png;base64,iVBORw0KGgo=';
    if (this.onload) this.onload();
    else if (this.onloadend) this.onloadend();
  };
  TestFileReader.prototype.readAsArrayBuffer = function(blob) {
    this.result = options.arrayBuffer || new ArrayBuffer(0);
    if (this.onload) this.onload();
    else if (this.onloadend) this.onloadend();
  };

  const context = {
    console: { log() {}, warn() {}, error() {} },
    navigator: { getGamepads: () => [] },
    window: { previewPromises: [] },
    tizen: {
      filesystem: {
        createDirectory() {},
        openFile(path, mode) {
          opened.push({ path, mode });
          if (mode === 'r') {
            if (!options.cachedBlob) throw new Error('cache miss');
            return {
              readBlob() { return options.cachedBlob; },
              close() {},
            };
          }
          return {
            writeData(value) { writes.push({ path, value }); },
            close() {},
          };
        },
        listDirectory(path, onSuccess) { onSuccess(listedFiles.slice()); },
        deleteDirectory() {},
        deleteFile(path) { deleted.push(path); },
      },
    },
    sendMessage(method, params) {
      sent.push({ method, params });
      return options.networkError
        ? Promise.reject(options.networkError)
        : Promise.resolve(options.networkBytes);
    },
    Blob,
    FileReader: TestFileReader,
    Uint8Array,
    Int32Array,
    Uint32Array,
    Set,
    Promise,
    Math,
    atob(value) { return Buffer.from(value, 'base64').toString('binary'); },
    btoa(value) { return Buffer.from(value, 'binary').toString('base64'); },
  };
  context.window.atob = context.atob;
  context.window.btoa = context.btoa;
  if (options.crypto) context.window.crypto = options.crypto;
  vm.runInNewContext(fs.readFileSync('wasm/static/js/utils.js', 'utf8'), context);
  return { context, opened, deleted, writes, sent };
}

async function testHostScopedPreviewFiles() {
  const harness = createContext({ networkBytes: new Uint8Array([1]) });
  const first = new harness.context.NvHTTP('host-a', 'client');
  first.serverUid = 'server/A:1';
  const second = new harness.context.NvHTTP('host-b', 'client');
  second.serverUid = 'server-B';

  assert.strictEqual(first.getPreviewImageFileName(42), 'preview-server_A_1-42.jpg');
  assert.strictEqual(second.getPreviewImageFileName(42), 'preview-server-B-42.jpg');
  assert.notStrictEqual(first.getPreviewImageFileName(42), second.getPreviewImageFileName(42));

  first.savePreviewImage(42, 'data:image/jpeg;base64,AQI=');
  second.savePreviewImage(42, 'data:image/jpeg;base64,AwQ=');
  assert.deepStrictEqual(harness.writes.map((entry) => entry.path), [
    'documents/preview-server_A_1-42.jpg',
    'documents/preview-server-B-42.jpg',
  ]);

  harness.context.tizen.filesystem.listDirectory = function(path, onSuccess) {
    onSuccess([
      'preview-server_A_1-42.jpg',
      'preview-server-B-42.jpg',
      'preview-42.jpg',
    ]);
  };
  await first.clearBoxArt();
  assert.deepStrictEqual(harness.deleted, ['documents/preview-server_A_1-42.jpg'],
    'clearing one host leaves other hosts and legacy unowned files untouched');
}

async function testNetworkPngBytesAreWrittenDirectly() {
  const networkBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff]);
  const harness = createContext({ networkBytes });
  const host = new harness.context.NvHTTP('host', 'client');
  host.serverUid = 'server';
  host._baseUrlHttps = 'https://host:47984';

  const dataUrl = await host.getBoxArt(42, false);
  assert.match(dataUrl, /^data:image\/png;base64,/);
  assert.strictEqual(harness.writes.length, 1);
  assert.strictEqual(harness.writes[0].value, networkBytes,
    'the exact network byte buffer is persisted without a base64 round trip');
  assert.strictEqual(harness.sent[0].params[3], 10000);
}

async function testCachedBlobAndReadFailureSettlement() {
  const cached = createContext({ cachedBlob: new Blob([new Uint8Array([1, 2, 3])]) });
  const cachedHost = new cached.context.NvHTTP('cached-host', 'client');
  assert.match(await cachedHost.getBoxArt(7, false), /^data:image\/png;base64,/);
  assert.strictEqual(cached.sent.length, 0, 'a valid readBlob cache avoids the network');
  assert(cached.opened.some((entry) => entry.mode === 'r'));

  const readFailure = createContext({
    cachedBlob: new Blob([new Uint8Array([1])]),
    fileReaderError: true,
    networkError: new Error('network unavailable'),
  });
  const failedHost = new readFailure.context.NvHTTP('failed-host', 'client');
  await assert.rejects(failedHost.getBoxArt(9, false), /network unavailable|reader failed/);
}

async function testSunshineDefaultBoxArtIsRefetchedPerHost() {
  const defaultHash = 'd9164ebd069b5f735eb8efc557801778498da37f572ef70e3d35604739e6c613';
  const digest = Uint8Array.from(defaultHash.match(/../g).map((value) => parseInt(value, 16))).buffer;
  const harness = createContext({
    cachedBlob: new Blob([new Uint8Array([1, 2, 3])]),
    networkBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
    crypto: { subtle: { digest: () => Promise.resolve(digest) } },
  });
  const host = new harness.context.NvHTTP('host', 'client');
  host.serverUid = 'server';
  host._baseUrlHttps = 'https://host:47984';

  await host.getBoxArt(42, true);
  await Promise.resolve();
  await Promise.resolve();

  assert.strictEqual(harness.sent.length, 1,
    'Sunshine default artwork is fetched again instead of remaining cached forever');
  assert(harness.deleted.includes('wgt-private/host/boxart-42.png'));
  assert(harness.deleted.includes('documents/preview-server-42.jpg'),
    'only this host\'s generated preview is invalidated');
}

async function main() {
  await testHostScopedPreviewFiles();
  await testNetworkPngBytesAreWrittenDirectly();
  await testCachedBlobAndReadFailureSettlement();
  await testSunshineDefaultBoxArtIsRefetchedPerHost();
  console.log('box_art_behavior_tests: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
