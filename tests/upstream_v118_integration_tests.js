const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// Contract for the upstream v1.18.0 integration: argument order across the JS/WASM bridge,
// the Disabled audio backend, new setting defaults, paired-host metadata policy and HTML escaping.

function read(path) {
  return fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, 'Missing function ' + name);
  return source.slice(start, matchingBrace(source, source.indexOf('{', start)) + 1);
}

function matchingBrace(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error('Unbalanced braces');
}

function extractCppFunction(source, signature) {
  const start = source.indexOf(signature);
  assert(start >= 0, 'Missing C++ function ' + signature);
  const open = source.indexOf('{', start);
  return source.slice(start, matchingBrace(source, open) + 1);
}

function splitTopLevel(list) {
  const items = [];
  let depth = 0;
  let current = '';
  for (const character of list) {
    if (character === '(' || character === '[') depth += 1;
    if (character === ')' || character === ']') depth -= 1;
    if (character === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function cppParameterNames(list) {
  return splitTopLevel(list).map((parameter) => /([A-Za-z_]\w*)\s*$/.exec(parameter)[1]);
}

const PREFIX_COUNT = 18; // host ... flipXYfaceButtons, identical in every start request
const STREAM_TAIL = [
  'audioBackend', 'audioConfig', 'audioSync', 'audioJitterMs', 'playHostAudio', 'decryptHostAudio',
  'videoCodec', 'hdrMode', 'fullRange', 'gameMode', 'disableWarnings', 'performanceStats', 'speculativeRfi',
];

function assertStreamTail(label, names) {
  const at = names.indexOf('audioBackend');
  assert.strictEqual(at, PREFIX_COUNT, label + ': audioBackend must follow the ' + PREFIX_COUNT + ' leading arguments');
  assert.deepStrictEqual(names.slice(at), STREAM_TAIL, label + ': stream argument order');
}

function testStartStreamParameterOrderIsIdenticalEverywhere() {
  const main = read('wasm/main.cpp');
  const header = read('wasm/moonlight_wasm.hpp');
  const messages = read('wasm/platform/messages.js');
  const index = read('wasm/platform/index.js');

  const definition = /MessageResult MoonlightInstance::StartStream\(([\s\S]*?)\)\s*\{/.exec(main);
  const freeFunction = /MessageResult startStream\(([\s\S]*?)\)\s*\{/.exec(main);
  const forwarded = /g_Instance->StartStream\(([\s\S]*?)\);/.exec(main);
  const memberDeclaration = /MessageResult StartStream\(([\s\S]*?)\);/.exec(header);
  const freeDeclaration = /MessageResult startStream\(([\s\S]*?)\);/.exec(header);
  const comment = /\/\*\s*(host,[\s\S]*?)\*\/\s*'startRequest'/.exec(messages);
  assert(definition && freeFunction && forwarded && memberDeclaration && freeDeclaration && comment,
    'every start-stream signature must be present');

  assertStreamTail('main.cpp StartStream', cppParameterNames(definition[1]));
  assertStreamTail('main.cpp startStream', cppParameterNames(freeFunction[1]));
  assertStreamTail('main.cpp forwarded call', splitTopLevel(forwarded[1]));
  assertStreamTail('moonlight_wasm.hpp StartStream', cppParameterNames(memberDeclaration[1]));
  assertStreamTail('moonlight_wasm.hpp startStream', cppParameterNames(freeDeclaration[1]));
  assertStreamTail('messages.js comment', splitTopLevel(comment[1].replace(/\s+/g, ' ')));

  const requests = Array.from(index.matchAll(/sendMessage\('startRequest', \[([\s\S]*?)\]\);/g));
  assert.strictEqual(requests.length, 2, 'resume and launch both send a start request');
  requests.forEach((request, number) => {
    assertStreamTail('index.js startRequest #' + (number + 1), splitTopLevel(request[1]));
  });
}

function testDecryptHostAudioSelectsAudioEncryption() {
  const main = read('wasm/main.cpp');
  assert.match(main, /encryptionFlags\s*=\s*decryptHostAudio\s*\?\s*ENCFLG_AUDIO\s*:\s*ENCFLG_NONE/,
    'Decrypt host audio must be the only thing that enables audio encryption');
  assert.match(read('wasm/moonlight_wasm.hpp'), /m_DecryptHostAudioEnabled/,
    'the instance keeps the Decrypt host audio choice');
}

function testDisabledAudioBackendIsSafeWithMediaGating() {
  const header = read('wasm/moonlight_wasm.hpp');
  const main = read('wasm/main.cpp');
  const player = read('wasm/wasmplayer.cpp');
  const audio = read('wasm/auddec.cpp');

  assert.match(header, /enum class AudioBackend\s*\{[^}]*\bDisabled\b[^}]*\}/, 'AudioBackend::Disabled exists');
  assert.match(main, /audioBackend == "Disabled"[\s\S]{0,200}AudioBackend::Disabled/,
    'the Disabled option selects AudioBackend::Disabled');

  // Only the EMSS backend creates and waits for an EMSS audio track, so Disabled never stalls startup.
  assert.match(player, /AudioBackend::Emss\s*&&\s*!instance->WaitForMediaStage\("audio track open"/);
  assert.doesNotMatch(player, /!=\s*AudioBackend::WebAudio/, 'gating must not be inverted to include Disabled');

  const init = extractCppFunction(audio, 'int MoonlightInstance::AudDecInit(');
  const disabledAt = init.indexOf('AudioBackend::Disabled');
  assert(disabledAt >= 0, 'AudDecInit handles the Disabled backend');
  assert(disabledAt < init.indexOf('opus_multistream_decoder_create'),
    'Disabled must return before an Opus decoder is created');

  const decode = extractCppFunction(audio, 'void MoonlightInstance::AudDecDecodeAndPlaySample(');
  assert(decode.indexOf('AudioBackend::Disabled') >= 0 &&
    decode.indexOf('AudioBackend::Disabled') < decode.indexOf('AudioBackend::WebAudio'),
    'Disabled packets are discarded before any backend dispatch or decoding');

  const cleanup = extractCppFunction(audio, 'void MoonlightInstance::AudDecCleanup(');
  assert.match(cleanup, /if \(g_Instance->m_OpusDecoder\) \{\s*opus_multistream_decoder_destroy/,
    'cleanup must tolerate an AudDecInit that skipped decoder creation');
}

function chain() {
  const target = function() {};
  const proxy = new Proxy(target, {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return () => '';
      if (property === 'then') return undefined;
      return proxy;
    },
    apply() { return proxy; },
  });
  return proxy;
}

function createSettingsContext(stored) {
  const switches = {};
  const stores = [];

  function switchFor(selector) {
    if (!switches[selector]) {
      const entry = { state: null };
      entry.MaterialSwitch = {
        on() { entry.state = true; },
        off() { entry.state = false; },
        enable() {},
        disable() { entry.disabled = true; },
      };
      switches[selector] = entry;
    }
    return switches[selector];
  }

  const target = {
    console: { log() {}, warn() {}, error() {} },
    Promise, parseFloat, parseInt, Number, String, Boolean, Math, JSON, Object, Array, isNaN, Date,
    platformVer: '9.0',
    document: {
      querySelector: switchFor,
      getElementById: (id) => switchFor('#' + id),
      querySelectorAll: () => [],
    },
    getData(key, callback) { callback({ [key]: stored[key] }); },
    storeData(key, value) { stores.push({ key, value }); },
  };
  const context = new Proxy(target, {
    has() { return true; },
    get(object, property) {
      if (property === Symbol.unscopables) return undefined;
      return property in object ? object[property] : chain();
    },
  });
  return { context, switches, stores };
}

function runIndexFunction(name, context) {
  const source = read('wasm/platform/index.js');
  vm.runInNewContext(extractFunction(source, name) + '\nthis.' + name + ' = ' + name + ';', context);
  context[name]();
}

function testDecryptHostAudioDefaultsOnlyWhenUnset() {
  const cases = [
    { stored: undefined, expected: false, label: 'unset defaults to off' },
    { stored: false, expected: false, label: 'stored false stays off' },
    { stored: true, expected: true, label: 'stored true stays on' },
  ];
  for (const { stored, expected, label } of cases) {
    const { context, switches } = createSettingsContext({ decryptHostAudio: stored });
    runIndexFunction('loadUserDataCb', context);
    assert.strictEqual(switches['#decryptHostAudioBtn'] && switches['#decryptHostAudioBtn'].state, expected,
      'Decrypt host audio ' + label);
  }

  const { context, stores } = createSettingsContext({});
  runIndexFunction('restoreDefaultsSettingsValues', context);
  assert(stores.some((entry) => entry.key === 'decryptHostAudio' && entry.value === false),
    'restoring defaults stores Decrypt host audio as false');
}

function createHostHarness(openUrlBehavior) {
  const calls = [];
  const context = {
    console: { log() {}, warn() {}, error() {} },
    sendMessage() { return Promise.resolve(''); },
    formatAddressForUrl: (address) => address,
  };
  vm.runInNewContext(read('wasm/static/js/utils.js') + '\nthis.Host = NvHTTP;', context);
  const host = new context.Host('192.0.2.1', 'client-id');
  host.httpPort = 47989;
  host.httpsPort = 47984;
  host._buildUidStr = () => 'uniqueid=client-id';
  host._parseServerInfo = (response) => (response === 'parsable' ? { parsed: true } : null);
  host._openUrlWithTimeout = (url, ppk, timeoutMs) => {
    calls.push({ url, timeoutMs });
    return openUrlBehavior(url);
  };
  return { host, calls };
}

async function testServerInfoPolicyForPairedAndUnpairedHosts() {
  {
    const { host, calls } = createHostHarness(() => Promise.resolve('parsable'));
    host.ppkstr = null;
    await host.refreshServerInfoAtAddress('192.0.2.1');
    assert.deepStrictEqual(calls.map((call) => call.url.split('/serverinfo')[0]), ['http://192.0.2.1:47989'],
      'an unpaired host is discovered over HTTP');
    assert.strictEqual(calls[0].timeoutMs, 5000, 'the local request timeout is kept');
  }
  {
    const { host, calls } = createHostHarness(() => Promise.resolve('unparsable'));
    host.ppkstr = 'pinned-certificate';
    await assert.rejects(host.refreshServerInfoAtAddress('192.0.2.1'));
    assert(calls.length >= 1 && calls.every((call) => call.url.startsWith('https://')),
      'a paired host never falls back to HTTP after a parse failure');
  }
  {
    const { host, calls } = createHostHarness(() => Promise.reject(-100));
    host.ppkstr = 'pinned-certificate';
    await assert.rejects(host.refreshServerInfoAtAddress('192.0.2.1'));
    assert(calls.length >= 1 && calls.every((call) => call.url.startsWith('https://')),
      'a paired host never falls back to HTTP after a certificate mismatch');
  }
  {
    const { host, calls } = createHostHarness(() => Promise.resolve('parsable'));
    host.ppkstr = 'pinned-certificate';
    const parsed = await host.refreshServerInfoAtAddress('192.0.2.1');
    assert.deepStrictEqual(parsed, { parsed: true });
    assert(calls.every((call) => call.timeoutMs === 5000), 'every request keeps the local timeout');
  }
}

async function testBaseUrlRefreshFollowsTheSamePolicy() {
  const prepare = (behavior, pinned) => {
    const harness = createHostHarness(behavior);
    harness.host.ppkstr = pinned;
    harness.host._baseUrlHttp = 'http://192.0.2.1:47989';
    harness.host._baseUrlHttps = 'https://192.0.2.1:47984';
    return harness;
  };
  {
    const { host, calls } = prepare(() => Promise.resolve('parsable'), null);
    await host.refreshServerInfo();
    assert.deepStrictEqual(calls.map((call) => call.url.split('/serverinfo')[0]), ['http://192.0.2.1:47989']);
  }
  {
    const { host, calls } = prepare(() => Promise.resolve('unparsable'), 'pinned-certificate');
    await assert.rejects(host.refreshServerInfo());
    assert(calls.length >= 1 && calls.every((call) => call.url.startsWith('https://')),
      'a paired host base-URL refresh never falls back to HTTP after a parse failure');
  }
  {
    const { host, calls } = prepare(() => Promise.reject(-100), 'pinned-certificate');
    await assert.rejects(host.refreshServerInfo());
    assert(calls.length >= 1 && calls.every((call) => call.url.startsWith('https://')),
      'a paired host base-URL refresh never falls back to HTTP after a certificate mismatch');
  }
  {
    const { host, calls } = prepare(() => Promise.resolve('parsable'), 'pinned-certificate');
    await host.refreshServerInfo();
    assert(calls.every((call) => call.timeoutMs === 5000), 'the local timeout is kept');
  }
}

function testHostDerivedTextIsEscapedBeforeHtml() {
  const messages = read('wasm/platform/messages.js');
  const context = {};
  vm.runInNewContext(extractFunction(messages, 'escapeHTML') + '\nthis.escapeHTML = escapeHTML;', context);
  assert.strictEqual(context.escapeHTML('<img src=x onerror="a(\'b\')">&'),
    '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');

  const hostDerived = /\b(?:nvhttpHost|host)\.(?:hostname|address|localAddress|macAddress|serverUid)\b|\b(?:app|currentGame|currentApp|appToStart)\.title\b/g;
  const sinks = /\.html\(|\.innerHTML\s*=|\bhtml:/;
  const offenders = [];
  read('wasm/platform/index.js').split('\n').forEach((line, number) => {
    if (!sinks.test(line)) return;
    for (const match of line.matchAll(hostDerived)) {
      if (line.slice(0, match.index).endsWith('escapeHTML(')) continue;
      offenders.push('index.js:' + (number + 1) + ' ' + match[0]);
    }
  });
  assert.deepStrictEqual(offenders, [], 'host or app names reach an HTML sink without escapeHTML');

  assert.doesNotMatch(read('wasm/static/js/utils.js'), /getElementsByTagName\('AppTitle'\)\[0\]\.innerHTML/,
    'app titles from host XML are read as text, not markup');
}

function testPerformanceStatsKeepWindowFixes() {
  const player = read('wasm/wasmplayer.cpp');
  const setup = extractCppFunction(player, 'int MoonlightInstance::VidDecSetup(');
  assert.match(setup, /m_LastFrameNumber\s*=\s*0;/, 'a new stream restarts frame numbering');
  assert.match(setup, /total_bytes\s*=\s*0;/, 'a new stream restarts the byte counter');
  assert.match(player, /receivedBitrate\s*=\s*bitrateMbps;/);
  assert.match(player, /const float bitrateMbps\s*=[^;]*windowDurationMs/,
    'bitrate is divided by the real length of the statistics window');
  const submit = extractCppFunction(player, 'int MoonlightInstance::VidDecSubmitDecodeUnit(');
  const overlayAt = submit.indexOf('m_PerformanceStatsEnabled.load()');
  const overlayBlock = submit.slice(overlayAt, matchingBrace(submit, submit.indexOf('{', overlayAt)) + 1);
  const withoutOverlay = submit.replace(overlayBlock, '');
  assert.match(withoutOverlay, /total_bytes\s*=\s*0;/,
    'the byte counter is reset even while the overlay is hidden');
}

function testUnexpectedTerminationUsesTheSingleStopPath() {
  const listener = read('wasm/connectionlistener.cpp');
  const terminated = extractCppFunction(listener, 'void MoonlightInstance::ClConnectionTerminated(');
  assert.match(terminated, /g_Instance->StopConnection\(errorCode\)/);
  const stopped = extractCppFunction(read('wasm/main.cpp'), 'void MoonlightInstance::OnConnectionStopped(');
  assert.doesNotMatch(stopped, /pthread_create|m_StopThread\.Create/,
    'the stop thread is owned by StopConnection alone');
}

// Contract for the upstream commits that landed on master after the v1.18.0 tag.

function testVideoSetupFailureIsReportedWithGuidance() {
  assert.match(read('wasm/moonlight_wasm.hpp'), /#define ERROR_VIDEO_SETUP_FAILED -200/);

  const player = read('wasm/wasmplayer.cpp');
  assert.match(player, /ERROR_VIDEO_SETUP_FAILED/, 'media pipeline setup reports its own error code');
  assert.match(player, /The TV rejected the video track[\s\S]{0,200}return ERROR_VIDEO_SETUP_FAILED/,
    'a video track the TV refuses to add is a video setup failure');
  // A stop requested by the user is not a video setup failure.
  assert.match(player, /m_ConnectionCancelled[\s\S]{0,200}-1[\s\S]{0,200}ERROR_VIDEO_SETUP_FAILED/);

  assert.match(read('wasm/connectionlistener.cpp'),
    /STAGE_VIDEO_STREAM_START\s*&&\s*errorCode\s*==\s*ERROR_VIDEO_SETUP_FAILED/,
    'the termination message explains the failure, so the stage dialog is skipped');

  const guidance = 'The TV was unable to start the streaming with the selected video settings. ' +
    'Try reducing the resolution or frame rate and consider changing the codec.';
  assert.match(read('wasm/platform/messages.js'), /case -200:[\s\S]{0,160}unable to start the streaming/);
  for (const locale of ['en-US', 'pt-BR']) {
    const dictionary = JSON.parse(read('wasm/static/locales/' + locale + '.json'));
    assert(Object.prototype.hasOwnProperty.call(dictionary, guidance), locale + ' translates the guidance');
  }
}

function testHostPollingResumesAroundPairing() {
  const index = read('wasm/platform/index.js');
  const addHost = extractFunction(index, 'addHostDialog');
  assert.match(addHost, /stopPollingHosts\(\);/, 'polling stops while the pairing dialog runs');
  assert.strictEqual((addHost.match(/startPollingHosts\(\);/g) || []).length, 4,
    'polling resumes after success and failure of both pairing flows');

  const pairing = extractFunction(index, 'pairingDialog');
  assert.match(pairing, /Ignored pairing failure due to cancellation\.'\);[\s\S]{0,200}onFailure\(\);/,
    'cancelling the pairing dialog still lets the caller recover');

  const endPolling = extractFunction(index, 'endBackgroundPollingOfHost');
  assert.match(endPolling,
    /hasOwnProperty(?:\.call\(activePolls,\s*(?:host\.)?serverUid\)|\((?:host\.)?serverUid\))/,
    'polling that is still running its first refresh can be stopped');
}

function testFramePacingAndAddressFieldDefaultOnlyWhenUnset() {
  for (const { stored, expected } of [
    { stored: undefined, expected: true },
    { stored: false, expected: false },
    { stored: true, expected: true },
  ]) {
    const { context, switches } = createSettingsContext({ framePacing: stored, ipAddressFieldMode: stored });
    runIndexFunction('loadUserDataCb', context);
    assert.strictEqual(switches['#framePacingBtn'].state, expected, 'frame pacing for stored=' + stored);
    assert.strictEqual(switches['#ipAddressFieldModeBtn'].state, expected, 'address field for stored=' + stored);
  }
  const { context, stores } = createSettingsContext({});
  runIndexFunction('restoreDefaultsSettingsValues', context);
  for (const key of ['framePacing', 'ipAddressFieldMode']) {
    assert(stores.some((entry) => entry.key === key && entry.value === true), key + ' restores to on');
  }
}

async function main() {
  const tests = [
    testStartStreamParameterOrderIsIdenticalEverywhere,
    testDecryptHostAudioSelectsAudioEncryption,
    testDisabledAudioBackendIsSafeWithMediaGating,
    testDecryptHostAudioDefaultsOnlyWhenUnset,
    testServerInfoPolicyForPairedAndUnpairedHosts,
    testBaseUrlRefreshFollowsTheSamePolicy,
    testHostDerivedTextIsEscapedBeforeHtml,
    testPerformanceStatsKeepWindowFixes,
    testUnexpectedTerminationUsesTheSingleStopPath,
    testVideoSetupFailureIsReportedWithGuidance,
    testHostPollingResumesAroundPairing,
    testFramePacingAndAddressFieldDefaultOnlyWhenUnset,
  ];
  const failures = [];
  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      failures.push(test.name);
      console.error('FAIL ' + test.name + ': ' + String(error.message).split('\n')[0]);
    }
  }
  if (failures.length) {
    console.error('upstream_v118_integration_tests: FAIL (' + failures.length + '/' + tests.length + ')');
    process.exit(1);
  }
  console.log('upstream_v118_integration_tests: PASS');
}

main();
