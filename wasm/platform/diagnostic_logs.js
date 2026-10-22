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
  // A log that reached its limit is cut down to this much, not by the size of one batch: rewriting a file of 2 MB on the
  // main thread (read, cut, write) took more than a second on the TV, and a full log did it with every batch, once a second
  var COMPACT_TARGET_BYTES = Math.floor(SESSION_LIMIT_BYTES * 0.75);
  // Only the end of a long log is put on the page, and not more often than this
  var VIEW_TAIL_BYTES = 128 * 1024;
  var VIEW_REFRESH_MS = 3000;
  var ENABLED_KEY = 'moonlight.diagnosticLogsEnabled';
  var CURRENT_FILE = 'wgt-private/moonlight-diagnostics-current.log';
  var PREVIOUS_FILE = 'wgt-private/moonlight-diagnostics-previous.log';

  function utf8Length(text) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(text).length;
    }
    return unescape(encodeURIComponent(text)).length;
  }

  // Saving the logs on the device can be switched off; the default is on
  function readEnabledSetting() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem(ENABLED_KEY) === 'false') {
        return false;
      }
    } catch (error) {
      // Storage may be unavailable; the logs stay on
    }
    return true;
  }

  function writeEnabledSetting(enabled) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false');
      }
    } catch (error) {
      // The choice then lasts until the app is closed
    }
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

  // The receiver of the logs is set with the keys of the remote, like the address of a host: four numbers for the address and five digits
  // for the port, each changed by Up and Down. The keyboard of the TV did not open for a field of text, so there is none.
  var DEFAULT_RECEIVER_HOST = [192, 168, 0, 0];
  var DEFAULT_RECEIVER_PORT = 48150;
  var PORT_DIGITS = 5;

  function parseIpv4Octets(text) {
    var match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text || '').trim());
    if (!match) {
      return null;
    }
    var octets = match.slice(1).map(Number);
    return octets.every(function(octet) { return octet <= 255; }) ? octets : null;
  }

  // A number goes up or down by one and comes around at the end of its range
  function stepCellValue(value, delta, count) {
    return (((value + delta) % count) + count) % count;
  }

  function portDigits(port) {
    var text = String(Math.max(0, Math.min(99999, Math.floor(Number(port) || 0))));
    while (text.length < PORT_DIGITS) {
      text = '0' + text;
    }
    return text;
  }

  function stepPortDigit(port, index, delta) {
    var digits = portDigits(port).split('');
    digits[index] = String(stepCellValue(Number(digits[index]), delta, 10));
    return Number(digits.join(''));
  }

  // Five digits can say more than a port can: when the typing ends, the port is brought into the range
  function clampPort(port) {
    return Math.max(1, Math.min(65535, Math.floor(Number(port) || 0)));
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
    this.enabled = readEnabledSetting();
    this.lastViewRefreshMs = 0;
    this.receiver = {octets: DEFAULT_RECEIVER_HOST.slice(), port: DEFAULT_RECEIVER_PORT};
  }

  DiagnosticLogManager.prototype.init = function() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.bindUi();
    this.applyNativeEnabled();
    this.timer = setInterval(this.pollNative.bind(this), 1000);
  };

  // The native side stops formatting and keeping lines while the logs are off
  DiagnosticLogManager.prototype.applyNativeEnabled = function() {
    try {
      if (typeof Module !== 'undefined' && typeof Module.setDiagnosticLogEnabled === 'function') {
        Module.setDiagnosticLogEnabled(this.enabled);
      }
    } catch (error) {
      this.setStatus('Unable to change native diagnostics: ' + error.message, true);
    }
  };

  DiagnosticLogManager.prototype.isEnabled = function() {
    return this.enabled;
  };

  DiagnosticLogManager.prototype.setEnabled = function(enabled) {
    this.enabled = !!enabled;
    writeEnabledSetting(this.enabled);
    if (!this.enabled) {
      this.pending = '';
    }
    this.applyNativeEnabled();
    this.updateEnabledSwitch();
    if (!this.enabled) {
      // The page says so next to the switch: a log that is not kept is not left behind either
      var self = this;
      return this.clearStored().then(function() {
        self.setStatus('Saving of diagnostic logs is off. All saved logs were deleted.', false);
      });
    }
    this.setStatus('Saving of diagnostic logs is on.', false);
    return typeof document !== 'undefined' ? this.refreshView() : Promise.resolve();
  };

  DiagnosticLogManager.prototype.pollNative = function() {
    try {
      if (typeof Module !== 'undefined' && typeof Module.drainDiagnosticLogs === 'function') {
        var batch = Module.drainDiagnosticLogs();
        if (batch && this.enabled) {
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
    if (!self.enabled) {
      self.pending = '';
      return Promise.resolve();
    }
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
        var compacted = trimDiagnosticLog(current + batch, COMPACT_TARGET_BYTES);
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
    if (!self.enabled) {
      return Promise.resolve();
    }
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

  // Adds a line that was detected by JavaScript. Native lines carry the stream clock, which does not
  // exist for events such as a stalled main thread or a previous run that ended unexpectedly.
  DiagnosticLogManager.prototype.appendLine = function(text, when) {
    if (!this.enabled) {
      return Promise.resolve();
    }
    var stamp = (when instanceof Date ? when : new Date()).toISOString();
    var line = '[js ' + stamp + '] ' + String(text == null ? '' : text).replace(/[\r\n]+$/, '') + '\n';
    this.pending = trimDiagnosticLog(this.pending + redactDiagnosticText(line), PENDING_LIMIT_BYTES);
    return this.persistPending();
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

  // The end of a text, from the start of a line, when the text is longer than the page should take
  function tailOfLog(text, maxChars) {
    if (text.length <= maxChars) {
      return {text: text, cut: false};
    }
    var tail = text.slice(text.length - maxChars);
    var newline = tail.indexOf('\n');
    return {text: newline >= 0 ? tail.slice(newline + 1) : tail, cut: true};
  }

  DiagnosticLogManager.prototype.refreshView = function() {
    var self = this;
    if (typeof document === 'undefined') {
      return Promise.resolve('');
    }
    self.lastViewRefreshMs = Date.now();
    return self.storage.read(self.selectedPath()).then(function(text) {
      // A log of 2 MB with tens of thousands of lines hung the page, so only the end of it is shown
      var shown = tailOfLog(text, VIEW_TAIL_BYTES);
      var viewport = document.getElementById('diagnosticLogViewport');
      if (viewport) {
        viewport.textContent = shown.text || (self.enabled
          ? 'No diagnostic log is available for this session.'
          : 'Saving of diagnostic logs is off.');
      }
      var summary = document.getElementById('diagnosticSummary');
      if (summary) {
        summary.textContent = utf8Length(text) + ' bytes retained' + (self.storage.degraded ? ' (memory only)' : '')
          + (shown.cut ? ', showing the last ' + Math.round(shown.text.length / 1024) + ' KB' : '')
          + (self.enabled ? '' : ', saving is off');
      }
      return text;
    });
  };

  DiagnosticLogManager.prototype.refreshViewIfVisible = function() {
    var pane = typeof document !== 'undefined' && document.getElementById('diagnosticSettings');
    if (pane && pane.style.display !== 'none' && Date.now() - this.lastViewRefreshMs >= VIEW_REFRESH_MS) {
      return this.refreshView();
    }
    return Promise.resolve();
  };

  // The streaming PC is where the receiver usually runs, so its address is the one that is offered. A name that is not an address of
  // four numbers cannot be shown in the cells, and the address that was set stays.
  DiagnosticLogManager.prototype.setDefaultHost = function(host) {
    var octets = parseIpv4Octets(host);
    if (octets) {
      this.receiver.octets = octets;
      this.renderReceiver();
    }
  };

  // Puts the numbers of the receiver into the cells of the page
  DiagnosticLogManager.prototype.renderReceiver = function() {
    if (typeof document === 'undefined') {
      return;
    }
    var hostCells = document.querySelectorAll('#diagnosticHost .diagnostic-cell');
    for (var i = 0; i < hostCells.length; i++) {
      hostCells[i].textContent = String(this.receiver.octets[i]);
    }
    var digits = portDigits(this.receiver.port);
    var portCells = document.querySelectorAll('#diagnosticPort .diagnostic-cell');
    for (var j = 0; j < portCells.length; j++) {
      portCells[j].textContent = digits.charAt(j);
    }
  };

  // Up and Down on a cell: the field is the id of the row, the cell is its place in the row, the change is +1 or -1
  DiagnosticLogManager.prototype.stepReceiverCell = function(field, cell, delta) {
    if (field === 'diagnosticHost' && cell >= 0 && cell < this.receiver.octets.length) {
      this.receiver.octets[cell] = stepCellValue(this.receiver.octets[cell], delta, 256);
    } else if (field === 'diagnosticPort' && cell >= 0 && cell < PORT_DIGITS) {
      this.receiver.port = stepPortDigit(this.receiver.port, cell, delta);
    }
    this.renderReceiver();
  };

  // The typing of a field ended
  DiagnosticLogManager.prototype.finishReceiverEdit = function() {
    this.receiver.port = clampPort(this.receiver.port);
    this.renderReceiver();
  };

  DiagnosticLogManager.prototype.exportSelected = function() {
    var self = this;
    var destination;
    try {
      destination = validateDiagnosticDestination(self.receiver.octets.join('.'), self.receiver.port);
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
    if (typeof window !== 'undefined' && !window.confirm('Clear all diagnostic logs?')) {
      return Promise.resolve(false);
    }
    return this.clearStored();
  };

  // Deletes the log of the current session and of the previous one, and what the native side still holds
  DiagnosticLogManager.prototype.clearStored = function() {
    var self = this;
    self.pending = '';
    // What the native side still holds is cleared too
    try {
      if (typeof Module !== 'undefined' && typeof Module.drainDiagnosticLogs === 'function') {
        Module.drainDiagnosticLogs();
      }
    } catch (error) {
      // Nothing to clear then
    }
    return self.storage.write(CURRENT_FILE, '').then(function() {
      self.currentSizeBytes = 0;
      return self.storage.write(PREVIOUS_FILE, '');
    }).then(function() {
      self.setStatus('All diagnostic logs cleared.', false);
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

  DiagnosticLogManager.prototype.updateEnabledSwitch = function() {
    if (typeof document === 'undefined') return;
    var enabledSwitch = document.getElementById('diagnosticLogsEnabledSwitch');
    if (!enabledSwitch) return;
    enabledSwitch.checked = this.enabled;
    var options = document.getElementById('diagnosticOptions');
    if (options) {
      if (this.enabled) options.classList.remove('hide-container');
      else options.classList.add('hide-container');
    }
    var wrapper = enabledSwitch.parentElement;
    if (wrapper && wrapper.MaterialSwitch) {
      if (this.enabled) wrapper.MaterialSwitch.on();
      else wrapper.MaterialSwitch.off();
    }
  };

  DiagnosticLogManager.prototype.bindUi = function() {
    if (typeof document === 'undefined') return;
    var self = this;
    var current = document.getElementById('diagnosticCurrentSessionBtn');
    var previous = document.getElementById('diagnosticPreviousSessionBtn');
    var send = document.getElementById('sendDiagnosticLogsBtn');
    var clear = document.getElementById('clearDiagnosticLogsBtn');
    if (current) current.addEventListener('click', function() { self.selectSession('current'); });
    if (previous) previous.addEventListener('click', function() { self.selectSession('previous'); });
    if (send) send.addEventListener('click', function() { self.exportSelected(); });
    if (clear) clear.addEventListener('click', function() { self.clearAll(); });
    var enabledSwitch = document.getElementById('diagnosticLogsEnabledSwitch');
    if (enabledSwitch) {
      enabledSwitch.addEventListener('change', function() { self.setEnabled(enabledSwitch.checked); });
    }
    self.updateEnabledSwitch();
    self.renderReceiver();
    self.updateSessionButtons();
  };

  return {
    redactDiagnosticText: redactDiagnosticText,
    trimDiagnosticLog: trimDiagnosticLog,
    tailOfLog: tailOfLog,
    COMPACT_TARGET_BYTES: COMPACT_TARGET_BYTES,
    SESSION_LIMIT_BYTES: SESSION_LIMIT_BYTES,
    ENABLED_KEY: ENABLED_KEY,
    validateDiagnosticDestination: validateDiagnosticDestination,
    parseIpv4Octets: parseIpv4Octets,
    stepCellValue: stepCellValue,
    portDigits: portDigits,
    stepPortDigit: stepPortDigit,
    clampPort: clampPort,
    buildDiagnosticExport: buildDiagnosticExport,
    DiagnosticLogManager: DiagnosticLogManager,
    MemoryStorage: MemoryStorage,
    createManager: function(storage) { return new DiagnosticLogManager(storage); }
  };
}));
