'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const html = read('wasm/index.html');
const index = read('wasm/platform/index.js');
const messages = read('wasm/platform/messages.js');
const navigation = read('wasm/platform/navigation.js');
const uiCss = read('wasm/static/css/ui.css');

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

// The screen is one container, hidden until the list is shown, with the heading, the count, the row of tiles and the hints
const open = html.indexOf('<section id="apps-screen"');
assert(open >= 0, 'the apps screen is a section');
const screen = html.slice(open, html.indexOf('</section>', open));
assert(/<section id="apps-screen" style="display: none">/.test(screen), 'it is hidden until the application shows it');
for (const id of ['apps-heading', 'apps-count', 'game-grid', 'apps-hints']) {
  assert(screen.includes('id="' + id + '"'), id + ' is in the apps screen');
}
assert(!/mdl-/.test(screen), 'the apps screen does not use MDL');

// The application hides and shows the screen as a whole, and the screens that show everything again leave it hidden
assert(!/\$\('[^']*#game-grid[^']*'\)\.(hide|show)\(/.test(index), 'the row is not hidden or shown on its own');
assert((index.match(/\$\('[^']*#apps-screen[^']*'\)\.hide\(\)/g) || []).length >= 4, 'the other screens hide the apps screen');
assert(/\$\('#apps-screen'\)\.show\(\)/.test(index), 'the list shows the apps screen');
assert(/\.not\('#listener, #wasmSpinner, #settings-list, #apps-screen'\)\.show\(\)/.test(index), 'the start of the application does not show it');

// The header is transparent in the new interface: nothing writes the old colors on it, and the body keeps its gradient
assert(!/\$\('#main-header'\)\.css\(/.test(index), 'no color or shadow is written on the header');
assert(!/\$\('body'\)\.css\('backgroundColor'/.test(index + messages), 'the body does not get a color under its gradient');
assert(/\$\('body'\)\.css\('background', 'transparent'\)/.test(messages), 'the stream is shown on a body without a background');
assert((messages.match(/\$\('body'\)\.css\('background', ''\)/g) || []).length === 1, 'the stream giving the body back its background');
assert(/\$\('body'\)\.css\('background', ''\)/.test(extractFunction(index, 'showAppsMode')));

// The tiles
const showApps = extractFunction(index, 'showApps');
assert(/class: 'game-container ui-tile'/.test(showApps));
assert(/id: 'game-container-' \+ app\.id/.test(showApps), 'the id of a tile is what the rest of the application looks for');
assert(/class: 'ui-tile__art'/.test(showApps) && /class: 'game-title ui-tile__cap'/.test(showApps) && /class: 'game-text'/.test(showApps));
assert(/ui-tile__badge/.test(showApps) && /t\('Running'\)/.test(showApps), 'a badge tells which app runs');
assert(!/mdl-|disable-animation|scrollText/.test(showApps), 'a tile is made of our own classes');
assert(/\$\('#game-' \+ app\.id\)\.append\(boxArtPlaceholderImg\)/.test(showApps), 'the picture goes into the box art');
assert(/\$\('#apps-count'\)\.text\(t\('Apps: %1\$d', sortedAppList\.length\)\)/.test(showApps));
assert(!/applist_(empty|error)/.test(index), 'the empty and the failed list say it in words');
assert(/class: 'ui-empty'/.test(showApps));
assert(!/snackbarLogLong\('(Your list is currently empty|Unable to retrieve your list)/.test(showApps), 'words that stay on the screen need no message that fades');
assert(/Views\.Apps\.view\.reset\(\);\s*var appToSelect/.test(showApps), 'the list is reset before the app to open on is chosen');
assert(!/&& window\.Views\b/.test(index), 'Views is a constant of the page, not a property of window');

// The navigation: one row, left and right move through it, up goes to the header, the tile is brought to the middle
const apps = navigation.slice(navigation.indexOf('  Apps: {'), navigation.indexOf('  AppsNav: {'));
assert(/view: new ListView\(\(\) => document\.getElementById\('game-grid'\)\.children\)/.test(apps));
assert(!/prevCardRow|nextCardRow|currentCardRow|prevCard\(|nextCard\(/.test(apps), 'the rows of six are gone');
assert(/left: function\(\) \{\s*this\.view\.prev\(\);\s*focusTile\(this\.view\.current\(\), 'smooth'\);/.test(apps));
assert(/right: function\(\) \{\s*this\.view\.next\(\);\s*focusTile\(this\.view\.current\(\), 'smooth'\);/.test(apps));
assert(/up: function\(\) \{[^}]*Navigation\.change\(Views\.AppsNav\)/.test(apps), 'up goes to the header');
assert(/enter: function\(\) \{[^}]*centerInRow\(this\.view\.current\(\), 'auto'\)/.test(apps), 'the list opens on the current tile');
assert(/switch: function\(\) \{[^}]*centerInRow\(/.test(apps));
assert(/focusTile\(Views\.Apps\.view\.current\(\), 'smooth'\)/.test(navigation.slice(navigation.indexOf('  AppsNav: {'))), 'coming down from the header too');

// The row is a strip under a window: the strip is moved with a transform (the compositor does that), nothing scrolls
{
  const calls = [];
  // A window 1000 wide with a strip of 2000 under it, and tiles of 200 that start 100 from the left, a tile every 300
  const view = { clientWidth: 1000 };
  const strip = { offsetWidth: 2000, parentElement: view, style: { transform: '' } };
  let transition = '';
  Object.defineProperty(strip.style, 'transition', {
    get: () => transition,
    set: (value) => { transition = value; calls.push('transition ' + JSON.stringify(value)); }
  });
  const tile = (name, index) => ({
    name,
    offsetLeft: 100 + index * 300,
    offsetWidth: 200,
    parentElement: strip,
    focus: (options) => calls.push(name + ' focus ' + JSON.stringify(options))
  });
  const context = {
    resolveElement: (target) => target,
    blurElement: (target) => calls.push('blur ' + (target && target.name)),
    document: { activeElement: { name: 'old' } }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(navigation, 'centerInRow') + extractFunction(navigation, 'focusTile'), context);

  context.focusTile(tile('third', 2), 'smooth');
  assert.deepStrictEqual(calls, ['blur old', 'third focus {"preventScroll":true}'], 'the focus does not scroll the window');
  assert.strictEqual(strip.style.transform, 'translate3d(-300px, 0, 0)', 'the tile (at 700..900) is brought to the middle of the window');
  assert(!calls.some((call) => call.startsWith('transition')), 'a move that glides leaves the transition of the stylesheet alone');

  context.centerInRow(tile('first', 0), 'smooth');
  assert.strictEqual(strip.style.transform, 'translate3d(0px, 0, 0)', 'the strip does not leave a gap before the first tile');

  context.centerInRow(tile('last', 6), 'smooth');
  assert.strictEqual(strip.style.transform, 'translate3d(-1000px, 0, 0)', 'nor does it go further than its end (2000 under a window of 1000)');

  calls.length = 0;
  context.centerInRow(tile('second', 1), 'auto');
  assert.deepStrictEqual(calls, ['transition "none"', 'transition ""'], 'a jump has no glide, and the glide is back right after');
  assert.strictEqual(strip.style.transform, 'translate3d(0px, 0, 0)');

  calls.length = 0;
  context.centerInRow(tile('second', 1), 'auto');
  assert.deepStrictEqual(calls, [], 'a tile that is in the middle already changes nothing');

  context.focusTile(undefined, 'smooth');
  context.centerInRow(null, 'auto');
  context.centerInRow({ parentElement: null }, 'auto');
  assert.deepStrictEqual(calls, [], 'an empty list has nothing to focus');
}
assert(!/scrollIntoView/.test(extractFunction(navigation, 'centerInRow') + extractFunction(navigation, 'focusTile')), 'the row is not moved by the scroll of the browser');

// The look: a tile does not change its size, the outline is the same kind of layer as everywhere, the old rules are gone
assert(!/mdl-card|disable-animation|scrollText/.test(uiCss), 'the old rules of the games section are gone');
assert(/<div id="game-row">\s*<div id="game-grid"><\/div>\s*<\/div>/.test(screen), 'the strip of tiles is in its window');
assert(/#game-row \{[^}]*overflow: clip;/.test(uiCss), 'the window clips and nothing can scroll it, not even the focus');
assert(/#game-grid \{[^}]*width: max-content;[^}]*min-width: 100%;[^}]*transition: transform 0\.32s var\(--ui-ease\);[^}]*will-change: transform;/.test(uiCss), 'the strip is a layer that glides');
assert(!/#game-grid \{[^}]*overflow/.test(uiCss), 'the strip does not scroll');
assert(/\.ui-tile \{[^}]*flex: none;[^}]*width: 260px;[^}]*transform-origin: 50% 195px;/.test(uiCss), 'a tile has a fixed place and grows around its box art');
assert(/\.ui-tile:hover, \.ui-tile:focus, \.ui-tile\.hovered \{[^}]*transform: scale\(1\.12\);/.test(uiCss), 'a tile grows with a transform, not with its size');
assert(/\.ui-tile::after \{[^}]*transition: opacity 0\.2s var\(--ui-ease\), transform 0\.2s var\(--ui-ease\)/.test(uiCss));
assert(/\.ui-tile__art \{[^}]*width: 260px;[^}]*height: 390px;/.test(uiCss));
assert(/\.ui-tile\.current-game-active \.ui-tile__art \{[^}]*border-color: var\(--ui-ok\)/.test(uiCss));
assert(/\.ui-tile\.current-game-active \.ui-tile__badge \{[^}]*display: inline-flex/.test(uiCss));
assert(/\.ui-tile__badge \{[^}]*z-index: 1/.test(uiCss), 'the badge is above the picture');
assert(/-webkit-line-clamp: 2/.test(uiCss) && /\.ui-tile__cap \{[^}]*height: 60px/.test(uiCss), 'the title has the room of two lines whatever it is');
assert(/\.ui-empty, \.ui-empty\.hovered \{\s*background: none/.test(uiCss));

// Strings
for (const locale of ['en-US', 'pt-BR', 'pl-PL']) {
  const strings = JSON.parse(read('wasm/static/locales/' + locale + '.json'));
  for (const key of ['Library', 'Apps: %1$d', 'Running']) assert(key in strings, locale + ' has "' + key + '"');
}

// The pictures are decoded off the main thread
assert(/boxArtPlaceholderImg\.decoding = 'async'/.test(showApps));

console.log('library_screen_tests: PASS');
