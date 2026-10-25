'use strict';

// Frame pacing used to anchor the presentation time of every frame to the first one (or the first after a gap of 250 ms) and never
// moved it: a first frame that arrived late (a stall of the network) became the delay of the whole stream, and the stats overlay
// showed an "Average packet queue delay" of 136 ms, against 6 ms with the pacing off. The anchor now follows the frames of the last
// two seconds (PlayoutAnchor in video_timing.hpp, tested in tests/video_timing_tests.cpp); this test checks the way the player uses it.

const assert = require('assert');
const fs = require('fs');

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const player = read('wasm/wasmplayer.cpp');
const header = read('wasm/moonlight_wasm.hpp');
const timing = read('wasm/video_timing.hpp');

function extractBlock(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, 'missing ' + marker);
  let depth = 0;
  for (let at = source.indexOf('{', start); at < source.length; at++) {
    if (source[at] === '{') depth++;
    if (source[at] === '}' && --depth === 0) return source.slice(start, at + 1);
  }
  throw new Error('unbalanced braces after ' + marker);
}

const submit = extractBlock(player, 'int MoonlightInstance::VidDecSubmitDecodeUnit(');
const setup = extractBlock(player, 'int MoonlightInstance::VidDecSetup(');

// The anchor of the first frame is gone, the estimator took its place
assert(!/s_firstAppend/.test(player), 'no anchor that is set once and never moves');
assert(/static PlayoutAnchor s_PlayoutAnchor\(/.test(player));

// Every stream sizes the cap by its frame rate, and starts from a clean window
assert(/s_PlayoutAnchor = PlayoutAnchor\(PlayoutMaxBufferUs\(static_cast<int64_t>\(std::llround\(1000000\.0 \/ static_cast<double>\(redrawRate\)\)\)\)\);/.test(setup));

// The frame works on a copy of the estimator that is committed only when the frame was appended, like the rest of the pacing state
assert(/PlayoutAnchor candidatePlayoutAnchor = s_PlayoutAnchor;/.test(submit));
assert(/if \(!s_hasFirstFrame \|\| timestampUpdate\.resetPacing\) \{\s*candidatePlayoutAnchor\.Reset\(\);/.test(submit), 'a new timeline starts the window again');
assert(/s_PlayoutAnchor = candidatePlayoutAnchor;/.test(submit.slice(submit.indexOf('AppendAndCommitPacingState'))), 'committed with the frame');

// The offset is the arrival time minus the timestamp, and only a stream that paces pays for the estimate
assert(/arrivalOffsetUs = std::chrono::duration_cast<std::chrono::microseconds>\(pacingStart\.time_since_epoch\(\)\)\.count\(\) - packetPtsUs;/.test(submit));
assert(/if \(s_FramePacingEnabled\) \{\s*const int64_t anchorOffsetUs = candidatePlayoutAnchor\.Observe\(arrivalOffsetUs\);/.test(submit));
assert(/const auto targetTime = candidateFirstAppend\s*\+ std::chrono::duration_cast<std::chrono::steady_clock::duration>\(\s*std::chrono::duration<double>\(packetPtsSeconds\)\)\s*- std::chrono::duration_cast<std::chrono::steady_clock::duration>\(kFrameTimeMargin\);/.test(submit),
  'the time to show a frame is still the anchor plus its timestamp, a little early');
assert(/candidateFirstAppend = std::chrono::steady_clock::time_point\(\s*std::chrono::duration_cast<std::chrono::steady_clock::duration>\(std::chrono::microseconds\(anchorOffsetUs\)\)\);/.test(submit));

// The estimator is the one of the header, and the cap is the one that the tests pin
assert(/class PlayoutAnchor \{/.test(timing) && /inline int64_t PlayoutMaxBufferUs\(int64_t frameIntervalUs\)/.test(timing));

// The log says how far behind the best case the frames are held
assert(/uint32_t maxFrameGapMs;\s*uint32_t maxPlayoutBufferUs;/.test(header));
assert(/"maxFrameGapMs=%u playoutBufferMs=%\.1f bitrateMbps=%\.1f\\n"/.test(player));
assert(/m_ActiveWndVideoStats\.maxPlayoutBufferUs = MAX\(/.test(submit));
assert(/dst\.maxPlayoutBufferUs = MAX\(dst\.maxPlayoutBufferUs, src\.maxPlayoutBufferUs\);/.test(player));

console.log('frame_pacing_wiring_tests: PASS');
