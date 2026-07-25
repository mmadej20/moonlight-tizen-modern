# Diagnostic Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded persistent diagnostic logging, an on-TV viewer, and on-demand export to a PowerShell receiver without affecting the streaming hot path.

**Architecture:** A small native C++ ring buffer captures existing Moonlight log messages with a non-blocking lock and exposes batched drains through Embind. A focused JavaScript module redacts and rotates two bounded session logs in private Tizen storage, drives the settings UI, and exports one selected session by HTTP POST. A standalone PowerShell `TcpListener` receives and safely stores exported logs.

**Tech Stack:** C++17, Emscripten/Embind, JavaScript ES5-compatible browser code, Tizen Web Filesystem API, HTML/CSS/MDL navigation, Node.js tests, PowerShell 7/Windows PowerShell, Docker/Tizen CLI.

## Global Constraints

- Keep all changes local and create no Git commits.
- Preserve existing `emscripten_log(EM_LOG_CONSOLE, ...)` output.
- Retain only current and previous sessions, each capped at 2 MiB.
- Poll native logs every 1000 ms and cap the JavaScript retry queue at 256 KiB.
- Never perform storage, JavaScript, or network operations while the native buffer lock is held.
- Export only on user request to `http://<host>:48150/moonlight-logs` with a 5000 ms timeout.
- Do not change decoder, IDR, packet, codec, or pacing behavior.
- Do not claim physical-TV validation unless it actually runs.

---

### Task 1: Native bounded diagnostic buffer

**Files:**
- Create: `wasm/diagnostic_log.hpp`
- Create: `wasm/diagnostic_log.cpp`
- Create: `tests/diagnostic_log_tests.cpp`
- Modify: `wasm/connectionlistener.cpp`
- Modify: `wasm/main.cpp`
- Modify: `CMakeLists.txt`

**Interfaces:**
- Produces: `bool DiagnosticLogTryAppend(uint64_t timestampMs, std::string_view message)`
- Produces: `std::string DrainDiagnosticLogs()` bound to JavaScript as `Module.drainDiagnosticLogs()`
- Produces: `void ResetDiagnosticLogsForTests()` for native tests only

- [ ] **Step 1: Write failing native tests**

Create tests that instantiate a small `DiagnosticLogBuffer`, append timestamped complete records, assert FIFO drain order, force eviction, hold the test lock to assert non-blocking drop behavior, and assert one synthetic dropped-record line after capture resumes.

```cpp
DiagnosticLogBuffer buffer(96);
assert(buffer.TryAppend(10, "first\n"));
assert(buffer.TryAppend(20, "second\n"));
const std::string drained = buffer.Drain();
assert(drained.find("first") < drained.find("second"));

buffer.LockForTest();
assert(!buffer.TryAppend(30, "contended\n"));
buffer.UnlockForTest();
assert(buffer.TryAppend(40, "resumed\n"));
assert(buffer.Drain().find("dropped 1 diagnostic record") != std::string::npos);
```

- [ ] **Step 2: Verify RED**

Run the existing native compiler workflow used by `tests/video_timing_tests.cpp`, adding `tests/diagnostic_log_tests.cpp` and `wasm/diagnostic_log.cpp`. Expected: compilation fails because the new files and interfaces do not exist.

- [ ] **Step 3: Implement the buffer**

Use `std::deque<std::string>`, a byte counter, `std::mutex::try_lock()`, and an atomic dropped counter. Format records as `[<timestampMs> ms] <message>`, preserve newline termination, evict whole records until the fixed capacity is met, and return concatenated records from `Drain()` after releasing the lock.

- [ ] **Step 4: Integrate capture and Embind**

In `ClLogMessage()`, call `emscripten_log()` exactly as today and then call `DiagnosticLogTryAppend(LiGetMillis(), message)`. Add `emscripten::function("drainDiagnosticLogs", &DrainDiagnosticLogs)` in the existing binding block. Add `wasm/diagnostic_log.cpp` to the `moonlight-wasm` target.

- [ ] **Step 5: Verify GREEN and regression tests**

Run both native diagnostic tests and the existing video timing tests. Expected: both exit 0.

