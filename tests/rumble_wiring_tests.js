'use strict';

// Rumble from the host: the control stream thread drops repeats and posts the rest to the interface without waiting
// (plain numbers, never a pointer to a string that is gone by the time the call runs), the interface applies the latest
// value at most every 50 ms, and the stream end silences the controllers.

const assert = require('assert');
const fs = require('fs');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function extractBraced(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, 'Missing ' + marker);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(source.indexOf('{', start) + 1, index);
    }
  }
  throw new Error('Unbalanced braces after ' + marker);
}

const html = read('wasm/index.html');
const gamepad = read('wasm/gamepad.cpp');
const header = read('wasm/moonlight_wasm.hpp');
const index = read('wasm/platform/index.js');
const messages = read('wasm/platform/messages.js');

assert(html.indexOf('platform/rumble.js') > 0 && html.indexOf('platform/rumble.js') < html.indexOf('platform/index.js'),
  'rumble.js loads before index.js');
assert(/#include "rumble_dedupe\.hpp"/.test(header));

// Native side.
const rumble = extractBraced(gamepad, 'void MoonlightInstance::ClControllerRumble(');
// ClControllerRumble is a static member function of the instance class: it has no this
assert(/static void ClControllerRumble\(/.test(header));
assert(/s_RumbleDedupe\.ShouldPost\(controllerNumber, lowFreqMotor, highFreqMotor\)/.test(rumble), 'repeats are dropped');
assert(/MAIN_THREAD_ASYNC_EM_ASM\(/.test(rumble), 'the control stream thread does not wait for the interface');
assert(!/PostToJs\(/.test(rumble) && !/c_str\(\)/.test(rumble),
  'an asynchronous call must not carry a pointer to a string that is destroyed when this function returns');
assert(/handleRumble\(\$0, \$1, \$2\)/.test(rumble), 'the numbers are passed as they came');
assert(/controllerNumber, lowFreqMotor, highFreqMotor\)/.test(rumble.slice(rumble.indexOf('MAIN_THREAD_ASYNC_EM_ASM'))));
const handle = extractBraced(gamepad, 'void MoonlightInstance::HandleGamepadInputState(');
assert(/s_RumbleDedupe\.Reset\(\)/.test(handle), 'a new stream starts silent');

// Interface side.
assert(/var rumbleThrottle = RumbleThrottle\.create\(/.test(index));
const play = index.slice(index.indexOf('var rumbleThrottle = RumbleThrottle.create('));
assert(/playEffect\('dual-rumble', \{/.test(play.slice(0, 1800)), 'the effect is the same as before');
assert(/duration: 5000/.test(play.slice(0, 1800)));
assert(/function handleRumble\(controllerNumber, lowFreqMotor, highFreqMotor\)/.test(index));
const handleRumble = extractBraced(index, 'function handleRumble(');
assert(/highFreqMotor \/ 65535/.test(handleRumble) && /lowFreqMotor \/ 65535/.test(handleRumble),
  'the motors map to the weak and strong magnitudes as the native side did: high is weak, low is strong');
assert(/rumbleThrottle\.update\(/.test(handleRumble));

// The old text message still works and goes through the same throttle, without a console line per message.
const branch = messages.slice(messages.indexOf("msg.indexOf('controllerRumble: ') === 0"), messages.indexOf("msg.indexOf('mouseEmulationOn') === 0"));
assert(/rumbleThrottle\.update\(/.test(branch));
assert(!/playEffect/.test(branch) && !/console\./.test(branch), 'no effect started and no console line per message');

// The end of the stream silences the controllers and writes what the throttle did.
const showAppsMode = extractBraced(index, 'function showAppsMode(');
assert(/rumbleThrottle\.stopAll\(\)/.test(showAppsMode));
assert(/logDiagnostic\(rumbleThrottle\.describe\(\)\)/.test(showAppsMode));

console.log('rumble wiring tests passed');
