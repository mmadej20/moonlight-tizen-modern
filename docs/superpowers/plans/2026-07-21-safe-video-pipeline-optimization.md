# Safe Video Pipeline Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve HEVC/AV1 packet timing, pacing efficiency, and performance reporting while preserving Samsung hardware decoding and the existing codec negotiation behavior.

**Architecture:** Add a platform-independent timing helper that rebases Moonlight's 32-bit presentation timestamps and splits pacing waits into sleep and spin phases. Integrate it transactionally into the existing decoder worker callback, and rename statistics so the overlay reports only synchronous stages the application can actually measure.

**Tech Stack:** C++17, Moonlight Common C, Samsung Tizen WASM Player, Samsung Emscripten, WSL g++ native tests, Docker/Tizen CLI packaging.

## Global Constraints

- Do not create commits or modify any remote repository.
- Preserve `samsung::wasm::DecodingMode::kHardware` and existing HEVC/AV1 MIME profiles.
- Do not enable direct submit, frame dropping, additional IDR requests, `-O3`, or different slice counts.
- Keep the contiguous packet assembly buffer.
- Do not describe packet submission as completed hardware decoding or display rendering.
- Produce a locally signed `Moonlight.wgt`; do not claim device validation.

---

### Task 1: Testable timestamp and pacing calculations

**Files:**
- Create: `tests/video_timing_tests.cpp`
- Create: `wasm/video_timing.hpp`

**Interfaces:**
- Produces: `VideoTimestampState`, `RebasePresentationTimestamp(uint32_t, VideoTimestampState&)`, `PacingWait`, and `CalculatePacingWait(std::chrono::microseconds, std::chrono::microseconds)`.

- [ ] **Step 1: Write the failing native test**

Create tests that include the not-yet-existing header and assert:

```cpp
#include "wasm/video_timing.hpp"

#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdint>

using namespace std::chrono_literals;

static void AssertNear(double actual, double expected) {
  assert(std::fabs(actual - expected) < 0.000001);
}

int main() {
  VideoTimestampState state{};
  AssertNear(RebasePresentationTimestamp(1000, state), 0.0);
  AssertNear(RebasePresentationTimestamp(1016, state), 0.016);
  AssertNear(RebasePresentationTimestamp(1050, state), 0.050);
  AssertNear(RebasePresentationTimestamp(1049, state), 0.050);
  AssertNear(RebasePresentationTimestamp(1066, state), 0.066);

  VideoTimestampState wrapping{};
  AssertNear(RebasePresentationTimestamp(UINT32_MAX - 15, wrapping), 0.0);
  AssertNear(RebasePresentationTimestamp(16, wrapping), 0.032);

  VideoTimestampState committed{};
  AssertNear(RebasePresentationTimestamp(2000, committed), 0.0);
  auto candidate = committed;
  AssertNear(RebasePresentationTimestamp(2033, candidate), 0.033);
  AssertNear(RebasePresentationTimestamp(2016, committed), 0.016);

  auto noWait = CalculatePacingWait(-1us, 500us);
  assert(noWait.sleep == 0us && noWait.spin == 0us);
  auto spinOnly = CalculatePacingWait(300us, 500us);
  assert(spinOnly.sleep == 0us && spinOnly.spin == 300us);
  auto hybrid = CalculatePacingWait(2500us, 500us);
  assert(hybrid.sleep == 2000us && hybrid.spin == 500us);
}
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -I. tests/video_timing_tests.cpp -o /tmp/moonlight-video-timing-tests"
```

Expected: compilation fails because `wasm/video_timing.hpp` does not exist.

- [ ] **Step 3: Add the minimal timing helper**

