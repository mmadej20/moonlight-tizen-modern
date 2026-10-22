(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.StreamMenuSupport = api;
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // One step of the volume row is this many steps of the TV (a step of the TV is one press of a volume key)
  var VOLUME_STEP = 5;

  var ITEMS = ['resume', 'volume', 'stats', 'mouse', 'disconnect', 'quit'];

  // The stream menu: what is in it, what each item does, and in which order the platform is told about it. The page draws it
  // and moves through it (the view of the navigation), this is the part that has no page in it.
  //
  // env: {
  //   module(): the native module (setInputCaptured, toggleStats, toggleMouseEmulation, isMouseEmulationActive), or null
  //   volume: {adjust(steps, source), read()}   the volume of the TV
  //   enter(), leave(): the page takes the controls for the menu (the navigation, the pad loop) and gives them back
  //   render(model): draws the panel
  //   statsOn(): whether the statistics are shown now
  //   mouseEnabled(): whether the setting of the mouse emulation is on
  //   disconnect(), quit(): end the stream (the page knows how)
  //   log(text)
  // }
  function createMenu(env) {
    var opened = false;
    var selectArmed = false;
    var pendingStats = null;

    function nativeModule() {
      var source = env.module;
      var instance = typeof source === 'function' ? source() : source;
      return instance || null;
    }

    function callNative(name) {
      var instance = nativeModule();
      if (!instance || typeof instance[name] !== 'function') {
        return undefined;
      }
      try {
        return instance[name].apply(instance, Array.prototype.slice.call(arguments, 1));
      } catch (error) {
        if (typeof env.log === 'function') {
          env.log('Stream menu: ' + name + ' failed: ' + error.message);
        }
        return undefined;
      }
    }

    function statsOn() {
      return pendingStats !== null ? pendingStats : !!env.statsOn();
    }

    function model() {
      var tv = env.volume && typeof env.volume.read === 'function' ? env.volume.read() : null;
      var mouseEnabled = !!env.mouseEnabled();
      return {
        items: [
          {id: 'resume', kind: 'action', enabled: true},
          {id: 'volume', kind: 'level', enabled: true, volume: tv ? tv.volume : 0, muted: tv ? tv.muted : false},
          {id: 'stats', kind: 'toggle', enabled: true, on: statsOn()},
          {id: 'mouse', kind: 'toggle', enabled: mouseEnabled, on: mouseEnabled && !!callNative('isMouseEmulationActive')},
          {id: 'disconnect', kind: 'action', enabled: true},
          {id: 'quit', kind: 'action', enabled: true}
        ]
      };
    }

    function render() {
      env.render(model());
    }

    function open() {
      if (opened) {
        return false;
      }
      opened = true;
      selectArmed = false;
      pendingStats = null;
      // The host stops getting input first (the native side did it already when the pad opened the menu), then the page changes
      callNative('setInputCaptured', true);
      env.enter();
      render();
      return true;
    }

    function close() {
      if (!opened) {
        return false;
      }
      opened = false;
      pendingStats = null;
      // The page gives its controls back first, so that nothing it still reads reaches the host; then the host gets the input
      env.leave();
      callNative('setInputCaptured', false);
      return true;
    }

    function activate(id) {
      if (!opened) {
        return;
      }
      switch (id) {
        case 'resume':
          close();
          break;
        case 'stats':
          // The stream tells that the statistics changed after a moment: until then the toggle shows what it will be
          pendingStats = !statsOn();
          callNative('toggleStats');
          render();
          break;
        case 'mouse':
          if (env.mouseEnabled()) {
            callNative('toggleMouseEmulation');
            render();
          }
          break;
        case 'disconnect':
          env.disconnect();
          break;
        case 'quit':
          env.quit();
          break;
        default:
          break;
      }
    }

    function adjust(id, delta) {
      if (!opened || id !== 'volume' || !delta) {
        return;
      }
      env.volume.adjust((delta > 0 ? 1 : -1) * VOLUME_STEP, 'menu');
      render();
    }

    // The state of the page changed (the statistics were switched, the volume moved): draw what is true now
    function refresh() {
      if (!opened) {
        return;
      }
      pendingStats = null;
      render();
    }

    // The Select button of a pad. The Select that opened the menu is still down when it opens: its release arms the button, and
    // the next press closes the menu
    function onSelect(pressed) {
      if (!opened) {
        return;
      }
      if (!pressed) {
        selectArmed = true;
      } else if (selectArmed) {
        close();
      }
    }

    return {
      open: open,
      close: close,
      toggle: function() { return opened ? close() : open(); },
      isOpen: function() { return opened; },
      model: model,
      activate: activate,
      adjust: adjust,
      refresh: refresh,
      onSelect: onSelect
    };
  }

  // The state of the stream as the corner of the menu shows it: ['1440p · 60 FPS', 'HEVC · HDR', '60 Mbps']
  function describeStream(values) {
    var height = values.height >= 2160 ? '4K' : values.height + 'p';
    var codec = values.codec === 'H264' ? 'H.264' : values.codec;
    return [
      height + ' · ' + values.fps + ' FPS',
      values.hdr ? codec + ' · HDR' : codec,
      values.bitrateMbps + ' Mbps'
    ];
  }

  return {
    ITEMS: ITEMS,
    VOLUME_STEP: VOLUME_STEP,
    createMenu: createMenu,
    describeStream: describeStream
  };
}));
