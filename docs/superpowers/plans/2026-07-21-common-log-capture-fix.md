# Moonlight-common Log Capture Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route existing Moonlight-common packet-loss, decoder, RFI, and IDR messages into the persistent TV diagnostic export.

**Architecture:** Compile `moonlight-common-c` with its listener-based logging path and safely forward preformatted messages through `ClLogMessage()`. Keep streaming and recovery behavior unchanged.

**Tech Stack:** CMake, C/C++, Emscripten, Node.js regression checks, Docker/Tizen WGT packaging.

## Global Constraints

- Do not change decoder, packet-loss, RFI, or IDR recovery behavior.
- Do not block streaming threads.
- Do not create commits.
- Produce a final signed local `Moonlight.wgt`.

---

### Task 1: Regression guard and listener wiring

**Files:**
- Create: `tests/common_log_capture_wiring_tests.js`
- Modify: `CMakeLists.txt`
- Modify: `moonlight-common-c/src/Platform.h`

**Interfaces:**
- Consumes: `Limelog()` and `CONNECTION_LISTENER_CALLBACKS.logMessage`.
- Produces: all existing `Limelog()` records flowing through `MoonlightInstance::ClLogMessage()`.

- [ ] **Step 1: Write a failing regression test**

Create a Node.js test that reads the build and macro sources and asserts that the `moonlight-common-c` target defines `LC_LOG`, that `Limelog()` forwards with `ListenerCallbacks.logMessage("%s", message)`, and that `ClLogMessage()` appends to the diagnostic buffer.

- [ ] **Step 2: Run the test and verify RED**

Run: `node tests/common_log_capture_wiring_tests.js`

Expected: FAIL because `LC_LOG` is absent and the callback currently treats the formatted message as a format string.

- [ ] **Step 3: Implement the minimal wiring fix**

Add `LC_LOG` beside `LC_CHROME` in `target_compile_definitions(moonlight-common-c PUBLIC ...)`. Change the callback invocation in the active `LC_LOG` macro to:

```c
ListenerCallbacks.logMessage("%s", message);
```

- [ ] **Step 4: Run the regression and existing tests**

Run the new Node.js regression, native diagnostic buffer and video timing tests, existing diagnostic JavaScript suites, JS syntax checks, and the PowerShell receiver integration test. All must exit 0.

### Task 2: Package and inspect the corrected widget

**Files:**
- Replace generated artifact: `Moonlight.wgt`

- [ ] **Step 1: Build the widget**

Run: `docker build -t moonlight-tizen-local-diagnostics .`

Expected: exit 0 and successful Tizen package signing.

- [ ] **Step 2: Extract the final artifact**

Create a temporary container from the image, copy `/home/moonlight/Moonlight.wgt` to the workspace, then remove the temporary container.

- [ ] **Step 3: Verify the final artifact**

Calculate SHA-256, list archive entries, and confirm `platform/diagnostic_logs.js`, `author-signature.xml`, and `signature1.xml` are present.
