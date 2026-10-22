const assert = require('assert');
const fs = require('fs');
const path = require('path');

function createFakeBrowser() {
  const listeners = Object.create(null);
  const pendingFrames = new Map();
  const gamepad = {
    index: 0,
    buttons: [{ pressed: false, value: 0 }],
    axes: [0],
  };
  let nextFrameId = 1;

  const fake = {
    gamepads: [gamepad],
    webkitGetGamepadsCalls: 0,
    hidden: false,
    navigator: {
      webkitGetGamepads() {
        assert.strictEqual(this, fake.navigator, 'webkitGetGamepads keeps navigator as its receiver');
        fake.webkitGetGamepadsCalls += 1;
        return fake.gamepads;
      },
    },
    document: {
      get hidden() {
        return fake.hidden;
      },
    },
    CustomEvent: function CustomEvent(type, options) {
      this.type = type;
      this.detail = options.detail;
    },
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      pendingFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      pendingFrames.delete(id);
    },
    addEventListener(type, listener) {
      (listeners[type] || (listeners[type] = [])).push(listener);
    },
    dispatchEvent(event) {
      (listeners[event.type] || []).slice().forEach((listener) => listener(event));
    },
    emit(type, event) {
      (listeners[type] || []).slice().forEach((listener) => listener(event));
    },
    pendingFrameCount() {
      return pendingFrames.size;
    },
    listenerCount(type) {
      return (listeners[type] || []).length;
    },
    runFrame() {
      assert.strictEqual(pendingFrames.size, 1, 'exactly one animation frame must be pending');
      const [id, callback] = pendingFrames.entries().next().value;
      pendingFrames.delete(id);
      callback(0);
    },
    setHidden(hidden) {
      fake.hidden = hidden;
      fake.emit('visibilitychange', {});
    },
  };

  return fake;
}

