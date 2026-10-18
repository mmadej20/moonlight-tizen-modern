(function(root, factory) {
  var exported = factory();
  root.StartTimeline = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
}(typeof window !== 'undefined' ? window : this, function() {
  'use strict';

  // Times the stages between pressing an app and the connection being up, so that the diagnostic log says where the
  // seconds go: the host (launching the game), the network, or the TV (setting up the media pipeline).

  function create(options) {
    var now = options.now;
    var startedAt = null;
    var lastAt = 0;
    var stages = [];

    function begin() {
      startedAt = now();
      lastAt = startedAt;
      stages = [];
    }

    // Records that the named stage has just finished. A stage counts once, and nothing is recorded outside a start.
    function mark(name) {
      if (startedAt === null) {
        return;
      }
      for (var i = 0; i < stages.length; i += 1) {
        if (stages[i].name === name) {
          return;
        }
      }
      var at = now();
      stages.push({name: name, ms: at - lastAt});
      lastAt = at;
    }

    function cancel() {
      startedAt = null;
      stages = [];
    }

    // Describes the finished start and closes the measurement. Returns null when no start is being measured.
    function finish() {
      if (startedAt === null) {
        return null;
      }
      var total = lastAt - startedAt;
      var parts = stages.map(function(stage) {
        return stage.name + ' ' + stage.ms + ' ms';
      });
      cancel();
      return 'Stream start took ' + total + ' ms: ' + parts.join(', ');
    }

    return {
      begin: begin,
      mark: mark,
      cancel: cancel,
      finish: finish
    };
  }

  return {
    create: create
  };
}));
