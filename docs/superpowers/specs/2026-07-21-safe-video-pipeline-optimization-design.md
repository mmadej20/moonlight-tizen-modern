# Safe Video Pipeline Optimization Design

## Goal

Improve the efficiency and observability of the HEVC and AV1 packet submission path without changing codec negotiation, enabling frame dropping, or replacing Samsung's hardware-decoding pipeline.

## Scope

The implementation will:

- preserve `samsung::wasm::DecodingMode::kHardware` and the existing HEVC/AV1 MIME profiles;
- derive packet timestamps from `DECODE_UNIT::presentationTimeMs` instead of accumulating a fixed frame duration;
- replace unbounded busy-wait frame pacing with coarse sleeping followed by a short spin for sub-millisecond precision;
- isolate pacing calculations in testable, platform-independent helper functions;
- report packet queue delay, pacing delay, packet assembly time, and synchronous `AppendPacket()` call time using names that reflect what is actually measured;
- stop describing successful packet submission as completed hardware decoding or rendering;
- send width, height, and frame-rate metadata on the first accepted keyframe only, with zero values on ordinary frames;
- reset all session-scoped timestamp and statistics counters during video setup;
- preserve the existing contiguous packet assembly buffer because Samsung's packet API accepts one payload pointer and Samsung's game-streaming sample uses the same assembly pattern.

The implementation will not:

- enable `CAPABILITY_DIRECT_SUBMIT`;
- discard delayed reference frames or force additional IDR frames;
- change `CAPABILITY_SLICES_PER_FRAME(4)`;
- change the compiler from `-Os` to `-O3`;
- claim to measure asynchronous hardware decode or physical display presentation time.

## Architecture

A small header-only timing helper will contain pure calculations for converting Moonlight presentation timestamps into Samsung packet timestamps and for dividing a pacing wait into sleep and spin intervals. Keeping these calculations independent of Tizen APIs allows native unit tests to exercise timestamp rebasing, dropped-frame gaps, and pacing boundaries.

`VidDecSubmitDecodeUnit()` remains on Moonlight's decoder worker thread. It assembles the fragmented frame, calculates a rebased PTS, performs hybrid pacing when enabled, builds one `ElementaryMediaPacket`, and submits it synchronously. Samsung's hardware pipeline remains asynchronous after submission.

## Timestamp and Pacing Rules

- The first accepted frame establishes both the Moonlight PTS origin and the local steady-clock origin.
- Packet PTS is `(presentationTimeMs - firstPresentationTimeMs) / 1000.0` seconds.
- Timestamp subtraction uses unsigned wrap-safe arithmetic.
- A repeated or regressing input timestamp is clamped so packet timestamps never move backwards.
- Packet duration remains `1 / configured FPS`, using double precision.
- When pacing is enabled, the decoder thread sleeps while more than 500 microseconds remain and spins only for the final 500 microseconds.
- When pacing is disabled, no sleep or spin is performed.

## Packet Metadata

Width, height, and frame-rate fields are included on the first successfully submitted IDR frame of a session. Subsequent packets use zero for these optional fields. If submission of that first IDR fails, the metadata flag remains unset so the next IDR carries configuration again.

## Statistics

The overlay will use the following meanings:

- packet queue delay: callback time minus `enqueueTimeMs`, measured before pacing;
- packet assembly time: time spent copying the fragmented decode unit into the contiguous buffer;
- frame pacing delay: time deliberately spent waiting before submission;
- packet submission time: synchronous duration of `AppendPacket()`;
- received/submitted frames: frames entering the callback and packets accepted by `AppendPacket()`.

No counter will be labelled decoded or rendered because the platform completes those operations asynchronously and exposes no completion callback in the current integration.

All counters, byte totals, frame-number tracking, and timestamp state are reset in `VidDecSetup()`.

## Error Handling

An `AppendPacket()` failure preserves the current behavior: log the failure and return `DR_NEED_IDR`. Timestamp monotonicity and first-keyframe metadata state must not advance on failed submission.

## Testing and Build

Native C++ tests will cover timestamp rebasing, dropped-frame timestamp gaps, regression clamping, wraparound, and sleep/spin boundary calculations. Tests will be written and observed failing before the helper implementation is added.

After unit tests pass, the normal repository build workflow will compile the WebAssembly module and package the Tizen application. Completion requires a newly produced `.wgt` file and inspection of its path, size, and modification time. Device or emulator playback validation is outside this build-only scope and will not be claimed.
