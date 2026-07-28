# Audio Sync and Video Timing Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace burst-heavy audio correction with a bounded controller and preserve media PTS across frame-pacer discontinuities.

**Architecture:** Add one header-only state machine for audio lead correction and extend the existing video timing helper so media timestamp progression and pacing resets are independent. Keep Samsung EMSS integration in `auddec.cpp` and `wasmplayer.cpp` thin and transactional.

**Tech Stack:** C++17, Moonlight Common C, Opus, Samsung Tizen WASM Player, Node.js structural tests, Docker WGT build

## Global Constraints

- Preserve Samsung hardware decoding and existing H.264, HEVC, and AV1 profiles.
- Preserve `CAPABILITY_DIRECT_SUBMIT` for audio and `CAPABILITY_SLICES_PER_FRAME(4)` for video.
- Do not change video queue capacity, IDR policy, codec negotiation, or stream configuration.
- Use 200 ms/120 ms audio soft hysteresis, a 350 ms hard limit, and at most one soft drop per ten packets.
- Keep the 250 ms video pacing-reset threshold and the adaptive 50-300 microsecond spin window.
- Commit the audio and video behavior changes separately.
- Do not claim physical-TV validation without running it.

---

### Task 1: Bounded audio synchronization controller

**Files:**
- Create: `wasm/audio_sync.hpp`
- Create: `tests/audio_sync_tests.cpp`
- Modify: `wasm/auddec.cpp`
- Modify: `tests/media_ownership_wiring_tests.js`

**Interfaces:**
- Produces: `AudioSyncController`, `AudioSyncDecision`, `ObservePacket(nowSeconds)`, and `CommitAppend(nowSeconds, durationSeconds)`.
- Consumes: successful Opus decode and Samsung `AppendPacket()` result from `auddec.cpp`.

- [ ] **Step 1: Write the failing native controller test**

Cover:

```cpp
AudioSyncController controller(0.200, 0.120, 0.350, 10);
assert(controller.ObservePacket(0.000) == AudioSyncDecision::Append);
controller.CommitAppend(0.000, 0.005);
// Build 200 ms of accepted lead, then verify one-in-ten soft correction.
// Build 350 ms of lead, then verify consecutive hard-limit drops.
// Advance wall time below 120 ms lead and verify soft correction clears.
```

Also assert that calling `ObservePacket()` without `CommitAppend()` does not
advance estimated lead.

- [ ] **Step 2: Run the native test and verify RED**

Run:

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/audio_sync_tests.cpp -o /tmp/audio_sync_tests"
```

Expected: compilation fails because `wasm/audio_sync.hpp` does not exist.

- [ ] **Step 3: Implement the minimal controller**

Use seconds as `double` in the pure helper. `ObservePacket()` computes
`max(0, estimatedEnd - now)`, enters soft correction above 0.200, leaves below
0.120, drops every tenth packet while soft correction is active, and drops
every packet at or above 0.350. `CommitAppend()` updates:

```cpp
estimatedEnd = std::max(estimatedEnd, now) + duration;
```

- [ ] **Step 4: Run the native test and verify GREEN**

Compile and execute `/tmp/audio_sync_tests`; require exit code 0.

- [ ] **Step 5: Add failing integration assertions**

Extend `media_ownership_wiring_tests.js` to require:

- `DecodeAndAppendPacket()` returns an outcome;
- controller commit occurs only for the appended outcome;
- drop logs are aggregated rather than emitted for every packet.

Run the test and require an assertion failure against the current
`auddec.cpp`.

- [ ] **Step 6: Integrate the controller in `auddec.cpp`**

Return `DecodeAppendOutcome::{DecodeFailed, AppendFailed, Appended}` from the
decode helper. Commit controller state and advance packet PTS only after
`Appended`. Track dropped packet count and maximum lead, and emit one summary
when at least one second has elapsed since the previous summary.

- [ ] **Step 7: Verify and commit patch 1**

Run:

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/audio_sync_tests.cpp -o /tmp/audio_sync_tests && /tmp/audio_sync_tests"
rtk node tests/media_ownership_wiring_tests.js
rtk git diff --check
```