function run() {
  const { createGamepadController, describeGamepad } = require('../wasm/platform/gamepad.js');
  assert.strictEqual(typeof createGamepadController, 'function', 'gamepad module exposes the injectable controller factory');

  // The log line of a connected pad names it and the vibration effects of the browser
  assert.strictEqual(
    describeGamepad({ id: 'Flydigi Vader 4 Pro (STANDARD GAMEPAD Vendor: 04b4 Product: 2412)', index: 1, mapping: 'standard',
      buttons: new Array(17), axes: [0, 0, 0, 0], vibrationActuator: { type: 'dual-rumble', effects: ['dual-rumble', 'trigger-rumble'] } }),
    'id="Flydigi Vader 4 Pro (STANDARD GAMEPAD Vendor: 04b4 Product: 2412)" index=1 mapping="standard" buttons=17 axes=4 ' +
      'vibrationEffects=dual-rumble,trigger-rumble (type dual-rumble)'
  );
  assert.strictEqual(
    describeGamepad({ id: 'pad', index: 0, mapping: '', buttons: [], axes: [], vibrationActuator: { type: 'dual-rumble' } }),
    'id="pad" index=0 mapping="" buttons=0 axes=0 vibrationEffects=not listed (type dual-rumble)',
    'a browser that does not list the effects says so'
  );
  assert.strictEqual(describeGamepad({ id: 'pad', index: 0, buttons: [], axes: [] }),
    'id="pad" index=0 mapping="" buttons=0 axes=0 vibrationEffects=none', 'a pad without an actuator says none');

  const fake = createFakeBrowser();
  const events = [];
  fake.addEventListener('gamepadinputchanged', (event) => events.push(event));
  const controller = createGamepadController(fake);

  controller.startWatching();
  controller.startWatching();
  assert.strictEqual(fake.pendingFrameCount(), 1, 'repeated starts leave one animation frame pending');
  assert.strictEqual(fake.listenerCount('gamepadconnected'), 1, 'connection listener installs once');
  assert.strictEqual(fake.listenerCount('gamepaddisconnected'), 1, 'disconnection listener installs once');
  assert.strictEqual(fake.listenerCount('visibilitychange'), 1, 'visibility listener installs once');

  fake.runFrame();
  assert.strictEqual(fake.webkitGetGamepadsCalls, 1, 'one WebKit gamepad read occurs per frame');

  fake.gamepads[0].buttons[0] = { pressed: true, value: 1 };
  fake.runFrame();
  assert.strictEqual(events[0].detail.changes[0].type, 'button', 'button edges dispatch input changes');

  fake.gamepads[0].axes[0] = 0.0005;
  fake.runFrame();
  assert.strictEqual(events.length, 1, 'axis movement within epsilon does not dispatch');

  fake.gamepads[0].axes[0] = 0.002;
  fake.runFrame();
  assert.strictEqual(events[1].detail.changes[0].type, 'axis', 'axis movement above epsilon dispatches');

  const connected = { index: 2, buttons: [{ pressed: false, value: 0 }], axes: [0] };
  fake.emit('gamepadconnected', { gamepad: connected });
  fake.gamepads[2] = connected;
  connected.buttons[0] = { pressed: true, value: 1 };
  fake.runFrame();
  assert.strictEqual(events[2].detail.changes[0].type, 'button', 'connection events establish a snapshot');
  fake.gamepads[2] = null;
  fake.emit('gamepaddisconnected', { gamepad: connected });
  fake.runFrame();
  assert.strictEqual(events.length, 3, 'disconnected pads no longer emit changes');

  const discovered = { index: 1, buttons: [{ pressed: false, value: 0 }], axes: [0] };
  fake.gamepads[1] = discovered;
  fake.runFrame();
  discovered.buttons[0] = { pressed: true, value: 1 };
  fake.runFrame();
  assert.strictEqual(events[3].detail.changes[0].type, 'button', 'polling discovers pads without connection events');

  fake.emit('gamepaddisconnected', { gamepad: discovered });
  discovered.buttons[0] = { pressed: false, value: 0 };
  fake.runFrame();
  assert.strictEqual(events.length, 4, 'event-disconnected pads are reinitialized without duplicate input');

  fake.gamepads[0] = null;
  fake.runFrame();
  fake.gamepads[0] = { index: 0, buttons: [{ pressed: false, value: 0 }], axes: [0] };
  fake.runFrame();
  fake.gamepads[0].buttons[0] = { pressed: true, value: 1 };
  fake.runFrame();
  assert.strictEqual(events.length, 5, 'missing pads are cleaned up before later reconnection');

  fake.setHidden(true);
  assert.strictEqual(fake.pendingFrameCount(), 0, 'hidden documents cancel the pending frame');
  fake.setHidden(false);
  assert.strictEqual(fake.pendingFrameCount(), 1, 'visible documents resume one frame');
  controller.stopWatching();
  controller.stopWatching();
  assert.strictEqual(fake.pendingFrameCount(), 0, 'repeated stops cancel all frames');
  controller.startWatching();
  assert.strictEqual(fake.pendingFrameCount(), 1, 'a stopped controller starts one new frame');
  assert.strictEqual(fake.listenerCount('gamepadconnected'), 1, 'restarting does not duplicate listeners');
  controller.stopWatching();
  assert.strictEqual(fake.pendingFrameCount(), 0, 'a restarted controller stops cleanly');

  // The stream menu watches the pads again in the middle of a stream, with a button of the pad still down (the Select that opened
  // it). The snapshots taken before the stream would report that as a press: after resync() the pads are looked at afresh
  const staleFake = createFakeBrowser();
  const staleEvents = [];
  staleFake.addEventListener('gamepadinputchanged', (event) => staleEvents.push(event));
  const staleController = createGamepadController(staleFake);
  staleController.startWatching();
  staleFake.runFrame();
  staleController.stopWatching();
  staleFake.gamepads[0].buttons[0] = { pressed: true, value: 1 };
  staleController.startWatching();
  staleFake.runFrame();
  assert.strictEqual(staleEvents.length, 1, 'without resync the old snapshot reports a button that went down in the meantime');
  staleController.stopWatching();

  const resyncFake = createFakeBrowser();
  const resyncEvents = [];
  resyncFake.addEventListener('gamepadinputchanged', (event) => resyncEvents.push(event));
  const resyncController = createGamepadController(resyncFake);
  resyncController.startWatching();
  resyncFake.runFrame();
  resyncController.stopWatching();
  resyncFake.gamepads[0].buttons[0] = { pressed: true, value: 1 };
  resyncController.resync();
  resyncController.startWatching();
  resyncFake.runFrame();
  assert.strictEqual(resyncEvents.length, 0, 'after resync a button that is down is not a change');
  resyncFake.gamepads[0].buttons[0] = { pressed: false, value: 0 };
  resyncFake.runFrame();
  assert.strictEqual(resyncEvents.length, 1, 'its release is a change');
  assert.deepStrictEqual(resyncEvents[0].detail.changes, [{ type: 'button', index: 0, pressed: false }]);
  resyncController.stopWatching();

  const hiddenFake = createFakeBrowser();
  hiddenFake.hidden = true;
  createGamepadController(hiddenFake).startWatching();
  assert.strictEqual(hiddenFake.pendingFrameCount(), 0, 'starting while hidden does not schedule a frame');

  const missingNavigatorFake = createFakeBrowser();
  delete missingNavigatorFake.navigator;
  const missingNavigatorController = createGamepadController(missingNavigatorFake);
  let missingNavigatorError = null;
  missingNavigatorController.startWatching();
  try {
    missingNavigatorFake.runFrame();
  } catch (error) {
    missingNavigatorError = error;
  }
  const missingNavigatorPending = missingNavigatorFake.pendingFrameCount();
  missingNavigatorController.stopWatching();

  const throwingFake = createFakeBrowser();
  const throwingEvents = [];
  let throwNextRead = true;
  throwingFake.navigator.webkitGetGamepads = function() {
    assert.strictEqual(this, throwingFake.navigator, 'throwing WebKit API keeps navigator as its receiver');
    throwingFake.webkitGetGamepadsCalls += 1;
    if (throwNextRead) {
      throwNextRead = false;
      throw new Error('temporary gamepad API failure');
    }
    return throwingFake.gamepads;
  };
  throwingFake.addEventListener('gamepadinputchanged', (event) => throwingEvents.push(event));
  const throwingController = createGamepadController(throwingFake);
  let throwingError = null;
  throwingController.startWatching();
  try {
    throwingFake.runFrame();
  } catch (error) {
    throwingError = error;
  }
  const callsAfterFailedFrame = throwingFake.webkitGetGamepadsCalls;
  const pendingAfterFailedFrame = throwingFake.pendingFrameCount();
  let callsAfterRecoveryFrame = null;
  let pendingAfterRecoveryFrame = null;
  let recoveredEventType = null;
  if (pendingAfterFailedFrame === 1) {
    throwingFake.runFrame();
    callsAfterRecoveryFrame = throwingFake.webkitGetGamepadsCalls;
    pendingAfterRecoveryFrame = throwingFake.pendingFrameCount();
    throwingFake.gamepads[0].buttons[0] = { pressed: true, value: 1 };
    throwingFake.runFrame();
    recoveredEventType = throwingEvents[0] && throwingEvents[0].detail.changes[0].type;
  }
  throwingController.stopWatching();

  const dispatchStopFake = createFakeBrowser();
  let dispatchStopController = null;
  dispatchStopFake.addEventListener('gamepadinputchanged', () => dispatchStopController.stopWatching());
  dispatchStopController = createGamepadController(dispatchStopFake);
  dispatchStopController.startWatching();
  dispatchStopFake.runFrame();
  dispatchStopFake.gamepads[0].buttons[0] = { pressed: true, value: 1 };
  dispatchStopFake.runFrame();
  assert.strictEqual(dispatchStopFake.pendingFrameCount(), 0, 'stopping during dispatch leaves no scheduled frame');

  assert.deepStrictEqual(
    {
      missingNavigatorThrew: missingNavigatorError !== null,
      missingNavigatorPending,
      throwingApiThrew: throwingError !== null,
      callsAfterFailedFrame,
      pendingAfterFailedFrame,
      callsAfterRecoveryFrame,
      pendingAfterRecoveryFrame,
      recoveredEventType,
    },
    {
      missingNavigatorThrew: false,
      missingNavigatorPending: 1,
      throwingApiThrew: false,
      callsAfterFailedFrame: 1,
      pendingAfterFailedFrame: 1,
      callsAfterRecoveryFrame: 2,
      pendingAfterRecoveryFrame: 1,
      recoveredEventType: 'button',
    },
    'missing or temporarily throwing gamepad APIs keep one recoverable RAF loop'
  );

  const absentApiFake = createFakeBrowser();
  const absentApiEvents = [];
  absentApiFake.addEventListener('gamepadinputchanged', (event) => absentApiEvents.push(event));
  const absentApiController = createGamepadController(absentApiFake);
  absentApiController.startWatching();
  absentApiFake.runFrame();
  delete absentApiFake.navigator.webkitGetGamepads;
  absentApiFake.gamepads[0].buttons[0] = { pressed: true, value: 1 };
  absentApiFake.runFrame();
  const callsWhileApiAbsent = absentApiFake.webkitGetGamepadsCalls;
  const pendingWhileApiAbsent = absentApiFake.pendingFrameCount();
  absentApiFake.navigator.webkitGetGamepads = function() {
    assert.strictEqual(this, absentApiFake.navigator, 'restored WebKit API keeps navigator as its receiver');
    absentApiFake.webkitGetGamepadsCalls += 1;
    return absentApiFake.gamepads;
  };
  absentApiFake.runFrame();
  assert.deepStrictEqual(
    {
      callsWhileApiAbsent,
      pendingWhileApiAbsent,
      callsAfterRecovery: absentApiFake.webkitGetGamepadsCalls,
      recoveredEventType: absentApiEvents[0] && absentApiEvents[0].detail.changes[0].type,
    },
    {
      callsWhileApiAbsent: 1,
      pendingWhileApiAbsent: 1,
      callsAfterRecovery: 2,
      recoveredEventType: 'button',
    },
    'temporarily absent gamepad APIs preserve snapshots and recover on one next frame'
  );
  absentApiController.stopWatching();

  const emptyArrayFake = createFakeBrowser();
  const emptyArrayEvents = [];
  emptyArrayFake.addEventListener('gamepadinputchanged', (event) => emptyArrayEvents.push(event));
  const emptyArrayController = createGamepadController(emptyArrayFake);
  emptyArrayController.startWatching();
  emptyArrayFake.runFrame();
  emptyArrayFake.gamepads = [];
  emptyArrayFake.runFrame();
  emptyArrayFake.gamepads = [{
    index: 0,
    buttons: [{ pressed: true, value: 1 }],
    axes: [0],
  }];
  emptyArrayFake.runFrame();
  assert.strictEqual(emptyArrayEvents.length, 0, 'a valid empty gamepad array removes missing snapshots');
  assert.strictEqual(emptyArrayFake.webkitGetGamepadsCalls, 3, 'valid samples perform one gamepad read per frame');
  emptyArrayController.stopWatching();

  const nativeSource = fs.readFileSync(path.join(__dirname, '../wasm/gamepad.cpp'), 'utf8');
  const pollStart = nativeSource.indexOf('bool MoonlightInstance::PollGamepads()');
  const pollEnd = nativeSource.indexOf('// Function to send controller rumble feedback', pollStart);
  assert(pollStart >= 0 && pollEnd > pollStart, 'PollGamepads implementation is present');
  const pollGamepads = nativeSource.slice(pollStart, pollEnd);
  assert.strictEqual(
    (pollGamepads.match(/SampleGamepadSlots\(/g) || []).length,
    1,
    'PollGamepads samples native gamepad data once, for all slots, before its controller loop'
  );
  const perCallStart = nativeSource.indexOf('static GamepadSample SampleGamepadSlotsPerCall(');
  const perCallEnd = nativeSource.indexOf('bool MoonlightInstance::PollGamepads()', perCallStart);
  assert(perCallStart >= 0 && perCallEnd > perCallStart, 'the per-call fallback is present');
  assert.strictEqual(
    (nativeSource.slice(perCallStart, perCallEnd).match(/emscripten_sample_gamepad_data\(\)/g) || []).length,
    1,
    'the per-call fallback also samples native gamepad data once per poll'
  );

  console.log('gamepad_polling_tests: PASS');
}

run();
