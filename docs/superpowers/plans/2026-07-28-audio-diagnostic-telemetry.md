# Audio Diagnostic Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add low-overhead telemetry that distinguishes renderer stalls, sync
corrections, append-result failures, RTP/FEC loss, PLC, and EMSS lifecycle
changes without modifying streaming behavior.

**Architecture:** Use two independent, single-thread-owned accumulators. The
WASM renderer reports decode/append/callback timing and packet outcomes. The
common audio transport reports RTP/FEC/PLC counters as window deltas and
cumulative totals. Rare EMSS track lifecycle events are formatted immediately.

**Tech stack:** C++17, C11, Moonlight common-c, Samsung Tizen WASM Player API,
native sanitizer tests, Node.js regression tests, Docker Tizen WGT build.

**Global constraints:**

- Do not add per-packet log writes.
- Do not change sync thresholds, RTP/FEC behavior, direct-submit mode, codec
  negotiation, timestamps, or session ownership.
- Keep all periodic formatting outside the hot-path accumulator.
- Write each behavior test first and observe it fail.
- Commit each completed patch separately.

## Task 1: Renderer Pipeline Telemetry

**Files:**

- Create: `wasm/audio_pipeline_diagnostics.hpp`
- Create: `tests/audio_pipeline_diagnostics_tests.cpp`
- Modify: `wasm/auddec.cpp`
- Modify: `tests/media_ownership_wiring_tests.js`

- [ ] **Step 1: Write the failing accumulator test**

Create a native test covering:

- one outcome per callback;
- appended, soft drop, hard drop, decode failure, append ignored, append buffer
  full, and other append failure counters;
- PLC counting;
- decode, append, and callback averages and maxima;
- current and maximum media offset;
- maximum sync lead;
- last session and append result;
- one-second rate limiting, forced partial flush, and reset.

Compile it before the implementation exists:

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/audio_pipeline_diagnostics_tests.cpp -o /tmp/audio_pipeline_diagnostics_tests"
```

Expected: compilation fails because
`wasm/audio_pipeline_diagnostics.hpp` does not exist.

- [ ] **Step 2: Implement the platform-independent accumulator**

Define:

```cpp
enum class AudioPacketOutcome {
  Appended,
  SoftDropped,
  HardDropped,
  DecodeFailed,
  AppendIgnored,
  AppendBufferFull,
  AppendOtherFailure,
};

struct AudioPipelineSample {
  AudioPacketOutcome outcome;
  bool plc;
  uint64_t decodeUs;
  uint64_t appendUs;
  uint64_t callbackUs;
  double mediaOffsetSeconds;
  double syncLeadSeconds;
  int sessionId;
  int appendResultCode;
};
```

Add `AudioPipelineSnapshot` and `AudioPipelineDiagnostics` with `Reset()`,
`Record()`, and `Flush()`. `Record()` includes the current sample before it
returns a snapshot. Stage averages use only samples where the stage ran. The
per-packet path performs no allocation.

- [ ] **Step 3: Run the focused native test**

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/audio_pipeline_diagnostics_tests.cpp -o /tmp/audio_pipeline_diagnostics_tests && /tmp/audio_pipeline_diagnostics_tests"
```

Expected: PASS.

- [ ] **Step 4: Integrate with `auddec.cpp`**

Measure callback, Opus decode, and Samsung append durations with
`std::chrono::steady_clock`. Preserve the packet PTS used by the callback.

Read `AppendPacket()` as a `Result<void>` and classify its public
`operation_result`:

- `kAppendIgnored`;
- `kAppendBufferFull`;
- all other non-success values.

Record a sample for every callback, including both sync-drop paths. Emit one
stable `AudioPipelineStats key=value...` record per second and flush a final
partial window during cleanup. Replace the old separate Audio Sync aggregate so
the renderer emits at most one periodic record.

- [ ] **Step 5: Run renderer and wiring regressions**

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/audio_sync_tests.cpp -o /tmp/audio_sync_tests && /tmp/audio_sync_tests"
rtk node tests/media_ownership_wiring_tests.js
```

Expected: PASS.

- [ ] **Step 6: Commit the renderer patch**

```powershell
rtk git add wasm/audio_pipeline_diagnostics.hpp wasm/auddec.cpp tests/audio_pipeline_diagnostics_tests.cpp tests/media_ownership_wiring_tests.js
rtk git commit -m "feat: add audio renderer diagnostics"
```

## Task 2: RTP, FEC, and PLC Telemetry

**Files:**

- Create: `moonlight-common-c/src/AudioTransportDiagnostics.h`
- Create: `tests/audio_transport_diagnostics_tests.c`
- Modify: `moonlight-common-c/src/RtpAudioQueue.h`
- Modify: `moonlight-common-c/src/RtpAudioQueue.c`
- Modify: `moonlight-common-c/src/AudioStream.c`

- [ ] **Step 1: Write the failing counter-window test**

Cover:

- normal and 16-bit-wrap sequence distance;
- no snapshot before one second;
- first and subsequent cumulative-to-window deltas;
- forced final partial snapshot;
- reset behavior.

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && gcc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/audio_transport_diagnostics_tests.c -o /tmp/audio_transport_diagnostics_tests"
```

Expected: compilation fails because
`moonlight-common-c/src/AudioTransportDiagnostics.h` does not exist.

