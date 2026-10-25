'use strict';

// The TV follows the Enter key of the remote with a native click. The handler stops that click for every element, because the
// interface clicks by itself and a second click would press a button twice. A text field is let through: the native click is
// what opens the on-screen keyboard, and a click that a script makes does not (the keyboard did not open for the text field of the
// Add Host dialog after the click was stopped for it).

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const remote = read('wasm/platform/remote_controller.js');
const index = read('wasm/platform/index.js');

function press(keyCode, activeElement) {
  const calls = [];
  const context = {
    tvKey: { KEY_UP: 38, KEY_DOWN: 40, KEY_LEFT: 37, KEY_RIGHT: 39, KEY_ENTER: 13, KEY_REMOTE_ENTER: 32, KEY_RETURN: 10009 },
    Navigation: {
      up: () => calls.push('up'), down: () => calls.push('down'), left: () => calls.push('left'), right: () => calls.push('right'),
      accept: () => calls.push('accept'), back: () => calls.push('back')
    },
    isGamepadActive: true,
    document: { activeElement }
  };
  vm.createContext(context);
  vm.runInContext(remote, context);
  let prevented = false;
  context.remoteControllerHandler({ keyCode, preventDefault: () => { prevented = true; } });
  return { prevented, calls, gamepadActive: context.isGamepadActive };
}

const button = { tagName: 'BUTTON', type: 'button' };
const checkbox = { tagName: 'INPUT', type: 'checkbox' };
const textField = (extra) => Object.assign({ tagName: 'INPUT', type: 'text', readOnly: true }, extra);

for (const key of [13, 32]) {
  const onButton = press(key, button);
  assert.strictEqual(onButton.prevented, true, 'Enter on a button stops the native click, key ' + key);
  assert.deepStrictEqual(onButton.calls, ['accept']);

  assert.strictEqual(press(key, checkbox).prevented, true, 'a switch is a button too');
  assert.strictEqual(press(key, null).prevented, true, 'nothing has the focus');
  assert.strictEqual(press(key, undefined).prevented, true);

  const onField = press(key, textField());
  assert.strictEqual(onField.prevented, false, 'Enter on a text field keeps the native click, key ' + key);
  assert.deepStrictEqual(onField.calls, ['accept'], 'and still selects the item');
  assert.strictEqual(press(key, textField({ readOnly: false })).prevented, false, 'also while the field is open');
  for (const type of ['search', 'tel', 'url', 'email', 'password', 'number']) {
    assert.strictEqual(press(key, textField({ type })).prevented, false, type + ' opens the keyboard too');
  }
}

// The other keys are untouched, and a key of the remote still tells that the remote is the input in use
assert.deepStrictEqual(press(38, button).calls, ['up']);
assert.deepStrictEqual(press(10009, textField()).calls, ['back']);
assert.strictEqual(press(38, button).prevented, false);
assert.strictEqual(press(13, textField()).gamepadActive, false);

// What the TV does with the text field of the Add Host dialog is written to the log, so that a keyboard that does not open leaves a trace
assert(/\$\('#ipAddressTextInput'\)\.on\('focus click blur', function\(event\) \{\s*const nativeEvent = event\.originalEvent \|\| event;\s*logDiagnostic\('Add Host text field: ' \+ event\.type \+ ' trusted=' \+ nativeEvent\.isTrusted \+ ' readOnly=' \+ this\.readOnly\);/.test(index));

console.log('remote_controller_tests: PASS');