---

### Task 2: Session storage, redaction, and export logic

**Files:**
- Create: `wasm/platform/diagnostic_logs.js`
- Create: `tests/diagnostic_logs_js_tests.js`
- Modify: `wasm/index.html`

**Interfaces:**
- Produces: `redactDiagnosticText(text: string): string`
- Produces: `trimDiagnosticLog(text: string, maxBytes: number): string`
- Produces: `validateDiagnosticDestination(host: string, port: string): {host: string, port: number}`
- Produces: `buildDiagnosticExport(sessionName: string, text: string, metadata: object): {filename: string, body: string}`
- Produces: global `DiagnosticLogs` manager with `init`, `beginSession`, `refreshView`, `exportSelected`, and `clearAll`

- [ ] **Step 1: Write failing Node tests**

Tests must assert that PINs, password/token/key query parameters, and URL credentials are replaced with `[REDACTED]`; host IPs and frame counters remain; trimming is UTF-8 byte bounded and starts on a complete record; destination rejects schemes, paths, empty hosts, and ports outside 1–65535; export filenames contain only safe characters.

```js
assert.strictEqual(redactDiagnosticText('PIN: 1234'), 'PIN: [REDACTED]');
assert(redactDiagnosticText('host=192.168.1.10 frame=42').includes('192.168.1.10'));
assert.throws(() => validateDiagnosticDestination('http://host', '48150'));
assert.strictEqual(validateDiagnosticDestination('192.168.1.10', '48150').port, 48150);
```

- [ ] **Step 2: Verify RED**

Run `node tests/diagnostic_logs_js_tests.js`. Expected: module-not-found failure.

- [ ] **Step 3: Implement pure helpers and storage adapter**

Use a UMD-style export so the same file works in Node and as a browser global. Implement a `TizenDiagnosticStorage` adapter using `tizen.filesystem.openFile()` with `wgt-private` paths and an in-memory fallback that reports degraded persistence. Keep pending batches bounded to 256 KiB.

- [ ] **Step 4: Implement manager lifecycle**

`init()` starts a 1000 ms timer that calls `Module.drainDiagnosticLogs()` only when available. `beginSession(metadata)` replaces previous with current only after a successful read/write, then writes a redacted metadata header. `refreshView()` loads only the chosen file, applies the filter in memory, and updates text via `textContent`. `clearAll()` clears both sessions only after UI confirmation.

- [ ] **Step 5: Implement on-demand export**

Validate the destination, use `AbortController` with 5000 ms timeout, and call `fetch('http://' + host + ':' + port + '/moonlight-logs', {method: 'POST', headers, body})`. Preserve the local file on every result and return a structured success/error object for the UI.

- [ ] **Step 6: Verify GREEN**

Run `node tests/diagnostic_logs_js_tests.js`. Expected: all assertions pass and exit 0.

---

### Task 3: Settings UI and stream metadata integration

**Files:**
- Modify: `wasm/index.html`
- Modify: `wasm/static/css/style.css`
- Modify: `wasm/platform/index.js`
- Modify: `wasm/platform/navigation.js`

**Interfaces:**
- Consumes: global `DiagnosticLogs` from Task 2
- Produces: settings category `diagnosticSettings`
- Produces: navigation view `Views.DiagnosticSettings`

- [ ] **Step 1: Add static DOM contract test**

Extend the JS test to read `wasm/index.html` and assert unique IDs for `diagnosticSettings`, `diagnosticSessionSelect`, `diagnosticFilter`, `diagnosticLogViewport`, `diagnosticHost`, `diagnosticPort`, `sendDiagnosticLogsBtn`, and `clearDiagnosticLogsBtn`, plus the script include before `index.js`.

- [ ] **Step 2: Verify RED**

Run `node tests/diagnostic_logs_js_tests.js`. Expected: missing diagnostic DOM IDs.

- [ ] **Step 3: Add settings markup and styles**

Add the category after Advanced Settings and a right-pane section with session selector, metadata, filter, read-only `<pre>` viewport, host/port inputs, action buttons, and status text. Use existing color/focus conventions, a bounded viewport height, `overflow: auto`, and `white-space: pre-wrap`.