- [ ] **Step 2: Implement the header-only snapshot helper**

Define cumulative `RTP_AUDIO_STATS`, window snapshot state, wrap-safe sequence
distance, and a snapshot function supporting normal interval and forced flush.
The helper must remain usable from C11 and allocate no memory.

- [ ] **Step 3: Run the focused native test**

Compile and execute the command from step 1 with
`&& /tmp/audio_transport_diagnostics_tests`.

Expected: PASS.

- [ ] **Step 4: Instrument `RtpAudioQueue` without changing behavior**

Store cumulative statistics in `RTP_AUDIO_QUEUE` and increment:

- valid/invalid audio and FEC datagrams;
- out-of-sequence audio datagrams;
- recovered FEC data shards;
- unrecoverable FEC blocks;
- the wrap-safe packet distance skipped before a full missing-block jump;
- zero-length PLC placeholders returned by `RtpaGetQueuedPacket()`.

Do not generate additional PLC placeholders and do not alter queue transitions.

- [ ] **Step 5: Emit transport windows from `AudioStream`**

Initialize the snapshot state with the audio queue. After processing received
packets, emit at most one
`AudioTransportStats windowMs=... delta... total...` record per second. After
joining the receive thread, force one final partial snapshot before destroying
the queue.

- [ ] **Step 6: Run transport and common-c regressions**

Run the focused test plus the repository's audio/common native and JavaScript
regression commands discovered in the test scripts.

Expected: PASS.

- [ ] **Step 7: Commit the transport patch**

```powershell
rtk git add moonlight-common-c/src/AudioTransportDiagnostics.h moonlight-common-c/src/RtpAudioQueue.h moonlight-common-c/src/RtpAudioQueue.c moonlight-common-c/src/AudioStream.c tests/audio_transport_diagnostics_tests.c
rtk git commit -m "feat: add audio transport diagnostics"
```

## Task 3: EMSS Track Lifecycle Telemetry

**Files:**

- Create: `wasm/media_track_diagnostics.hpp`
- Create: `tests/media_track_diagnostics_tests.cpp`
- Modify: `wasm/wasmplayer.cpp`

- [ ] **Step 1: Write the failing formatter test**

Cover every known `EmssTrackCloseReason`, unknown numeric values, open records
with current session or query error, close records, and session-change records.

Compile with the same C++17 sanitizer flags as Task 1.

Expected: compilation fails because `wasm/media_track_diagnostics.hpp` does not
exist.

- [ ] **Step 2: Implement deterministic lifecycle formatting**

Provide pure helpers for reason-name mapping and stable open, close, and
session-change strings. The functions run only on rare lifecycle events.

- [ ] **Step 3: Integrate both audio and video listeners**

On open, report stored session and `GetSessionId()` success or numeric error. On
close, report reason name/value and stored session. On session change, report
old/new values before updating the stored id. Preserve all flags, latches, and
assignments.

- [ ] **Step 4: Run focused and media ownership tests**

Expected: PASS.

- [ ] **Step 5: Commit the lifecycle patch**

```powershell
rtk git add wasm/media_track_diagnostics.hpp wasm/wasmplayer.cpp tests/media_track_diagnostics_tests.cpp
rtk git commit -m "feat: add media track lifecycle diagnostics"
```

## Task 4: Operator Documentation

**Files:**

- Modify: `docs/diagnostic-logs.md`
- Modify: `docs/audio-audit-and-prechange-log-analysis-2026-07-28.md`

- [ ] **Step 1: Document every stable field**

Explain the two periodic records, rare lifecycle records, rate limits, units,
delta versus cumulative counters, and the fact that telemetry observes rather
than repairs transport loss.

- [ ] **Step 2: Add a TV comparison checklist**

Describe how to correlate:

- callback/append maxima with packet gaps;
- sync drops with media offset and lead;
- append errors with lifecycle/session changes;
- FEC recovery, failed blocks, full-block skips, and PLC;
- pre-change and post-change sessions.

- [ ] **Step 3: Commit the documentation patch**

```powershell
rtk git add docs/diagnostic-logs.md docs/audio-audit-and-prechange-log-analysis-2026-07-28.md
rtk git commit -m "docs: document audio diagnostic telemetry"
```

## Task 5: End-to-End Verification and WGT

- [ ] **Step 1: Run all focused native tests**

Run audio pipeline, transport, lifecycle, Audio Sync, video timing, diagnostic
logger, and pairing timeout tests with the repository-supported commands.

- [ ] **Step 2: Run the complete JavaScript suite**

```powershell
rtk npm run test:js
```

Expected: PASS.

- [ ] **Step 3: Check repository hygiene**

```powershell
rtk git diff --check
rtk git status --short
```

- [ ] **Step 4: Build the signed Tizen package**

Verify Docker Desktop is running, build the repository image, extract
`Moonlight.wgt`, and inspect its archive/signature files. Record its size and
SHA-256.

- [ ] **Step 5: Commit only any necessary verification wiring**

If verification requires a test-runner update, commit it separately. Do not
commit the binary WGT unless it is already a tracked project artifact.

- [ ] **Step 6: Report the validation boundary**

Report verified commands and artifact details. State explicitly that physical
TV logs are still required to confirm or reject the runtime hypotheses.
