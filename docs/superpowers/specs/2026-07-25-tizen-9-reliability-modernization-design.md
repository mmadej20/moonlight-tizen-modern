# Moonlight Tizen 9 Reliability and Modernization Design

Date: 2026-07-25

## Objective

Harden Moonlight Tizen for Samsung Tizen 9.0, primarily the
UE43CU7172UXXH, while preserving Samsung's proprietary WASM Player and
socket integration. The work fixes audit findings 2, 4, 6, 7, 8, 9, and
10, fixes JavaScript gamepad polling, bounds subnet discovery, improves
frame pacing, modernizes independently replaceable dependencies, and
produces a verified WGT package.

## Compatibility Boundary

The application will explicitly require Tizen 9.0. Browser-side code may
therefore rely on the Chromium M120-era platform supplied by Tizen 9.

Samsung Emscripten 1.39.4.7 remains the compatibility boundary for the
proprietary WASM Player and Tizen socket APIs. Replacing this SDK with
upstream Emscripten would require a separate port and is outside this
repair. The legacy SDK and any unavoidable build dependencies remain
inside Docker and are not shipped as TV runtime dependencies.

## Scope

### Included

1. Strict pairing-response parsing and bounded hexadecimal decoding.
2. Idempotent connection shutdown, explicit lifecycle state, safe thread
   ownership, and synchronized shared state.
3. Request-scoped HTTP cancellation, native timeouts, bounded response
   storage, and reliable queue behavior.
4. Deterministic JavaScript completion and cancellation behavior for app
   loading, IndexedDB, Add Host, pairing, navigation, and stream reload.
5. Bounded, cancellable EMSS setup and teardown with checked API results.
6. Correct Opus decoder destruction.
7. Certificate, pairing, and OpenSSL allocation cleanup.
8. A single visibility-aware JavaScript gamepad polling loop.
9. Subnet fetching through a bounded pool of eight workers.
10. Monotonic, discontinuity-aware, low-spin frame pacing.
11. A bounded attempt to modernize jQuery and the containerized build
    dependencies without breaking Samsung SDK compatibility.
12. Automated regression checks and a signed WGT build.

### Excluded

- Porting Samsung's proprietary extensions to upstream Emscripten.
- Unrequested audit findings outside points 2, 4, 6, 7, 8, 9, and 10.
- Changing unrelated streaming, codec-selection, decoder-queue, or
  diagnostic-log behavior.
- Claiming physical-TV validation without installing and exercising the
  package on the television.

## Architecture

### Native Safety Utilities

Pairing parsing will use a small capacity-aware hexadecimal decoder. Its
contract requires an exact source length, rejects odd lengths and
non-hexadecimal characters, and refuses output larger than the supplied
destination. Pairing fields will be validated before any field is
copied or used. An empty or truncated response is a normal parse failure,
not input to string or cryptographic routines.

HTTP response accumulation will use checked size arithmetic, preserve the
old buffer if allocation fails, append a terminator only when capacity
allows it, and enforce a hard response-size limit. Text/XML requests are
limited to 1 MiB. The explicitly binary box-art request is limited to
8 MiB.

Every native allocation has one explicit release path. This includes
generated and loaded certificate objects, pairing buffers, OpenSSL-owned
signature memory, and Opus decoder instances. Partially initialized
objects remain safe to destroy.

### Connection Lifecycle

The connection owns an atomic lifecycle state:

`Idle -> Starting -> Running -> Stopping -> Idle`

Only valid forward transitions are allowed. The first shutdown caller
atomically enters `Stopping`; all later callers observe that shutdown is
already in progress and return without duplicating cleanup.

Each worker thread has a corresponding "created" flag or owned handle.
Shutdown joins only threads that were successfully created and never
joins the current thread. Startup cancellation interrupts the Moonlight
connection attempt before joining workers. Manual stop, remote
termination, startup failure, media failure, and page exit converge on
the same cleanup routine.

Mouse state, stream statistics, and lifecycle flags shared across threads
will use atomics or the existing mutex boundary as appropriate. Plain
unsynchronized reads and writes will not be retained.

### HTTP Requests

Each HTTP job owns:

- a unique request ID;
- its libcurl handle and response buffer;
- an atomic cancellation flag;
- connect and total timeout values;
- its completion callback or promise settlement.

Native code, rather than a JavaScript `Promise.race`, enforces connect,
total, and low-speed timeouts. Cancelling a request ID affects only that
job. A queued job cancelled before execution settles as cancelled without
opening a connection. A running job observes cancellation through the
curl progress callback. Completion is delivered exactly once.

The existing dispatcher may remain serialized where required by the
Samsung networking environment, but it will no longer expose global
cancellation. Subnet discovery is separate: its bounded JavaScript pool
uses up to eight independent browser `fetch` probes.

### EMSS Media Lifecycle

Media setup and teardown will report one of: success, immediate API
failure, asynchronous callback failure, timeout, or cancellation.
`IsValid`, track creation, `Open`, `Play`, and `Close` results will be
checked. All callback paths update protected state and wake all waiters.

Setup has a 10-second deadline. Close has a 3-second deadline. A
connection stop wakes either wait immediately. Timeout or cancellation
continues through safe best-effort cleanup instead of hanging the
connection thread indefinitely.

### JavaScript Operation Ownership

Pairing, Add Host, app-list loading, subnet discovery, and stream
transitions use monotonically increasing generation IDs. A callback may
modify UI or persistent state only when its generation is still current.
Cancelling an operation, leaving its screen, or starting a replacement
invalidates the old generation.

Every promise settles on every path:

- an empty app list restores app-view navigation and resolves normally;
- malformed IndexedDB data is logged and treated as missing;
- storage callbacks do not reference block-scoped values outside their
  scope;
