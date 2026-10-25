# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Moonlight Tizen Modern is a fork of `brightcraft/moonlight-tizen` (upstream): a Moonlight game-streaming client for Samsung TVs
(Tizen 9+), written as a C/C++ module compiled to WebAssembly plus a web interface. The README lists what differs from upstream.

## Repository rules

- **Never use git worktrees.** Development happens in one checkout on one long-lived branch, `main`. Do not run
  `git worktree add`, use worktree tools or subagents with worktree isolation, or create `.worktrees/`. Skills that ask for a
  worktree (for example `using-git-worktrees`) do not apply; this rule takes precedence. For risky work use a short-lived
  normal branch in the same checkout, merge it into `main`, then delete it. If the tree is dirty, commit or stash with a unique tag
  before switching; never discard someone else's changes.
- **Upstream** is the remote `upstream` (`brightcraft/moonlight-tizen`). Merge it with a normal merge commit on a short-lived
  branch and keep what this fork changes on purpose. The notes on merging and the table of intentional differences are on the local
  branch `local/docs-archive` (not pushed): `git show local/docs-archive:docs/upstream-sync.md`.
- Docs are not on `main`. Notes and reviews live on `local/docs-archive`; do not add a `docs/` folder to `main`.
- Do not commit `.wgt` files, logs (`moonlight-tv-logs/`) or `artifacts/`; they are untracked on purpose. Screenshots for the
  README are in `.github/readme/`.
- `core.autocrlf=true` gives CRLF files on Windows, so tests must accept both `\n` and `\r\n`.

## Commands

```sh
npm run test:js                      # all JavaScript suites; must stay green
node tests/<name>_tests.js           # one JavaScript suite
tools/run-native-tests.sh            # host-compilable C/C++ suites with ASan/UBSan (Linux or WSL, g++ 13+); prints a summary
```

- A new JS suite must be added in three places, or `dependency_manifest_tests` fails: the file `tests/<name>_tests.js`, the
  `test:js` chain in `package.json`, and `expectedJavaScriptSuites` in `tests/dependency_manifest_tests.js`.
- `tools/run-native-tests.sh` picks up every `tests/*_tests.cpp|c` by itself. It has no filter: to run one suite, copy its
  `g++ -std=c++17 -pthread -Wall -Wextra -Werror -fsanitize=address,undefined -I. tests/<name>_tests.cpp ...` line from the script
  (the extra sources a suite needs are in the `case "$name"` list). Three suites need an external driver and are reported as skipped.
- The WASM sources (`wasm/*.cpp`) compile **only inside the Docker build**; the native suites cover the headers and the files
  that do not need Emscripten.
- Build the package: `docker build --progress=plain -t <tag> .`, then `docker create --name n <tag> artifact-only` and
  `docker cp n:/home/moonlight/Moonlight.wgt .`. The final image is `FROM scratch`, so `docker run` does not work. Useful build
  args: `OPT_LEVEL` (`-O2` default), `FORCE_GAME_MODE` (adds the Game Mode metadata, a second `Moonlight-ForceGM.wgt` variant),
  `BUILD_TYPE`, `REPO_OWNER`, `REPO_NAME` (the last two are injected into `index.js` for the update check; they fall back to this
  repository). A build uses the CPU hard and disturbs a stream that runs on the same PC.
- Release: the GitHub workflow "Release (Stable)" (manual, on `main`) builds both variants and creates the release `v<version>`.
  The version is read from `res/config.xml`, and it is also pinned in `package.json`, `package-lock.json` and
  `tests/dependency_manifest_tests.js`: change all four together.

## Architecture

**Two halves joined by Embind.** `wasm/*.cpp` is the native side (Samsung's Emscripten 1.39.4.7, pthreads, no 64-bit atomics: a
guard test enforces that). `wasm/platform/*.js`, `wasm/index.html` and `wasm/static/` are the interface. The native side wraps
`moonlight-common-c` (the protocol, vendored with changes of this fork: speculative-RFI gate, diagnostics), `libgamestream`
(HTTP and pairing), `opus` and `h264bitstream`. `CMakeLists.txt` lists the sources of the vendored libraries by name, so a new
`.c` file must be added there.