Commit:

```powershell
rtk git add wasm/audio_sync.hpp wasm/auddec.cpp tests/audio_sync_tests.cpp tests/media_ownership_wiring_tests.js
rtk git commit -m "fix: soften audio synchronization drops"
```

---

### Task 2: Preserve media PTS across pacing resets

**Files:**
- Modify: `wasm/video_timing.hpp`
- Modify: `wasm/wasmplayer.cpp`
- Modify: `tests/video_timing_tests.cpp`

**Interfaces:**
- Produces: `VideoTimestampUpdate { double seconds; bool resetPacing; }`.
- Preserves: `AppendAndCommitPacingState`, adaptive spin behavior, and packet metadata transaction.

- [ ] **Step 1: Change tests to the desired behavior and verify RED**

Require:

```cpp
VideoTimestampState state{};
AssertNear(UpdatePresentationTimestamp(1000, state, 250).seconds, 0.0);
AssertNear(UpdatePresentationTimestamp(1016, state, 250).seconds, 0.016);
auto gap = UpdatePresentationTimestamp(1400, state, 250);
AssertNear(gap.seconds, 0.400);
assert(gap.resetPacing);
```

For `1000, 1050, 1049, 1066`, require the final PTS to be 0.066 rather than
0.067. Add a large backwards restart case that remains monotonic and requests
a pacing reset.

Compile and run the existing timing test. Expected: assertion failure because
the current helper collapses the forward gap and updates its raw baseline for
a one-millisecond regression.

- [ ] **Step 2: Implement timestamp/pacer separation**

For positive deltas, always add the delta to media PTS and set `resetPacing`
when it exceeds 250 ms. For small negative deltas, clamp output and retain the
last valid raw timestamp. For a backwards delta whose magnitude exceeds 250
ms, replace the raw baseline, preserve current output PTS, and request a pacing
reset.

Update `wasmplayer.cpp` to use `resetPacing` only when choosing and committing
`s_firstAppend`; packet PTS always comes from the monotonic media timeline.

- [ ] **Step 3: Verify and commit patch 2**

Run:

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/video_timing_tests.cpp -o /tmp/video_timing_tests && /tmp/video_timing_tests"
rtk node tests/media_ownership_wiring_tests.js
rtk git diff --check
```

Commit:

```powershell
rtk git add wasm/video_timing.hpp wasm/wasmplayer.cpp tests/video_timing_tests.cpp
rtk git commit -m "fix: preserve video PTS across pacing resets"
```

---

### Task 3: Full regression and WGT validation

**Files:**
- Modify only if required: `tests/dependency_manifest_tests.js`
- Modify only if required: `package.json`
- Produce: `Moonlight.wgt`

**Interfaces:**
- Consumes: both committed patches.
- Produces: test evidence and a signed Tizen widget.

- [ ] **Step 1: Run the complete JavaScript suite**

Run `rtk npm run test:js`. If the only failure is the already observed missing
`pairing_timeout_behavior_tests.js` manifest entry, add that existing test to
the expected list and package script, verify the complete suite, and commit the
manifest-only correction separately.

- [ ] **Step 2: Run focused native tests**

Run audio sync, video timing, media operation, operation latch, connection
lifecycle, owned pthread, dispatcher lifecycle, diagnostic log, and
speculative RFI policy tests with the repository's existing WSL compiler
commands and sanitizers where supported.

- [ ] **Step 3: Build and inspect the signed WGT**

Verify Docker Desktop is available, run the normal Docker build, extract the
new `/home/moonlight/Moonlight.wgt`, and record its size, SHA-256, and archive
contents. Do not commit the generated widget unless it is already tracked by
the repository.

- [ ] **Step 4: Final repository audit**

Require a clean worktree, show the commits created during this implementation,
and report that physical-TV behavior remains unverified unless a TV smoke test
was actually executed.
