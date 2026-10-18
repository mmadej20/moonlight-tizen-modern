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

  return {
    startWatching: startWatching,
    stopWatching: stopWatching,
    getStats: function() {
      return { polls: stats.polls, events: stats.events };
    },
  };
}

const Controller = typeof window !== 'undefined' ? createGamepadController(window) : null;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createGamepadController: createGamepadController };
}
