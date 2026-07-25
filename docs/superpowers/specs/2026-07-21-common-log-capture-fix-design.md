# Moonlight-common diagnostic log capture fix

## Problem

The diagnostic export captures messages written through `MoonlightInstance::ClLogMessage()`, but the current build compiles `moonlight-common-c` without `LC_LOG`. Its `Limelog()` fallback writes directly to the Emscripten console, bypassing the connection listener and the bounded diagnostic buffer. As a result, client-side causes and confirmation of IDR requests are absent from exported logs.

## Considered approaches

1. Enable `LC_LOG` for `moonlight-common-c` and route its existing logs through the registered listener. This is the smallest change and preserves the library's intended logging abstraction. Selected.
2. Modify the non-`LC_LOG` fallback to write both to Emscripten and the listener. This duplicates platform-specific behavior inside the vendored library and risks double logging in other configurations.
3. Capture browser console output in JavaScript. This is fragile on Tizen, loses native timing context, and may not receive worker-thread output consistently.

## Design

- Add `LC_LOG` to the `moonlight-common-c` target compile definitions.
- Pass the already formatted `Limelog()` message to the listener using `"%s"` so literal percent characters are not interpreted as a second format string.
- Keep all existing decoder, packet-loss, RFI, and IDR behavior unchanged.
- Keep the existing bounded, non-blocking diagnostic buffer unchanged.

After the change, messages such as `Unrecoverable frame`, `Network dropped`, `Requesting IDR frame on behalf of DR`, `Append video packet failed`, and `IDR frame request sent` flow through `ClLogMessage()` and into the persistent diagnostic session.

## Verification

- A regression test must fail before the change when the CMake wiring or safe listener forwarding is absent.
- Native diagnostic and video timing tests, JavaScript tests, and the PowerShell receiver integration test must remain green.
- Rebuild the signed WGT and verify it contains the diagnostic module and signatures.

The user's earlier instruction to continue through the final local WGT without additional approval applies to this narrowly scoped correction. No commit will be created.
