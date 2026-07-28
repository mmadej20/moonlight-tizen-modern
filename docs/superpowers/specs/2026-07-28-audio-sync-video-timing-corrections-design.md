# Audio Sync and Video Timing Corrections Design

## Goal

Reduce destructive audio packet dropping during short delivery bursts and
remove the media-timestamp regression introduced by discontinuity-aware frame
pacing, without changing codec negotiation, Samsung hardware decoding, video
queue behavior, or IDR policy.

## Scope

The work is split into two independently testable patches:

1. replace the 100 ms all-or-nothing audio limiter with a bounded controller;
2. separate monotonic media PTS calculation from local pacing-baseline resets.

Each patch is committed only after its focused tests and relevant regression
tests pass. A final signed WGT build validates integration. Physical-TV
playback remains a separate runtime validation step.

## Audio Sync Controller

The audio callback will use a small platform-independent state machine. It
tracks the estimated end of audio successfully accepted by Samsung EMSS and
compares that value with the local steady clock.

The controller uses:

- a 200 ms soft high watermark;
- a 120 ms low watermark that ends soft correction;
- a 350 ms hard watermark;
- a maximum soft correction rate of one dropped packet per ten received
  packets.

Above the soft watermark, correction becomes active. While active, the
controller drops no more than one packet in ten until the estimated lead falls
below the low watermark. At or above the hard watermark, packets may be
dropped consecutively until wall-clock consumption reduces the lead below the
hard watermark.

The estimated audio end and the next packet PTS advance only after both Opus
decoding and `ElementaryMediaTrack::AppendPacket()` succeed. Decode and append
failures do not create phantom backlog. Drop diagnostics are aggregated and
emitted at most once per second with the dropped count and observed lead.

The existing `CAPABILITY_DIRECT_SUBMIT`, Opus format, channel mapping, and
Samsung audio track configuration remain unchanged.

## Video Timestamp and Pacing Rules

Media PTS and pacing state have separate responsibilities:

- media PTS remains monotonic and preserves valid positive timestamp gaps;
- a small backwards timestamp is clamped without replacing the last valid raw
  timestamp;
- a large backwards timestamp is treated as a source timestamp restart,
  rebased to the current monotonic output PTS;
- the first frame, large forward gap, or backwards restart requests a local
  pacing-baseline reset;
- resetting the local pacing baseline never removes elapsed time from the PTS
  passed to Samsung EMSS.

The current 250 ms discontinuity threshold remains the trigger for resetting
the local pacer. The adaptive 50-300 microsecond spin window and cancellable
coarse waits remain unchanged in this patch.

This behavior applies equally to H.264, HEVC, and AV1. HEVC MIME profiles,
`DecodingMode::kHardware`, packet assembly, frame duration metadata, and
`CAPABILITY_SLICES_PER_FRAME(4)` are preserved.

## Testing

Audio controller tests cover normal real-time delivery, burst correction,
soft-drop rate limiting, hard-limit behavior, hysteresis, and commit-on-success
state. Wiring tests ensure `auddec.cpp` updates timing state only after a
successful append and rate-limits diagnostics.

Video timing tests cover positive gaps above 250 ms, small timestamp
regressions, large backwards restarts, unsigned wraparound, pacing reset
signals, failed append transactions, and cancellation.

The final verification runs the focused native tests, JavaScript regression
tests, and the normal Docker WGT build. The known dependency-manifest mismatch
for `pairing_timeout_behavior_tests.js` is fixed only if it still blocks the
complete JavaScript suite, as a test-manifest correction with no runtime
behavior change.
