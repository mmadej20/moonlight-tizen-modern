# Syncing with upstream

This fork tracks `https://github.com/brightcraft/moonlight-tizen` through the `upstream` remote. The history is
connected by real merge commits, so the next sync is an ordinary merge: Git already knows the last upstream commit
that was integrated.

Last sync: `upstream/master` at `26e973c` (2026-10-17), which contains `v1.18.0`.

## Procedure

Work in the main checkout on `main`. Do not use git worktrees (see `CLAUDE.md`).

1. `git fetch upstream --tags --prune`
2. Compare tags with `git log --oneline HEAD..upstream/master` and read the upstream `CHANGELOG.md`.
3. Predict the conflicts without touching the tree: `git merge-tree --write-tree --name-only HEAD upstream/master`.
4. Run the baseline before merging: `npm run test:js` and, in WSL or Linux, `tools/run-native-tests.sh`.
5. Write failing tests for the upstream behavior that must survive the merge (see `tests/upstream_v118_integration_tests.js`).
6. `git merge --no-ff --no-commit upstream/master` (or a release tag), resolve the conflicts, then review the hunks
   that merged cleanly: a clean merge is not proof of a correct merge.
7. `npm run test:js`, `tools/run-native-tests.sh`, then `docker build` for the standard and ForceGM variants. The
   WASM sources compile only inside the Docker build.
8. Commit the merge as `merge: integrate upstream <version or description>`.

Windows note: `core.autocrlf=true` checks files out with CRLF. Tests must not depend on bare `\n`. When resolving
conflicts with an editor that matches text literally, convert the conflicted files to LF first; the index stores LF.

## Intentional differences from upstream

| Area | Fork behavior | Why |
| --- | --- | --- |
| Connection lifecycle | `StopConnection(errorCode)` owns teardown; `StopThreadFunc` joins the connection and input threads, then stops the connection and closes the media source. `OnConnectionStopped` never starts a thread. | Single owner of teardown, tested by `connection_lifecycle_tests` and the operation latches. |
| Teardown | `RunStopSequence` (`stop_sequence.hpp`) runs the teardown and always notifies the interface and returns to idle; `ConnectionLifecycle::AbortStart` gives a failed start its slot back. Box art downloads go through a two-slot limiter in `utils.js`. | One shared HTTP thread made box art delay the start of a stream. See `docs/diagnostic-logs.md`. |
| Controllers | The input thread reads all controller slots with one synchronous call (`gamepad_sampling.hpp`), polls every 25 ms instead of 5 ms while no controller is in use, and the interface pauses its own `requestAnimationFrame` gamepad loop while a stream is shown. | One call instead of 2 + N per poll cuts the work the main thread does for the input thread; the interface loop only costs the main thread work during a stream. A controller state is sent only when it changes (plus a reminder every 100 ms), and rumble messages are deduplicated natively, posted asynchronously and applied at most every 50 ms (`rumble.js`). |
| Start-up | The sweep of the local network at start only runs when there is no known host or one of them does not answer. | 254 probes at every start cost about 90 s of radio and main thread work. |
| Media setup waits | Latch based, bounded (10 s), cancellable; a timeout reports `ERROR_VIDEO_SETUP_FAILED` (-200) unless the user cancelled. | Upstream waits on condition variables with a 5 s timeout; the fork's wait contract differs. |
| Frame pacer and statistics | Adaptive spin window, own statistics fields, statistics mutex. | Already sleeps instead of busy-waiting; carries fork diagnostics. |
| HTTP requests | Per-request ID with native cancellation; no JS HTTP queue. Pairing has no client-side limit on the time to enter the PIN. | Upstream queues requests in `_httpLock`; the fork cancels by request ID. |
| Server info | Both `refreshServerInfo` (base URLs) and `refreshServerInfoAtAddress` use HTTPS only for paired hosts. Every request passes the 5000 ms timeout. | Upstream security fix applied to the fork-only base-URL variant too. |
| Game Mode | Off by default on every platform version, never forced; the switch is disabled only on Tizen 5.5. | Do not force Game Mode on the TV. |
| Audio | EMSS is the default backend; Web Audio is opt-in; `Disabled` skips the EMSS audio track. | Keeps the tested default path. |
| RFI | `speculativeRfi` is the last start-stream argument and is off by default. | Experimental fork feature. |
| Packaging | jQuery 2.2.0 comes from the npm lockfile in the Dockerfile; release workflows pin images by digest and extract the WGT with `docker create` and `docker cp`. | `required_version="5.5"`, reproducible artifacts. |
| Build profile | `required_version="5.5"`, jQuery 2.2.0, Samsung Emscripten 1.39.4.7, `-O2` (`MOONLIGHT_OPT_LEVEL`, upstream builds with `-Os`; `docker build --build-arg OPT_LEVEL=-Os` restores it). | See `docs/2026-07-28-legacy-runtime-ab-artifact.md`. Decoding 5 ms of Opus took 1.4 ms on the TV with `-Os`. |

## Start-stream argument order

`audioBackend, audioConfig, audioSync, audioJitterMs, playHostAudio, decryptHostAudio, videoCodec, hdrMode,
fullRange, gameMode, disableWarnings, performanceStats, speculativeRfi` follow the first 18 arguments
(`host` ... `flipXYfaceButtons`). The order must be identical in `index.js`, `messages.js`, `moonlight_wasm.hpp` and
`main.cpp`; `upstream_v118_integration_tests` checks it.
