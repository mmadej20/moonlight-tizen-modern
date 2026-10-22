'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const html = read('wasm/index.html');
const index = read('wasm/platform/index.js');
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
assert.strictEqual(emptyHints.length, 5, 'only the removal of the hosts, the system information and three rows of the logs (port, clear, session) have no hint');
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

// The old stylesheet is gone with the rules of the settings and the glow that the header buttons got from it
assert(!fs.existsSync('wasm/static/css/style.css'));
assert(!/#selectResolution|74\.5rem/.test(uiCss), 'nothing of the old settings is left in the new stylesheet');

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

// The diagnostic logs: the switch is the first row and the only one while it is off, the fields of the receiver type only after A,
// and the two buttons of the session are one control
const navigation = read('wasm/platform/navigation.js');
const diagnostic = navigation.slice(navigation.indexOf('  DiagnosticSettings: {'), navigation.indexOf('  AboutSettings: {'));
assert(/options && options\.classList\.contains\('hide-container'\)\) \{\s*return \['diagnosticLogsEnabledBtn'\];/.test(diagnostic), 'switched off, the switch is all there is');
assert(/return \[\s*'diagnosticLogsEnabledBtn',\s*'diagnosticHost',\s*'diagnosticPort',\s*'sendDiagnosticLogsBtn',\s*'clearDiagnosticLogsBtn',\s*'diagnosticCurrentSessionBtn',\s*'diagnosticLogViewport'\s*\];/.test(diagnostic));
assert(!/diagnosticFilter/.test(diagnostic + index));
assert(/if \(finishDiagnosticEdit\(\)\) \{\s*return;\s*\}\s*if \(current === 'diagnosticHost' \|\| current === 'diagnosticPort'\) \{\s*startDiagnosticEdit\(current\);/.test(diagnostic), 'A closes an open field and opens the one that has the mark');
assert(/back: function\(\) \{\s*\/\/ B first closes an open field\s*if \(finishDiagnosticEdit\(\)\) \{\s*return;/.test(diagnostic), 'B closes the field before it leaves the page');
assert(/leave: function\(\) \{\s*finishDiagnosticEdit\(\);/.test(diagnostic), 'leaving the page closes the field');
assert(/up: function\(\) \{[^]*?if \(diagnosticEdit\.field\) \{\s*changeDiagnosticCell\(1\);\s*return;/.test(diagnostic), 'Up raises the number of an open field');
assert(/down: function\(\) \{\s*if \(diagnosticEdit\.field\) \{\s*changeDiagnosticCell\(-1\);\s*return;/.test(diagnostic), 'Down lowers it');
assert(/left: function\(\) \{[^]*?if \(diagnosticEdit\.field\) \{\s*moveDiagnosticCell\(-1\);\s*return;\s*\}\s*if \(this\.view\.current\(\) === 'diagnosticCurrentSessionBtn'\) \{\s*clickElement\('diagnosticCurrentSessionBtn'\);/.test(diagnostic));
assert(/right: function\(\) \{\s*if \(diagnosticEdit\.field\) \{\s*moveDiagnosticCell\(1\);\s*return;\s*\}\s*if \(this\.view\.current\(\) === 'diagnosticCurrentSessionBtn'\) \{\s*clickElement\('diagnosticPreviousSessionBtn'\);/.test(diagnostic));
assert(!/readOnly|\.click\(\)|handleDiagnosticFieldState/.test(diagnostic), 'there is no field of text and no keyboard in the logs');
{
  // The numbers of the receiver, on a page of two fields: four cells for the host and five digits for the port
  const makeField = (id, count) => {
    const classes = new Set();
    const cells = Array.from({ length: count }, () => {
      const set = new Set();
      return { classList: { toggle: (name, on) => (on ? set.add(name) : set.delete(name)), add: (name) => set.add(name), remove: (name) => set.delete(name), has: (name) => set.has(name) } };
    });
    return { id, cells, classes, classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) }, querySelectorAll: () => cells };
  };
  const fields = { diagnosticHost: makeField('diagnosticHost', 4), diagnosticPort: makeField('diagnosticPort', 5) };
  const log = [];
  const context = {
    document: { getElementById: (id) => fields[id] || null },
    DiagnosticLogs: { stepReceiverCell: (...args) => log.push(['step', ...args]), finishReceiverEdit: () => log.push(['finish']) },
    Array
  };
  vm.createContext(context);
  vm.runInContext("const hoveredClassName = 'hovered'; const diagnosticEdit = { field: null, cell: 0 };", context);
  for (const name of ['diagnosticCells', 'markDiagnosticCell', 'startDiagnosticEdit', 'finishDiagnosticEdit', 'moveDiagnosticCell', 'changeDiagnosticCell']) {
    vm.runInContext(extractFunction(navigation, name), context);
  }
  const marked = (field) => field.cells.map((cell) => cell.classList.has('hovered'));

  assert.strictEqual(context.finishDiagnosticEdit(), false, 'with no open field there is nothing to close, and the page may be left');
  assert.deepStrictEqual(log, []);
  context.startDiagnosticEdit('diagnosticHost');
  assert(fields.diagnosticHost.classes.has('editing'));
  assert.deepStrictEqual(marked(fields.diagnosticHost), [true, false, false, false], 'the mark starts on the first number');
  context.moveDiagnosticCell(1);
  context.moveDiagnosticCell(1);
  assert.deepStrictEqual(marked(fields.diagnosticHost), [false, false, true, false], 'Right moves the mark');
  context.moveDiagnosticCell(5);
  assert.deepStrictEqual(marked(fields.diagnosticHost), [false, false, false, true], 'and stops at the last number');
  context.moveDiagnosticCell(-9);
  assert.deepStrictEqual(marked(fields.diagnosticHost), [true, false, false, false], 'and at the first');
  context.moveDiagnosticCell(2);
  context.changeDiagnosticCell(1);
  context.changeDiagnosticCell(-1);
  assert.deepStrictEqual(log, [['step', 'diagnosticHost', 2, 1], ['step', 'diagnosticHost', 2, -1]], 'the number under the mark is the one that changes');
  log.length = 0;
  assert.strictEqual(context.finishDiagnosticEdit(), true, 'closing says that there was a field');
  assert(!fields.diagnosticHost.classes.has('editing'));
  assert.deepStrictEqual(marked(fields.diagnosticHost), [false, false, false, false], 'no number keeps its mark');
  assert.deepStrictEqual(log, [['finish']], 'the port is brought into its range when a field closes');
  assert.strictEqual(context.finishDiagnosticEdit(), false);

  context.startDiagnosticEdit('diagnosticPort');
  context.moveDiagnosticCell(4);
  assert.deepStrictEqual(marked(fields.diagnosticPort), [false, false, false, false, true], 'the port has five numbers');
}

// The selected number of the address of a host shows which one it is: the id selectors of the four numbers outweigh a class, so the
// color of the selected one is named by id too, and it differs from the color of the others
assert(/\.ip-address-select-field\.hovered, \.ip-address-select-field:hover,\s*#ipAddressField1\.hovered, #ipAddressField2\.hovered, #ipAddressField3\.hovered, #ipAddressField4\.hovered \{\s*border-color: var\(--ui-moon\);/.test(uiCss));
assert(/\.diagnostic-cells\.editing \.diagnostic-cell\.hovered \{\s*border-color: var\(--ui-moon\);\s*background: var\(--ui-surface-raised\);\s*outline: 6px solid var\(--ui-ring\);/.test(uiCss), 'the number that is open shows it');

// The list of the options scrolls to the row that has the focus. The browser scrolls to the element that has it, but a switch is a
// box of no size at the start of its row, so a row that is cut in half still counts as visible: the row is kept in view instead
{
  const box = (top, bottom) => ({ top, bottom });
  const makeRow = (top, bottom) => {
    const row = { getBoundingClientRect: () => box(top, bottom), closest: (selector) => (/settings-options/.test(selector) ? list : row) };
    return row;
  };
  const list = { scrollTop: 100, getBoundingClientRect: () => box(200, 900) };
  const input = (row) => ({ closest: (selector) => (/setting-option/.test(selector) ? row : null) });
  const context = { resolveElement: (target) => target };
  vm.createContext(context);
  vm.runInContext(extractFunction(navigation, 'keepInView'), context);

  context.keepInView(input(makeRow(300, 400)));
  assert.strictEqual(list.scrollTop, 100, 'a row that is in view does not move the list');
  context.keepInView(input(makeRow(804, 914)));
  assert.strictEqual(list.scrollTop, 100 + (914 - 900 + 12), 'a row that is cut at the bottom is brought up, with a margin');
  list.scrollTop = 100;
  context.keepInView(input(makeRow(190, 300)));
  assert.strictEqual(list.scrollTop, 100 - (200 + 12 - 190), 'a row that is cut at the top is brought down, with a margin');
  context.keepInView(undefined);
  context.keepInView({});
  assert.strictEqual(list.scrollTop, 100 - 22, 'nothing to do for what is not an element or has no list around it');
}
assert(/ keepInView\(element\);\s*return;/.test(extractFunction(navigation, 'focusElement')) && /\n  keepInView\(element\);\n\}/.test(extractFunction(navigation, 'focusElement')), 'every focus keeps the row in view');
assert(/closest\('\.settings-options, #settings-left-pane'\)/.test(extractFunction(navigation, 'keepInView')));

const manager = read('wasm/platform/diagnostic_logs.js');
assert(!/addEventListener\('(blur|keydown)'/.test(manager), 'no listener of the keyboard is left in the logs');
assert(/id="diagnosticSettings"[\s\S]*?<div id="diagnosticPort" class="diagnostic-cells"/.test(html));
assert(/\.setting-option > label:has\(\+ \.mdl-list__item-text-body:empty\) \{\s*grid-row: 1 \/ span 2;/.test(uiCss), 'a row without a hint centers its title');

console.log('settings_screen_tests: PASS');
