'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const html = read('wasm/index.html');
const index = read('wasm/platform/index.js');
const navigation = read('wasm/platform/navigation.js');
const i18n = read('wasm/platform/i18n.js');
const uiCss = read('wasm/static/css/ui.css');
const fontsCss = read('wasm/static/css/ui-fonts.css');

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

// The page: the new stylesheets come after the old one, the header keeps the ids that the navigation uses, and the hosts
// screen is one container that holds the heading, the row of cards and the hints
assert(!html.includes('static/css/style.css') && !fs.existsSync('wasm/static/css/style.css'), 'the old stylesheet is gone');
assert(html.indexOf('static/css/ui-fonts.css') > html.indexOf('static/css/material.min.css'));
assert(html.indexOf('static/css/ui.css') > html.indexOf('static/css/ui-fonts.css'));
for (const id of ['goBackBtn', 'settingsBtn', 'supportBtn', 'restoreDefaultsBtn', 'quitRunningAppBtn']) {
  assert(new RegExp('<button[^>]*id="' + id + '"[^>]*class="ui-btn ui-fx"').test(html), id + ' is a button of the new header');
}
const screen = html.slice(html.indexOf('<section id="hosts-screen">'), html.indexOf('</section>', html.indexOf('<section id="hosts-screen">')));
assert(screen.includes('id="hosts-heading"') && screen.includes('id="host-grid"') && screen.includes('id="hosts-hints"'));
assert(screen.includes('id="addHostContainer"'), 'the add host card is in the row');
assert(!/mdl-card/.test(screen), 'the hosts screen does not use the cards of MDL any more');

