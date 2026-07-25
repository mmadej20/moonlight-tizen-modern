# Diagnostic Logs Design

## Goal

Add a diagnostic log viewer to Moonlight's settings that preserves the current and previous streaming sessions and can export a selected session to the current streaming host on the local network. Diagnostics must not block or materially slow the video, audio, input, or networking paths.

## Scope

The feature will:

- preserve the existing `emscripten_log(EM_LOG_CONSOLE, ...)` output;
- copy Moonlight C/C++ log messages into a bounded, thread-safe in-memory buffer;
- batch new log records from C++ to JavaScript approximately once per second;
- persist the current and previous streaming sessions in the application's private Tizen storage;
- add a `Diagnostic logs` category to the existing settings screen;
- display, filter, clear, and export either retained session;
- export logs on demand to the currently selected host through an HTTP receiver;
- provide a local PowerShell receiver script that writes exported logs to timestamped files;
- redact known credentials before persistence and export;
- keep all work local and create no Git commits.

The feature will not:

- stream logs continuously to the PC;
- depend on `sdb dlog`, `sdb shell`, or access to the TV application sandbox;
- upload logs to an Internet service;
- change IDR recovery behavior, decoder capabilities, video pacing, codec negotiation, or packet handling;
- claim successful device validation until the resulting WGT is tested on a physical TV.

## Architecture

### Native log capture

`MoonlightInstance::ClLogMessage()` will continue formatting each message once and sending it to `emscripten_log`. It will also offer a timestamped copy to a dedicated diagnostic log buffer.

The native buffer will:

- have a fixed byte capacity;
- preserve whole records rather than arbitrary byte fragments;
- remove the oldest records when space is needed;
- use a non-blocking or tightly bounded critical section;
- drop a new diagnostic record rather than waiting on a contended lock;
- count dropped records and emit a synthetic summary when capture resumes;
- expose a batch-drain interface for JavaScript without exposing internal storage.

No file, JavaScript, network, or Tizen API call may occur while the native buffer lock is held.

### JavaScript persistence

JavaScript will poll the native batch interface every second while the application is active. A drained batch first enters a JavaScript pending queue and is removed from that queue only after it has been appended successfully to private Tizen application storage.

Two session files will be retained:

- `current.log`: the active or most recently active stream;
- `previous.log`: the session that preceded `current.log`.

At the start of a stream, `previous.log` is replaced with the complete contents of `current.log`. `current.log` is cleared only after that replacement succeeds, then receives the new session header. Each session is limited to 2 MiB. When a session exceeds the limit, the oldest complete records are removed and the file begins with a truncation marker.

Session headers will record the start time and available stream parameters: host address, codec, resolution, frame rate, bitrate, frame-pacing state, application version, and TV/runtime information already exposed to the application. Missing values will be written as `unknown` rather than preventing logging.

Persistence failures will be reported in the diagnostic screen and console. They will not stop streaming. Failed batches remain in a bounded JavaScript pending queue for retry and remain viewable during the current process lifetime. If that queue reaches its 256 KiB limit, it removes the oldest complete records and inserts a truncation marker.

### Redaction

Before persistence, JavaScript will redact known sensitive values. Redaction applies to the UI and exported files but does not alter the existing transient console output.

At minimum, redaction will cover:

- pairing PIN values;
- query parameters and fields whose names contain `token`, `key`, `secret`, `password`, `pin`, or equivalent known credential names;
- credentials embedded in URLs.

Host IP addresses, codec information, timestamps, frame numbers, packet counters, and performance measurements will remain because they are required for diagnosis. The UI will state that exported diagnostics contain local network addresses.

## Settings UI

The existing two-pane settings layout will receive a `Diagnostic logs` category. Its content will include:

- session selector: `Current session` and `Previous session`;
- metadata summary containing time, host, stream parameters, record count, retained size, truncation state, and dropped native record count;
- a read-only, focusable, remote-scrollable log viewport;
- a case-insensitive text filter that does not modify stored data;
- `Send logs to PC` and `Clear logs` buttons;
- editable destination address and port fields, prefilled from the currently selected streaming host and port `48150`;
- clear success and failure status messages.