- cancelled Add Host and pairing work cannot mutate host state later;
- app indexes are reset or clamped after list replacement;
- stream reload waits for the actual quit result instead of a fixed
  timer;
- quit failures leave navigation usable and surface a diagnostic error.

## Performance Design

### Gamepad Polling

JavaScript will maintain exactly one `requestAnimationFrame` gamepad
pump. It calls the available `navigator.getGamepads` implementation once
per animation frame, reuses compact controller snapshots, and publishes
only connection changes or meaningful input changes.

Button transitions are never filtered. Axis changes use the existing
dead zone plus a small epsilon to suppress browser noise. The pump pauses
when the document is hidden, invalidates stale snapshots, and resumes
once visible. Starting the UI or a stream repeatedly must not create
additional timers or animation loops.

Native low-latency controller transmission remains responsible for
streaming cadence; the JavaScript pump updates state without performing
duplicate samples for the same controller in one frame.

### Bounded Subnet Discovery

Subnet discovery uses a reusable pool with a concurrency limit of eight.
Workers pull addresses from a shared queue. Results are associated with
the active scan generation and may be reported in deterministic address
order even when requests complete out of order.

Leaving the screen or starting a new scan prevents queued probes from
starting and aborts active probes through their `AbortController`
instances. The pool waits for active settlements before considering the
old scan complete, preventing unhandled rejections and background UI
mutation.

### Frame Pacing

The frame pacer uses a monotonic clock and absolute target deadlines.
It does not accumulate relative sleep error. A backwards timestamp or a
jump greater than 250 milliseconds resets the timing baseline.

For an early frame, the pacer sleeps in cancellation-aware chunks until
near its deadline. It then uses a short adaptive spin window initialized
to 200 microseconds. An exponential moving average of observed sleep
overshoot adjusts this window between 50 and 300 microseconds. Late
frames are submitted immediately. Cancellation or shutdown disables
spinning and wakes coarse waits promptly.

## Dependency Modernization

### jQuery

jQuery 2.2.0 will be replaced with jQuery 4.0.0 after auditing every
project use for APIs removed in jQuery 3 and 4. The upgrade is accepted
only when JavaScript regression tests pass and the packaged application
contains no reference to the old asset. If a small compatibility edit is
needed, it remains limited to existing jQuery call sites rather than
adding a broad shim.

### Tizen, Python, OpenSSL, and Emscripten

The production build uses Tizen Studio 6.1, the latest stable release
published by Tizen at design time and already compatible with the
project's headless packaging flow. A separate Docker build experiment
tests whether Samsung Emscripten can run under Python 3 and build/link
against OpenSSL 3 without altering the proprietary runtime ABI.

The modern experiment is accepted only if it performs a clean build,
passes the same automated tests, produces the expected WASM Player and
socket symbols, and creates a structurally valid signed WGT. If Samsung's
SDK requires Python 2 or its pinned OpenSSL port, the experiment is
discarded and those tools remain isolated in the reproducible builder.
That fallback satisfies compatibility and will be documented with the
exact failure rather than hidden.

## Error Reporting

Expected network cancellation and timeout are distinct from parsing,
storage, media, and internal lifecycle failures. User-facing messages
remain concise; diagnostic logging records the request or operation ID,
stage, timeout/cancellation reason, and native error code where
available. Secrets, certificates, PIN-derived material, and full pairing
payloads are never logged.

## Test Strategy

Implementation follows test-first changes where the affected unit can run
outside the TV:

### Native Tests

- exact, short, long, odd-length, and invalid-character pairing fields;
- HTTP buffer growth, allocation failure behavior, maximum response size,
  per-request cancellation, and timeout completion;
- valid and invalid lifecycle transitions plus repeated and concurrent
  stop requests;
- teardown after partial thread and media initialization;
- EMSS immediate failure, callback failure, timeout, cancellation, and
  successful close;
- Opus and certificate cleanup through repeated setup/teardown;
- frame deadline calculation, late frames, timestamp discontinuities,
  adaptive spin limits, and cancellation.

Host builds will use AddressSanitizer and UndefinedBehaviorSanitizer when
the available compiler and third-party libraries support them.

### JavaScript Tests

- only one gamepad loop after repeated initialization;
- one gamepad-array read per frame;
- visibility pause/resume, disconnects, button edges, and axis noise;
- subnet concurrency never exceeding eight;
- scan cancellation and stale-generation suppression;
- empty app lists and corrected navigation indexes;
- malformed or missing IndexedDB state;
- cancelled Add Host and pairing responses;
- quit success and failure without a fixed reload delay.

### Regression and Packaging

All existing native, JavaScript, receiver, and diagnostic regression
tests must pass. A clean Docker build then produces a signed WGT. The
package will be inspected for:

- Tizen 9.0 manifest requirements;
- expected signatures and application identifiers;
- current JavaScript assets and absence of jQuery 2.2.0;
- expected WASM, worker, media, and socket artifacts;
- absence of unintended source/build files;
- reproducible size and SHA-256 reporting.

## Delivery and Acceptance

The deliverables are:

1. source changes implementing the approved scope;
2. automated tests and their recorded results;
3. documentation of any Samsung SDK dependency that could not be
   modernized;
4. a signed `Moonlight.wgt`;
5. package size and SHA-256 hash;
6. a short UE43CU7172UXXH smoke-test checklist covering pairing,
   discovery, app loading, gamepad input, stream start/stop, frame
   smoothness, and repeated reconnects.

Completion requires all automated gates and Docker packaging to pass.
Physical-TV behavior remains explicitly unverified until the WGT is
installed and exercised on the target television.