- **JS to native:** Embind exports (`startStream`, `stopStream`, `toggleStats`, `drainDiagnosticLogs`, ... in `main.cpp`;
  `makeCert`/`httpInit`/`openUrl` in `http.cpp`; `setInputCaptured` and the menu calls in `gamepad.cpp`). `startStream` takes a long
  positional argument list that must have the same order in `index.js`, `messages.js`, `moonlight_wasm.hpp` and `main.cpp`
  (`upstream_v118_integration_tests` checks it).
- **Native to JS:** `PostToJs(string)` calls `handleMessage` in `platform/messages.js` on the main thread and **blocks the
  calling thread** until it returns; `PostToJsAsync` copies the string and does not wait. Never pass `c_str()` of a temporary to an
  asynchronous call.
- **Media:** decoded by the Tizen WASM Player (EMSS), not in the module. `wasmplayer.cpp` is the video renderer (frame pacing:
  `video_timing.hpp`, `PlayoutAnchor`), `auddec.cpp` the audio renderer (EMSS or an optional Web Audio backend, Opus decode,
  `audio_sync.hpp`). Input is `input.cpp` (mouse, keyboard) and `gamepad.cpp` (pads sampled by an input thread, state sent only
  when it changes).
- **Logic lives in headers.** The testable parts are header-only files without Emscripten dependencies (`stop_sequence.hpp`,
  `connection_lifecycle.hpp`, `operation_latch.hpp`, `stream_menu_gate.hpp`, `rumble_dedupe.hpp`, ...), compiled by
  `tests/*_tests.cpp`. Keep new logic out of the `.cpp` files that need Emscripten when it can be tested on the host.
- **Teardown and waits:** a stream stops through one owned sequence (`StopConnection`, `RunStopSequence`); waits for the media
  pipeline are bounded and cancellable (latches); HTTP requests carry an id and are cancelled by it. Any new wait must be bounded.
- **Interface:** `Views` and `Navigation` in `platform/navigation.js`. The remote (`remote_controller.js`), the keyboard and the
  gamepad all call the same `Navigation.up/down/left/right/accept/back`; each view lists the ids of its elements in a `ListView`,
  and `focusElement`/`mark` show the focus (the class `hovered`). `platform/index.js` is the large controller. Settings rows keep
  the order label, hint, `div#...Menu`, menu container, because the navigation depends on it. MDL still drives switches, menus and
  sliders. Styles are the `ui-` tokens and components of `wasm/static/css/ui.css`; focus effects use only opacity, transform and
  border color.
- **Stream menu:** the native `StreamMenuGate` (hold Select) holds the pad input back and posts `streamMenuOpen`; `stream_menu.js`
  and `Views.StreamMenu` are the panel. If the page does not take over in time, the gate gives the input back.
- **Logs:** native lines go to a ring buffer (`diagnostic_log.cpp`) that `platform/diagnostic_logs.js` drains once a second into a
  file on the TV; JS adds lines with `logDiagnostic()`. `tools/Receive-MoonlightLogs.ps1` (port 48150) receives a log sent from
  the TV into `tools/moonlight-tv-logs/`.
- **Translations:** `wasm/static/locales/{en-US,pl-PL,pt-BR}.json`; `en-US` is the source and the key is the English text, which is
  also the content of the element with `data-i18n`. Add every new string to all three files.

## Things that are not obvious

- `res/config.xml` keeps `required_version="5.5"` on purpose (the legacy runtime profile that the TV runs reliably), although the
  interface is built and tested only for Tizen 9. The build pins jQuery 2.2.0 (from the lockfile) and the Samsung toolchain.
- The remote handler calls `preventDefault()` on Enter to stop the TV from sending a second, native click (upstream added it).
  That click seems to be what opens the on-screen keyboard for a text field, so Enter on a text field is let through
  (`remote_controller.js`). This is the working explanation for the keyboard that did not open in the Add Host dialog and is not
  confirmed on a TV yet: the log lines `Add Host text field: focus|click|blur trusted=... readOnly=...` show what the TV did.
- A Docker build step patches the generated `moonlight-wasm.js` (`tools/patch-embind-string.js`, the Embind `std::string` read
  that wrote a byte past its buffer). The patch fails the build when its target is not found exactly once.
- Speculative loss reporting (RFI) is gated on the decoder advertising RFI (`RtpVideoQueuePolicy.h`); without that gate one late
  packet freezes the picture for about two seconds. The setting "Speculative RFI recovery" opts in.
