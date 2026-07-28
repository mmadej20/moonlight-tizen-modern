# Rate-limited Freeze Diagnostics Implementation Plan

**Goal:** Reduce normal diagnostic volume by about 80-90% and add enough
low-frequency video telemetry to distinguish network, depacketizer, and
renderer stalls.

**Constraints:** Preserve stream behavior, codec negotiation, timestamps,
Audio Sync policy, FEC, IDR policy, and direct-submit mode. Write tests first
and commit each patch separately.

## Patch 1: Audio telemetry rate limiting

- Extend `AudioPipelineDiagnostics` with a 10 s normal interval and a 1 s
  anomaly cooldown.
- Treat sync drops, PLC, decode failures, and append failures as anomalies.
- Extend `AudioTransportDiagnostics` with the same normal/anomaly policy;
  normal audio/FEC traffic is not an anomaly.
- Add boundary tests proving the first anomaly is immediate, bursts are
  coalesced, and normal traffic remains in a 10 s window.
- Run both focused native tests and audio wiring regressions.
- Commit as `fix: rate limit audio diagnostic telemetry`.

## Patch 2: Video freeze diagnostics

- Add a C11 video receive accumulator with:
  - a 10 s packet heartbeat;
  - a stall event after 1 s without a video datagram;
  - repeat stall reports no more often than every 5 s;
  - one recovery event when traffic resumes.
- Integrate it in `VideoStream.c` without changing receive decisions.
- Correct the corrupt-frame formatter to unsigned and include expected/actual
  packet indices plus a newline.
- Log the rare event when an IDR is recognized by the depakietyzator.
- Add focused native tests for heartbeat, stall cooldown, and recovery.
- Commit as `feat: add rate-limited video freeze diagnostics`.

## Patch 3: Renderer-side IDR probe

- Emit rare markers immediately before and after the actual Samsung
  `ElementaryMediaTrack::AppendPacket()` call for an IDR frame.
- Include frame number, PTS, session, result, and append duration.
- Keep normal P-frame rendering silent; the receive heartbeat already proves
  whether transport remains active.
- Run video timing and full build regressions.
- Commit as `fix: place IDR probe around actual renderer`.

## Validation

- Compile focused C/C++ tests with `-Wall -Wextra -Werror` and ASan/UBSan.
- Run the complete Node regression suite.
- Run all existing focused native suites touched by the branch.
- Build the Docker Tizen artifact and verify the WGT signature and SHA-256.
- Do not claim the freeze fixed until a physical-TV log shows which heartbeat
  stops first.
