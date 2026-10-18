'use strict';

// The interface watches the controllers with a requestAnimationFrame loop to navigate its menus. The native input
// thread reads the same controllers during a stream, so the loop only costs the main thread work (a getGamepads()
// snapshot per frame and an event for every stick movement) and gets in the way of the video. It is paused while a
// stream is shown and resumed when the app list returns.

const assert = require('assert');
const fs = require('fs');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, 'Missing function ' + name);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('Unbalanced braces in ' + name);
}

// The controller counts what it did, so that the log can say how busy it was before it was paused.
const { createGamepadController } = require('../wasm/platform/gamepad.js');
const frames = [];
const listeners = {};
const pad = { index: 0, buttons: [{ pressed: false, value: 0 }], axes: [0] };
const environment = {
  navigator: { getGamepads() { return [pad]; } },
  document: { hidden: false },
  CustomEvent: function CustomEvent(type, options) { this.type = type; this.detail = options.detail; },
  requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
  cancelAnimationFrame() { frames.length = 0; },
  addEventListener(type, listener) { (listeners[type] || (listeners[type] = [])).push(listener); },
  dispatchEvent(event) { (listeners[event.type] || []).forEach((listener) => listener(event)); },
};
const controller = createGamepadController(environment);
assert.strictEqual(typeof controller.getStats, 'function', 'the controller reports what it did');
assert.deepStrictEqual(controller.getStats(), { polls: 0, events: 0 });
controller.startWatching();
frames.shift()(0);
pad.buttons[0] = { pressed: true, value: 1 };
frames.shift()(0);
pad.axes[0] = 0.5;
frames.shift()(0);
assert.deepStrictEqual(controller.getStats(), { polls: 3, events: 2 }, 'every frame is a poll, every change an event');
controller.stopWatching();

// Wiring in the interface.
const index = read('wasm/platform/index.js');

const showStreamMode = extractFunction(index, 'showStreamMode');
assert(/Controller\.stopWatching\(\)/.test(showStreamMode), 'the stream view pauses the interface gamepad loop');
assert(showStreamMode.indexOf('Controller.stopWatching()') > showStreamMode.indexOf('isInGame = true'),
  'it pauses together with entering the stream');
assert(/UI gamepad watching paused/.test(showStreamMode), 'the pause is written to the log, with what the loop did');

const showAppsMode = extractFunction(index, 'showAppsMode');
assert(/Controller\.startWatching\(\)/.test(showAppsMode), 'the app list resumes the loop');
assert(showAppsMode.indexOf('Controller.startWatching()') > showAppsMode.indexOf('isInGame = false'),
  'it resumes after the stream is over');
assert(/UI gamepad watching resumed/.test(showAppsMode));

// Every place that can end up in the host list after a stream resumes it as well (starting is idempotent), so the
// pad can never be left without menu control.
const showHostsMode = extractFunction(index, 'showHostsMode');
assert(/Controller\.startWatching\(\)/.test(showHostsMode), 'the host list resumes the loop');

console.log('ui gamepad stream pause tests passed');
