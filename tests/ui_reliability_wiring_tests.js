const assert = require('assert');
const fs = require('fs');
const { ListView } = require('../wasm/platform/navigation.js');

const items = ['first', 'second'];
const view = new ListView(() => items);
view.index = 10;
assert.strictEqual(view.current(), 'second');
assert.strictEqual(view.index, 1);

const emptyView = new ListView(() => undefined);
assert.doesNotThrow(() => emptyView.current());
assert.strictEqual(emptyView.current(), undefined);
assert.doesNotThrow(() => emptyView.next());
assert.doesNotThrow(() => emptyView.prevOption());

const indexSource = fs.readFileSync('wasm/platform/index.js', 'utf8');
const navigationSource = fs.readFileSync('wasm/platform/navigation.js', 'utf8');
const messagesSource = fs.readFileSync('wasm/platform/messages.js', 'utf8');
const utilsSource = fs.readFileSync('wasm/static/js/utils.js', 'utf8');
const htmlSource = fs.readFileSync('wasm/index.html', 'utf8');
const nativeHeaderSource = fs.readFileSync('wasm/moonlight_wasm.hpp', 'utf8');
const nativeMainSource = fs.readFileSync('wasm/main.cpp', 'utf8');

assert.match(indexSource, /addHostGenerationGate/);
assert.match(indexSource, /pairingGenerationGate/);
assert.match(indexSource, /appsGenerationGate/);
assert.match(indexSource, /OperationGuard\.parseStoredJson/);
assert.match(indexSource, /Views\.Apps\.view\.reset\(\);[\s\S]*showAppsMode\(\);[\s\S]*resolve\(\[\]\)/);
assert.match(indexSource, /function stopGame\(host\)[\s\S]*return host\.refreshServerInfo/);
assert.match(navigationSource, /normalize\(\)/);
assert.doesNotMatch(utilsSource, /\.then\(this\.refreshServerInfo\(\)\)/);
assert.match(utilsSource, /\.then\(\(\)\s*=>\s*this\.refreshServerInfo\(\)\)/);
assert.doesNotMatch(indexSource, /setTimeout\(\(\)\s*=>\s*startGame\(host,\s*appID\),\s*3000\)/);
assert.match(messagesSource, /showApps\(api\)\.then/);
assert.doesNotMatch(messagesSource, /},\s*1500\);/);
assert.match(indexSource, /function handleShowAppsNavigationFailure\(error\)[\s\S]*OperationGuard\.isStaleOperationError/);
assert.strictEqual(
  (indexSource.match(/}, handleShowAppsNavigationFailure\);/g) || []).length,
  (indexSource.match(/showApps\(host\)\.then/g) || []).length
);
assert.match(messagesSource, /if\s*\(!OperationGuard\.isStaleOperationError\(error\)\)/);
assert(htmlSource.indexOf('platform/operation_guard.js') < htmlSource.indexOf('platform/index.js'));

assert.match(htmlSource, /id="speculativeRfiBtn"[\s\S]*for="speculativeRfiSwitch"/);
assert.match(htmlSource, /id="speculativeRfiSwitch"/);
assert.match(navigationSource, /'speculativeRfiBtn'/);
assert.match(indexSource, /#speculativeRfiSwitch'\)\.on\('click', saveSpeculativeRfi\)/);
assert.match(indexSource, /function saveSpeculativeRfi\(\)[\s\S]*storeData\('speculativeRfi'/);
assert.match(indexSource, /getData\('speculativeRfi'[\s\S]*#speculativeRfiBtn/);
assert.match(indexSource, /const defaultSpeculativeRfi = false;[\s\S]*storeData\('speculativeRfi', defaultSpeculativeRfi/);
assert.strictEqual(
  (indexSource.match(/performanceStats,\s*speculativeRfi/g) || []).length,
  2
);
assert.match(messagesSource, /performanceStats, speculativeRfi/);
assert.match(nativeHeaderSource, /bool disableWarnings, bool performanceStats, bool speculativeRfi/);
assert.match(nativeMainSource, /decoderCapabilitiesWithOptionalRfi\(/);
assert.match(nativeMainSource, /Experimental RFI recovery requested/);
assert.match(nativeMainSource, /Decoder renderer capabilities/);

console.log('ui_reliability_wiring_tests: PASS');
