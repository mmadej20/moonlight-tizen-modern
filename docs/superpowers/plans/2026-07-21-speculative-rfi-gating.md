# Speculative RFI Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent speculative frame-loss prediction from discarding HEVC reference state when the Tizen decoder cannot use RFI.

**Architecture:** Isolate the prediction decision in a pure C-compatible inline predicate and use it at the existing RTP queue call site. Preserve all definitive recovery paths and decoder behavior.

**Tech Stack:** C99, C++17 native tests, Moonlight-common RTP/FEC queue, Emscripten, Docker, Tizen WGT packaging.

## Global Constraints

- Do not enable unsupported decoder RFI capabilities.
- Do not alter FEC, definitive loss detection, or IDR fallback.
- Do not create commits.
- Produce a final signed local `Moonlight.wgt`.

---

### Task 1: Test and implement speculative-RFI policy

**Files:**
- Create: `tests/speculative_rfi_policy_tests.cpp`
- Create: `moonlight-common-c/src/RtpVideoQueuePolicy.h`
- Modify: `moonlight-common-c/src/RtpVideoQueue.c`

**Interfaces:**
- Produces: `bool shouldUseSpeculativeRfi(bool frameAlreadyReportedLost, bool receivedOosData, bool rfiEnabled, unsigned int missingPackets, unsigned int recoverablePackets)`.
- Consumes: the RTP queue's existing state and `isReferenceFrameInvalidationEnabled()`.

- [ ] **Step 1: Write the failing native policy test**

Test that RFI-disabled prediction is rejected; valid RFI prediction is accepted; reported, OOS, and FEC-recoverable cases are rejected.

- [ ] **Step 2: Verify RED**

Run `g++ -std=c++17 -Wall -Wextra -Werror tests/speculative_rfi_policy_tests.cpp -o /tmp/speculative_rfi_policy_tests` under WSL.

Expected: compilation fails because `RtpVideoQueuePolicy.h` does not exist.

- [ ] **Step 3: Implement the minimal predicate and wire it into the RTP queue**

Create the C-compatible header and replace the existing compound speculative-loss condition with the predicate, passing `isReferenceFrameInvalidationEnabled()`.

- [ ] **Step 4: Verify GREEN and regressions**

Compile and run the new test, then run the existing diagnostic buffer, video timing, JavaScript diagnostics, syntax, log wiring, and PowerShell receiver tests. Every command must exit 0.

### Task 2: Build and verify the corrected widget

**Files:**
- Replace generated artifact: `Moonlight.wgt`

- [ ] **Step 1: Build the Docker image and signed widget**

Run `docker build -t moonlight-tizen-local-diagnostics .` and require exit 0.

- [ ] **Step 2: Extract `Moonlight.wgt` from the image**

Create a temporary container, copy `/home/moonlight/Moonlight.wgt` to the workspace, and remove the container.

- [ ] **Step 3: Inspect the final widget**

Verify SHA-256, archive entries, diagnostic JavaScript, and both Tizen signature files.
