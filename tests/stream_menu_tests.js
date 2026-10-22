'use strict';

const assert = require('assert');

const support = require('../wasm/platform/stream_menu.js');
const volume = require('../wasm/platform/volume.js');

// The menu with recording fakes: every call of the platform goes into one list, so the order can be asserted
function createFixture(options) {
  options = options || {};
  const calls = [];
  const state = { stats: !!options.stats, mouseSetting: options.mouseSetting !== false, mouseActive: false, volume: 40, muted: false };
  const modulePrototype = {
    setInputCaptured(captured) { calls.push('captured ' + captured); },
    toggleStats() { calls.push('toggleStats'); },
    toggleMouseEmulation() { calls.push('toggleMouseEmulation'); state.mouseActive = !state.mouseActive; },
    isMouseEmulationActive() { return state.mouseActive; },
    stopStream() { calls.push('stopStream'); }
  };
  const renders = [];
  const env = {
    module: () => (options.noModule ? null : modulePrototype),
    volume: {
      adjust(steps, source) { calls.push('volume ' + steps + ' ' + source); state.volume += steps; return { volume: state.volume, muted: state.muted }; },
      read() { return { volume: state.volume, muted: state.muted }; }
    },
    enter() { calls.push('enter'); },
    leave() { calls.push('leave'); },
    render(model) { renders.push(model); },
    statsOn: () => state.stats,
    mouseEnabled: () => state.mouseSetting,
    disconnect() { calls.push('disconnect'); },
    quit() { calls.push('quit'); },
    log(text) { calls.push('log ' + text); }
  };
  return { menu: support.createMenu(env), calls, renders, state };
}

const ids = (model) => model.items.map((item) => item.id);

// Open and close: the input is taken before the page shows anything, and given back after the page has gone
{
  const { menu, calls, renders } = createFixture();
  assert.strictEqual(menu.isOpen(), false);
  assert.strictEqual(menu.open(), true);
  assert.deepStrictEqual(calls, ['captured true', 'enter']);
  assert.strictEqual(menu.isOpen(), true);
  assert.strictEqual(renders.length, 1, 'the panel is drawn once when it opens');
  assert.strictEqual(menu.open(), false, 'opening twice does nothing');
  assert.deepStrictEqual(calls, ['captured true', 'enter']);
  assert.strictEqual(menu.close(), true);
  assert.deepStrictEqual(calls, ['captured true', 'enter', 'leave', 'captured false']);
  assert.strictEqual(menu.close(), false, 'closing twice does nothing');
  assert.strictEqual(calls.length, 4);
  menu.toggle();
  assert.strictEqual(menu.isOpen(), true);
  menu.toggle();
  assert.strictEqual(menu.isOpen(), false);
}

// The items, in the order of the board
{
  const { menu } = createFixture({ stats: true });
  const model = menu.model();
  assert.deepStrictEqual(ids(model), ['resume', 'volume', 'stats', 'mouse', 'disconnect', 'quit']);
  assert.deepStrictEqual(model.items.map((item) => item.kind), ['action', 'level', 'toggle', 'toggle', 'action', 'action']);
  assert.strictEqual(model.items[1].volume, 40);
  assert.strictEqual(model.items[1].muted, false);
  assert.strictEqual(model.items[2].on, true);
  assert.strictEqual(model.items[3].on, false);
  assert.strictEqual(model.items[3].enabled, true);
  assert(model.items.every((item) => item.enabled !== undefined));
}

// The mouse of the controller works only when the setting is on, and then the item does nothing
{
  const { menu, calls } = createFixture({ mouseSetting: false });
  menu.open();
  assert.strictEqual(menu.model().items[3].enabled, false);
  calls.length = 0;
  menu.activate('mouse');
  assert.deepStrictEqual(calls, [], 'a disabled item is not activated');
}

