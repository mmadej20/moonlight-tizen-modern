/* eslint-disable */

const SyncFunctions = {
  // no parameters
  'makeCert': (...args) => Module.makeCert(...args),
  // cert, privateKey, myUniqueid
  'httpInit': (...args) => Module.httpInit(...args),
  /* host, httpPort, width, height, fps, bitrate, rikey, rikeyid, appversion, gfeversion, rtspurl, serverCodecModeSupport,
  framePacing, optimizeGames, rumbleFeedback, mouseEmulation, flipABfaceButtons, flipXYfaceButtons, audioBackend,
  audioConfig, audioSync, audioJitterMs, playHostAudio, decryptHostAudio, videoCodec, hdrMode, fullRange, gameMode,
  disableWarnings, performanceStats, speculativeRfi */
  'startRequest': (...args) => Module.startStream(...args),
  // no parameters
  'stopRequest': (...args) => Module.stopStream(...args),
  // requestId
  'cancelRequest': (...args) => Module.cancelRequest(...args),
  // no parameters
  'toggleStats': (...args) => Module.toggleStats(...args),
};

const AsyncFunctions = {
  // url, ppk, binaryResponse, timeoutMs
  'openUrl': (...args) => Module.openUrl(...args),
  // no parameters
  'STUN': (...args) => Module.stun(...args),
  // serverMajorVersion, address, httpPort, randomNumber
  'pair': (...args) => Module.pair(...args),
  // macAddress
  'wakeOnLan': (...args) => Module.wakeOnLan(...args),
};

var createMessageBridge = function(syncFunctions, asyncFunctions, logger) {
  var callbacks = {};
  var callbacks_ids = 1;
  var bridgeLogger = logger || console;

  var pendingCount = function() {
    return Object.keys(callbacks).length;
  };

  var settle = function(callbackId, type, msg) {
    var callback = callbacks[callbackId];
    if (!callback) {
      if (bridgeLogger && typeof bridgeLogger.warn === 'function') {
        bridgeLogger.warn(
          '[messages.js] Ignoring response for settled callback ID ' +
            callbackId,
        );
      }
      return false;
    }

    delete callbacks[callbackId];
    if (type !== 'resolve' && type !== 'reject') {
      callback.reject(new Error(
        'Invalid response type for callback ID ' + callbackId,
      ));
      return false;
    }

    callback[type](msg);
    return true;
  };

  /**
   * Sends a message with arguments to the Wasm module.
   *
   * @param {String} method A named method
   * @param {Array} params An array of arguments
   * @return {Promise} The Wasm module calls back through handlePromiseMessage
   */
  var sendMessage = function(method, params) {
    if (syncFunctions[method]) {
      return new Promise(function(resolve, reject) {
        const ret = syncFunctions[method](...params);
        if (ret.type === 'resolve') {
          resolve(ret.ret);
        } else {
          reject(ret.ret);
        }
      });
    }

    var id = callbacks_ids++;
    var request = new Promise(function(resolve, reject) {
      callbacks[id] = {
        resolve: resolve,
        reject: reject,
      };

      try {
        if (!asyncFunctions[method]) {
          throw new Error('Unknown asynchronous method: ' + method);
        }
        asyncFunctions[method](id, ...params);
      } catch (error) {
        delete callbacks[id];
        reject(error);
      }
    });

    request.requestId = id;
    request.cancel = function() {
      return sendMessage('cancelRequest', [id]);
    };
    return request;
  };

  return {
    sendMessage: sendMessage,
    resolve: function(callbackId, msg) {
      return settle(callbackId, 'resolve', msg);
    },
    reject: function(callbackId, msg) {
      return settle(callbackId, 'reject', msg);
    },
    settle: settle,
    pendingCount: pendingCount,
  };
};

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeBackendMessageText(text) {
  return String(text || '')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .trim();
}

function replaceKnownStageLabels(text) {
  const stageLabels = [
    'none',
    'platform initialization',
    'name resolution',
    'audio stream initialization',
    'RTSP handshake',
    'control stream initialization',
    'video stream initialization',
    'input stream initialization',
    'control stream establishment',
    'video stream establishment',
    'audio stream establishment',
    'input stream establishment',
  ];

  const translatedStageLabels = [
    t('none'),
    t('platform initialization'),
    t('name resolution'),
    t('audio stream initialization'),
    t('RTSP handshake'),
    t('control stream initialization'),
    t('video stream initialization'),
    t('input stream initialization'),
    t('control stream establishment'),
    t('video stream establishment'),
    t('audio stream establishment'),
    t('input stream establishment'),
  ];

  let translated = text.replace(/\bStarting\b/g, t('Starting'));
  stageLabels.forEach((label, i) => {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    translated = translated.replace(new RegExp(escapedLabel, 'gi'), translatedStageLabels[i]);
  });

  return translated;
}

