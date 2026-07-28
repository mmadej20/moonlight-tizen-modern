# Legacy runtime A/B artifact

## Purpose

This package is intended to test whether the runtime-facing changes from commit
`7eff49d` correlate with the random TV crashes while retaining every later
audio-sync, HEVC timing, recovery, and diagnostic fix.

It does not use a different WASM compiler. Both profiles use Tizen Studio CLI
6.1, Samsung Emscripten 1.39.4.7, `latest-fastcomp`, and the same CMake
toolchain and flags.

## Selected runtime profile

- `required_version="5.5"`;
- jQuery 2.2.0 referenced and packaged;
- jQuery 4.0.0 absent from the WGT;
- current native diagnostics present in `moonlight-wasm.js.mem`.

jQuery 2.2.0 is deprecated and npm reports one known moderate-severity
vulnerability. This downgrade is limited to the requested diagnostic A/B
package.

## Artifact

- Source commit: `ac1a2287c503fe03799f45c68cc7abafea2a3814`
- Path: `C:\Users\madej\Downloads\moonlight-tizen-master\Moonlight-legacy-runtime.wgt`
- Size: 2323460 bytes
- Timestamp UTC: `2026-07-28T20:20:05Z`
- SHA-256: `3E4ADCBFCF2EAD117B93AA378F9CBD76CB09EB521008402D8865B9498A973492`

Archive inspection found 61 entries, including:

- `author-signature.xml`;
- `signature1.xml`;
- `config.xml`;
- `index.html`;
- `static/js/jquery-2.2.0.min.js`;
- `moonlight-wasm.wasm`;
- `moonlight-wasm.js.mem`.

The archive does not contain a jQuery 4.0.0 asset.

## Verification

- all 14 JavaScript suites passed;
- `receiver_integration_test.ps1` passed;
- `audio_sync_tests.cpp` passed under ASan/UBSan;
- `audio_pipeline_diagnostics_tests.cpp` passed under ASan/UBSan;
- `video_timing_tests.cpp` passed under ASan/UBSan;
- `media_track_diagnostics_tests.cpp` passed under ASan/UBSan;
- Docker compiled/installed the widget, signed it, and produced the WGT;
- package inspection confirmed Tizen 5.5, jQuery 2.2.0, both signature files,
  and the current audio/video diagnostic strings.

No physical-TV validation is claimed.
