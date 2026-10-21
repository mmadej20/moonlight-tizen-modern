'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const html = read('wasm/index.html');
const index = read('wasm/platform/index.js');
const style = read('wasm/static/css/style.css');
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

// The page: the two panes are in one wrapper, with the title of the options and the hints
const open = html.indexOf('<div id="settings-list"');
const settings = html.slice(open, html.indexOf('<section id="apps-screen"'));
for (const id of ['settings-body', 'settings-left-pane', 'settings-right-pane', 'settings-title', 'settings-hints']) {
  assert(settings.includes('id="' + id + '"'), id + ' is in the settings screen');
}
assert(settings.indexOf('id="settings-title"') < settings.indexOf('id="basicSettings"'), 'the title comes before the options');
assert(settings.indexOf('id="settings-hints"') > settings.indexOf('id="aboutSettings"'), 'the hints are under the panes');

// The navigation looks for the list of a menu as the fourth child of its row (label, hint, field, menu): the order stays
const menus = ['videoResolutionMenu', 'videoFramerateMenu', 'videoBitrateMenu', 'languageMenu', 'audioBackendMenu', 'audioConfigMenu',
  'audioJitterMenu', 'videoCodecMenu'];
for (const menu of menus) {
  const row = new RegExp('<label[^>]*>[\\s\\S]*?</label>\\s*<span class="mdl-list__item-text-body"[^>]*>[\\s\\S]*?</span>\\s*<div id="' + menu + '">[\\s\\S]*?</div>\\s*<(ul|div) class="' + menu + ' ');
  assert(row.test(settings), menu + ' is followed by its list in the order that the navigation expects');
}
assert(!/mdl-menu--bottom-left/.test(settings), 'the menus open under the field at the right edge of the row');
assert((settings.match(/mdl-menu--bottom-right/g) || []).length === menus.length);

// A switch row has a hint: the rows that had none show the sentence of the switch as their hint
const rows = settings.split('<div class="setting-option').slice(1);
const emptyHints = rows.filter((row) => /<span class="mdl-list__item-text-body"><\/span>/.test(row.split('<div id=')[0]));
assert.strictEqual(emptyHints.length, 2, 'only the removal of the hosts and the system information have no hint');
for (const id of ['rumbleFeedbackMenu', 'mouseEmulationMenu', 'flipABfaceButtonsMenu', 'flipXYfaceButtonsMenu', 'playHostAudioMenu',
  'connectionWarningsMenu', 'performanceStatsMenu']) {
  const row = rows.find((candidate) => candidate.includes('<div id="' + id + '">'));
  const hint = /<span class="mdl-list__item-text-body" data-i18n="([^"]+)">([^<]+)<\/span>/.exec(row);
  assert(hint && hint[1] === hint[2], id + ' shows the sentence of its switch as the hint');
  assert(row.includes('<span class="mdl-switch__label" data-i18n="' + hint[1] + '"'), id + ' keeps the sentence in the switch for the screen reader');
}

// The title is the name of the chosen category, and the hints lose the dash that the strings start with
{
  const makeElement = (text) => ({ textContent: text });
  const hints = [makeElement('- Increase to improve image clarity.'), makeElement('Already clean'), makeElement('  - Spaced dash'),
    makeElement('A - B in the middle'), makeElement('')];
  const title = makeElement('old');
  let selectedLabel = makeElement('Video Settings');
  const context = {
    document: {
      querySelector: (selector) => (selector === '.settings-category.selected label' ? selectedLabel : null),
      getElementById: (id) => (id === 'settings-title' ? title : null),
      querySelectorAll: (selector) => (selector === '.settings-options .mdl-list__item-text-body' ? hints : [])
    }
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(index, 'updateSettingsTitle') + extractFunction(index, 'tidySettingHints'), context);
  context.updateSettingsTitle();
  assert.strictEqual(title.textContent, 'Video Settings');
  selectedLabel = null;
  context.updateSettingsTitle();
  assert.strictEqual(title.textContent, '', 'no category, no title');
  context.tidySettingHints();
  assert.deepStrictEqual(hints.map((hint) => hint.textContent),
    ['Increase to improve image clarity.', 'Already clean', 'Spaced dash', 'A - B in the middle', '']);
}
assert(/showSettingsMode[\s\S]*?tidySettingHints\(\);\s*updateSettingsTitle\(\);/.test(extractFunction(index, 'showSettingsMode')),
  'the hints and the title follow the language, because showSettingsMode runs again when it changes');
assert(/selectedCategory\.classList\.add\('selected'\);\s*updateSettingsTitle\(\);/.test(index), 'the title follows the chosen category');

// The old stylesheet of the settings is gone, and the header buttons no longer get its glow
assert(!/setting-option|settings-category|settings-options|settings-left-pane|diagnostic-|#selectResolution|mdl-switch__thumb[^}]*\{[^}]*74\.5rem/.test(style),
  'style.css has no rule of the old settings');
const glow = style.slice(style.indexOf('Interactive Elements'), style.indexOf('{', style.indexOf('Interactive Elements')));
for (const id of ['settingsBtn', 'supportBtn', 'goBackBtn', 'restoreDefaultsBtn', 'quitRunningAppBtn']) {
  assert(!glow.includes('#' + id), id + ' is a button of the new interface and has its own outline');
}
assert(glow.includes('#continueAddHost'), 'the dialogs keep theirs until they are redesigned');

// The look: a row is a grid with the control on the right and highlights as a whole
assert(/\.setting-option \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/.test(uiCss));
assert(/\.setting-option:has\(\.hovered, :focus, \.is-focused\) \{[^}]*border-color: var\(--ui-moon\)/.test(uiCss), 'the row is highlighted when its control is');
assert(/\.setting-option > div\[id\$="Menu"\] \{\s*grid-column: 2;/.test(uiCss));
assert(/\.settings-options \{[^}]*overflow-y: auto;/.test(uiCss), 'the options scroll and the title stays');
assert(/\.settings-category\.selected \{[^}]*background: var\(--ui-surface-raised\);/.test(uiCss));

// The switch is drawn by a track and a thumb that moves with a transform, and it is scoped to the settings (a dialog has its own)
assert(/\.settings-options \.mdl-switch\.is-checked \.mdl-switch__thumb \{[^}]*transform: translateX\(40px\)/.test(uiCss));
assert(/\.settings-options \.mdl-switch__thumb \{[^}]*transition: transform 0\.2s var\(--ui-ease\), background-color 0\.2s var\(--ui-ease\)/.test(uiCss));
assert(!/(^|\n)\.mdl-switch__(track|thumb)/.test(uiCss), 'a rule of the switch is not for every switch of the page');
assert(/\.settings-options \.mdl-switch\.hovered/.test(uiCss), 'the switch does not get the grey wash of a highlighted element');

// A menu: MDL sets its place and size inline, and the aligned side and width are set by the stylesheet
assert(/\.setting-option \.mdl-menu__container \{[^}]*right: 28px !important;[^}]*left: auto !important;[^}]*width: 520px !important;/.test(uiCss));
assert(/\.setting-option \.mdl-menu__container:has\(\.mdl-slider\) \{\s*width: 760px !important;/.test(uiCss), 'the menu of a slider is wider');
assert(/\.setting-option \.mdl-menu__item\.hovered/.test(uiCss));

console.log('settings_screen_tests: PASS');
