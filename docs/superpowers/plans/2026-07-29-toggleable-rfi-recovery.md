# Toggleable RFI Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, default-off Advanced setting that enables codec-correct RFI negotiation for controlled TV testing.

**Architecture:** Keep capability selection in a pure C++ helper, pass one boolean through the existing JavaScript-to-Emscripten stream launch boundary, and set the static decoder callback capability before the connection thread starts. Preserve the existing speculative policy gate so speculative recovery is active only when RFI was actually negotiated.

**Tech Stack:** JavaScript, jQuery/MDL, C++17, Moonlight Common C, Emscripten, Node.js source-wiring tests, Docker, Tizen WGT packaging.

## Global Constraints

- The setting is experimental, persistent, and defaults to off.
- Disabled behavior must preserve `CAPABILITY_SLICES_PER_FRAME(4)` exactly.
- RFI capability must match the selected H.264, HEVC, or AV1 codec.
- Never bypass `isReferenceFrameInvalidationEnabled()`.
- Log the requested mode and final capability mask once per stream.
- Keep the legacy Tizen runtime packaging profile currently selected by the branch.
- Commit each independently reviewable patch.

---

### Task 1: Capability policy tests

**Files:**
- Modify: `tests/speculative_rfi_policy_tests.cpp`
- Create: `wasm/rfi_capabilities.hpp`

**Interfaces:**
- Consumes: `VIDEO_FORMAT_MASK_H264`, `VIDEO_FORMAT_MASK_H265`, `VIDEO_FORMAT_MASK_AV1`, and the three `CAPABILITY_REFERENCE_FRAME_INVALIDATION_*` constants from `Limelight.h`.
- Produces: `int decoderCapabilitiesWithOptionalRfi(int baseCapabilities, bool enabled, int supportedVideoFormats)`.

- [ ] **Step 1: Write failing native tests**

Add assertions proving that disabled and unknown formats preserve the base
capability, while enabled H.264, HEVC Main/Main10, and AV1 Main8/Main10 add only
their matching RFI bit.

- [ ] **Step 2: Run the native test to verify RED**

Run:

```powershell
wsl g++ -std=c++17 -Wall -Wextra -Werror -I. tests/speculative_rfi_policy_tests.cpp -o /tmp/speculative_rfi_policy_tests
```

Expected: compilation fails because `wasm/rfi_capabilities.hpp` does not exist.

- [ ] **Step 3: Commit the failing test**

```powershell
git add tests/speculative_rfi_policy_tests.cpp
git commit -m "test: define codec-specific RFI capabilities"
```

- [ ] **Step 4: Implement the pure capability helper**

Create `wasm/rfi_capabilities.hpp` with a C++17 inline function that returns
`baseCapabilities` when disabled or unknown and otherwise ORs exactly one
codec-specific RFI bit selected by the format masks.

- [ ] **Step 5: Run the native test to verify GREEN**

Compile with the command from Step 2, then run:

```powershell
wsl /tmp/speculative_rfi_policy_tests
```

Expected: exit code 0 and `speculative_rfi_policy_tests: PASS`.

- [ ] **Step 6: Commit the helper**

```powershell
git add wasm/rfi_capabilities.hpp
git commit -m "feat: derive codec-specific RFI capabilities"
```

### Task 2: Advanced setting and stream wiring

**Files:**
- Modify: `tests/ui_reliability_wiring_tests.js`
- Modify: `wasm/index.html`
- Modify: `wasm/platform/navigation.js`
- Modify: `wasm/platform/index.js`
- Modify: `wasm/platform/messages.js`
- Modify: `wasm/moonlight_wasm.hpp`
- Modify: `wasm/main.cpp`

**Interfaces:**
- Consumes: `decoderCapabilitiesWithOptionalRfi(...)` from Task 1.
- Produces: persisted key `speculativeRfi`, DOM IDs `speculativeRfiBtn` and
  `speculativeRfiSwitch`, and a final `bool speculativeRfi` stream argument.