function replaceKnownStatsLabels(text) {
  return text
    .replace(/Video stream:/g, t('Video stream:'))
    .replace(/Codec:/g, t('Codec:'))
    .replace(/Incoming frame rate from network:/g, t('Incoming frame rate from network:'))
    .replace(/Decoding frame rate:/g, t('Decoding frame rate:'))
    .replace(/Rendering frame rate:/g, t('Rendering frame rate:'))
    .replace(/Incoming bitrate from network:/g, t('Incoming bitrate from network:'))
    .replace(/Host processing latency min\/max\/average:/g, t('Host processing latency min/max/average:'))
    .replace(/Frames dropped by your network connection:/g, t('Frames dropped by your network connection:'))
    .replace(/Average network latency:/g, t('Average network latency:'))
    .replace(/\bvariance:/g, t('variance:'))
    .replace(/\bN\/A\b/g, t('N/A'))
    .replace(/Average decoding time:/g, t('Average decoding time:'))
    .replace(/Average frame queue delay:/g, t('Average frame queue delay:'))
    .replace(/Average rendering time:/g, t('Average rendering time:'))
    .replace(/Slow connection to PC\.\nReduce your bitrate!/g, t('Slow connection to PC.\nReduce your bitrate!'));
}

function replaceKnownWolErrorLabels(text) {
  const wolErrorLabels = [
    'Invalid MAC address format',
    'Invalid MAC address: default zero MAC address not allowed',
    'Failed to create socket',
    'Failed to enable broadcast',
    'Failed to send magic packet to MAC address',
    'Failed to send IPv6 magic packet to MAC address',
    'Unknown error'
  ];

  const translatedWolErrorLabels = [
    t('Invalid MAC address format'),
    t('Invalid MAC address: default zero MAC address not allowed'),
    t('Failed to create socket'),
    t('Failed to enable broadcast'),
    t('Failed to send magic packet to MAC address'),
    t('Failed to send IPv6 magic packet to MAC address'),
    t('Unknown error')
  ];

  let translated = text;
  wolErrorLabels.forEach((label, i) => {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    translated = translated.replace(new RegExp(escapedLabel, 'gi'), translatedWolErrorLabels[i]);
  });

  return translated;
}

function translateBackendMessage(text) {
  const normalized = normalizeBackendMessageText(text);
  let translated = t(normalized);
  translated = replaceKnownStageLabels(translated);
  translated = replaceKnownStatsLabels(translated);
  return translated;
}

var cancelledAsyncRequests = new WeakSet();
var cancelAsyncRequest = function(promise) {
  if (!promise || typeof promise.cancel !== 'function' ||
      cancelledAsyncRequests.has(promise)) {
    return false;
  }

  cancelledAsyncRequests.add(promise);
  promise.cancel();
  return true;
};

var messageBridge = createMessageBridge(SyncFunctions, AsyncFunctions, console);
var sendMessage = messageBridge.sendMessage;

var handlePromiseMessage = function(callbackId, type, msg) {
  return messageBridge.settle(callbackId, type, msg);
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    cancelAsyncRequest: cancelAsyncRequest,
    createMessageBridge: createMessageBridge,
  };
}

/**
 * handleMessage - Handles messages from the Wasm module
 *
 * @param  {Object} msg An object given by the Wasm module
 * @return {void}
 */
