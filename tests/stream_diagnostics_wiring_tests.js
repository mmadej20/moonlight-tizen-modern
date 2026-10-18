'use strict';

const assert = require('assert');
const fs = require('fs');

function read(path) {
  return fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, 'Missing function ' + name);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('Unbalanced braces in ' + name);
}

const html = read('wasm/index.html');
const index = read('wasm/platform/index.js');
const messages = read('wasm/platform/messages.js');
const main = read('wasm/main.cpp');
const http = read('wasm/http.cpp');
const player = read('wasm/wasmplayer.cpp');
const audio = read('wasm/auddec.cpp');

// The watchdog script must be loaded before index.js uses it, after the log manager it writes to.
const watchdogAt = html.indexOf('platform/stream_watchdog.js');
assert(watchdogAt > html.indexOf('platform/diagnostic_logs.js'), 'stream_watchdog.js loads after diagnostic_logs.js');
assert(watchdogAt < html.indexOf('platform/index.js'), 'stream_watchdog.js loads before index.js');

// JavaScript lifecycle: report a previous unclean end at startup, run while the stream view is shown, stop with it.
const attach = extractFunction(index, 'attachListeners');
assert(attach.indexOf('DiagnosticLogs.init();') < attach.indexOf('initStreamWatchdog();'),
  'the watchdog starts after the log manager is initialised');
const init = extractFunction(index, 'initStreamWatchdog');
assert.match(init, /StreamWatchdog\.create\(/);
assert.match(init, /Module\.getStreamHealth\(\)/, 'the native counters feed the heartbeat');
assert.match(init, /DiagnosticLogs\.appendLine\(/, 'watchdog findings go to the diagnostic log');
assert.match(init, /reportUncleanExit\(\)/);
assert.match(extractFunction(index, 'showStreamMode'), /streamWatchdog\.start\(/);
assert.match(extractFunction(index, 'showAppsMode'), /stopStreamWatchdog\(/);
assert.match(messages, /streamTerminated: '\) === 0[\s\S]*stopStreamWatchdog\('stream terminated '/,
  'a terminated stream is recorded as a clean end');

// Native counters: reset per stream, fed by both media paths, exposed to JavaScript.
assert.match(main, /m_StreamHealth\.Reset\(StreamHealth::NowMs\(\)\)/);
assert.match(main, /emscripten::function\("getStreamHealth", &getStreamHealth\)/);
assert.match(player, /m_StreamHealth\.VideoSubmitted\(/);
assert.match(audio, /m_StreamHealth\.AudioSubmitted\(/);
// Probes that tell a wedged platform call from a stalled main thread.
assert.match(player, /ScopedSection\s+\w+\(g_Instance->m_StreamHealth\.VideoAppend\(\)\);[\s\S]{0,120}m_VideoTrack\.AppendPacket\(pkt\)/,
  'the video append is timed');
assert.match(audio, /ScopedSection\s+\w+\(g_Instance->Health\(\)\.AudioAppend\(\)\);[\s\S]{0,120}track->AppendPacket\(pkt\)/,
  'the audio append is timed');
const inputThread = main.slice(main.indexOf('void* MoonlightInstance::InputThreadFunc('));
assert.match(inputThread.slice(0, inputThread.indexOf('usleep')),
  /ScopedSection\s+\w+\(me->m_StreamHealth\.InputPoll\(\)\);[\s\S]*PollGamepads\(\)\)?;/,
  'every gamepad poll is timed, because it asks the main thread for the gamepad state');
assert.match(main, /g_Instance->Health\(\)\.MainCall\(\)/);
for (const name of ['PostToJs', 'PostPromiseMessage']) {
  const body = main.slice(main.indexOf('void ' + name + '('));
  assert.match(body.slice(0, body.indexOf('MAIN_THREAD_EM_ASM')), /MainThreadCallScope waiting;/,
    name + ' records how long the worker waits for the main thread');
}
assert.doesNotMatch(main.slice(main.indexOf('void PostToJsAsync(')).split('}')[0], /MainThreadCallScope/,
  'the asynchronous post never waits, so it is not timed');

// HTTP: every dispatcher request goes through the helper that logs queue waits.
assert.match(http, /PostHttpJob\(\s*HttpUrlPathForLog\(url\)/);
assert.match(main, /PostHttpJob\(\s*"pair"/);
assert.doesNotMatch(http, /m_Dispatcher\.post_job\(\s*\[this, callbackId, url/);
assert.match(http, /ShouldLogWait\(waited\)/);
assert.match(http, /ShouldLogSlow\(ran\)/);

console.log('stream_diagnostics_wiring_tests: PASS');
