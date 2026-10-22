'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const html = read('wasm/index.html');
const index = read('wasm/platform/index.js');
const messages = read('wasm/platform/messages.js');
const navigation = read('wasm/platform/navigation.js');
const remote = read('wasm/platform/remote_controller.js');
const uiCss = read('wasm/static/css/ui.css');
const gamepadCpp = read('wasm/gamepad.cpp');
const inputCpp = read('wasm/input.cpp');
const header = read('wasm/moonlight_wasm.hpp');
const support = require('../wasm/platform/stream_menu.js');

// The text from the marker to the brace that closes the first brace after it
function extractBlock(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, 'missing ' + marker);
  let depth = 0;
  for (let at = source.indexOf('{', start); at < source.length; at++) {
    if (source[at] === '{') depth++;
    if (source[at] === '}' && --depth === 0) return source.slice(start, at + 1);
  }
  throw new Error('unbalanced braces after ' + marker);
}
const extractFunction = (source, name) => extractBlock(source, 'function ' + name + '(');

// ------------------------------------------------------------------------------------------------ the page
const menuStart = html.indexOf('<div id="stream-menu"');
assert(menuStart > html.indexOf('<div id="volume-bar"'), 'the menu follows the volume bar');
const menuHtml = html.slice(menuStart, html.indexOf('<video id="wasm_module"'));
// The stream hides the children of #main-content: the menu must not be one of them
const mainContentEnd = html.indexOf('</main>');
assert(html.indexOf('<main id="main-content"') >= 0 && mainContentEnd > 0 && mainContentEnd < menuStart, 'the stream menu is not inside #main-content, which the stream hides');

for (const id of ['streamMenuResume', 'streamMenuVolume', 'streamMenuStats', 'streamMenuMouse', 'streamMenuDisconnect', 'streamMenuQuit',
  'stream-menu-chips', 'stream-menu-sub', 'stream-menu-cells', 'stream-menu-volume', 'stream-menu-stats-text', 'stream-menu-stats-toggle',
  'stream-menu-mouse-text', 'stream-menu-mouse-note', 'stream-menu-mouse-toggle']) {
  assert(menuHtml.includes('id="' + id + '"'), id + ' is in the menu');
}
assert((menuHtml.match(/class="ui-streammenu__cell"/g) || []).length === 10, 'ten cells for the volume');
assert(!/mdl-/.test(menuHtml), 'the menu does not use MDL');
assert(/<div id="stream-menu" class="ui-streammenu" aria-hidden="true">/.test(menuHtml), 'it starts closed');
assert(html.indexOf('platform/stream_menu.js') > html.indexOf('platform/volume.js') && html.indexOf('platform/stream_menu.js') < html.indexOf('platform/index.js'),
  'the module is loaded after the volume and before the page');
