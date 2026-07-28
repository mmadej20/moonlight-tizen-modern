# Audio Diagnostic Telemetry Design

## Goal

Add low-overhead diagnostics that can confirm or reject the remaining audio
pipeline hypotheses on a physical Tizen TV without changing stream behavior,
codec negotiation, packet timing, FEC recovery, or track lifecycle.

## Evidence Questions

The telemetry must answer:

1. Does Opus decode or Samsung `AppendPacket()` block the direct-submit receive
   thread for a material part of the 5 ms packet budget?
2. Are Audio Sync corrections still frequent, and how much media-timeline lag
   accumulates while they run?
3. Are append failures `kAppendIgnored`, `kAppendBufferFull`, or another
   `OperationResult`?
4. How many packets are recovered by FEC, replaced with PLC, or skipped because
   an entire FEC block is absent?
5. Does an audio track close/reopen or session-id change precede a new audio
   failure?

## Chosen Approach

Use periodic aggregate telemetry.

- Per-packet work is limited to counters, additions, maxima, and monotonic clock
  reads.
- Renderer and transport statistics are emitted at most once per second.
- Cleanup flushes a partial final window.
- Lifecycle events are logged immediately because they are rare.
- Log records use stable `key=value` fields to support machine parsing.
- Diagnostics are always enabled because the current test workflow exports the
  diagnostic session log after a failure. At two periodic records per second,
  the expected volume remains well below the 2 MiB rotating log limit for a
  normal session.

Rejected alternatives:

- per-packet logging would reproduce the synchronous log storm observed in the
  old Audio Sync implementation;
- a new diagnostics UI toggle would add unrelated UI state and could leave a
  reproduction without telemetry;
- changing `CAPABILITY_DIRECT_SUBMIT` would alter behavior before the timing
  hypothesis is measured.

## Renderer Telemetry

Create a platform-independent `AudioPipelineDiagnostics` accumulator in
`wasm/audio_pipeline_diagnostics.hpp`.

Each callback records exactly one outcome:

- appended;
- soft sync drop;
- hard sync drop;
- Opus decode failure;
- append ignored;
- append buffer full;
- other append failure.

Each sample also records:

- whether it was an Opus PLC input;
- Opus decode duration;
- Samsung append duration;
- total renderer callback duration;
- current media lag (`wall clock - next audio PTS`);
- maximum estimated Audio Sync lead;
- current audio session id;
- numeric value of the last append failure.

The one-second snapshot contains window counts, averages, maxima, current media
lag, maximum media lag, maximum sync lead, current session id, and the last
append failure code.

`auddec.cpp` reads `Result<void>::operation_result` from `AppendPacket()`.
`kAppendIgnored` and `kAppendBufferFull` get dedicated counters. All other
non-success codes are grouped while retaining the last numeric code. Samsung's
API exposes `operation_result` directly on `Result<void>`, and stale session ids
are documented to produce non-fatal `kAppendIgnored`.

The emitted record begins with:

```text
AudioPipelineStats
```

It replaces the current separate `Audio sync correction dropped` record so
there is only one renderer telemetry line per reporting window.

## Transport and FEC Telemetry

Add cumulative `RTP_AUDIO_STATS` to `RTP_AUDIO_QUEUE`, following the statistics
pattern in current upstream `moonlight-common-c`.

Record:

- all recognized audio and FEC datagrams, with invalid counters as subsets;
- invalid audio and FEC datagrams;
- out-of-sequence audio datagrams;
- data shards recovered by Reed-Solomon;
- FEC blocks that could not be recovered;
- packets skipped when `handleMissingPackets()` jumps over a completely absent
  block;
- zero-length PLC placeholders returned to the decoder.

The full-block skip count is calculated before changing
`nextRtpSequenceNumber`, using 16-bit RTP sequence arithmetic. This observes the
existing behavior but does not generate new PLC packets.

`AudioStream.c` snapshots cumulative counters once per second and logs window
deltas plus cumulative totals. The emitted record begins with:

```text
AudioTransportStats
```

The final partial window is flushed during stream shutdown. Existing detailed
FEC failure and sequence-gap messages remain available for exact packet
numbers.

Renderer callback duration already includes Opus and Samsung append time. The
difference between total callback time and the reported decode/append parts
captures local overhead inside `auddec.cpp`. FEC/decryption is evaluated using
the transport counters and correlation with renderer stalls; no new high
resolution cross-platform clock is added in this patch.

## Track Lifecycle Telemetry

Enhance rare EMSS track events with:

- track kind;
- open/closed event;
- close reason name and numeric value;
- old and new stored session id;
- current track session id or the `GetSessionId()` error code.

The behavior of `m_AudioStarted`, `m_VideoStarted`, latches, and stored session
ids remains unchanged. These records only expose the state transitions needed
to diagnose suspend/resume and stale-session appends.

## Log Examples

```text
AudioPipelineStats windowMs=1003 packets=201 appended=198 plc=1 softDrop=2 hardDrop=0 decodeFail=0 appendIgnored=0 appendBufferFull=0 appendOther=0 decodeAvgUs=61 decodeMaxUs=133 appendAvgUs=84 appendMaxUs=520 callbackAvgUs=151 callbackMaxUs=702 mediaLagMs=12 mediaLagMaxMs=18 leadMaxMs=207 session=4 lastAppendResult=0
AudioTransportStats windowMs=1004 audio=201 fec=100 invalidAudio=0 invalidFec=0 oos=0 recovered=1 fecFailed=0 fullBlockSkipped=0 plc=0 totalRecovered=7 totalFecFailed=1 totalFullBlockSkipped=4
AUDIO track closed reason=kSourceSuspended(3) storedSession=4
AUDIO session changed old=4 new=5
AUDIO track open storedSession=5 currentSession=5
```

## Performance and Safety Constraints

- No per-packet `ClLogMessage()` or `Limelog()` is added.
- No heap allocation occurs in the per-packet accumulator.
- Formatting happens only when a snapshot is emitted.
- Counter reset and snapshot emission occur on the same stream thread that
  owns the corresponding accumulator.
- Numeric counters use 64-bit storage.
- A session restart resets window and cumulative renderer statistics.
- Transport statistics are reset by `RtpaInitializeQueue()`.
- Existing stream behavior and error returns are preserved.

## Testing

Tests are written and observed failing before implementation.

Native renderer tests cover:

- one outcome per callback;
- average and maximum duration calculations;
- separate soft/hard/decode/append failure counters;
- `kAppendIgnored` and `kAppendBufferFull` classification;
- one-second rate limiting and forced cleanup snapshot;
- current and maximum media lag;
- reset between sessions.

Native transport tests cover:

- wrap-safe full-block skip distance;
- cumulative-to-window delta snapshots;
- final partial window flush;
- reset behavior.

Native lifecycle tests cover close-reason names and deterministic diagnostic
formatting. The normal JavaScript regression suite and Docker WGT build validate
integration with the Samsung headers.

## Validation Boundary

Passing local tests and producing a signed WGT prove build integration only.
The hypotheses remain unconfirmed until a session is run on a physical TV and
the resulting `AudioPipelineStats`, `AudioTransportStats`, and lifecycle records
are compared with the pre-change log.
