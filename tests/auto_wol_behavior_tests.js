const assert = require('assert');
const fs = require('fs');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert(start >= 0, 'Missing function: ' + signature);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('Unterminated function: ' + signature);
}

function testWakeOnLanRunsOffTheMainThreadAndSettlesItsPromise() {
  const source = fs.readFileSync('wasm/main.cpp', 'utf8');
  const publicMethod = extractFunction(source, 'void MoonlightInstance::WakeOnLan(');
  const privateMethod = extractFunction(source, 'void MoonlightInstance::WakeOnLan_private(');

  assert.match(publicMethod, /m_Dispatcher\.post_job/,
    'Wake-on-LAN must leave the Tizen main thread before using socket APIs');
  assert.doesNotMatch(publicMethod, /socket\s*\(/,
    'the public entry point must not create sockets on the main thread');
  assert.match(privateMethod, /PostPromiseMessage\(callbackId, "reject"/,
    'native Wake-on-LAN failures must reject the JavaScript promise');
  assert.match(privateMethod, /PostPromiseMessage\(callbackId, "resolve"/,
    'a successful Wake-on-LAN request must resolve the JavaScript promise');
  assert.match(privateMethod, /default zero MAC address not allowed/,
    'the placeholder zero MAC must be rejected before opening a socket');
}

function testAutoWakeOnLanIsHostScopedAndCancellationSafe() {
  const html = fs.readFileSync('wasm/index.html', 'utf8');
  const index = fs.readFileSync('wasm/platform/index.js', 'utf8');
  const navigation = fs.readFileSync('wasm/platform/navigation.js', 'utf8');
  const utils = fs.readFileSync('wasm/static/js/utils.js', 'utf8');

  assert.match(html, /id="autoWolDialog"/);
  assert.match(html, /id="autoWolCheckboxSwitch"/);
  assert.match(navigation, /AutoWolDialog/);
  assert.match(utils, /this\.autoWolEnabled = false/,
    'the Auto WOL preference belongs to an individual host');
  assert.match(index, /host\.autoWolEnabled === true/);
  assert.match(index, /autoWolGenerationGate = OperationGuard\.createGenerationGate\(\)/,
    'dialog work must use the shared generation guard pattern');
  assert.match(index, /autoWolGenerationGate\.isCurrent/,
    'late Wake-on-LAN scans and polls must be ignored after cancellation');
  assert.match(index, /var errorMessage = '';/,
    'the failure message must remain available to the dialog close handler');
  assert.match(index, /autoWolDialog\(host,[\s\S]*?\n\s*return;\n\s*}/,
    'opening Auto WOL must not also show the ordinary offline-host failure path');
}

function main() {
  testWakeOnLanRunsOffTheMainThreadAndSettlesItsPromise();
  testAutoWakeOnLanIsHostScopedAndCancellationSafe();
  console.log('auto_wol_behavior_tests: PASS');
}

main();