- [ ] **Step 1: Write failing wiring assertions**

Assert that the HTML control and navigation item exist; click handling,
`storeData`, `getData`, and restore-default behavior use `speculativeRfi`;
both resume and launch arrays pass it; JavaScript and C++ signatures accept it;
and native code derives and logs renderer capabilities.

- [ ] **Step 2: Run the JavaScript test to verify RED**

Run:

```powershell
node tests/ui_reliability_wiring_tests.js
```

Expected: failure reporting the missing speculative-RFI control or wiring.

- [ ] **Step 3: Commit the failing wiring test**

```powershell
git add tests/ui_reliability_wiring_tests.js
git commit -m "test: define speculative RFI setting wiring"
```

- [ ] **Step 4: Add the Advanced control and persistence**

Add the default-off experimental switch with a warning description, add it to
Advanced navigation, bind `saveSpeculativeRfi`, persist its boolean value, load
missing values as off, and reset it to off in Restore Defaults.

- [ ] **Step 5: Pass the setting through both stream launch paths**

Read the switch as `0` or `1`, include it in the start summary and diagnostic
session metadata, append it to both `startRequest` arrays, and document the
argument in `messages.js`.

- [ ] **Step 6: Apply and log native capabilities**

Append `bool speculativeRfi` to both wrapper and instance signatures. After
codec selection and fallback, set:

```cpp
s_DrCallbacks.capabilities = decoderCapabilitiesWithOptionalRfi(
    CAPABILITY_SLICES_PER_FRAME(4),
    speculativeRfi,
    m_StreamConfig.supportedVideoFormats);
```

Log the requested state and resulting hexadecimal capability mask once before
the connection thread starts.

- [ ] **Step 7: Run focused tests to verify GREEN**

Run:

```powershell
node tests/ui_reliability_wiring_tests.js
wsl /tmp/speculative_rfi_policy_tests
```

Expected: both print `PASS`.

- [ ] **Step 8: Commit the implementation**

```powershell
git add wasm/index.html wasm/platform/navigation.js wasm/platform/index.js wasm/platform/messages.js wasm/moonlight_wasm.hpp wasm/main.cpp
git commit -m "feat: add experimental RFI recovery toggle"
```

### Task 3: Regression verification and TV artifact

**Files:**
- Create: `Moonlight-legacy-rfi-toggle.wgt`

**Interfaces:**
- Consumes: the complete implementation from Tasks 1 and 2.
- Produces: a signed legacy-runtime widget and a reproducible TV A/B procedure.

- [ ] **Step 1: Run the JavaScript suite**

Run:

```powershell
npm run test:js
```

Expected: every named suite prints `PASS`.

- [ ] **Step 2: Run native and receiver regressions**

Compile and run the speculative policy test with warnings as errors, then run
the repository's PowerShell receiver integration script using Windows
PowerShell. Every command must exit 0.

- [ ] **Step 3: Build the signed widget**

Build the repository Docker image, copy `/home/moonlight/Moonlight.wgt` from a
temporary container to `Moonlight-legacy-rfi-toggle.wgt`, and remove only that
verified temporary container.

- [ ] **Step 4: Inspect the artifact**

Verify SHA-256, `config.xml` legacy required version, jQuery 2.2 inclusion, both
Tizen signature files, the Advanced switch markup, and the native diagnostic
strings in the packaged files.

- [ ] **Step 5: Commit any packaging metadata patch**

Do not commit generated WGT files unless the repository already tracks them.
Commit only source or documentation changes created by packaging.

- [ ] **Step 6: Report the A/B test procedure**

State that RFI may shorten recovery and reduce IDRs after isolated loss but
cannot reduce network packet drops, large FEC-unrecoverable bursts, or shared
audio/video stalls. Provide the exact off/on comparison metrics and artifact
path.