// A button of the menu: the ids of the navigation are the ones of the markup
const navButtons = JSON.parse(extractBlock(navigation, 'const streamMenuButtons = ').replace(/^const streamMenuButtons = /, '').replace(/(\w+):/g, '"$1":').replace(/'/g, '"').replace(/,\s*}/, '}'));
assert.deepStrictEqual(Object.keys(navButtons), support.ITEMS, 'the buttons are the items of the menu, in its order');
for (const id of Object.values(navButtons)) assert(menuHtml.includes('id="' + id + '"'), id + ' is a button of the panel');

// The strings
for (const locale of ['en-US', 'pt-BR', 'pl-PL']) {
  const strings = JSON.parse(read('wasm/static/locales/' + locale + '.json'));
  const keys = [...menuHtml.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);
  for (const key of keys.concat(['On', 'Off', 'Off in settings', 'INFO', 'GREEN', 'F2', 'SELECT (HOLD)',
    '— Open the stream menu: volume, statistics, mouse emulation, disconnect, and quit the game.'])) {
    assert(key in strings, locale + ' has "' + key + '"');
  }
}
assert(/data-i18n="INFO">INFO<\/span> \/ <span class="navGuideRemoteText" data-i18n="GREEN">GREEN<\/span> \/ <span class="navGuideKeyboardText" data-i18n="F2">F2<\/span> \/ <span class="navGuideGamepadText" data-i18n="SELECT \(HOLD\)">/.test(html),
  'the navigation guide tells how to open the menu');

// ------------------------------------------------------------------------------------------------ the look
assert(/--ui-panel: #0E141E;/.test(uiCss), 'the token of the panel');
assert(/\.ui-streammenu \{[^}]*position: fixed;[^}]*z-index: 6;[^}]*opacity: 0;[^}]*visibility: hidden;/.test(uiCss), 'the menu is above the volume bar (5) and starts hidden');
assert(/\.ui-streammenu\.is-open \{[^}]*opacity: 1;[^}]*visibility: visible;/.test(uiCss));
assert(/\.ui-streammenu__panel \{[^}]*width: 680px;[^}]*background: var\(--ui-panel\);[^}]*transform: translateX\(48px\);[^}]*transition: transform 0\.24s/.test(uiCss), 'an opaque panel that slides with a transform');
assert(/\.ui-streammenu\.is-open \.ui-streammenu__panel \{\s*transform: none;/.test(uiCss));
const menuCss = uiCss.slice(uiCss.indexOf('The stream menu. It opens over the stream'));
assert(!/transition: all/.test(menuCss) && !/transition:[^;]*\b(left|right|top|bottom|width|height|margin|padding)\b/.test(menuCss), 'nothing of the menu moves by a layout property');
assert(/\.ui-streammenu__item--danger \{\s*color: var\(--ui-bad\);/.test(uiCss));
assert(/\.ui-streammenu__toggle\.is-on::after \{\s*transform: translateX\(36px\);/.test(uiCss));

// ------------------------------------------------------------------------------------------------ the navigation view
{
  const calls = [];
  const context = {
    mark: (target) => calls.push('mark ' + target),
    unmark: (target) => calls.push('unmark ' + target),
    StreamMenu: {
      model: () => ({ items: support.ITEMS.map((id) => ({ id, enabled: id !== 'mouse' })) }),
      adjust: (id, delta) => calls.push('adjust ' + id + ' ' + delta),
      activate: (id) => calls.push('activate ' + id),
      close: () => calls.push('close')
    }
  };
  vm.createContext(context);
  vm.runInContext(extractBlock(navigation, 'class ListView') + '\n' + extractBlock(navigation, 'const streamMenuButtons = ') + ';\n' +
    extractFunction(navigation, 'streamMenuItemOf') + '\nvar views = { ' + extractBlock(navigation, '  StreamMenu: {') + ' };', context);
  const view = context.views.StreamMenu;
  assert.deepStrictEqual(Array.from(view.view.func()), ['streamMenuResume', 'streamMenuVolume', 'streamMenuStats', 'streamMenuDisconnect', 'streamMenuQuit'],
    'a disabled item is not on the list');
  view.enter();
  assert.strictEqual(view.view.current(), 'streamMenuResume');
  view.up();
  assert.strictEqual(view.view.current(), 'streamMenuResume', 'up from the first item stays on it');
  for (let i = 0; i < 10; i++) view.down();
  assert.strictEqual(view.view.current(), 'streamMenuQuit', 'down stops at the last item, which ends the game: the list does not wrap');
  view.up();
  assert.strictEqual(view.view.current(), 'streamMenuDisconnect');
  calls.length = 0;
  view.view.reset();
  view.down();
  assert.strictEqual(view.view.current(), 'streamMenuVolume');
  calls.length = 0;
  view.left();
  view.right();
  view.accept();
  view.back();
  assert.deepStrictEqual(calls, ['adjust volume -1', 'adjust volume 1', 'activate volume', 'close']);
  view.leave();
  assert.strictEqual(calls[calls.length - 1], 'unmark streamMenuVolume');
}
assert(/focus: focus,\s*\};/.test(navigation.slice(navigation.indexOf('const Navigation = (function() {'))), 'the navigation can be told that it has the focus');

// ------------------------------------------------------------------------------------------------ the page around the menu
function createPage(options) {
  options = options || {};
  const calls = [];
  const elements = {};
  const makeElement = (id) => {
    const classes = new Set();
    return {
      id, textContent: '', children: [], attrs: {}, style: {}, open: false,
      classList: {
        add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name),
        toggle: (name, force) => { if (force === undefined ? !classes.has(name) : force) classes.add(name); else classes.delete(name); }
      },
      setAttribute(name, value) { this.attrs[name] = value; },
      appendChild(child) { this.children.push(child); },
      close() { calls.push('dialog.close'); this.open = false; }
    };
  };
  const element = (id) => elements[id] || (elements[id] = makeElement(id));
  const cells = Array.from({ length: 10 }, (_, i) => makeElement('cell' + i));
  const state = { stats: false, mouse: true, volume: 70, muted: false, paused: true, dialogOpen: false, mouseActive: false };
  let hooks = null;
  const context = {
    support,
    document: {
      getElementById: element,
      createElement: () => makeElement('new'),
      querySelectorAll: (selector) => (selector === '#stream-menu-cells .ui-streammenu__cell' ? cells : []),
      querySelector: (selector) => (selector === '#quitAppDialog' ? element('quitAppDialog') : selector === '#quitAppDialogOverlay' ? element('quitAppDialogOverlay') : null)
    },
    StreamMenuSupport: support,
    Module: {
      setInputCaptured: (captured) => calls.push('captured ' + captured),
      toggleStats: () => calls.push('toggleStats'),
      toggleMouseEmulation: () => calls.push('toggleMouseEmulation'),
      isMouseEmulationActive: () => state.mouseActive,
      stopStream: () => calls.push('stopStream')
    },
    VolumeControl: {
      adjust: (steps, source) => { calls.push('volume ' + steps + ' ' + source); state.volume += steps; return null; },
      read: () => ({ volume: state.volume, muted: state.muted })
    },
    Controller: {
      resync: () => calls.push('resync'),
      startWatching: () => calls.push('startWatching'),
      stopWatching: () => calls.push('stopWatching')
    },
    Navigation: {
      start: () => calls.push('Navigation.start'),
      stop: () => calls.push('Navigation.stop'),
      push: (view) => calls.push('push ' + view.name),
      pop: () => calls.push('pop'),
      focus: () => calls.push('Navigation.focus')
    },
    Views: { StreamMenu: { name: 'StreamMenu', view: { reset: () => calls.push('reset') } } },
    hideVolumeBar: () => calls.push('hideVolumeBar'),
    logDiagnostic: (line) => calls.push('log ' + line),
    quitAppDialog: (given) => { calls.push('quitAppDialog'); hooks = given; },
    $: (selector) => ({ prop: () => (selector === '#performanceStatsSwitch' ? state.stats : state.mouse) }),
    t: (key) => key,
    isUiGamepadPaused: true,
    isDialogOpen: false,
    currentStream: options.noStream ? null : { title: 'Steam Big Picture', host: 'GAMING-PC', summary: ['1440p · 60 FPS', 'HEVC · HDR', '60 Mbps'] }
  };
  vm.createContext(context);
  const code = ['enterStreamMenu', 'leaveStreamMenu', 'renderStreamMenu', 'quitFromStreamMenu'].map((name) => extractFunction(index, name)).join('\n');
  const creation = extractBlock(index, 'const StreamMenu = StreamMenuSupport.createMenu(') + ');';
  vm.runInContext(code + '\n' + creation, context);
  return { context, calls, state, element, cells, menu: vm.runInContext('StreamMenu', context), hooks: () => hooks };
}

// Opening: the host loses the input, the pad loop and the navigation work for the menu, and the panel shows
{
  const page = createPage();
  assert.strictEqual(page.menu.open(), true);
  assert.deepStrictEqual(page.calls, [
    'captured true', 'resync', 'startWatching', 'Navigation.start', 'reset', 'push StreamMenu', 'Navigation.focus', 'hideVolumeBar', 'log Stream menu opened'
  ], 'the order in which the menu takes over');
  assert.strictEqual(page.context.isUiGamepadPaused, false, 'the pad loop that the stream paused runs again');
  const menu = page.element('stream-menu');
  assert(menu.classList.contains('is-open'));
  assert.strictEqual(menu.attrs['aria-hidden'], 'false');
  assert.strictEqual(page.element('stream-menu-sub').textContent, 'Steam Big Picture · GAMING-PC');
  assert.deepStrictEqual(page.element('stream-menu-chips').children.map((chip) => chip.textContent), ['1440p · 60 FPS', 'HEVC · HDR', '60 Mbps']);
  assert.strictEqual(page.element('stream-menu-volume').textContent, '70%');
  assert.strictEqual(page.cells.filter((cell) => cell.classList.contains('is-on')).length, 7, 'seventy percent is seven cells of ten');
}

// Closing gives everything back, in the reverse order, and the host gets the input last
{
  const page = createPage();
  page.menu.open();
  page.calls.length = 0;
  page.menu.close();
  assert.deepStrictEqual(page.calls, ['pop', 'stopWatching', 'Navigation.stop', 'log Stream menu closed', 'captured false']);
  assert.strictEqual(page.context.isUiGamepadPaused, true, 'the loop of the pads is paused again, as during any stream');
  assert(!page.element('stream-menu').classList.contains('is-open'));
  assert.strictEqual(page.element('stream-menu').attrs['aria-hidden'], 'true');
}

// The stream ends under the menu (Review Focus 4): the same close, which leaves the interface as after a normal stream. A stream
// that ends with the menu shut does nothing to it
{
  const page = createPage();
  page.menu.close();
  assert.deepStrictEqual(page.calls, [], 'a menu that is not open is left alone');
  page.menu.open();
  page.calls.length = 0;
  page.menu.close();
  assert(page.calls.includes('Navigation.stop') && page.calls.includes('stopWatching') && page.calls.includes('captured false'));
}

// ... and with the quit dialog over the menu, the dialog goes first
{
  const page = createPage();
  page.menu.open();
  page.element('quitAppDialog').open = true;
  page.context.isDialogOpen = true;
  page.calls.length = 0;
  page.menu.close();
  assert.deepStrictEqual(page.calls.slice(0, 3), ['dialog.close', 'pop', 'pop'], 'the dialog and then the menu leave the stack of the views');
  assert.strictEqual(page.element('quitAppDialogOverlay').style.display, 'none');
  assert.strictEqual(page.context.isDialogOpen, false);
}

// The items
{
  const page = createPage();
  page.menu.open();
  page.calls.length = 0;
  page.menu.activate('disconnect');
  assert.deepStrictEqual(page.calls.slice(-3), ['log Stream menu closed', 'captured false', 'stopStream'], 'disconnect closes the menu and then ends the stream');

  const quit = createPage();
  quit.menu.open();
  quit.calls.length = 0;
  quit.menu.activate('quit');
  assert.deepStrictEqual(quit.calls, ['quitAppDialog']);
  assert(!quit.element('stream-menu').classList.contains('is-open'), 'the dialog is over the video, not over the panel');
  assert.strictEqual(quit.hooks().title, 'Steam Big Picture');
  quit.hooks().onCancel();
  assert(quit.element('stream-menu').classList.contains('is-open'), 'a cancel brings the panel back');
  assert.strictEqual(quit.menu.isOpen(), true);
  quit.calls.length = 0;
  quit.hooks().onConfirm();
  assert.deepStrictEqual(quit.calls.slice(-2), ['captured false', 'stopStream'], 'a confirmed quit closes the menu and ends the stream (the dialog then quits the game)');
  assert.strictEqual(quit.menu.isOpen(), false);
}

// The rows
{
  const page = createPage();
  page.menu.open();
  page.state.stats = true;
  page.menu.refresh();
  assert(page.element('stream-menu-stats-toggle').classList.contains('is-on'));
  assert.strictEqual(page.element('stream-menu-stats-text').textContent, 'On');
  page.menu.activate('mouse');
  assert(page.calls.includes('toggleMouseEmulation'));
  page.state.mouse = false;
  page.menu.refresh();
  assert.strictEqual(page.element('stream-menu-mouse-note').textContent, 'Off in settings', 'a switch that the setting keeps off says so under its name');
  assert.strictEqual(page.element('stream-menu-mouse-text').textContent, 'Off');
  assert(page.element('streamMenuMouse').classList.contains('is-disabled'));
  page.state.mouse = true;
  page.menu.refresh();
  assert.strictEqual(page.element('stream-menu-mouse-note').textContent, '', 'and says nothing once the setting is on');
  assert(!page.element('streamMenuMouse').classList.contains('is-disabled'));
  page.state.mouse = false;
  page.menu.refresh();
  page.state.muted = true;
  page.menu.refresh();
  assert.strictEqual(page.element('stream-menu-volume').textContent, '0%', 'a muted TV shows no volume');
  assert.strictEqual(page.cells.filter((cell) => cell.classList.contains('is-on')).length, 0);
  page.state.muted = false;
  page.menu.adjust('volume', 1);
  assert.strictEqual(page.element('stream-menu-volume').textContent, '75%');
  const bare = createPage({ noStream: true });
  assert.doesNotThrow(() => bare.menu.open());
  assert.strictEqual(bare.element('stream-menu-sub').textContent, '');
}

// ------------------------------------------------------------------------------------------------ the rest of the page
// The pad: Select tells the menu about its press and release; the stream that starts tells the menu what it streams
assert(/if \(index === 8\) \{\s*StreamMenu\.onSelect\(pressed\);\s*\}/.test(index));
assert(/currentStream = \{\s*title: appToStart\.title,\s*host: host\.hostname,\s*summary: StreamMenuSupport\.describeStream\(\{/.test(index));
assert(index.indexOf('currentStream = {') < index.indexOf('      showStreamMode();'), 'the menu knows the stream before it starts');
assert(/if \(StreamMenu\.isOpen\(\)\) \{\s*StreamMenu\.refresh\(\);\s*return;\s*\}/.test(extractFunction(index, 'showVolumeBar')), 'the bar gives way to the row of the menu');

// The Back key of the remote does not reach the host while the menu is open (Review Focus 5)
assert(/e\.key === 'XF86Back' && isInGame === true && !StreamMenu\.isOpen\(\)/.test(index));

// The quit dialog: asked by the stream menu with hooks, and by the library as before
{
  const dialog = extractFunction(index, 'quitAppDialog');
  assert(/var hooks = options && typeof options\.onConfirm === 'function' \? options : null;/.test(dialog), 'a click passes an event, which is not a set of hooks');
  assert(/if \(!hooks && api\.currentGame === 0\)/.test(dialog), 'the stream menu does not need the data of the host to be up to date');
  assert(/hooks \? Promise\.resolve\(\{ title: hooks\.title \}\) : api\.getAppById\(api\.currentGame\)/.test(dialog));
  assert(/hooks\.onCancel\(\)/.test(dialog) && /hooks\.onConfirm\(\);\s*\}\s*stopGame\(api\)/.test(dialog), 'a confirmed quit runs the hook and then quits the game as before');
  assert(/\$\('#quitRunningAppBtn'\)\.on\('click', quitAppDialog\)/.test(index), 'the button of the library still passes the event');
}

// The messages: the menu opens by the message of the pad, and closes first when the stream ends
assert(/msg === 'streamMenuOpen'\) \{\s*[^}]*if \(isInGame === true\) \{\s*StreamMenu\.open\(\);/.test(messages));
assert(/msg\.indexOf\('streamTerminated: '\) === 0\) \{\s*[^\n]*\n\s*StreamMenu\.close\(\);\s*[^\n]*\n\s*stopAudioScheduler\(\);/.test(messages), 'the menu goes first when the stream ends');
assert((messages.match(/StreamMenu\.refresh\(\);/g) || []).length === 2, 'the statistics messages refresh an open menu');

// The remote: the green key toggles the menu during a stream only
{
  const calls = [];
  const context = {
    isGamepadActive: false,
    isInGame: true,
    tvKey: { KEY_UP: 38, KEY_DOWN: 40, KEY_LEFT: 37, KEY_RIGHT: 39, KEY_ENTER: 13, KEY_REMOTE_ENTER: 29443, KEY_RETURN: 10009,
      KEY_VOLUME_UP: 447, KEY_VOLUME_DOWN: 448, KEY_VOLUME_MUTE: 449, KEY_CHANNEL_UP: 427, KEY_CHANNEL_DOWN: 428, KEY_RED: 403, KEY_GREEN: 404, KEY_YELLOW: 405, KEY_INFO: 457 },
    Navigation: new Proxy({}, { get: (_, name) => () => calls.push('Navigation.' + String(name)) }),
    VolumeControl: { up() {}, down() {}, toggleMute() {} },
    Module: { stopStream: () => calls.push('stopStream'), toggleStats: () => calls.push('toggleStats') },
    StreamMenu: { toggle: () => calls.push('toggle') }
  };
  vm.createContext(context);
  vm.runInContext(remote, context);
  context.remoteControllerHandler({ keyCode: 404, preventDefault() {} });
  assert.deepStrictEqual(calls, ['toggle']);
  calls.length = 0;
  calls.length = 0;
  context.remoteControllerHandler({ keyCode: 457, preventDefault() {} });
  assert.deepStrictEqual(calls, ['toggle'], 'the Info key opens and closes the menu too');
  calls.length = 0;
  context.isInGame = false;
  context.remoteControllerHandler({ keyCode: 404, preventDefault() {} });
  context.remoteControllerHandler({ keyCode: 457, preventDefault() {} });
  assert.deepStrictEqual(calls, [], 'outside a stream the green and the Info key do nothing');
  context.isInGame = true;
  context.remoteControllerHandler({ keyCode: 403, preventDefault() {} });
  context.remoteControllerHandler({ keyCode: 405, preventDefault() {} });
  assert.deepStrictEqual(calls, ['stopStream', 'toggleStats'], 'red and yellow are as they were');
}
assert(/'ColorF1Green',/.test(index) && /'Info',\s*\/\/ Opens the stream menu/.test(index), 'the green and the Info key are registered with the platform');

// ------------------------------------------------------------------------------------------------ the native side
assert(/#include "stream_menu_gate\.hpp"/.test(header));
assert(/static_assert\(StreamMenuGate::kSelectFlag == BACK_FLAG/.test(gamepadCpp), 'the gate holds the Select button of the protocol');
assert(/MenuGate\(\)\.UpdateHold\(gamepadID, MonotonicNowMs\(\), static_cast<uint16_t>\(buttonFlags\)\)\) \{\s*PostToJsAsync\(std::string\("streamMenuOpen"\)\);/.test(gamepadCpp),
  'a hold is told to the page without making the input thread wait');
assert(/MenuGate\(\)\.Decide\(gamepadID, static_cast<uint16_t>\(buttonFlags\)\);\s*if \(decision != StreamMenuGate::SendDecision::Send\) \{/.test(gamepadCpp));
assert(gamepadCpp.indexOf('MenuGate().Decide(') < gamepadCpp.indexOf('if (mouseEmulationActive) {'), 'the decision comes before both the mouse and the gamepad sends');
assert(/SendNeutral\) \{\s*LiSendMultiControllerEvent\(gamepadID, activeGamepadMask, 0, 0, 0, 0, 0, 0, 0\);/.test(gamepadCpp), 'the host gets one neutral state when the menu opens');
assert(/s_ControllerSendFilter\.Reset\(gamepadID\);\s*\}\s*continue;/.test(gamepadCpp));
assert(/MenuGate\(\)\.SetCaptured\(false\);/.test(gamepadCpp.slice(gamepadCpp.indexOf('::HandleGamepadInputState'))), 'every stream starts with the menu closed');
assert(/!menuCaptured && \(buttonFlags & PLAY_FLAG\)/.test(gamepadCpp), 'Start does not toggle the mouse while the menu is open');
for (const name of ['setInputCaptured', 'isMouseEmulationActive', 'toggleMouseEmulation']) {
  assert(new RegExp('emscripten::function\\("' + name + '", &' + name + '\\)').test(gamepadCpp), name + ' is bound');
}
assert(/std::atomic<bool> mouseEmulationActive\{false\};/.test(gamepadCpp) && /std::atomic<bool> mouseEmulationSwitch\{false\};/.test(gamepadCpp));
assert(/if \(!mouseEmulationSwitch\.load\(\)\) \{\s*return;/.test(gamepadCpp), 'the menu cannot start the mouse when the setting is off');
for (const handler of ['HandleMouseDown', 'HandleMouseMove', 'HandleWheel', 'HandleKeyDown']) {
  assert(/MenuGate\(\)\.IsCaptured\(\)/.test(extractBlock(inputCpp, 'EM_BOOL MoonlightInstance::' + handler)), handler + ' sends nothing while the menu is open');
}
for (const handler of ['HandleMouseUp', 'HandleKeyUp']) {
  assert(!/MenuGate\(\)/.test(extractBlock(inputCpp, 'EM_BOOL MoonlightInstance::' + handler)), handler + ' still lets go, so that nothing stays pressed on the host');
}
assert(/IsCaptured\(\)\) \{\s*return;\s*\}/.test(extractBlock(inputCpp, 'void MoonlightInstance::ReportMouseMovement')), 'pending movement is dropped, not sent late');

console.log('stream_menu_screen_tests: PASS');
