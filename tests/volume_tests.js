'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const volume = require('../wasm/platform/volume.js');
const lagWatch = require('../wasm/platform/lag_watch.js');

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const html = read('wasm/index.html');
const index = read('wasm/platform/index.js');
const remote = read('wasm/platform/remote_controller.js');
const navigation = read('wasm/platform/navigation.js');
const uiCss = read('wasm/static/css/ui.css');
const player = read('wasm/wasmplayer.cpp');
const header = read('wasm/moonlight_wasm.hpp');

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, 'missing function ' + name);
  let depth = 0;
  for (let at = source.indexOf('{', start); at < source.length; at++) {
    if (source[at] === '{') depth++;
    if (source[at] === '}' && --depth === 0) return source.slice(start, at + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

// The TV, as far as the volume goes
function createTv(options) {
  options = options || {};
  const state = { volume: 40, mute: false, registered: [], unregistered: [], listener: null, unset: 0 };
  const platform = {
    tvaudiocontrol: {
      getVolume: () => state.volume,
      isMute: () => state.mute,
      setVolumeUp() { state.volume = Math.min(100, state.volume + 1); },
      setVolumeDown() { state.volume = Math.max(0, state.volume - 1); },
      setMute(value) { state.mute = !!value; },
      setVolumeChangeListener(callback) { state.listener = callback; },
      unsetVolumeChangeListener() { state.unset += 1; }
    },
    tvinputdevice: {
      registerKey(key) { if (options.refuse === key) throw new Error('refused'); state.registered.push(key); },
      unregisterKey(key) { state.unregistered.push(key); }
    }
  };
  return { state, platform };
}

// With the keys taken from the system, the application changes the volume itself and reports each change
{
  const tv = createTv();
  const logs = [];
  const changes = [];
  const control = volume.createControl({ tizen: tv.platform, log: (text) => logs.push(text), onChange: (change) => changes.push(change) });
  assert.strictEqual(control.handlesKeys(), false, 'before a stream the keys are the system\'s');
  control.start(true);
  assert.deepStrictEqual(tv.state.registered, ['VolumeUp', 'VolumeDown', 'VolumeMute']);
  assert.strictEqual(control.handlesKeys(), true);

  control.up();
  control.up();
  control.down();
  assert.strictEqual(tv.state.volume, 41);
  assert.deepStrictEqual(changes.map((change) => change.volume), [41, 42, 41]);
  assert.deepStrictEqual(changes.map((change) => change.source), ['key up', 'key up', 'key down']);
  assert(logs.some((line) => /^Volume: 41 by key up$/.test(line)), 'every change is written to the diagnostic log');

  // The TV reports the change that the keys caused: the bar has shown it already
  const before = changes.length;
  tv.state.listener(41);
  assert.strictEqual(changes.length, before, 'a report of what is shown is not shown again');
  // A change that did not come from the keys is shown
  tv.state.volume = 60;
  tv.state.listener(60);
  assert.strictEqual(changes[changes.length - 1].volume, 60);
  assert.strictEqual(changes[changes.length - 1].source, 'tv');

  // Mute asks for the opposite of what it is, because the API sets the state that it is given
  control.toggleMute();
  assert.strictEqual(tv.state.mute, true);
  assert.strictEqual(changes[changes.length - 1].muted, true);
  control.toggleMute();
  assert.strictEqual(tv.state.mute, false);

  control.stop();
  assert.deepStrictEqual(tv.state.unregistered, ['VolumeUp', 'VolumeDown', 'VolumeMute'], 'the keys go back to the system');
  assert.strictEqual(tv.state.unset, 1, 'the listener is released');
  assert.strictEqual(control.handlesKeys(), false);
  control.stop();
  assert.strictEqual(tv.state.unset, 1, 'stopping twice does nothing');
}

// The stream menu changes the volume by steps of the TV: one report and one line of the log for all of them
{
  const tv = createTv();
  const logs = [];
  const changes = [];
  const control = volume.createControl({ tizen: tv.platform, log: (text) => logs.push(text), onChange: (change) => changes.push(change) });
  control.start(true);
  logs.length = 0;
  const state = control.adjust(5, 'menu');
  assert.strictEqual(tv.state.volume, 45);
  assert.deepStrictEqual(changes.map((change) => [change.volume, change.source]), [[45, 'menu']]);
  assert.strictEqual(state.volume, 45);
  assert.deepStrictEqual(logs, ['Volume: 45 by menu']);
  control.adjust(-3, 'menu');
  assert.strictEqual(tv.state.volume, 42);
  control.adjust(0, 'menu');
  assert.strictEqual(tv.state.volume, 42, 'no step changes nothing');
  control.adjust(-100, 'menu');
  assert.strictEqual(tv.state.volume, 0, 'the TV stops at its limits');
  control.stop();
  const bare = volume.createControl({ tizen: null, log() {}, onChange() { assert.fail('nothing to show'); } });
  assert.strictEqual(bare.adjust(5, 'menu'), null, 'a platform without the API changes nothing');
}

// With the bar off the keys stay with the system (so does its bar), and the changes are still written to the log
{
  const tv = createTv();
  const logs = [];
  const control = volume.createControl({ tizen: tv.platform, log: (text) => logs.push(text), onChange() {} });
  control.start(false);
  assert.deepStrictEqual(tv.state.registered, []);
  assert.strictEqual(control.handlesKeys(), false);
  tv.state.volume = 55;
  tv.state.listener(55);
  assert(logs.some((line) => /^Volume: 55 by tv$/.test(line)));
  control.stop();
}

// A key that the system keeps is not taken, and the rest of the application goes on
{
  const tv = createTv({ refuse: 'VolumeMute' });
  const logs = [];
  const control = volume.createControl({ tizen: tv.platform, log: (text) => logs.push(text), onChange() {} });
  control.start(true);
  assert.deepStrictEqual(tv.state.registered, ['VolumeUp', 'VolumeDown']);
  assert(logs.some((line) => /VolumeMute cannot be taken/.test(line)));
  control.stop();
  assert.deepStrictEqual(tv.state.unregistered, ['VolumeUp', 'VolumeDown'], 'only what was taken is given back');
}

// A platform without the API (a desktop browser) changes nothing and breaks nothing
{
  const control = volume.createControl({ tizen: null, log() {}, onChange() { assert.fail('nothing to show'); } });
  control.start(true);
  assert.strictEqual(control.up(), null);
  control.stop();
}

// The watch of the main thread: one line for a second in which timers were late, and none for the others
{
  let now = 0;
  const logs = [];
  const timers = [];
  const watch = lagWatch.create({
    now: () => now,
    setInterval: (callback) => { timers.push(callback); return timers.length; },
    clearInterval() { timers.length = 0; },
    log: (text) => logs.push(text)
  });
  watch.start();
  const tick = (advance) => { now += advance; timers[0](); };
  for (let i = 0; i < 25; i++) tick(50);
  assert.deepStrictEqual(logs, [], 'timers on time: nothing is written');
  tick(50 + 120);
  for (let i = 0; i < 20; i++) tick(50);
  assert.strictEqual(logs.length, 1);
  assert(/^Main thread: 1 late timers in \d+ ms, the worst by 120 ms$/.test(logs[0]), logs[0]);
  for (let i = 0; i < 25; i++) tick(50);
  assert.strictEqual(logs.length, 1, 'the next seconds are quiet again');
  watch.stop();
  assert.strictEqual(timers.length, 0);
}

// The page: the scripts come before the application, and the setting is a row of the audio settings after the other ones
assert(html.indexOf('platform/volume.js') > html.indexOf('platform/diagnostic_logs.js') && html.indexOf('platform/lag_watch.js') < html.indexOf('platform/index.js'));
assert(html.indexOf('platform/volume.js') < html.indexOf('platform/index.js'));
assert(/<input type="checkbox" id="volumeBarSwitch" class="mdl-switch__input" checked>/.test(html), 'on by default');
const audioSettings = html.slice(html.indexOf('id="audioSettings"'), html.indexOf('id="videoSettings"'));
assert(audioSettings.includes('id="volumeBarOption"') && audioSettings.indexOf('id="volumeBarOption"') > audioSettings.indexOf('id="decryptHostAudioOption"'));
assert(/'decryptHostAudioBtn'\s*:\s*null|isAudioOutputDisabled\(\) \? null : 'decryptHostAudioBtn',\s*'volumeBarBtn'/.test(navigation), 'the switch is on the list of the navigation');
for (const id of ['volume-bar', 'volume-bar-fill', 'volume-bar-value', 'volume-bar-icon']) assert(html.includes('id="' + id + '"'), id);

// The remote: the keys go through the control, which asks the TV for the opposite of the mute state
assert(/KEY_VOLUME_UP:[^]*?VolumeControl\.up\(\);/.test(remote));
assert(/KEY_VOLUME_DOWN:[^]*?VolumeControl\.down\(\);/.test(remote));
assert(/KEY_VOLUME_MUTE:[^]*?VolumeControl\.toggleMute\(\);/.test(remote));
assert(!/tizen\.tvaudiocontrol/.test(remote), 'the remote does not call the API itself any more');

// The application: the stream starts and stops the control and the watch, and the bar is shown by the control
const showApps = extractFunction(index, 'showAppsMode');
assert(/VolumeControl\.stop\(\);\s*LagWatch\.stop\(\);\s*hideVolumeBar\(\);/.test(showApps), 'leaving the stream gives the keys back');
assert(/isInGame = true;[\s\S]{0,400}?VolumeControl\.start\(isVolumeBarEnabled\(\)\);\s*LagWatch\.start\(\);/.test(index), 'the stream takes the keys, if the bar is on');
const messages = read('wasm/platform/messages.js');
assert(/stopAudioScheduler\(\);\s*\/\/[^\n]*\n\s*VolumeControl\.stop\(\);\s*LagWatch\.stop\(\);\s*hideVolumeBar\(\);/.test(messages), 'the end of the stream gives the keys back at once');
assert(/\$\('#volumeBarSwitch'\)\.on\('click', saveVolumeBar\)/.test(index));
assert(/storeData\('volumeBar', chosenVolumeBar, null\)/.test(index));
assert(/getData\('volumeBar'[\s\S]*?previousValue\.volumeBar == null \|\| previousValue\.volumeBar == true[\s\S]*?MaterialSwitch\.on\(\)/.test(index), 'on by default');
assert(/const defaultVolumeBar = true;/.test(index), 'restoring the defaults turns it on');
{
  const bar = { classes: new Set(), classList: { add(name) { bar.classes.add(name); }, remove(name) { bar.classes.delete(name); }, toggle(name, on) { if (on) bar.classes.add(name); else bar.classes.delete(name); } } };
  const fill = { style: {} };
  const value = { textContent: '' };
  const timers = [];
  const menu = { open: false, refreshes: 0 };
  const context = {
    isInGame: true,
    VolumeControl: { handlesKeys: () => true },
    StreamMenu: { isOpen: () => menu.open, refresh: () => { menu.refreshes += 1; } },
    document: { getElementById: (id) => ({ 'volume-bar': bar, 'volume-bar-fill': fill, 'volume-bar-value': value }[id] || null) },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
    Math, Number, String
  };
  vm.createContext(context);
  vm.runInContext('var volumeBarTimer = null;\n' + extractFunction(index, 'showVolumeBar') + extractFunction(index, 'hideVolumeBar'), context);
  context.showVolumeBar({ volume: 30, muted: false });
  assert(bar.classes.has('is-visible'));
  assert.strictEqual(fill.style.transform, 'scaleX(0.3)');
  assert.strictEqual(value.textContent, '30');
  assert.strictEqual(timers[0].delay, 1800, 'it stays for a moment');
  timers[0].callback();
  assert(!bar.classes.has('is-visible'));
  context.showVolumeBar({ volume: 30, muted: true });
  assert(bar.classes.has('is-muted'));
  assert.strictEqual(fill.style.transform, 'scaleX(0)', 'muted, the bar is empty');
  context.VolumeControl.handlesKeys = () => false;
  bar.classes.clear();
  context.showVolumeBar({ volume: 70, muted: false });
  assert(!bar.classes.has('is-visible'), 'with the keys left to the system there is no bar of ours');
  context.VolumeControl.handlesKeys = () => true;
  context.isInGame = false;
  context.showVolumeBar({ volume: 70, muted: false });
  assert(!bar.classes.has('is-visible'), 'and none outside of a stream');
  // The stream menu has a volume row of its own: the bar stays away, and the row is told that the volume changed
  context.isInGame = true;
  menu.open = true;
  context.showVolumeBar({ volume: 70, muted: false });
  assert(!bar.classes.has('is-visible'), 'no bar over the stream menu');
  assert.strictEqual(menu.refreshes, 1, 'the row of the menu follows the keys');
}

// The bar moves only opacity and the scale of its fill
assert(/\.ui-volume \{[^}]*position: fixed;[^}]*opacity: 0;[^}]*visibility: hidden;[^}]*transition: opacity 0\.2s var\(--ui-ease\), visibility 0s linear 0\.2s;/.test(uiCss));
assert(/\.ui-volume\.is-visible \{[^}]*opacity: 1;/.test(uiCss));
assert(/\.ui-volume__fill \{[^}]*transform: scaleX\(0\);[^}]*transform-origin: left;/.test(uiCss));