Implement a header with include guards. `RebasePresentationTimestamp()` initializes the first sample at zero, calculates `int32_t delta = static_cast<int32_t>(current - state.lastRawTimestampMs)`, ignores negative deltas, accumulates non-negative deltas in a `uint64_t`, and returns seconds. `CalculatePacingWait()` returns zero for non-positive waits, spin-only at or below the spin window, and `remaining - spinWindow` plus the spin window otherwise.

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -I. tests/video_timing_tests.cpp -o /tmp/moonlight-video-timing-tests && /tmp/moonlight-video-timing-tests"
```

Expected: exit code 0 with no assertion failures.

---

### Task 2: Integrate real PTS and hybrid pacing

**Files:**
- Modify: `wasm/wasmplayer.cpp:1-530`

**Interfaces:**
- Consumes: timing helper from Task 1.
- Produces: packet PTS based on `decodeUnit->presentationTimeMs`, hybrid pacing, and first-IDR-only packet metadata.

- [ ] **Step 1: Confirm the tested helper provides transactional state**

Run the native command from Task 1 and require exit code 0. The copy-state assertions written before the helper implementation document the transaction used by the callback.

- [ ] **Step 2: Replace synthetic fixed-FPS pacing state**

In `wasmplayer.cpp`:

- include `video_timing.hpp` and `<thread>`;
- calculate `s_frameDuration` with double precision;
- replace `s_pktPts`, `s_ptsDiff`, and `s_lastSec` state with `VideoTimestampState s_TimestampState` and `bool s_HasSubmittedVideoConfig`;
- reset timestamp state, video-config state, `total_bytes`, and `m_LastFrameNumber` in `VidDecSetup()`;
- before submission, calculate PTS using a copy of `s_TimestampState`;
- establish the local steady-clock origin on the first candidate frame;
- when pacing is enabled, target `origin + packet PTS - kFrameTimeMargin`, sleep for the coarse phase returned by `CalculatePacingWait()`, then spin until the target;
- set packet width/height/FPS only when `!s_HasSubmittedVideoConfig && frameType == FRAME_TYPE_IDR`;
- after successful `AppendPacket()`, commit the candidate timestamp state and mark video configuration submitted;
- on failure, return `DR_NEED_IDR` without committing either state.

- [ ] **Step 3: Re-run native timing tests**

Run the Task 1 test command and require exit code 0.

---

### Task 3: Correct synchronous pipeline statistics

**Files:**
- Modify: `wasm/moonlight_wasm.hpp:56-79`
- Modify: `wasm/wasmplayer.cpp:343-716`

**Interfaces:**
- Produces: received/submitted FPS plus queue, assembly, pacing, and submission durations with microsecond precision.

- [ ] **Step 1: Define observable metric semantics before editing**

Use these exact counters in `VIDEO_STATS`:

```cpp
uint32_t receivedFrames;
uint32_t submittedFrames;
uint32_t totalFrames;
uint32_t networkDroppedFrames;
uint64_t totalQueueTimeUs;
uint64_t totalAssemblyTimeUs;
uint64_t totalPacerTimeUs;
uint64_t totalSubmitTimeUs;
float totalFps;
float receivedFps;
float submittedFps;
```

Keep existing host latency, RTT, bitrate, and measurement timestamp fields.

- [ ] **Step 2: Instrument non-overlapping stages**

Use `steady_clock` microseconds around packet copying, pacing, and `AppendPacket()`. Measure queue time once at callback entry as `LiGetMillis() - enqueueTimeMs`, converted to microseconds. Increment `submittedFrames` only after a successful append.

- [ ] **Step 3: Update aggregation and overlay labels**

Aggregate each renamed field exactly once. Display:

```text
Incoming frame rate from network
Packet submission rate
Average packet queue delay
Average packet assembly time
Average frame pacing delay
Average packet submission time
```

Divide received-stage totals by `receivedFrames` and successful-submission totals by `submittedFrames`, guarding every denominator against zero.

- [ ] **Step 4: Run native timing tests again**

Run the Task 1 test command and require exit code 0.

---

### Task 4: Build and verify the Tizen widget

**Files:**
- Read: `Dockerfile`
- Produce: `Moonlight.wgt`

**Interfaces:**
- Consumes: all source changes from Tasks 1-3.
- Produces: locally signed Tizen widget.

- [ ] **Step 1: Start Docker Desktop if its engine is unavailable**

Launch `C:\Program Files\Docker\Docker\Docker Desktop.exe` hidden and poll `docker info` in intervals shorter than 60 seconds until the Linux engine responds or a bounded startup timeout is reached.

- [ ] **Step 2: Build the repository Docker image**

Run:

```powershell
rtk docker build --progress=plain -t moonlight-tizen-local-safe .
```

Expected: exit code 0 and Dockerfile packaging step creates `/home/moonlight/Moonlight.wgt`.

- [ ] **Step 3: Extract the WGT locally**

Create a uniquely named container from `moonlight-tizen-local-safe`, copy `/home/moonlight/Moonlight.wgt` to the workspace as `Moonlight.wgt`, then remove only that exact temporary container.

- [ ] **Step 4: Verify source tests and artifact freshness**

Freshly run the native timing test. Inspect `Moonlight.wgt` for non-zero size and a modification timestamp from this build. Open the ZIP-compatible WGT listing and confirm it contains `config.xml`, the WebAssembly application files, and signing metadata.

- [ ] **Step 5: Report exact verification limits**

Report the artifact path, byte size, SHA-256, test command result, and Docker build result. Explicitly state that no emulator or physical TV playback test was performed.
