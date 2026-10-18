'use strict';

// The input thread used to ask the main thread about each controller slot separately: 2 + N synchronous round trips
// every 5 ms, about 1200 per second with four slots and no controller at all. These tests pin the replacement: one
// call that fills every slot, a schedule that polls slowly while nothing is connected, and the telemetry around them.

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

const sampling = read('wasm/gamepad_sampling.hpp');
const gamepad = read('wasm/gamepad.cpp');
const main = read('wasm/main.cpp');
const header = read('wasm/moonlight_wasm.hpp');

// The JavaScript that runs on the main thread, taken from the C++ source and run against a fake browser.
const emAsmBody = extractBraced(sampling, 'MAIN_THREAD_EM_ASM_INT(');
const STRIDE = 1432; // sizeof(EmscriptenGamepadEvent) in this toolchain

function runSampler(overrides) {
  const filled = [];
  const environment = Object.assign({
    navigator: { getGamepads() { return []; } },
    fill: (pointer, pad) => filled.push({ pointer, pad }),
    base: 1000,
    stride: STRIDE,
    slots: 16,
  }, overrides);
  const sampler = new Function('navigator', '__fillGamepadEventData', '$0', '$1', '$2', emAsmBody);
  const result = sampler(environment.navigator, environment.fill, environment.base, environment.stride, environment.slots);
  return { result, filled };
}

// One call reports the slot count and which slots hold a controller, and fills exactly those slots.
const padA = { id: 'A', index: 0 };
const padC = { id: 'C', index: 2 };
let run = runSampler({ navigator: { getGamepads() { return [padA, null, padC, null]; } } });
assert.strictEqual(run.result, 4 | (0b0101 << 8), 'count in the low byte, present slots above it');
assert.deepStrictEqual(run.filled.map((entry) => entry.pointer), [1000, 1000 + 2 * STRIDE],
  'only present slots are filled, each at its own offset');
assert.strictEqual(run.filled[1].pad, padC, 'the controller of the slot is the one that gets written');

// Without controllers nothing is written and the answer still carries the slot count.
run = runSampler({ navigator: { getGamepads() { return [null, null, null, null]; } } });
assert.strictEqual(run.result, 4);
assert.strictEqual(run.filled.length, 0);

// More slots than the native array holds are ignored.
run = runSampler({ navigator: { getGamepads() { return new Array(20).fill(padA); } }, slots: 16 });
assert.strictEqual(run.result & 0xFF, 16, 'the count never exceeds the native slot array');
assert.strictEqual(run.filled.length, 16);

// The WebKit name of the API is still honoured, with the navigator as its receiver.
const webkit = { webkitGetGamepads() { assert.strictEqual(this, webkit); return [padA]; } };
run = runSampler({ navigator: webkit });
assert.strictEqual(run.result, 1 | (1 << 8));

// Nothing throws inside the proxied call, because an exception in a call that the main thread runs for a worker
// leaves that worker waiting for good. -1 says the bulk call cannot work in this build (the caller falls back to
// the per-call API), -2 says the browser threw (the caller skips the poll; the per-call API would throw as well).
run = runSampler({ navigator: {} });
assert.strictEqual(run.result, -1, 'no gamepad API');
run = runSampler({ navigator: { getGamepads() { throw new Error('denied'); } } });
assert.strictEqual(run.result, -2, 'the API throws');
run = runSampler({
  navigator: { getGamepads() { return [padA]; } },
  fill: () => { throw new Error('layout'); },
});
assert.strictEqual(run.result, -2, 'filling a slot throws');
const withoutFill = new Function('navigator', '$0', '$1', '$2', emAsmBody);
assert.strictEqual(withoutFill({ getGamepads() { return [padA]; } }, 1000, STRIDE, 16), -1,
  'the Emscripten helper is missing from this build');

// A line break inside a string literal does not compile (an edit script once turned the escape sequence for a new
// line in a log message into a real line break), so every line must close the quotes it opens.
[['wasm/gamepad.cpp', gamepad], ['wasm/gamepad_sampling.hpp', sampling]].forEach(([name, text]) => {
  text.split('\n').forEach((line, number) => {
    const code = line.replace(/\/\/.*$/, '').replace(/\\./g, '');
    assert.strictEqual((code.match(/"/g) || []).length % 2, 0, name + ':' + (number + 1) + ' has an unterminated string');
  });
});

// The native side makes that one call per poll and keeps the per-call API only as a fallback.
assert(/bool MoonlightInstance::PollGamepads\(\)/.test(gamepad), 'PollGamepads reports whether a controller is active');
assert(/bool PollGamepads\(\);/.test(header), 'the declaration matches');
const poll = extractBraced(gamepad, 'bool MoonlightInstance::PollGamepads()');
assert.strictEqual((poll.match(/SampleGamepadSlots\(/g) || []).length, 1, 'one bulk call per poll');
assert(!/emscripten_get_gamepad_status\(/.test(poll), 'the per-slot call is not in the poll itself');
assert(/emscripten_get_gamepad_status\(/.test(gamepad), 'the per-call API remains as the fallback');
assert(/Gamepad sampling/.test(gamepad), 'which sampling mode is used is written to the log');
assert(/if \(sample\.unavailable\)/.test(poll), 'only a bulk call that cannot work switches to the per-call API');
assert(/the browser failed to read the controllers/.test(poll), 'a browser failure is logged and the poll is skipped');
assert(!/EmscriptenGamepadEvent events\[kMaxControllers\]\{\}/.test(poll),
  'the slot array is not cleared on every poll, only present slots are read');

// Telemetry: how many controllers are in use and how many state packets were sent to the host.
assert(/m_StreamHealth\.SetActiveControllers\(/.test(poll), 'the active controller count is published');
assert((poll.match(/m_StreamHealth\.ControllerSent\(\)/g) || []).length >= 1, 'sent controller states are counted');

// The input thread polls on a schedule and only times the part that waits for the main thread.
const input = extractBraced(main, 'void* MoonlightInstance::InputThreadFunc(');
assert(/GamepadPollSchedule/.test(input), 'the poll schedule is used');
assert(/if \(schedule\.ShouldPoll\(\)\)/.test(input));
assert(/schedule\.Polled\(/.test(input));
const pollBlock = extractBraced(input, 'if (schedule.ShouldPoll())');
assert(/ScopedSection pollSection\(me->m_StreamHealth\.InputPoll\(\)\)/.test(pollBlock),
  'inputPoll* now measures the round trip to the main thread of one poll');
assert(/me->PollGamepads\(\)/.test(pollBlock));
assert(!/ReportMouseMovement/.test(pollBlock), 'mouse movement is still reported every round');
assert(/me->ReportMouseMovement\(\);/.test(input));
assert(/usleep\(5 \* 1000\)/.test(input), 'the round length stays 5 ms');

console.log('gamepad sampling wiring tests passed');
