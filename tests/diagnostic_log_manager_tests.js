'use strict';

const assert = require('assert');
const diagnostics = require('../wasm/platform/diagnostic_logs.js');

const CURRENT = 'wgt-private/moonlight-diagnostics-current.log';
const PREVIOUS = 'wgt-private/moonlight-diagnostics-previous.log';

(async function() {
  const storage = new diagnostics.MemoryStorage();
  storage.degraded = false;
  await storage.write(CURRENT, 'old-session\n');

  const manager = diagnostics.createManager(storage);
  await manager.beginSession({
    host: '192.168.1.10',
    codec: 'HEVC',
    width: 3840,
    height: 2160,
    fps: 60,
    bitrateKbps: 36000,
    framePacing: true,
    audioBackend: 'WebAudio',
    audioConfig: 'Stereo',
    audioSync: false,
    audioJitterMs: 75,
    speculativeRfi: true,
    startedAt: '2026-07-21T20:00:00.000Z'
  });

  assert.strictEqual(await storage.read(PREVIOUS), 'old-session\n');
  const current = await storage.read(CURRENT);
  assert(current.includes('Codec: HEVC'));
  assert(current.includes('Video: 3840x2160 @ 60 FPS'));
  assert(current.includes('Bitrate: 36000 Kbps'));
  assert(current.includes('Audio backend: WebAudio'));
  assert(current.includes('Audio configuration: Stereo'));
  assert(current.includes('Audio synchronization: disabled'));
  assert(current.includes('Audio jitter buffer: 75 ms'));
  assert(current.includes('Experimental RFI recovery: enabled'));

  let appendCalls = 0;
  storage.append = function(path, text) {
    appendCalls += 1;
    this.files[path] = (this.files[path] || '') + text;
    return Promise.resolve();
  };
  manager.pending = 'Network dropped 1 frame\n';
  await manager.persistPending();
  assert.strictEqual(appendCalls, 1, 'regular log batches should be appended');
  assert((await storage.read(CURRENT)).includes('Network dropped 1 frame'));
  assert.strictEqual(manager.pending, '');

  // Events detected by JavaScript share the log, tagged with the wall clock because they have no stream clock
  await manager.appendLine('main thread stalled for 4200 ms', new Date('2026-10-18T10:00:00.000Z'));
  assert((await storage.read(CURRENT)).includes(
    '[js 2026-10-18T10:00:00.000Z] main thread stalled for 4200 ms\n'));
  await manager.appendLine('first line\n\n', new Date('2026-10-18T10:00:01.000Z'));
  const afterTrailingNewlines = await storage.read(CURRENT);
  assert(afterTrailingNewlines.endsWith('[js 2026-10-18T10:00:01.000Z] first line\n'));
  assert(!afterTrailingNewlines.endsWith('\n\n'), 'trailing newlines must not be doubled');
  await manager.appendLine('credentials rikey=TOPSECRET', new Date('2026-10-18T10:00:02.000Z'));
  const afterSecret = await storage.read(CURRENT);
  assert(!afterSecret.includes('TOPSECRET'), 'JavaScript lines are redacted like native lines');
  assert(afterSecret.includes('[REDACTED]'));

  manager.selectSession('previous');
  assert.strictEqual(manager.selectedPath(), PREVIOUS);
  manager.selectSession('current');
  assert.strictEqual(manager.selectedPath(), CURRENT);

  // A log that reaches its limit is cut down to three quarters of it, so that the next batches are only appended
  // (the file of 2 MB was rewritten on the main thread once a second, and that stalled the whole application)
  {
    const fullStorage = new diagnostics.MemoryStorage();
    fullStorage.degraded = false;
    const line = 'Input queue reached maximum size limit\n';
    await fullStorage.write(CURRENT, line.repeat(Math.floor(diagnostics.SESSION_LIMIT_BYTES / line.length)));
    let writes = 0;
    let appends = 0;
    const originalWrite = fullStorage.write.bind(fullStorage);
    fullStorage.write = function(path, text) { writes += 1; return originalWrite(path, text); };
    const originalAppend = fullStorage.append.bind(fullStorage);
    fullStorage.append = function(path, text) { appends += 1; return originalAppend(path, text); };

    const fullManager = diagnostics.createManager(fullStorage);
    fullManager.pending = 'x'.repeat(2000) + '\n';
    await fullManager.persistPending();
    assert.strictEqual(writes, 1, 'the full log is cut down once');
    assert(Buffer.byteLength(await fullStorage.read(CURRENT), 'utf8') <= diagnostics.COMPACT_TARGET_BYTES);
    assert(diagnostics.COMPACT_TARGET_BYTES < diagnostics.SESSION_LIMIT_BYTES);

    for (let i = 0; i < 20; i++) {
      fullManager.pending = 'next batch ' + i + '\n';
      await fullManager.persistPending();
    }
    assert.strictEqual(writes, 1, 'the next batches do not rewrite the file');
    assert.strictEqual(appends, 20, 'they are appended');
  }

  // Only the end of a long log is put on the page, from the start of a line
  {
    const short = diagnostics.tailOfLog('a\nb\n', 100);
    assert.deepStrictEqual(short, {text: 'a\nb\n', cut: false});
    const long = diagnostics.tailOfLog('first line\nsecond line\nthird line\n', 20);
    assert.strictEqual(long.cut, true);
    assert.strictEqual(long.text, 'third line\n');
    assert.strictEqual(diagnostics.tailOfLog('x'.repeat(50), 10).text, 'x'.repeat(10), 'one long line is cut as it is');
  }

  // The logs can be switched off: nothing is kept, the choice is remembered, and the default is on
  {
    const memory = {};
    global.localStorage = {
      getItem: (key) => (Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null),
      setItem: (key, value) => { memory[key] = String(value); }
    };
    const offStorage = new diagnostics.MemoryStorage();
    offStorage.degraded = false;
    const offManager = diagnostics.createManager(offStorage);
    assert.strictEqual(offManager.isEnabled(), true, 'on by default');

    await offManager.appendLine('kept while on', new Date('2026-10-21T10:00:00.000Z'));
    assert((await offStorage.read(CURRENT)).includes('kept while on'));

    await offManager.setEnabled(false);
    assert.strictEqual(memory[diagnostics.ENABLED_KEY], 'false', 'the choice is stored');
    assert.strictEqual(offManager.isEnabled(), false);
    const before = await offStorage.read(CURRENT);
    await offManager.appendLine('not kept', new Date('2026-10-21T10:00:01.000Z'));
    offManager.pending = 'pending text\n';
    await offManager.persistPending();
    await offManager.beginSession({host: '192.168.1.10', startedAt: '2026-10-21T10:00:02.000Z'});
    assert.strictEqual(await offStorage.read(CURRENT), before, 'nothing is written while the logs are off');
    assert.strictEqual(offManager.pending, '');

    const reopened = diagnostics.createManager(new diagnostics.MemoryStorage());
    assert.strictEqual(reopened.isEnabled(), false, 'the choice survives a restart');

    await offManager.setEnabled(true);
    assert.strictEqual(memory[diagnostics.ENABLED_KEY], 'true');
    await offManager.appendLine('kept again', new Date('2026-10-21T10:00:03.000Z'));
    assert((await offStorage.read(CURRENT)).includes('kept again'));

    // Clearing works whether or not the logs are on, and takes the previous session too
    await offStorage.write(PREVIOUS, 'old\n');
    await offManager.setEnabled(false);
    await offManager.clearAll();
    assert.strictEqual(await offStorage.read(CURRENT), '');
    assert.strictEqual(await offStorage.read(PREVIOUS), '');
    delete global.localStorage;

    // A storage that throws leaves the logs on
    global.localStorage = {getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }};
    assert.strictEqual(diagnostics.createManager(new diagnostics.MemoryStorage()).isEnabled(), true);
    await diagnostics.createManager(new diagnostics.MemoryStorage()).setEnabled(false);
    delete global.localStorage;
  }

  console.log('diagnostic_log_manager_tests: PASS');
}()).catch((error) => {
  console.error(error);
  process.exit(1);
});
