function createGamepadController(environment) {
  var rafId = null;
  var watching = false;
  var listenersInstalled = false;
  var snapshots = Object.create(null);
  var axisEpsilon = 0.001;
  // What the loop did so far, so that the log can say how busy it was before it was paused for a stream
  var stats = { polls: 0, events: 0 };

  function createSnapshot(gamepad) {
    return {
      buttons: gamepad.buttons.map(function(button) { return button.pressed; }),
      axes: gamepad.axes.slice(),
    };
  }

  function updateSnapshot(snapshot, buttons, axes) {
    snapshot.buttons.length = buttons.length;
    snapshot.axes.length = axes.length;

    for (var i = 0; i < buttons.length; i++) {
      snapshot.buttons[i] = buttons[i].pressed;
    }
    for (var j = 0; j < axes.length; j++) {
      snapshot.axes[j] = axes[j];
    }
  }

  function dispatchChanges(changes) {
    stats.events += 1;
    environment.dispatchEvent(new environment.CustomEvent('gamepadinputchanged', {
      detail: { changes: changes },
    }));
  }

  function analyzeGamepad(gamepad) {
    var snapshot = snapshots[gamepad.index];
    if (!snapshot) {
      snapshots[gamepad.index] = createSnapshot(gamepad);
      return;
    }

    var changes = [];
    var buttons = gamepad.buttons;
    var axes = gamepad.axes;

    if (snapshot.buttons.length === buttons.length && snapshot.axes.length === axes.length) {
      for (var i = 0; i < buttons.length; i++) {
        if (snapshot.buttons[i] !== buttons[i].pressed) {
          changes.push({ type: 'button', index: i, pressed: buttons[i].pressed });
        }
      }

      for (var j = 0; j < axes.length; j++) {
        if (Math.abs(snapshot.axes[j] - axes[j]) > axisEpsilon) {
          changes.push({ type: 'axis', index: j, value: axes[j] });
        }
      }
    }

    updateSnapshot(snapshot, buttons, axes);
    if (changes.length > 0) {
      dispatchChanges(changes);
    }
  }

  function gamepadConnected(gamepad) {
    snapshots[gamepad.index] = createSnapshot(gamepad);
  }

  function gamepadDisconnected(gamepad) {
    delete snapshots[gamepad.index];
  }

  function readGamepads() {
    var navigator = environment.navigator;
    if (!navigator) {
      return null;
    }

    try {
      if (typeof navigator.getGamepads === 'function') {
        return navigator.getGamepads.call(navigator);
      }
      if (typeof navigator.webkitGetGamepads === 'function') {
        return navigator.webkitGetGamepads.call(navigator);
      }
    } catch (error) {
      return null;
    }

    return null;
  }

  function poll() {
    stats.polls += 1;
    var gamepads = readGamepads();
    if (!gamepads) {
      return;
    }
    var seen = Object.create(null);

    for (var i = 0; i < gamepads.length; i++) {
      var gamepad = gamepads[i];
      if (gamepad) {
        seen[gamepad.index] = true;
        analyzeGamepad(gamepad);
      }
    }

    Object.keys(snapshots).forEach(function(index) {
      if (!seen[index]) {
        delete snapshots[index];
      }
    });
  }

  function schedule() {
    if (watching && !environment.document.hidden && rafId === null) {
      rafId = environment.requestAnimationFrame(function() {
        rafId = null;
        if (watching && !environment.document.hidden) {
          try {
            poll();
          } finally {
            schedule();
          }
        }
      });
    }
  }

  function onVisibilityChange() {
    if (environment.document.hidden) {
      if (rafId !== null) {
        environment.cancelAnimationFrame(rafId);
        rafId = null;
      }
      return;
    }
    schedule();
  }

  function installListeners() {
    if (listenersInstalled) {
      return;
    }

    environment.addEventListener('gamepadconnected', function(event) {
      gamepadConnected(event.gamepad);
    });
    environment.addEventListener('gamepaddisconnected', function(event) {
      gamepadDisconnected(event.gamepad);
    });
    environment.addEventListener('visibilitychange', onVisibilityChange);
    listenersInstalled = true;
  }

  function startWatching() {
    installListeners();
    if (watching) {
      return;
    }
    watching = true;
    schedule();
  }

  function stopWatching() {
    watching = false;
    if (rafId !== null) {
      environment.cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // Forgets what the pads looked like, so that the next poll takes them as they are and reports no change. The loop is paused for a
  // stream, and what the old snapshots would report when it resumes (a button that went down meanwhile) is not input
  function resync() {
    snapshots = Object.create(null);
  }

  return {
    startWatching: startWatching,
    stopWatching: stopWatching,
    resync: resync,
    getStats: function() {
      return { polls: stats.polls, events: stats.events };
    },
  };
}

// One line that says what the browser knows about a pad, for the log. The log used to hold the pad as JSON, which is {} for a Gamepad,
// so nothing told which pad it was or which vibration effects the browser offers for it (a trigger-rumble effect is what the trigger motors need)
function describeGamepad(gamepad) {
  var actuator = gamepad.vibrationActuator;
  var effects = 'none';
  if (actuator) {
    effects = Array.isArray(actuator.effects) ? actuator.effects.join(',') : 'not listed';
    if (actuator.type) {
      effects += ' (type ' + actuator.type + ')';
    }
  }
  return 'id="' + gamepad.id + '" index=' + gamepad.index + ' mapping="' + (gamepad.mapping || '') + '" buttons=' +
    (gamepad.buttons ? gamepad.buttons.length : 0) + ' axes=' + (gamepad.axes ? gamepad.axes.length : 0) +
    ' vibrationEffects=' + effects;
}

const Controller = typeof window !== 'undefined' ? createGamepadController(window) : null;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createGamepadController: createGamepadController, describeGamepad: describeGamepad };
}
