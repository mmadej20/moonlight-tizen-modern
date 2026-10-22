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
            if (/-thumb\.jpg$/.test(path)) {
              if (!options.thumbnailBlob) throw new Error('no smaller copy');
              return { readBlob() { return options.thumbnailBlob; }, close() {} };
            }
            if (options.previewMissing && path.startsWith('documents/')) throw new Error('no preview');
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
  const drawn = [];
  if (options.shrink) {
    context.createImageBitmap = () => (options.shrinkError ? Promise.reject(options.shrinkError)
      : Promise.resolve({ width: options.sourceWidth || 600, height: options.sourceHeight || 900, close() { drawn.push('closed'); } }));
    context.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext() { return { fillRect() {}, drawImage() { drawn.push('drawn'); } }; },
        toDataURL(type, quality) { drawn.push([type, quality, this.width, this.height]); return 'data:image/jpeg;base64,AQID'; },
      }),
    };
  }
  vm.runInNewContext(fs.readFileSync('wasm/static/js/utils.js', 'utf8'), context);
  return { context, opened, deleted, writes, sent, drawn };
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

// The list shows a smaller copy of a box art: heavy pictures made moving through it heavy on the TV
async function testListGetsTheSmallerCopy() {
  // An original that is in the storage becomes a copy of 360 px, which is stored next to it
  const cached = createContext({ cachedBlob: new Blob([new Uint8Array([1, 2, 3])]), shrink: true });
  const host = new cached.context.NvHTTP('host', 'client');
  assert.strictEqual(await host.getBoxArt(7, false), 'data:image/jpeg;base64,AQID');
  assert.deepStrictEqual(cached.drawn.find(Array.isArray), ['image/jpeg', 0.85, 360, 540], 'the width is 360 and the height keeps the proportions');
  assert(cached.drawn.includes('closed'), 'the decoded picture is released');
  const stored = cached.writes.find((entry) => entry.path === 'wgt-private/host/boxart-7-thumb.jpg');
  assert(stored, 'the copy is stored next to the original');
  assert.deepStrictEqual(Array.from(stored.value), [1, 2, 3], 'as the bytes of the JPEG');

  // A picture that is smaller than that is not enlarged
  const small = createContext({ cachedBlob: new Blob([new Uint8Array([1])]), shrink: true, sourceWidth: 200, sourceHeight: 300 });
  await new small.context.NvHTTP('host', 'client').getBoxArt(7, false);
  assert.deepStrictEqual(small.drawn.find(Array.isArray).slice(2), [200, 300]);

  // Next time the copy is read and the original is left alone, so there is no test of the default art and no network
  const again = createContext({ thumbnailBlob: new Blob([new Uint8Array([9])]), dataUrl: 'data:image/jpeg;base64,CQ==' });
  const againHost = new again.context.NvHTTP('host', 'client');
  assert.strictEqual(await againHost.getBoxArt(7, false), 'data:image/jpeg;base64,CQ==');
  assert(!again.opened.some((entry) => entry.path.endsWith('boxart-7.png')), 'the original is not read');
  assert.strictEqual(again.sent.length, 0);

  // The Smart Hub preview is made from the original, so a missing preview sends the list back to the original
  const needsPreview = createContext({
    thumbnailBlob: new Blob([new Uint8Array([9])]), cachedBlob: new Blob([new Uint8Array([1, 2, 3])]), previewMissing: true, shrink: true,
  });
  const previewHost = new needsPreview.context.NvHTTP('host', 'client');
  previewHost.serverUid = 'server';
  await previewHost.getBoxArt(7, true);
  assert(needsPreview.opened.some((entry) => entry.path.endsWith('boxart-7.png') && entry.mode === 'r'), 'the original is read for the preview');

  // A picture that was just fetched is shown small, but its copy is not stored: it may be the default art of the host, which is fetched again later
  const fetched = createContext({ networkBytes: new Uint8Array([0x89, 0x50]), shrink: true });
  const fetchedHost = new fetched.context.NvHTTP('host', 'client');
  fetchedHost.serverUid = 'server';
  fetchedHost._baseUrlHttps = 'https://host:47984';
  assert.strictEqual(await fetchedHost.getBoxArt(8, false), 'data:image/jpeg;base64,AQID');
  assert.deepStrictEqual(fetched.writes.map((entry) => entry.path), ['wgt-private/host/boxart-8.png'], 'only the original is stored');

  // When the copy cannot be made, the list gets the original as before
  const broken = createContext({ cachedBlob: new Blob([new Uint8Array([1])]), shrink: true, shrinkError: new Error('cannot decode') });
  assert.match(await new broken.context.NvHTTP('host', 'client').getBoxArt(7, false), /^data:image\/png;base64,/);
  assert(!broken.writes.some((entry) => entry.path.endsWith('-thumb.jpg')));
}

async function testLoopbackAddressesAreNeverPolledAsRemoteHosts() {
  const harness = createContext({ networkBytes: new Uint8Array([1]) });
  const host = new harness.context.NvHTTP('127.0.0.1', 'client', 'localhost');
  host.hostname = 'gaming-pc';
  host.localAddress = '::1';
  host.externalIP = '192.168.1.25';
  const attempted = [];
  host.refreshServerInfoAtAddress = function(address) {
    attempted.push(address);
    return address === '192.168.1.25' ? Promise.resolve() : Promise.reject(new Error('offline'));
  };

  const selected = await new Promise((resolve, reject) => host.selectServerAddress(resolve, reject));
  assert.strictEqual(selected, '192.168.1.25');
  assert(!attempted.includes('127.0.0.1'));
  assert(!attempted.includes('::1'));
  assert(!attempted.includes('localhost'));
}

async function main() {
  await testHostScopedPreviewFiles();
  await testNetworkPngBytesAreWrittenDirectly();
  await testCachedBlobAndReadFailureSettlement();
  await testSunshineDefaultBoxArtIsRefetchedPerHost();
  await testListGetsTheSmallerCopy();
  await testLoopbackAddressesAreNeverPolledAsRemoteHosts();
  console.log('box_art_behavior_tests: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
