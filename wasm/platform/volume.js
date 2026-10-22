(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VolumeSupport = api;
    root.VolumeControl = api.createControl();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var KEYS = ['VolumeUp', 'VolumeDown', 'VolumeMute'];

  // The volume of the TV during a stream. The system draws its own volume bar over the stream when it handles the keys, and while
  // it shows, the stream stutters. When the keys are registered the system leaves them to the application, which changes the
  // volume itself and shows its own bar (a plain element of the page). Either way the changes are written to the diagnostic log,
  // so that a stutter can be put next to the moment that the volume changed.
  //
  // env: {tizen: the object of the platform (or a function that returns it), onChange({volume, muted, source}), log(text)}
  function VolumeControl(env) {
    this.env = env || {};
    this.running = false;
    this.registered = [];
    this.listening = false;
    this.last = null;
  }

  VolumeControl.prototype.platform = function() {
    var source = this.env.tizen;
    var platform = typeof source === 'function' ? source() : source;
    return platform || null;
  };

  VolumeControl.prototype.audio = function() {
    var platform = this.platform();
    return platform && platform.tvaudiocontrol ? platform.tvaudiocontrol : null;
  };

  VolumeControl.prototype.log = function(text) {
    if (typeof this.env.log === 'function') {
      this.env.log(text);
    }
  };

  // keys: whether the volume keys are taken from the system (and so the bar of the system does not show)
  VolumeControl.prototype.start = function(keys) {
    if (this.running) {
      return;
    }
    this.running = true;
    var audio = this.audio();
    var self = this;
    if (audio && typeof audio.setVolumeChangeListener === 'function') {
      try {
        audio.setVolumeChangeListener(function(volume) {
          self.report('tv', volume);
        });
        this.listening = true;
      } catch (error) {
        this.log('Volume: the changes of the TV cannot be followed: ' + error.message);
      }
    }
    if (keys) {
      var platform = this.platform();
      var input = platform && platform.tvinputdevice;
      KEYS.forEach(function(key) {
        try {
          input.registerKey(key);
          self.registered.push(key);
        } catch (error) {
          self.log('Volume: the key ' + key + ' cannot be taken from the system: ' + error.message);
        }
      });
    }
    this.log('Volume: following the volume of the TV' + (this.registered.length ? ', with the keys taken from the system' : ''));
  };

  VolumeControl.prototype.stop = function() {
    if (!this.running) {
      return;
    }
    this.running = false;
    var platform = this.platform();
    var input = platform && platform.tvinputdevice;
    this.registered.forEach(function(key) {
      try {
        input.unregisterKey(key);
      } catch (error) {
        // The key is released when the application closes
      }
    });
    this.registered = [];
    var audio = this.audio();
    if (this.listening && audio && typeof audio.unsetVolumeChangeListener === 'function') {
      try {
        audio.unsetVolumeChangeListener();
      } catch (error) {
        // Nothing more to release
      }
    }
    this.listening = false;
    this.last = null;
  };

  // Whether the application changes the volume itself (the keys are not left to the system)
  VolumeControl.prototype.handlesKeys = function() {
    return this.running && this.registered.length > 0;
  };

  // The state of the TV now, shown through onChange when it changed or when a key was the reason
  VolumeControl.prototype.report = function(source, volumeFromEvent) {
    var audio = this.audio();
    if (!audio) {
      return null;
    }
    var volume = volumeFromEvent;
    var muted = false;
    try {
      if (typeof volume !== 'number') {
        volume = audio.getVolume();
      }
      muted = !!audio.isMute();
    } catch (error) {
      this.log('Volume: cannot read the volume of the TV: ' + error.message);
      return null;
    }
    var state = {volume: volume, muted: muted, source: source};
    var changed = !this.last || this.last.volume !== volume || this.last.muted !== muted;
    this.last = {volume: volume, muted: muted};
    if (changed || source !== 'tv') {
      this.log('Volume: ' + volume + (muted ? ' (muted)' : '') + ' by ' + source);
      if (typeof this.env.onChange === 'function') {
        this.env.onChange(state);
      }
    }
    return state;
  };

  VolumeControl.prototype.up = function() {
    var audio = this.audio();
    if (audio) {
      audio.setVolumeUp();
    }
    return this.report('key up');
  };

  VolumeControl.prototype.down = function() {
    var audio = this.audio();
    if (audio) {
      audio.setVolumeDown();
    }
    return this.report('key down');
  };

  // The stream menu changes the volume by steps of the TV (a step is one press of a key): one report for all of them
  VolumeControl.prototype.adjust = function(steps, source) {
    var audio = this.audio();
    if (audio) {
      var count = Math.abs(Math.round(steps) || 0);
      for (var i = 0; i < count; i++) {
        if (steps > 0) {
          audio.setVolumeUp();
        } else {
          audio.setVolumeDown();
        }
      }
    }
    return this.report(source || 'menu');
  };

  // The API sets the mute state to the value that it is given: asking for the opposite of what it is toggles it
  VolumeControl.prototype.toggleMute = function() {
    var audio = this.audio();
    if (audio) {
      audio.setMute(!audio.isMute());
    }
    return this.report('key mute');
  };

  return {
    KEYS: KEYS,
    VolumeControl: VolumeControl,
    createControl: function(env) {
      return new VolumeControl(env || {
        tizen: function() { return typeof tizen !== 'undefined' ? tizen : null; },
        log: function(text) {
          if (typeof logDiagnostic === 'function') {
            logDiagnostic(text);
          }
        },
        onChange: function(state) {
          if (typeof showVolumeBar === 'function') {
            showVolumeBar(state);
          }
        }
      });
    }
  };
}));
