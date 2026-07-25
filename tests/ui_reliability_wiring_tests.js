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

console.log('ui_reliability_wiring_tests: PASS');