Rendering must use text nodes or `textContent`; log contents must never be assigned as HTML. Opening the screen will load only the selected session. Filtering and switching sessions must remain responsive with a full 2 MiB file.

`Clear logs` requires confirmation and clears both retained sessions. It does not disable future capture.

## Export Protocol

Export is initiated only by the user. The application sends a single HTTP `POST` request to:

`http://<selected-host>:48150/moonlight-logs`

The request body will be UTF-8 text containing a short export header followed by the selected redacted session. Headers will include a format version, session selection, application identifier, and a sanitized suggested filename. The application will use a five-second timeout and will retain the local log regardless of the result.

The receiver will be a local PowerShell script built on `System.Net.Sockets.TcpListener` to avoid administrator-only URL reservations. It will:

- listen on a configurable local address and port, defaulting to port `48150`;
- implement the minimal HTTP handling required for the export request;
- accept only `POST /moonlight-logs`;
- reject missing, malformed, chunked, or oversized requests;
- cap the accepted body at 3 MiB;
- sanitize the output filename and write only inside an explicitly selected output directory;
- return a small plain-text success or failure response;
- handle one request at a time, which is sufficient for an on-demand diagnostic tool;
- print the listening address, saved path, and errors to its console.

The script documentation will note that Windows Firewall may ask for permission and that the receiver should be stopped after collection.

## Failure Handling

- Native buffer contention: drop the diagnostic record, increment the dropped counter, and continue the originating operation.
- Native buffer overflow: evict oldest complete records and add a truncation marker.
- JavaScript batch or storage failure: retain streaming operation, show the error, and retry on the next scheduled flush when safe.
- Missing previous session: show an empty-state message.
- Missing current host: require the destination address to be entered before export.
- Invalid address or port: reject locally and keep the log.
- Network timeout, connection refusal, HTTP error, or malformed response: show a concise error and keep the log.
- Application exit during export: no guarantee is made for the in-progress request; persisted logs remain available on the next launch.

## Performance Constraints

- The decode callback and network receive paths must never perform persistent storage or HTTP work.
- Native capture must allocate no unbounded memory and must not wait for JavaScript.
- JavaScript persistence is batched rather than performed per log record.
- The feature must not add per-frame logging. It captures only messages already emitted by the application and Moonlight Common C, plus session metadata and diagnostic drop/truncation summaries.
- Normal streaming behavior remains unchanged when the diagnostics screen is closed and no export is active, apart from bounded log capture and periodic batch persistence.

## Testing

Platform-independent tests will cover:

- preservation of whole records and eviction order;
- fixed-capacity behavior and truncation markers;
- non-blocking contention behavior and dropped-record summaries;
- batch draining without duplication;
- session rotation and 2 MiB limits;
- credential redaction without removing diagnostic IP addresses or counters;
- destination and port validation;
- export request construction and receiver rejection of invalid paths, methods, lengths, and filenames.

Integration verification will include:

- the existing native video timing tests;
- a production WebAssembly/Tizen build;
- creation and structural inspection of a newly signed `Moonlight.wgt`;
- a local receiver test that sends a representative log and verifies the saved bytes and filename;
- confirmation that no Git commit was created.

Physical-TV acceptance requires:

1. stream 4K at 60 FPS long enough to encounter or attempt to reproduce an IDR request;
2. return to `Settings -> Diagnostic logs` without restarting when possible;
3. confirm that current-session messages include the relevant loss, depacketizer, queue, or decoder result;
4. restart the application and confirm that current and previous session retention behaves as designed;
5. run the receiver on the selected host, export both session choices, and compare the received files with the on-screen log;
6. confirm that streaming remains stable with diagnostic capture enabled.

## Deliverables

- native bounded diagnostic log buffer and JavaScript batch bridge;
- private-storage session rotation and redaction logic;
- settings UI and remote-control navigation support;
- on-demand HTTP export client;
- local PowerShell receiver script and usage instructions;
- automated tests;
- locally built signed WGT, with path, size, checksum, and verification limits reported.
