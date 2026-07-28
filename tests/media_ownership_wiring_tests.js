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
assert.match(audio, /enum class DecodeAppendOutcome/);
assert.match(audio, /static DecodeAppendOutcome DecodeAndAppendPacket/);
assert.match(
  audio,
  /if\s*\(\s*decodeOutcome\s*==\s*DecodeAppendOutcome::Appended\s*\)\s*\{[\s\S]*?s_AudioSyncController\.CommitAppend/,
);
assert.doesNotMatch(audio, /Dropping audio packet to avoid overflow/);
assert.match(audio, /Audio sync correction dropped/);
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