function handleMessage(msg) {
  console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Message data: ', msg);
  // If it's a recognized event, notify the appropriate function
  if (msg.indexOf('streamTerminated: ') === 0) {
    // Release the audio scheduler of the Web Audio backend, which is a no-op for the EMSS backend
    stopAudioScheduler();
    // Remove the on-screen overlays
    $('#connection-warnings, #performance-stats').css('display', 'none');
    // Remove the video stream now
    $('#listener').removeClass('fullscreen');
    $('#loadingSpinner').css('display', 'none');
    $('body').css('backgroundColor', '#282C38');
    $('#wasm_module').css('display', 'none');
    // Show a termination snackbar message if the termination was unexpected
    var errorCode = parseInt(msg.replace('streamTerminated: ', ''));
    switch (errorCode) {
      case 0: // ML_ERROR_GRACEFUL_TERMINATION
        break;
      case -100: // ML_ERROR_NO_VIDEO_TRAFFIC
        snackbarLogLong('No video received from host. Check the host PC\'s firewall and port forwarding rules.');
        break;
      case -101: // ML_ERROR_NO_VIDEO_FRAME
        snackbarLogLong('Your network connection isn\'t performing well. Reduce your video bitrate setting or try a faster connection.');
        break;
      case -102: // ML_ERROR_UNEXPECTED_EARLY_TERMINATION
        snackbarLogLong('Something went wrong on your host PC when starting the stream. Restart your host PC and try again.');
        break;
      case -103: // ML_ERROR_PROTECTED_CONTENT
        snackbarLogLong('An issue occurred on your host PC while starting the stream. Make sure you don\'t have any DRM-protected content open on your host PC.');
        break;
      case -104: // ML_ERROR_FRAME_CONVERSION
        snackbarLogLong('The host PC reported a fatal video encoding error. Try disabling HDR mode, changing the streaming resolution, or changing your host PC\'s display resolution.');
        break;
      default:
        snackbarLogLong('Connection terminated');
        break;
    }
    // Return to the app list with new current game
    showApps(api).then(function() {
      // Scroll to the current game row
      Navigation.switch();
      // Switch to Apps view
      if (!window.isDialogOpen) {
        Navigation.change(Views.Apps);
      }
    }, function(error) {
      if (!OperationGuard.isStaleOperationError(error)) {
        console.error('%c[messages.js, handleMessage]', 'color: gray;', 'Error: Failed to reload the app list after stream termination:', error);
      }
    });
  } else if (msg === 'Connection Established') {
    // Prepare the screen for video stream
    $('#loadingSpinner').css('display', 'none');
    $('body').css('backgroundColor', 'transparent');
    $('#wasm_module').css('display', '');
    $('#wasm_module').focus();
  } else if (msg.indexOf('ProgressMsg: ') === 0) {
    // Show progress message under loading spinner
    $('#loadingSpinnerMessage').text(translateBackendMessage(msg.replace('ProgressMsg: ', '')));
  } else if (msg.indexOf('TransientMsg: ') === 0) {
    // Show transient message as notification
    snackbarLogLong(translateBackendMessage(msg.replace('TransientMsg: ', '')));
  } else if (msg.indexOf('DialogMsg: ') === 0) {
    // Show dialog message using the warning dialog
    warningDialog(t('Connection Error'), translateBackendMessage(msg.replace('DialogMsg: ', '')));
  } else if (msg === 'displayVideo') {
    // Show the video stream now
    $('#listener').addClass('fullscreen');
  } else if (msg.indexOf('NoWarningMsg: ') === 0) {
    // Hide the connection warnings overlay
    $('#connection-warnings').css('background', 'transparent');
    $('#connection-warnings').text('');
  } else if (msg.indexOf('WarningMsg: ') === 0) {
    // Show the connection warnings overlay
    $('#connection-warnings').css('background', 'rgba(0, 0, 0, 0.5)');
    $('#connection-warnings').text(translateBackendMessage(msg.replace('WarningMsg: ', '')));
  } else if (msg.indexOf('NoStatMsg: ') === 0) {
    // Toggle the performance stats switch and save the state
    if ($('#performanceStatsSwitch').prop('checked')) {
      $('#performanceStatsBtn')[0].MaterialSwitch.off();
      savePerformanceStats();
      $('#performance-stats').css('display', 'none');
    }
    // Hide the performance statistics overlay
    $('#performance-stats').css('background', 'transparent');
    $('#performance-stats').text('');
  } else if (msg.indexOf('StatMsg: ') === 0) {
    // Toggle the performance stats switch and save the state
    if (!$('#performanceStatsSwitch').prop('checked')) {
      $('#performanceStatsBtn')[0].MaterialSwitch.on();
      savePerformanceStats();
      $('#performance-stats').css('display', 'inline-block');
    }
    // Show the performance statistics overlay
    $('#performance-stats').css('background', 'rgba(0, 0, 0, 0.5)');
    $('#performance-stats').text(translateBackendMessage(msg.replace('StatMsg: ', '')));
  } else if (msg.indexOf('controllerRumble: ') === 0) {
    const eventData = msg.split(' ')[1].split(',');
    const gamepadIdx = parseInt(eventData[0]);
    const weakMagnitude = parseFloat(eventData[1]);
    const strongMagnitude = parseFloat(eventData[2]);
    const gamepads = navigator.getGamepads();
    const gamepad = gamepads[gamepadIdx];
    // Check if the gamepad exists and if it has a vibrationActuator associated with it
    if (gamepad && gamepad.vibrationActuator) {
      console.log('%c[messages.js, handleMessage]', 'color: gray;', 'Playing rumble on gamepad ' + gamepadIdx + ' with weak magnitude ' + weakMagnitude + ' and strong magnitude ' + strongMagnitude + '...');
      gamepad.vibrationActuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration: 5000, // Moonlight should be sending another rumble event when stopping
        weakMagnitude: weakMagnitude,
        strongMagnitude: strongMagnitude,
      });
    } else {
      console.warn('%c[messages.js, handleMessage]', 'color: gray;', 'Warning: Gamepad ' + gamepadIdx + ' does not support the rumble feature!');
    }
  } else if (msg.indexOf('mouseEmulationOn') === 0) {
    // Show mouse emulation enable status as a notification
    snackbarLogLong('Mouse emulation is activated');
  } else if (msg.indexOf('mouseEmulationOff') === 0) {
    // Show mouse emulation disable status as notification
    snackbarLogLong('Mouse emulation is deactivated');
  }
}
