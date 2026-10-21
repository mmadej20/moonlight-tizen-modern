'use strict';

// The controller state is sent to the host when it changes (and as a reminder every 100 ms) instead of on every poll.
// These tests pin where the filter sits in the poll, that exactly the checked state is the one that is sent, and
// when the filter forgets what it sent.

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

const gamepad = read('wasm/gamepad.cpp');
const header = read('wasm/moonlight_wasm.hpp');

assert(/#include "controller_send_filter\.hpp"/.test(header), 'the filter is part of the instance header');
assert(/static ControllerSendFilter s_ControllerSendFilter;/.test(gamepad), 'one filter serves the input thread');

const poll = extractBraced(gamepad, 'bool MoonlightInstance::PollGamepads()');

// The state that is compared is built from the very values that are sent.
const send = poll.slice(poll.indexOf('const ControllerState state'));
assert(/const ControllerState state\s*=?\s*\{?/.test(poll) || /ControllerState state\{/.test(poll), 'the state is built once per controller');
assert(/s_ControllerSendFilter\.ShouldSend\(gamepadID, state, MonotonicNowMs\(\)\)/.test(poll),
  'the filter decides with a monotonic clock');
const sendCall = /LiSendMultiControllerEvent\(\s*gamepadID,\s*state\.activeMask,\s*state\.buttonFlags,\s*state\.leftTrigger,\s*state\.rightTrigger,\s*state\.leftStickX,\s*state\.leftStickY,\s*state\.rightStickX,\s*state\.rightStickY\s*\)/;
assert(sendCall.test(poll), 'the call sends exactly the fields that were compared');
assert(!/LiSendMultiControllerEvent\(\s*gamepadID,\s*activeGamepadMask,\s*buttonFlags/.test(poll),
  'the old unconditional call is gone');

// Mouse emulation keeps its own events, and the removed-controller event is still unconditional.
assert(/LiSendMouseMoveEvent\(/.test(poll));
assert(/LiSendMultiControllerEvent\(i, activeGamepadMask & ~\(1 << i\), 0, 0, 0, 0, 0, 0, 0\);/.test(poll),
  'the zeroed state of a controller that left is always sent');

// The filter forgets what it sent when the host's picture of the controller changes.
const removal = poll.slice(poll.indexOf('for (int i : removed)'), poll.indexOf('for (int i : arrived)'));
assert(/s_ControllerSendFilter\.Reset\(i\)/.test(removal), 'a controller that left is forgotten');
const arrival = poll.slice(poll.indexOf('for (int i : arrived)'), poll.indexOf('// Process live input'));
assert(/s_ControllerSendFilter\.Reset\(i\)/.test(arrival), 'a controller that arrived starts with a fresh state');
const handle = extractBraced(gamepad, 'void MoonlightInstance::HandleGamepadInputState(');
assert(/s_ControllerSendFilter\.ResetAll\(\)/.test(handle), 'a new stream starts with a fresh state');

console.log('controller filter wiring tests passed');
