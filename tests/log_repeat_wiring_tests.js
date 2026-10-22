'use strict';

// The streaming library logged "Input queue reached maximum size limit" about 80000 times in a few minutes once the thread
// that empties the queue had died. The 2 MB log file of the application filled up, and a full file was read, cut and
// written again on the main thread every second, which stalled the whole application for seconds (the start of a stream
// failed with a timeout, the page of the logs hung, the vibration of a gamepad lasted too long) and survived a restart
// of the TV and a reinstallation. The same message again within a second is now left out and counted, the log can be
// switched off, and a full log is cut down once, not with every batch.

const assert = require('assert');
const fs = require('fs');

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

const listener = read('wasm/connectionlistener.cpp');
const main = read('wasm/main.cpp');
const diagnosticLog = read('wasm/diagnostic_log.cpp');
const diagnosticHeader = read('wasm/diagnostic_log.hpp');
const manager = read('wasm/platform/diagnostic_logs.js');
const html = read('wasm/index.html');

// Every message passes the filter, on its way to the console and to the log
const logMessage = listener.slice(listener.indexOf('void MoonlightInstance::ClLogMessage('));
assert(/#include "log_repeat_filter\.hpp"/.test(listener));
assert(/static LogRepeatFilter repeatFilter;/.test(logMessage));
const checkAt = logMessage.indexOf('repeatFilter.Check(message, nowMs)');
const consoleAt = logMessage.indexOf('emscripten_log(EM_LOG_CONSOLE, "%s", message)');
assert(checkAt > 0 && consoleAt > checkAt, 'the message is checked before it is logged');
assert(/if \(!decision\.log\) \{\s+return;\s+\}/.test(logMessage), 'a repeated message is left out');
assert(/the previous message was repeated %u times/.test(logMessage), 'the count is logged');

// The log can be switched off from the page, and the native side stops keeping lines
assert(/emscripten::function\("setDiagnosticLogEnabled", &SetDiagnosticLogEnabled\);/.test(main));
assert(/void SetDiagnosticLogEnabled\(bool enabled\)/.test(diagnosticLog));
assert(/if \(!Enabled\(\)\) \{\s+return false;\s+\}/.test(diagnosticLog));
assert(/void SetEnabled\(bool enabled\)/.test(diagnosticHeader));
assert(/Module\.setDiagnosticLogEnabled\(this\.enabled\)/.test(manager));

// The page has the switch and the button that clears everything
assert(/id="diagnosticLogsEnabledSwitch"[^>]*class="mdl-switch__input"[^>]*checked/.test(html));
assert(/id="clearDiagnosticLogsBtn"[^>]*data-i18n="Clear">Clear</.test(html));
assert(/<label data-i18n="Clear all logs">Clear all logs<\/label>/.test(html), 'the row that clears is titled by the old label');
assert(!/data-i18n="Clear logs"/.test(html), 'the old label is gone');

// A full log is cut down to three quarters, only the end of it is put on the page, and not more often than every 3 s
assert(/var COMPACT_TARGET_BYTES = Math\.floor\(SESSION_LIMIT_BYTES \* 0\.75\);/.test(manager));
assert(/trimDiagnosticLog\(current \+ batch, COMPACT_TARGET_BYTES\)/.test(manager));
assert(!/trimDiagnosticLog\(current \+ batch, SESSION_LIMIT_BYTES\)/.test(manager));
assert(/tailOfLog\(text, VIEW_TAIL_BYTES\)/.test(manager));
assert(/Date\.now\(\) - this\.lastViewRefreshMs >= VIEW_REFRESH_MS/.test(manager));

// Both languages have the new texts, and the label that was renamed is not left behind
for (const locale of ['en-US', 'pt-BR']) {
  const dictionary = JSON.parse(read('wasm/static/locales/' + locale + '.json'));
  for (const key of ['Save diagnostic logs on this device', 'Clear all logs', 'Send', 'Clear',
    '- Turning this off stops saving logs and deletes all the logs that are saved on this device.']) {
    assert(Object.prototype.hasOwnProperty.call(dictionary, key), locale + ' has "' + key + '"');
  }
  assert(!Object.prototype.hasOwnProperty.call(dictionary, 'Clear logs'), locale + ' has no stale label');
  assert(!Object.prototype.hasOwnProperty.call(dictionary, 'Filter'), locale + ' has no label of the filter');
  assert(!Object.prototype.hasOwnProperty.call(dictionary,
    '- Turn this off to stop writing logs on the device. Logs that are already saved stay until you clear them.'), locale + ' does not promise that saved logs stay');
}

console.log('log repeat wiring tests passed');
