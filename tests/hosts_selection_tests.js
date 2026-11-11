'use strict';

// Three things that the TV showed on the screen of the hosts and in the settings:
// - a computer that was switched off showed as online until the first request to it timed out, because the state of the last
//   session was loaded with the host;
// - the row starts with the add host card alone and marked; the first host took its place in the selection while the mark stayed,
//   so two cards were highlighted;
// - the Game Mode setting was still shown in the ForceGM variant, where it does not apply.

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const index = read('wasm/platform/index.js');
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

// A host that is loaded from the storage is not known to be online, and a card shows no status until the host answered
assert(/Object\.assign\(revivedHost, hosts\[hostUID\]\);[\s\S]*?revivedHost\.online = null;[\s\S]*?addHostToGrid\(revivedHost\);/.test(index));
assert(/else if \(host\.online === false\) \{\s*state = 'offline';/.test(extractFunction(index, 'updateHostStatusIndicator')), 'only a host that did not answer is offline');
assert(/host\.online === true \? t\('ONLINE'\) : t\('OFFLINE'\)/.test(index), 'the details say online only for a host that answered');
assert(!/escapeHTML\(host\.online\)/.test(index));

// A card that is chosen before its host answered waits for the answer, instead of telling that the host is offline
{
  const chosen = extractFunction(index, 'hostChosen');
  assert(/if \(host\.online == null && hostStatusChecks\[host\.serverUid\]\) \{\s*isHostOpening = false;\s*hostStatusChecks\[host\.serverUid\]\.then\(function\(\) \{\s*if \(host\.online != null\) \{\s*hostChosen\(host, onSuccessCallback\);/.test(chosen));
  assert(chosen.indexOf('host.online == null') < chosen.indexOf('if (!host.online)'), 'before the host is taken as offline');
  const polling = extractFunction(index, 'beginBackgroundPollingOfHost');
  assert(/var statusCheck = host\.refreshServerInfo\(\)/.test(polling) && /hostStatusChecks\[serverUid\] = statusCheck;\s*return statusCheck;/.test(polling));
}

// The selection of the row of hosts, run against a small fake of the page
{
  class Card {
    constructor(id) {
      this.id = id;
      this.classes = new Set();
      const classes = this.classes;
      this.classList = { contains: (name) => classes.has(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name) };
    }
  }
  const grid = [];
  const context = {
    document: { activeElement: null },
    Views: { Hosts: { view: { index: 0, func: () => grid } } },
    mark: (card) => card.classList.add('hovered'),
    unmark: (card) => card.classList.remove('hovered'),
    focusElement: (card) => { context.document.activeElement = card; },
    Math: Math, Array: Array
  };
  vm.createContext(context);
  vm.runInContext(extractFunction(index, 'selectHostCard'), context);
  const marked = () => grid.filter((card) => card.classList.contains('hovered')).map((card) => card.id);

  // The application starts: the add host card is alone, marked and focused
  const addCard = new Card('addHostContainer');
  grid.push(addCard);
  context.mark(addCard);
  context.document.activeElement = addCard;

  // The stored host arrives a moment later and is put before the add host card (what addHostToGrid does around the insertion)
  const insert = (card, takesSelection) => {
    const before = grid.slice();
    const selectedBefore = before[context.Views.Hosts.view.index];
    grid.splice(grid.indexOf(addCard), 0, card);
    context.selectHostCard(takesSelection ? grid.indexOf(card) : grid.indexOf(selectedBefore));
  };
  const first = new Card('host-container-1');
  insert(first, true);
  assert.deepStrictEqual(marked(), ['host-container-1'], 'one card is highlighted: the host, not the add host card too');
  assert.strictEqual(context.Views.Hosts.view.index, 0);
  assert.strictEqual(context.document.activeElement, first, 'the focus moved with the mark');

  // A second host that is found later does not take the selection, and the card that had it keeps it
  const second = new Card('host-container-2');
  insert(second, false);
  assert.deepStrictEqual(marked(), ['host-container-1']);
  assert.strictEqual(context.Views.Hosts.view.index, 0);

  // The user is on the add host card when a host is found: the selection stays on the add host card, which moved one place on
  context.selectHostCard(2);
  assert.deepStrictEqual(marked(), ['addHostContainer']);
  const third = new Card('host-container-3');
  insert(third, false);
  assert.deepStrictEqual(marked(), ['addHostContainer']);
  assert.strictEqual(grid[context.Views.Hosts.view.index], addCard, 'the A button acts on the card that is highlighted');

  // A row that shows no mark (another view has the controls) gets none, and the place is kept within the row
  context.unmark(addCard);
  context.document.activeElement = null;
  context.selectHostCard(99);
  assert.deepStrictEqual(marked(), []);
  assert.strictEqual(context.Views.Hosts.view.index, grid.length - 1);
  assert.strictEqual(context.document.activeElement, null);
}

// addHostToGrid keeps the selection in step with the row, and the host that was opened last is found by the id of its card
{
  const addHost = extractFunction(index, 'addHostToGrid');
  assert(/var cardsBefore = Array\.prototype\.slice\.call\(Views\.Hosts\.view\.func\(\)\);\s*var selectedBefore = cardsBefore\[Views\.Hosts\.view\.index\];\s*\$\('#addHostContainer'\)\.before\(hostContainer\);/.test(addHost));
  assert(/var isFirstHost = cardsBefore\.length <= 1;/.test(addHost));
  assert(/var isLastOpenedHost = !isHostsLoaded && localStorage\.getItem\('lastOpenedHost'\) === String\(host\.serverUid\);/.test(addHost));
  assert(/var selectedAfter = \(isFirstHost \|\| isLastOpenedHost\) \? cardsAfter\.indexOf\(hostContainer\[0\]\) : cardsAfter\.indexOf\(selectedBefore\);\s*selectHostCard\(selectedAfter >= 0 \? selectedAfter : 0\);/.test(addHost));
  const showHosts = extractFunction(index, 'showHosts');
  assert(/children\[i\]\.id === 'host-container-' \+ lastOpenedHost\) \{\s*selectHostCard\(i\);/.test(showHosts));
  assert(!/'host-' \+ lastOpenedHost/.test(index), 'not by the id of a part of the card, which is never a card of the row');
}

// The ForceGM variant: the Game Mode switch is off, its row is hidden, the navigation skips it, and the stored choice is not touched
{
  const load = extractFunction(index, 'loadUserDataCb');
  const gameMode = load.slice(load.indexOf("getData('gameMode'"), load.indexOf("getData('gameMode'") + 1200);
  assert(/const isForceGMVariant = checkForceGMVariant\(\);\s*if \(isForceGMVariant\) \{[\s\S]*?document\.querySelector\('#gameModeBtn'\)\.MaterialSwitch\.off\(\);\s*\$\('#gameModeMenu'\)\.closest\('\.setting-option'\)\.addClass\('hide-container'\);\s*return;\s*\}/.test(gameMode));
  assert(!/storeData\('gameMode'/.test(gameMode.slice(0, gameMode.indexOf('return;'))), 'the choice of the standard variant stays stored');
  assert(/\.hide-container \{\s*display: none !important;/.test(uiCss));
  // The stream reads the switch, so a switch that is off is a stream without the setting
  assert(/const gameMode = \$\('#gameModeSwitch'\)\.parent\(\)\.hasClass\('is-checked'\) \? 1 : 0;/.test(index));

  assert(/'fullRangeBtn',\s*'gameModeBtn'\s*\]\.filter\(\(id\) => !isSettingRowHidden\(id\)\)\),/.test(navigation));
  const rows = {
    gameModeBtn: { closest: () => ({ classList: { contains: (name) => name === 'hide-container' && rows.hidden } }) },
    hdrModeBtn: { closest: () => ({ classList: { contains: () => false } }) }
  };
  const context = { document: { getElementById: (id) => rows[id] || null } };
  vm.createContext(context);
  vm.runInContext(extractFunction(navigation, 'isSettingRowHidden'), context);
  rows.hidden = true;
  assert.strictEqual(context.isSettingRowHidden('gameModeBtn'), true);
  assert.strictEqual(context.isSettingRowHidden('hdrModeBtn'), false);
  assert.strictEqual(context.isSettingRowHidden('missing'), false);
  rows.hidden = false;
  assert.strictEqual(context.isSettingRowHidden('gameModeBtn'), false, 'the standard variant shows the row');
}

console.log('hosts_selection_tests: PASS');
