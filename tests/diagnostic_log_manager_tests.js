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

  console.log('diagnostic_log_manager_tests: PASS');
}()).catch((error) => {
  console.error(error);
  process.exit(1);
});