// The application hides and shows the screen as one piece, and no longer writes a title of the screen into the header
assert(!/#hosts-heading|#hosts-hints/.test(index), 'the parts are not hidden one by one');
assert((index.match(/\$\('#hosts-screen/g) || []).length >= 4, 'the other screens hide the hosts screen as a whole');
assert(!/\$\('#header-title'\)\.html\(/.test(index));

// The cards
const addHost = extractFunction(index, 'addHostToGrid');
assert(/class: 'host-container ui-card ui-fx'/.test(addHost));
assert(!/mdl-/.test(addHost), 'a card is made of our own classes');
assert(/class: 'host-menu'/.test(addHost) && /hostMenuDialog\(host\)/.test(addHost));
assert(/\$\('#addHostContainer'\)\.before\(hostContainer\)/.test(addHost), 'the add host card stays the last one');

// The states of a card, run against a small fake of the document
{
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; this.className = ''; this.ownText = ''; }
    // As in a browser, setting the text of an element removes its children
    set textContent(value) { this.children = []; this.ownText = value; }
    get textContent() { return this.ownText; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    appendChild(child) { this.children.push(child); }
  }
  const elements = {};
  ['host-container-u', 'host-status-u', 'host-action-u'].forEach((id) => { elements[id] = new Element('div'); });
  const context = {
    document: { getElementById: (id) => elements[id] || null, createElement: (tag) => new Element(tag) },
    t: (key) => '<' + key + '>'
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(index, 'updateHostStatusIndicator'), context);
  const update = (host) => context.updateHostStatusIndicator(Object.assign({ serverUid: 'u' }, host));
  const pillText = () => elements['host-status-u'].children.map((child) => child.textContent).join('');
  const actionText = () => elements['host-action-u'].children.map((child) => child.textContent).join('|');

  update({ online: true, paired: true });
  assert.strictEqual(elements['host-container-u'].attributes['data-state'], 'online');
  assert.strictEqual(elements['host-status-u'].className, 'ui-pill ui-pill--ok');
  assert.strictEqual(pillText(), '<Online>');
  assert.strictEqual(actionText(), 'A|<Open library>');

  update({ online: true, paired: false });
  assert.strictEqual(elements['host-container-u'].attributes['data-state'], 'unpaired');
  assert.strictEqual(elements['host-status-u'].className, 'ui-pill ui-pill--warn');
  assert.strictEqual(actionText(), 'A|<Pair with PIN>');

  update({ online: false, paired: true });
  assert.strictEqual(elements['host-container-u'].attributes['data-state'], 'offline');
  assert.strictEqual(elements['host-status-u'].className, 'ui-pill ui-pill--mute');
  assert.strictEqual(actionText(), '', 'an offline host that is not woken automatically has no action');

  update({ online: false, paired: true, autoWolEnabled: true });
  assert.strictEqual(actionText(), 'A|<Wake PC>');

  update({ online: undefined, paired: false });
  assert.strictEqual(elements['host-container-u'].attributes['data-state'], 'unknown');
  assert.strictEqual(elements['host-status-u'].style.display, 'none', 'a host that was not asked yet shows no status');
}

// The navigation: one row of cards, the header above it, X opens the menu of the host, Y the settings
const hostsView = navigation.slice(navigation.indexOf('  Hosts: {'), navigation.indexOf('  HostsNav: {'));
assert(/view: new ListView\(\(\) => document\.getElementById\('host-grid'\)\.children\)/.test(hostsView));
assert(/up: function\(\) \{[^}]*Navigation\.change\(Views\.HostsNav\)/.test(hostsView), 'up goes to the header');
assert(/currentItem\.querySelector\('\.host-menu'\)/.test(hostsView), 'the menu button is found by its class, not by its place');
assert(!/children\[[01]\]|prevCardRow|nextCardRow/.test(hostsView), 'nothing depends on the order of the parts of a card');
assert(/menu: function\(\) \{[^}]*clickElement\('settingsBtn'\)/.test(hostsView));
assert(!/HostsMenuHighlight/.test(navigation + index), 'the view that highlighted the menu icon is gone');
assert(/menu: runOp\('menu'\)/.test(navigation));
assert(/return \['updateAppBtn', 'supportBtn', 'settingsBtn'\]/.test(navigation), 'the header buttons are in the order of the screen');

// The pad: A and B answer at once, X and Y have their places
assert(/0: \(\) => throttledNavigation\(\(\) => Navigation\.accept\(\)\)/.test(index));
assert(/2: \(\) => throttledNavigation\(\(\) => Navigation\.press\(\)\)/.test(index));
assert(/3: \(\) => throttledNavigation\(\(\) => Navigation\.menu\(\)\)/.test(index));
assert(!/delayedNavigation|setTimeout\(callback, NAVIGATION/.test(index), 'no action waits before it runs');
{
  const context = { Date: { now: () => context.time }, time: 1000, lastNavigationTime: 0, NAVIGATION_COOLDOWN: 100, calls: 0 };
  vm.createContext(context);
  vm.runInContext(extractFunction(index, 'throttledNavigation'), context);
  context.throttledNavigation(() => context.calls++);
  assert.strictEqual(context.calls, 1, 'the first press acts at once');
  context.time = 1050;
  context.throttledNavigation(() => context.calls++);
  assert.strictEqual(context.calls, 1, 'a bounce within the cooldown is ignored');
  context.time = 1100;
  context.throttledNavigation(() => context.calls++);
  assert.strictEqual(context.calls, 2, 'the next press after the cooldown acts');
}

// Polish: the same strings as the source language, registered, and the fonts of the interface are in the package
const english = JSON.parse(read('wasm/static/locales/en-US.json'));
const polish = JSON.parse(read('wasm/static/locales/pl-PL.json'));
assert.deepStrictEqual(Object.keys(polish), Object.keys(english), 'pl-PL has the keys of en-US, in the same order');
for (const key of Object.keys(english)) {
  const placeholders = (text) => (text.match(/%\d+\$[sd]/g) || []).sort().join(',');
  assert.strictEqual(placeholders(polish[key]), placeholders(english[key]), 'placeholders of "' + key.slice(0, 40) + '"');
}
assert(/SUPPORTED_LOCALES = \['en-US', 'pl-PL', 'pt-BR'\]/.test(i18n));
assert(/'pl-PL': 'Polski'/.test(i18n));
for (const key of ['Where are we playing today?', 'Online', 'Offline', 'Not paired', 'Open library', 'Pair with PIN', 'Options', 'Select']) {
  for (const locale of ['en-US', 'pt-BR', 'pl-PL']) {
    assert(key in JSON.parse(read('wasm/static/locales/' + locale + '.json')), locale + ' has "' + key + '"');
  }
}
for (const file of ['BricolageGrotesque-latin', 'BricolageGrotesque-latin-ext', 'Figtree-latin', 'Figtree-latin-ext']) {
  assert(fs.existsSync('wasm/static/fonts/' + file + '.woff2'), file + ' is in the package');
  assert(fontsCss.includes('../fonts/' + file + '.woff2'));
}
assert(/font-family: 'Bricolage Grotesque'/.test(fontsCss) && /font-family: 'Figtree'/.test(fontsCss));
assert(!/https?:\/\//.test(fontsCss + uiCss), 'nothing is loaded from the network');

// The buttons of a card line up in one column, in one frame, and show only on the highlighted card
assert(/\.host-action, \.host-menu \{[^}]*border: 2px solid var\(--ui-line\)/.test(uiCss), 'both buttons have the same frame');
assert(/\.ui-card__foot \{[^}]*flex-direction: column;[^}]*align-items: stretch;[^}]*opacity: 0;/.test(uiCss), 'a column as wide as the card, hidden');
assert(/\.host-container\.hovered \.ui-card__foot,[^{]*\.host-container:hover \.ui-card__foot,[^{]*\.host-container:focus \.ui-card__foot,[^{]*\.host-container:focus-within \.ui-card__foot \{[^}]*opacity: 1;/.test(uiCss),
  'they show when the card is highlighted by the pad, the remote, the pointer or the focus');
assert(!/\.host-menu \{[^}]*align-self/.test(uiCss), 'the menu button is not narrower than the other one');

// What keeps the focus smooth: the outline changes opacity and transform only, and nothing animates a shadow or a layout property
assert(/\.ui-fx::after \{[^}]*transition: opacity 0\.2s var\(--ui-ease\), transform 0\.2s var\(--ui-ease\)/.test(uiCss));
assert(!/transition:\s*all/.test(uiCss), 'no transition of everything');
assert(!/transition[^;]*(box-shadow|width|height|margin|padding)/.test(uiCss));

// The outline lies 8 px outside of its element, so its corners are the corners of the element plus 8 px, from one property
assert(/\.ui-fx::after \{[^}]*border-radius: calc\(var\(--ui-r, 32px\) \+ 8px\);/.test(uiCss), 'the outline is concentric with its element');
assert(/\.ui-btn \{[^}]*--ui-r: 32px;[^}]*border-radius: var\(--ui-r\);/.test(uiCss));
assert(/\.ui-card \{[^}]*--ui-r: 32px;[^}]*border-radius: var\(--ui-r\);/.test(uiCss));

console.log('hosts_screen_tests: PASS');