// What each item does
{
  const { menu, calls, renders, state } = createFixture();
  menu.open();
  calls.length = 0;
  renders.length = 0;

  menu.activate('mouse');
  assert.deepStrictEqual(calls, ['toggleMouseEmulation']);
  assert.strictEqual(renders[renders.length - 1].items[3].on, true, 'the item shows the state at once');
  menu.activate('mouse');
  assert.strictEqual(renders[renders.length - 1].items[3].on, false);

  calls.length = 0;
  menu.activate('stats');
  assert.deepStrictEqual(calls, ['toggleStats']);
  assert.strictEqual(renders[renders.length - 1].items[2].on, true, 'the toggle shows the new state before the stream says so');
  menu.refresh();
  assert.strictEqual(renders[renders.length - 1].items[2].on, false, 'and the state of the page wins when it arrives');
  state.stats = true;
  menu.refresh();
  assert.strictEqual(renders[renders.length - 1].items[2].on, true);

  calls.length = 0;
  menu.adjust('volume', 1);
  menu.adjust('volume', -1);
  assert.deepStrictEqual(calls, ['volume 5 menu', 'volume -5 menu'], 'a step of the volume row is five steps of the TV');
  assert.strictEqual(renders[renders.length - 1].items[1].volume, 40);
  calls.length = 0;
  menu.adjust('stats', 1);
  menu.adjust('resume', -1);
  assert.deepStrictEqual(calls, [], 'only the volume row has values to change');

  menu.activate('volume');
  assert.deepStrictEqual(calls, [], 'A on the volume row does nothing');

  menu.activate('disconnect');
  assert.deepStrictEqual(calls, ['disconnect'], 'the page decides how to end the stream');
  calls.length = 0;
  menu.activate('quit');
  assert.deepStrictEqual(calls, ['quit']);

  calls.length = 0;
  menu.activate('resume');
  assert.deepStrictEqual(calls, ['leave', 'captured false'], 'back to the game closes the menu');
  assert.strictEqual(menu.isOpen(), false);
}

// A closed menu does not act, and does not draw
{
  const { menu, calls, renders } = createFixture();
  menu.activate('stats');
  menu.adjust('volume', 1);
  menu.refresh();
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(renders.length, 0);
}

// The Select that opened the menu does not close it: its release arms it, and the next press closes
{
  const { menu } = createFixture();
  menu.open();
  menu.onSelect(true);
  assert.strictEqual(menu.isOpen(), true, 'the press that is still going on does not count');
  menu.onSelect(false);
  assert.strictEqual(menu.isOpen(), true);
  menu.onSelect(true);
  assert.strictEqual(menu.isOpen(), false, 'a new press closes it');
  menu.onSelect(true);
  menu.onSelect(false);
  menu.open();
  menu.onSelect(true);
  assert.strictEqual(menu.isOpen(), true, 'every opening starts disarmed');
}

// A platform without the native side (the page in a desktop browser) still opens the menu
{
  const { menu, calls } = createFixture({ noModule: true });
  assert.doesNotThrow(() => { menu.open(); menu.activate('stats'); menu.activate('mouse'); menu.close(); });
  assert.deepStrictEqual(calls, ['enter', 'leave']);
  assert.strictEqual(menu.model().items[3].on, false);
}

// The state of the stream in the corner of the screen
assert.deepStrictEqual(
  support.describeStream({ width: 2560, height: 1440, fps: 60, codec: 'HEVC', hdr: true, bitrateMbps: 60 }),
  ['1440p · 60 FPS', 'HEVC · HDR', '60 Mbps']
);
assert.deepStrictEqual(
  support.describeStream({ width: 1920, height: 1080, fps: 120, codec: 'H264', hdr: false, bitrateMbps: 30.5 }),
  ['1080p · 120 FPS', 'H.264', '30.5 Mbps']
);
assert.deepStrictEqual(
  support.describeStream({ width: 3840, height: 2160, fps: 60, codec: 'AV1', hdr: true, bitrateMbps: 100 }),
  ['4K · 60 FPS', 'AV1 · HDR', '100 Mbps']
);
assert.deepStrictEqual(
  support.describeStream({ width: 1280, height: 720, fps: 60, codec: 'HEVC', hdr: false, bitrateMbps: 10 }),
  ['720p · 60 FPS', 'HEVC', '10 Mbps']
);

// The volume row reads the TV without writing a line to the log
{
  const logs = [];
  const tv = { volume: 33, mute: true };
  const control = volume.createControl({
    tizen: { tvaudiocontrol: { getVolume: () => tv.volume, isMute: () => tv.mute }, tvinputdevice: {} },
    log: (text) => logs.push(text),
    onChange() { assert.fail('reading is not a change'); }
  });
  assert.deepStrictEqual(control.read(), { volume: 33, muted: true });
  assert.deepStrictEqual(logs, []);
  const bare = volume.createControl({ tizen: null, log() {}, onChange() {} });
  assert.strictEqual(bare.read(), null);
}

console.log('stream_menu_tests: PASS');
