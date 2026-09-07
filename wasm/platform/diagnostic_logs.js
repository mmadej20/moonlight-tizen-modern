(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DiagnosticLogSupport = api;
    root.DiagnosticLogs = api.createManager();
  }
}(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var SESSION_LIMIT_BYTES = 2 * 1024 * 1024;
  var PENDING_LIMIT_BYTES = 256 * 1024;
  var CURRENT_FILE = 'wgt-private/moonlight-diagnostics-current.log';
  var PREVIOUS_FILE = 'wgt-private/moonlight-diagnostics-previous.log';

  function utf8Length(text) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(text).length;
    }
    return unescape(encodeURIComponent(text)).length;
  }

  function redactDiagnosticText(text) {
    var redacted = String(text == null ? '' : text);
    redacted = redacted.replace(/:\/\/[^\s\/@]+@/g, '://[REDACTED]@');
    redacted = redacted.replace(/([?&](?:token|key|secret|password|pin|rikey|rikeyid)=)[^&\s]*/gi, '$1[REDACTED]');
    redacted = redacted.replace(/(\b(?:pin|password|secret|rikey|rikeyid)\b\s*(?::|=|is)?\s*)[^\s,;]+/gi, '$1[REDACTED]');
    return redacted;
  }

  function trimDiagnosticLog(text, maxBytes) {
    text = String(text || '');
    if (utf8Length(text) <= maxBytes) {
      return text;
    }

    var marker = '[truncated]\n';
    if (utf8Length(marker) >= maxBytes) {
      return marker.slice(0, maxBytes);
    }

    var lines = [];
    var lineStart = 0;
    var newlineIndex;
    while ((newlineIndex = text.indexOf('\n', lineStart)) !== -1) {
      lines.push(text.slice(lineStart, newlineIndex + 1));
      lineStart = newlineIndex + 1;
    }
    if (lineStart < text.length) {
      lines.push(text.slice(lineStart));
    }
    var kept = [];
    var used = utf8Length(marker);
    for (var i = lines.length - 1; i >= 0; i--) {
      var lineBytes = utf8Length(lines[i]);
      if (used + lineBytes > maxBytes) {
        break;
      }
      kept.unshift(lines[i]);
      used += lineBytes;
    }
    return marker + kept.join('');
  }

  function validateDiagnosticDestination(host, port) {
    host = String(host || '').trim();
    if (!host || /[\/:?#\s]/.test(host) || host.indexOf('..') !== -1) {
      throw new Error('Enter a host name or IP address without a scheme or path.');
    }
    var numericPort = Number(port);
    if (!/^\d+$/.test(String(port)) || numericPort < 1 || numericPort > 65535) {
      throw new Error('Port must be a number from 1 to 65535.');
    }
    return {host: host, port: numericPort};
  }

  function safeFilenamePart(value) {
    return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  }

  function buildDiagnosticExport(sessionName, text, metadata) {
    metadata = metadata || {};
    var timestamp = metadata.startedAt || new Date().toISOString();
    var filename = 'moonlight-' + safeFilenamePart(sessionName).toLowerCase() + '-'
      + safeFilenamePart(timestamp) + '.log';
    var header = [
      'Moonlight diagnostic export v1',
      'Session: ' + sessionName,
      'Host: ' + (metadata.host || 'unknown'),
      'Started: ' + timestamp,
      ''
    ].join('\n');
    return {filename: filename, body: header + redactDiagnosticText(text)};
  }

  function MemoryStorage() {
    this.files = {};
    this.degraded = true;
  }
  MemoryStorage.prototype.read = function(path) {
    return Promise.resolve(this.files[path] || '');
  };
  MemoryStorage.prototype.write = function(path, text) {
    this.files[path] = text;
    return Promise.resolve();
  };
  MemoryStorage.prototype.append = function(path, text) {
    this.files[path] = (this.files[path] || '') + text;
    return Promise.resolve();
  };

  function TizenDiagnosticStorage() {
    this.degraded = false;
  }
  TizenDiagnosticStorage.prototype.read = function(path) {
    return new Promise(function(resolve) {
      try {
        var handle = tizen.filesystem.openFile(path, 'r');
        var text = handle.readString();
        handle.close();
        resolve(text || '');
      } catch (error) {
        resolve('');
      }
    });
  };
  TizenDiagnosticStorage.prototype.write = function(path, text) {
    return new Promise(function(resolve, reject) {
      try {
        var handle = tizen.filesystem.openFile(path, 'w');
        handle.writeString(text);
        handle.close();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  };
  TizenDiagnosticStorage.prototype.append = function(path, text) {
    return new Promise(function(resolve, reject) {
      try {
        var handle = tizen.filesystem.openFile(path, 'a');
        handle.writeString(text);
        handle.close();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  };

  function createStorage() {
    if (typeof tizen !== 'undefined' && tizen.filesystem && tizen.filesystem.openFile) {
      return new TizenDiagnosticStorage();
    }
    return new MemoryStorage();
  }

  function DiagnosticLogManager(storage) {
    this.storage = storage || createStorage();
    this.pending = '';
    this.metadata = {host: '', startedAt: ''};
    this.timer = null;
    this.flushing = false;
    this.initialized = false;
    this.currentSizeBytes = null;
    this.selectedSession = 'current';
  }

  DiagnosticLogManager.prototype.init = function() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.bindUi();
    this.timer = setInterval(this.pollNative.bind(this), 1000);
  };

  DiagnosticLogManager.prototype.pollNative = function() {
    try {
      if (typeof Module !== 'undefined' && typeof Module.drainDiagnosticLogs === 'function') {
        var batch = Module.drainDiagnosticLogs();
        if (batch) {
          this.pending = trimDiagnosticLog(this.pending + redactDiagnosticText(batch), PENDING_LIMIT_BYTES);
        }
      }
    } catch (error) {
      this.setStatus('Unable to drain native diagnostics: ' + error.message, true);
    }
    this.persistPending();
  };

  DiagnosticLogManager.prototype.persistPending = function() {
    var self = this;
    if (self.flushing || !self.pending) {
      return Promise.resolve();
    }
    self.flushing = true;
    var batch = self.pending;
    var batchSize = utf8Length(batch);
    var sizePromise = self.currentSizeBytes === null
      ? self.storage.read(CURRENT_FILE).then(function(current) {
        self.currentSizeBytes = utf8Length(current);
        return self.currentSizeBytes;
      })
      : Promise.resolve(self.currentSizeBytes);
    return sizePromise.then(function(currentSize) {
      if (currentSize + batchSize <= SESSION_LIMIT_BYTES) {
        return self.storage.append(CURRENT_FILE, batch).then(function() {
          self.currentSizeBytes = currentSize + batchSize;
        });
      }
      return self.storage.read(CURRENT_FILE).then(function(current) {
        var compacted = trimDiagnosticLog(current + batch, SESSION_LIMIT_BYTES);
        return self.storage.write(CURRENT_FILE, compacted).then(function() {
          self.currentSizeBytes = utf8Length(compacted);
        });
      });
    }).then(function() {
      if (self.pending.indexOf(batch) === 0) {
        self.pending = self.pending.slice(batch.length);
      }
      self.flushing = false;
      return self.refreshViewIfVisible();
    }).catch(function(error) {
      self.flushing = false;
      self.setStatus('Log storage failed: ' + error.message, true);
    });
  };

  DiagnosticLogManager.prototype.beginSession = function(metadata) {
    var self = this;
    self.metadata = metadata || {};
    self.metadata.startedAt = self.metadata.startedAt || new Date().toISOString();
    var header = redactDiagnosticText([
      '=== Moonlight stream session ===',
      'Started: ' + self.metadata.startedAt,
      'Host: ' + (self.metadata.host || 'unknown'),
      'Codec: ' + (self.metadata.codec || 'unknown'),
      'Video: ' + (self.metadata.width || 'unknown') + 'x' + (self.metadata.height || 'unknown')
        + ' @ ' + (self.metadata.fps || 'unknown') + ' FPS',
      'Bitrate: ' + (self.metadata.bitrateKbps || 'unknown') + ' Kbps',
      'Frame pacing: ' + (self.metadata.framePacing ? 'enabled' : 'disabled'),
      'Audio backend: ' + (self.metadata.audioBackend || 'unknown'),
      'Audio configuration: ' + (self.metadata.audioConfig || 'unknown'),
      'Audio synchronization: ' + (self.metadata.audioSync ? 'enabled' : 'disabled'),
      'Audio jitter buffer: ' + (
        self.metadata.audioJitterMs !== undefined && self.metadata.audioJitterMs !== null
          ? self.metadata.audioJitterMs
          : 'unknown'
      ) + ' ms',
      'Experimental RFI recovery: ' + (self.metadata.speculativeRfi ? 'enabled' : 'disabled'),
      ''
    ].join('\n'));

    return self.persistPending().then(function() {
      return self.storage.read(CURRENT_FILE);
    }).then(function(current) {
      return self.storage.write(PREVIOUS_FILE, current || '');
    }).then(function() {
      return self.storage.write(CURRENT_FILE, header);
    }).then(function() {
      self.currentSizeBytes = utf8Length(header);
      self.setDefaultHost(self.metadata.host || '');
    }).catch(function(error) {
      self.setStatus('Session rotation failed: ' + error.message, true);
    });
  };

  DiagnosticLogManager.prototype.selectedPath = function() {
    return this.selectedSession === 'previous' ? PREVIOUS_FILE : CURRENT_FILE;
  };

  DiagnosticLogManager.prototype.updateSessionButtons = function() {
    if (typeof document === 'undefined') return;
    var current = document.getElementById('diagnosticCurrentSessionBtn');
    var previous = document.getElementById('diagnosticPreviousSessionBtn');
    [[current, 'current'], [previous, 'previous']].forEach(function(entry) {
      if (!entry[0]) return;
      var selected = entry[1] === this.selectedSession;
      if (selected) entry[0].classList.add('selected');
      else entry[0].classList.remove('selected');
      entry[0].setAttribute('aria-pressed', selected ? 'true' : 'false');
    }, this);
  };

  DiagnosticLogManager.prototype.selectSession = function(session) {
    if (session !== 'current' && session !== 'previous') {
      return Promise.resolve();
    }
    this.selectedSession = session;
    this.updateSessionButtons();
    return typeof document !== 'undefined' ? this.refreshView() : Promise.resolve();
  };

  DiagnosticLogManager.prototype.refreshView = function() {
    var self = this;
    return self.storage.read(self.selectedPath()).then(function(text) {
      var filter = document.getElementById('diagnosticFilter');
      var query = filter ? filter.value.toLowerCase() : '';
      var visible = query ? text.split('\n').filter(function(line) {
        return line.toLowerCase().indexOf(query) !== -1;
      }).join('\n') : text;
      var viewport = document.getElementById('diagnosticLogViewport');
      if (viewport) {
        viewport.textContent = visible || 'No diagnostic log is available for this session.';
      }
      var summary = document.getElementById('diagnosticSummary');
      if (summary) {
        summary.textContent = utf8Length(text) + ' bytes retained' + (self.storage.degraded ? ' (memory only)' : '');
      }
      return text;
    });
  };

  DiagnosticLogManager.prototype.refreshViewIfVisible = function() {
    var pane = typeof document !== 'undefined' && document.getElementById('diagnosticSettings');
    if (pane && pane.style.display !== 'none') {
      return this.refreshView();
    }
    return Promise.resolve();
  };

  DiagnosticLogManager.prototype.setDefaultHost = function(host) {
    if (typeof document === 'undefined') {
      return;
    }
    var field = document.getElementById('diagnosticHost');
    if (field && host) {
      field.value = host;
    }
  };

  DiagnosticLogManager.prototype.exportSelected = function() {
    var self = this;
    var hostField = document.getElementById('diagnosticHost');
    var portField = document.getElementById('diagnosticPort');
    var destination;
    try {
      destination = validateDiagnosticDestination(hostField.value, portField.value);
    } catch (error) {
      self.setStatus(error.message, true);
      return Promise.resolve({ok: false, error: error.message});
    }

    return self.storage.read(self.selectedPath()).then(function(text) {
      var sessionName = self.selectedSession === 'previous' ? 'Previous session' : 'Current session';
      var payload = buildDiagnosticExport(sessionName, text, self.metadata);
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timeout = setTimeout(function() {
        if (controller) controller.abort();
      }, 5000);
      return fetch('http://' + destination.host + ':' + destination.port + '/moonlight-logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Moonlight-Filename': payload.filename
        },
        body: payload.body,
        signal: controller ? controller.signal : undefined
      }).then(function(response) {
        clearTimeout(timeout);
        if (!response.ok) throw new Error('Receiver returned HTTP ' + response.status);
        self.setStatus('Logs sent as ' + payload.filename, false);
        return {ok: true, filename: payload.filename};
      }).catch(function(error) {
        clearTimeout(timeout);
        self.setStatus('Log export failed: ' + error.message, true);
        return {ok: false, error: error.message};
      });
    });
  };

  DiagnosticLogManager.prototype.clearAll = function() {
    var self = this;
    if (typeof window !== 'undefined' && !window.confirm('Clear current and previous diagnostic logs?')) {
      return Promise.resolve(false);
    }
    self.pending = '';
    return self.storage.write(CURRENT_FILE, '').then(function() {
      self.currentSizeBytes = 0;
      return self.storage.write(PREVIOUS_FILE, '');
    }).then(function() {
      self.setStatus('Diagnostic logs cleared.', false);
      return self.refreshView();
    });
  };

  DiagnosticLogManager.prototype.setStatus = function(message, isError) {
    if (typeof document === 'undefined') return;
    var status = document.getElementById('diagnosticStatus');
    if (status) {
      status.textContent = message;
      status.className = isError ? 'diagnostic-status diagnostic-error' : 'diagnostic-status';
    }
  };

  DiagnosticLogManager.prototype.bindUi = function() {
    if (typeof document === 'undefined') return;
    var self = this;
    var current = document.getElementById('diagnosticCurrentSessionBtn');
    var previous = document.getElementById('diagnosticPreviousSessionBtn');
    var filter = document.getElementById('diagnosticFilter');
    var send = document.getElementById('sendDiagnosticLogsBtn');
    var clear = document.getElementById('clearDiagnosticLogsBtn');
    if (current) current.addEventListener('click', function() { self.selectSession('current'); });
    if (previous) previous.addEventListener('click', function() { self.selectSession('previous'); });
    if (filter) filter.addEventListener('input', function() { self.refreshView(); });
    if (send) send.addEventListener('click', function() { self.exportSelected(); });
    if (clear) clear.addEventListener('click', function() { self.clearAll(); });
    var port = document.getElementById('diagnosticPort');
    if (port && !port.value) port.value = '48150';
    self.updateSessionButtons();
  };

  return {
    redactDiagnosticText: redactDiagnosticText,
    trimDiagnosticLog: trimDiagnosticLog,
    validateDiagnosticDestination: validateDiagnosticDestination,
    buildDiagnosticExport: buildDiagnosticExport,
    DiagnosticLogManager: DiagnosticLogManager,
    MemoryStorage: MemoryStorage,
    createManager: function(storage) { return new DiagnosticLogManager(storage); }
  };
}));
