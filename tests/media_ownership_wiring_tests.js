'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const audio = fs.readFileSync(path.join(root, 'wasm', 'auddec.cpp'), 'utf8');
const player = fs.readFileSync(path.join(root, 'wasm', 'wasmplayer.cpp'), 'utf8');
const main = fs.readFileSync(path.join(root, 'wasm', 'main.cpp'), 'utf8');
const header = fs.readFileSync(path.join(root, 'wasm', 'moonlight_wasm.hpp'), 'utf8');

assert.match(audio, /opus_multistream_decoder_destroy\(g_Instance->m_OpusDecoder\)/);
assert.match(audio, /m_OpusDecoder\s*=\s*nullptr/);
assert.match(audio, /struct DecodeAppendResult/);
assert.match(audio, /static DecodeAppendResult DecodeAndAppendPacket/);
assert.match(
  audio,
  /if\s*\(\s*decodeOutcome\.outcome\s*==\s*AudioPacketOutcome::Appended\s*\)\s*\{[\s\S]*?s_AudioSyncController\.CommitAppend/,
);
assert.doesNotMatch(audio, /Dropping audio packet to avoid overflow/);
assert.doesNotMatch(audio, /Audio sync correction dropped/);
assert.match(audio, /AudioPipelineStats/);
assert.match(player, /10s/);
assert.match(main, /3s/);
assert.match(player, /add_track_result/);
assert.match(player, /OperationOutcome::Timeout/);
assert.match(header, /MediaOperationEpoch/);
assert.match(header, /MediaCallbackListeners/);

for (const callback of [
  'SourceListener::OnSourceOpen',
  'SourceListener::OnSourceOpenPending',
  'SourceListener::OnSourceClosed',
  'AudioTrackListener::OnTrackOpen',
  'AudioTrackListener::OnTrackClosed',
  'AudioTrackListener::OnSessionIdChanged',
  'VideoTrackListener::OnTrackOpen',
  'VideoTrackListener::OnTrackClosed',
  'VideoTrackListener::OnSessionIdChanged',
]) {
  const escapedCallback = callback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    player,
    new RegExp(`${escapedCallback}[\\s\\S]*?RunIfActive`),
    `${callback} must reject callbacks from stale media epochs`,
  );
}

assert.match(
  player,
  /m_Source->Open\(\s*\[instance,\s*mediaContext\][\s\S]*?RunIfActive\(mediaContext/,
);
assert.match(
  player,
  /m_MediaElement\.Play\(\s*\[instance,\s*mediaContext\][\s\S]*?RunIfActive\(mediaContext/,
);

const startupStart = player.indexOf('int MoonlightInstance::StartupVidDecSetup(');
const startupEnd = player.indexOf('\nint MoonlightInstance::VidDecSetup(', startupStart);
assert.notStrictEqual(startupStart, -1);
assert.notStrictEqual(startupEnd, -1);
const startupBody = player.slice(startupStart, startupEnd);
assert.doesNotMatch(
  startupBody,
  /WaitForMediaStage\("media element play"/,
  'Tizen may open both media tracks without completing the Play callback',
);
assert.match(startupBody, /if\s*\(!playResult\)/);

// Exercise the actual backend-dependent readiness predicate. Only C++ member
// access/scope notation is translated; short-circuit semantics stay identical.
const audioWait = startupBody.indexOf('WaitForMediaStage("audio track open"');
assert(audioWait > 0);
const conditionStart = startupBody.lastIndexOf('if (', audioWait) + 3;
let depth = 0;
let conditionEnd = conditionStart;
do {
  const char = startupBody[conditionEnd++];
  if (char === '(') depth++;
  if (char === ')') depth--;
} while (depth > 0 && conditionEnd < startupBody.length);
const readinessCondition = startupBody.slice(conditionStart, conditionEnd)
  .replace(/instance->/g, 'instance.').replace(/AudioBackend::/g, 'AudioBackend.');
function evaluateReadiness(backend, audioReady, videoReady) {
  const calls = [];
  const failed = require('vm').runInNewContext(readinessCondition, {
    AudioBackend: { Emss: 'EMSS' },
    instance: {
      m_AudioBackend: backend,
      WaitForMediaStage(stage) {
        calls.push(stage);
        return stage === 'audio track open' ? audioReady : videoReady;
      },
    },
  });
  return { failed, calls };
}
assert.deepStrictEqual(evaluateReadiness('WebAudio', false, true), {
  failed: false, calls: ['video track open'],
});
assert.deepStrictEqual(evaluateReadiness('WebAudio', false, false), {
  failed: true, calls: ['video track open'],
});
assert.deepStrictEqual(evaluateReadiness('EMSS', true, true), {
  failed: false, calls: ['audio track open', 'video track open'],
});
assert.deepStrictEqual(evaluateReadiness('EMSS', false, true), {
  failed: true, calls: ['audio track open'],
});
assert.match(startupBody, /if\s*\(g_Instance->m_AudioBackend == AudioBackend::Emss\)\s*\{[\s\S]*?ElementaryAudioTrackConfig/);

assert.match(
  main,
  /m_Source->Close\(\s*\[this,\s*closeContext\][\s\S]*?RunIfActive\(closeContext/,
);

const closeMediaStart = main.indexOf('OperationOutcome MoonlightInstance::CloseMediaSource()');
const closeMediaEnd = main.indexOf('\nvoid* MoonlightInstance::InputThreadFunc', closeMediaStart);
assert.notStrictEqual(closeMediaStart, -1);
assert.notStrictEqual(closeMediaEnd, -1);
const closeMediaBody = main.slice(closeMediaStart, closeMediaEnd);
assert.doesNotMatch(
  closeMediaBody,
  /if\s*\(!m_Source\)\s*\{\s*return OperationOutcome::Success;/,
  'no-source close must not bypass common media cleanup',
);
assert.match(closeMediaBody, /OperationOutcome outcome\s*=\s*OperationOutcome::Success/);
assert.match(closeMediaBody, /m_AudioTrack\s*=\s*samsung::wasm::ElementaryMediaTrack\(\)/);
assert.match(closeMediaBody, /m_VideoTrack\s*=\s*samsung::wasm::ElementaryMediaTrack\(\)/);
assert.match(closeMediaBody, /m_EmssReadyState\s*=\s*EmssReadyState::kDetached/);
assert.match(closeMediaBody, /m_AudioStarted\.store\(false\)/);
assert.match(closeMediaBody, /m_VideoStarted\.store\(false\)/);
assert.match(closeMediaBody, /m_AudioSessionId\.store\(0\)/);
assert.match(closeMediaBody, /m_VideoSessionId\.store\(0\)/);
assert.match(closeMediaBody, /m_Source\.reset\(\)/);

console.log('media_ownership_wiring_tests: PASS');