- [ ] **Step 4: Wire application lifecycle**

Include `platform/diagnostic_logs.js` before `platform/index.js`; initialize it after the WASM module and DOM are ready. Immediately before both existing `sendMessage('startRequest', ...)` calls, invoke one shared helper that calls `DiagnosticLogs.beginSession()` with `host.address`, resolution, FPS, bitrate, frame pacing, codec, and available version/runtime values.

- [ ] **Step 5: Add settings behavior and remote navigation**

Add `diagnosticSettings` to `handleSettingsView()`. Refresh the view when opened; bind selector/filter/send/clear controls once; add `Views.DiagnosticSettings` with the same back behavior as other panes and focus order matching the visible controls. Ensure remote up/down scrolls the viewport when it has focus.

- [ ] **Step 6: Verify UI contract and JavaScript syntax**

Run the Node tests and `node --check` for `diagnostic_logs.js`, `index.js`, and `navigation.js`. Expected: exit 0.

---

### Task 4: Safe PowerShell HTTP receiver

**Files:**
- Create: `tools/Receive-MoonlightLogs.ps1`
- Create: `tests/receiver_integration_test.ps1`
- Create: `docs/diagnostic-logs.md`

**Interfaces:**
- Produces: `Receive-MoonlightLogs.ps1 [-ListenAddress <ip>] [-Port 48150] [-OutputDirectory <path>] [-Once]`

- [ ] **Step 1: Write failing receiver integration test**

The test starts the receiver with `-ListenAddress 127.0.0.1 -Port <free-port> -Once`, waits until it prints readiness, POSTs a representative UTF-8 body to `/moonlight-logs`, asserts HTTP 200, verifies exactly one `.log` beneath the temporary output directory, compares bytes, and cleans up only that temporary directory/process.

- [ ] **Step 2: Verify RED**

Run `pwsh -NoProfile -File tests/receiver_integration_test.ps1`. Expected: failure because the receiver script does not exist.

- [ ] **Step 3: Implement the receiver**

Use `TcpListener`, parse request line and headers with strict limits, require `POST /moonlight-logs`, require numeric `Content-Length` from 1 through 3 MiB, reject `Transfer-Encoding`, read exactly the declared bytes, sanitize `X-Moonlight-Filename`, resolve the output path and verify it remains inside the selected directory, then write bytes atomically through a temporary file followed by a same-directory rename.

- [ ] **Step 4: Document usage**

Document the exact launch command, firewall note, default endpoint, TV export steps, output location, shutdown behavior, and troubleshooting for connection refused, timeout, and incorrect host selection.

- [ ] **Step 5: Verify GREEN and negative cases**

Run the integration test plus requests using GET, a wrong path, invalid length, and unsafe filename. Expected: valid request returns 200 and invalid requests return 4xx without creating files.

---

### Task 5: Full verification and WGT packaging

**Files:**
- Modify only if required by verified build failures: build/package configuration already named above
- Produce: `Moonlight.wgt`

- [ ] **Step 1: Run all local tests**

Run native timing tests, native diagnostic buffer tests, Node diagnostic tests, JavaScript syntax checks, and the PowerShell receiver integration test. Expected: every command exits 0.

- [ ] **Step 2: Build the production image**

Build with the repository Docker workflow using the local safe image naming convention. Expected: CMake, Emscripten, Tizen packaging, and signing complete with exit 0.

- [ ] **Step 3: Extract the artifact safely**

Create a uniquely named temporary container, copy only `/home/moonlight/Moonlight.wgt` to the workspace, verify the resolved destination is the workspace `Moonlight.wgt`, then remove only that temporary container.

- [ ] **Step 4: Inspect artifact and packaged files**

Record file size, modification time, and SHA-256. Inspect the ZIP-compatible listing and require `config.xml`, `index.html`, `platform/diagnostic_logs.js`, WebAssembly artifacts, `author-signature.xml`, and `signature1.xml`.

- [ ] **Step 5: Confirm local-only state**

Confirm no commit was created and list all modified/new files. Report explicitly that TV behavior is not validated until the user installs the WGT and tests persistence/export on the device.