// The video of the stream has a line in the diagnostic log every second, with the worst of the window
assert(/uint64_t maxPacerTimeUs;\s*uint64_t maxSubmitTimeUs;\s*uint32_t maxFrameGapMs;/.test(header));
assert(/"VideoPipelineStats windowMs=%llu received=%u submitted=%u networkDropped=%u "/.test(player));
assert(/"avgQueueUs=%llu avgAssemblyUs=%llu avgPacerUs=%llu maxPacerUs=%llu avgSubmitUs=%llu maxSubmitUs=%llu "/.test(player));
assert(/"maxFrameGapMs=%u playoutBufferMs=%\.1f bitrateMbps=%\.1f\\n"/.test(player));
assert(/ClLogMessage\("%s", windowLine\);/.test(player), 'written whether or not the overlay of the statistics is on');
assert(/m_ActiveWndVideoStats\.maxFrameGapMs = MAX\(/.test(player) && /s_LastFrameCallbackMs = 0;/.test(player), 'the gap is measured from the last frame, and starts again with the stream');
assert(/dst\.maxPacerTimeUs = MAX\(dst\.maxPacerTimeUs, src\.maxPacerTimeUs\);/.test(player));
// The line is formatted under the lock of the statistics and written after it is released
assert(player.indexOf('snprintf(\n        windowLine') < player.indexOf('statsLock.unlock();\n  if (windowLine[0] != 0)'));

for (const locale of ['en-US', 'pt-BR', 'pl-PL']) {
  const strings = JSON.parse(read('wasm/static/locales/' + locale + '.json'));
  for (const key of ['Volume bar in the stream', 'Show the volume bar of Moonlight while streaming',
    '- The volume keys of the remote change the volume of the TV with a bar of Moonlight, instead of the bar of the TV that is drawn over the stream.']) {
    assert(key in strings, locale + ' has "' + key.slice(0, 40) + '"');
  }
}

console.log('volume_tests: PASS');
