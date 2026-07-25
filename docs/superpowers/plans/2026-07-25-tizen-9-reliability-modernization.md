# Moonlight Tizen 9 Reliability and Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix audit findings 2, 4, 6, 7, 8, 9, and 10; correct JavaScript gamepad polling; bound subnet discovery; improve frame pacing; modernize compatible dependencies; and produce a verified Tizen 9 WGT for the Samsung UE43CU7172UXXH.

**Architecture:** Add small host-testable safety primitives for pairing, HTTP ownership, connection state, asynchronous media waits, and pacing, then integrate them into the existing Samsung WASM Player application without changing codec negotiation or decoder behavior. Browser operations gain request or generation ownership, while the Docker build keeps Samsung's proprietary Emscripten fork as an isolated compatibility boundary.

**Tech Stack:** C11, C++17, Moonlight Common C, libcurl, OpenSSL, Opus, Samsung WASM Player, Samsung Emscripten 1.39.4.7, Tizen Studio 6.1, JavaScript, Node.js 24 LTS, jQuery 4.0.0, WSL GCC/G++, Docker Engine.

## Global Constraints

- Target Samsung Tizen 9.0 and set `required_version="9.0"`.
- Preserve Samsung hardware decoding, existing H.264/HEVC/AV1 profiles, stream configuration, decoder queue behavior, and diagnostic logging.
- Keep Samsung Emscripten 1.39.4.7 unless a clean Python 3/OpenSSL 3.5.7 probe builds the same proprietary WASM Player and socket integration.
- Limit text/XML HTTP responses to 1 MiB and binary box-art responses to 8 MiB.
- Limit EMSS setup waits to 10 seconds and close waits to 3 seconds.
- Limit subnet discovery to eight active browser requests.
- Use a 250 ms pacing-discontinuity threshold and an adaptive 50-300 microsecond spin window initialized at 200 microseconds.
- Never log certificates, PIN-derived material, complete pairing payloads, or remote-input keys.
- Do not change unrequested audit findings or unrelated playback behavior.
- Do not claim physical-TV validation; produce a WGT and a target-TV smoke-test checklist.
- Initialize this archive as a local Git repository before implementation,
  capture the approved starting point in a baseline commit, work on a dedicated
  feature branch, and commit each task only after its task review is clean.
- Every shell command in this workspace must be prefixed with `rtk`.

---

## File Structure

### New focused implementation files

- `libgamestream/hex_utils.h`: capacity-aware hexadecimal decoder interface.
- `libgamestream/hex_utils.c`: strict fixed-size and bounded allocated decoding.
- `libgamestream/http_buffer.h`: bounded HTTP response-buffer interface.
- `libgamestream/http_buffer.c`: overflow-safe response accumulation.
- `libgamestream/http_context.h`: request-scoped cancellation and timeout configuration.
- `libgamestream/http_context.c`: atomic request cancellation helpers.
- `wasm/request_registry.hpp`: callback-ID to HTTP-context ownership map.
- `wasm/connection_lifecycle.hpp`: atomic connection-state transitions.
- `wasm/operation_latch.hpp`: bounded success/failure/cancellation wait primitive for EMSS.
- `wasm/platform/operation_guard.js`: generation tokens and safe stored-JSON parsing.
- `wasm/static/js/mdns-browser/subnet_scanner.js`: cancellable eight-worker subnet scanner.
- `package.json`: pinned browser dependency and JavaScript test scripts.
- `package-lock.json`: reproducible jQuery 4.0.0 dependency lock.
- `docs/tizen-9-build.md`: final toolchain decision, verification evidence, and TV checklist.

### New tests

- `tests/pairing_hex_tests.c`
- `tests/pairing_ownership_wiring_tests.js`
- `tests/http_buffer_tests.c`
- `tests/http_context_tests.c`
- `tests/request_registry_tests.cpp`
- `tests/http_bridge_tests.js`
- `tests/connection_lifecycle_tests.cpp`
- `tests/dispatcher_lifecycle_tests.cpp`
- `tests/connection_wiring_tests.js`
- `tests/operation_latch_tests.cpp`
- `tests/media_ownership_wiring_tests.js`
- `tests/gamepad_polling_tests.js`
- `tests/subnet_scanner_tests.js`
- `tests/operation_guard_tests.js`
- `tests/ui_reliability_wiring_tests.js`
- `tests/dependency_manifest_tests.js`

### Existing files modified

- `CMakeLists.txt`: compile new native helpers.
- `libgamestream/pairing.c`, `libgamestream/pairing.h`: strict parsing, request context, and ownership cleanup.
- `libgamestream/http.c`, `libgamestream/http.h`, `libgamestream/errors.h`: bounded per-request HTTP.
- `wasm/http.cpp`, `wasm/main.cpp`, `wasm/moonlight_wasm.hpp`: certificate ownership, request registry, lifecycle, and teardown.
- `wasm/dispatcher/lib.hpp`: idempotent dispatcher start/stop.
- `wasm/connectionlistener.cpp`: route remote termination through the common stop owner.
- `wasm/input.cpp`, `wasm/gamepad.cpp`: synchronized input state and duplicate-sample removal.
- `wasm/wasmplayer.cpp`, `wasm/video_timing.hpp`, `wasm/auddec.cpp`: bounded EMSS, resource cleanup, and pacing.
- `wasm/platform/messages.js`, `wasm/static/js/utils.js`: cancellable request IDs and native-enforced timeouts.
- `wasm/platform/gamepad.js`: one animation-frame polling loop.
- `wasm/static/js/mdns-browser/main.js`: use the bounded scanner.
- `wasm/platform/index.js`, `wasm/platform/navigation.js`: deterministic UI cancellation and promise settlement.
- `wasm/index.html`: new helper scripts and jQuery 4.0.0 path.
- `res/config.xml`, `README.md`: Tizen 9 compatibility declaration.
- `Dockerfile`: reproducible jQuery installation, artifact stage, and accepted toolchain changes.

### Removed file

- `wasm/static/js/jquery-2.2.0.min.js`

---

### Task 1: Pairing parsing and cryptographic ownership

**Files:**
- Create: `libgamestream/hex_utils.h`
- Create: `libgamestream/hex_utils.c`
- Create: `tests/pairing_hex_tests.c`
- Create: `tests/pairing_ownership_wiring_tests.js`
- Modify: `libgamestream/pairing.c:31-393`
- Modify: `wasm/http.cpp:1-84`
- Modify: `CMakeLists.txt:56-61`

**Interfaces:**
- Produces: `int gs_decode_hex_exact(const char*, size_t, unsigned char*, size_t)`.
- Produces: `int gs_decode_hex_alloc(const char*, size_t, size_t, unsigned char**, size_t*)`.
- Preserves: `gs_pair()` result codes and the 2048-bit GameStream certificate protocol.
- Consumes later: Task 2 passes an HTTP request context through `gs_pair()`.

- [ ] **Step 1: Write strict hexadecimal decoder tests**

Create `tests/pairing_hex_tests.c` with these cases:

```c
#include "libgamestream/errors.h"
#include "libgamestream/hex_utils.h"

#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
  uint8_t output[4] = {0xAA, 0xAA, 0xAA, 0xAA};
  assert(gs_decode_hex_exact("0011aAfF", 8, output, sizeof(output)) == GS_OK);
  assert(output[0] == 0x00 && output[1] == 0x11);
  assert(output[2] == 0xAA && output[3] == 0xFF);

  memset(output, 0xAA, sizeof(output));
  assert(gs_decode_hex_exact("0011", 4, output, sizeof(output)) == GS_INVALID);
  assert(gs_decode_hex_exact("0011223344", 10, output, sizeof(output)) == GS_INVALID);
  assert(gs_decode_hex_exact("0011zzff", 8, output, sizeof(output)) == GS_INVALID);
  assert(gs_decode_hex_exact("0011aaf", 7, output, sizeof(output)) == GS_INVALID);
  assert(output[0] == 0xAA);

  unsigned char* allocated = NULL;
  size_t allocated_size = 0;
  assert(gs_decode_hex_alloc("414243", 6, 3, &allocated, &allocated_size) == GS_OK);
  assert(allocated_size == 3 && memcmp(allocated, "ABC", 3) == 0);
  free(allocated);
  allocated = NULL;
  assert(gs_decode_hex_alloc("41424344", 8, 3, &allocated, &allocated_size) == GS_INVALID);
  assert(allocated == NULL);
  return 0;
}
```

- [ ] **Step 2: Run the decoder test and verify RED**

Run:

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && gcc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/pairing_hex_tests.c libgamestream/hex_utils.c -o /tmp/pairing_hex_tests"
```

Expected: compilation fails because `hex_utils.h` and `hex_utils.c` do not exist.

- [ ] **Step 3: Implement the minimal decoder**

Use this public contract in `hex_utils.h`:

```c
#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

int gs_decode_hex_exact(const char* source, size_t source_length,
                        unsigned char* destination, size_t destination_capacity);
int gs_decode_hex_alloc(const char* source, size_t source_length,
                        size_t maximum_decoded_size,
                        unsigned char** destination, size_t* destination_size);

#ifdef __cplusplus
}
#endif
```

In `hex_utils.c`, convert each nibble with an explicit ASCII helper. Decode into
a temporary allocation, copy to the caller only after every character passes,
and return `GS_INVALID` for odd, short, long, non-hexadecimal, null, or
over-limit input.

- [ ] **Step 4: Run the decoder test and verify GREEN**

Run:

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && gcc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/pairing_hex_tests.c libgamestream/hex_utils.c -o /tmp/pairing_hex_tests && /tmp/pairing_hex_tests"
```

Expected: exit code 0 with no sanitizer output.

- [ ] **Step 5: Replace unbounded pairing conversions**

In `pairing.c`:

```c
if (gs_decode_hex_exact(result, strlen(result),
                        challenge_response_data_enc,
                        sizeof(challenge_response_data_enc)) != GS_OK) {
  ret = GS_INVALID;
  goto cleanup;
}

if (gs_decode_hex_exact(result, strlen(result),
                        pairing_secret,
                        sizeof(pairing_secret)) != GS_OK) {
  ret = GS_INVALID;
  goto cleanup;
}
```

Use `gs_decode_hex_alloc()` for `plaincert`, with a 16 KiB decoded maximum.
Change `xml_search()` to duplicate exactly `len` bytes and reject a closing tag
that occurs before the matching opening tag.

- [ ] **Step 6: Enforce protocol signature lengths**

Before copying the local certificate signature, require:

```c
if (asnSignature == NULL ||
    ASN1_STRING_length(asnSignature) != 256 ||
    asnSignature->data == NULL) {
  ret = GS_INVALID;
  goto cleanup;
}
```

After `sign_it()`, require `s_len == 256`. On every unsuccessful `sign_it()`
path, free `*sig` with `OPENSSL_free()`, set it to null, and set length to zero.
At `gs_pair()` cleanup, always call `OPENSSL_free(signature)` when non-null.
Initialize `*curl_ppk_string = NULL` before network work.

- [ ] **Step 7: Make certificate generation and loading transactional**

In `MoonlightInstance::MakeCert()`:

```cpp
CERT_KEY_PAIR certKeyPair = mkcert_generate();
if (!certKeyPair.x509 || !certKeyPair.pkey || !certKeyPair.p12) {
  mkcert_free(certKeyPair);
  return MessageResult::Reject(emscripten::val("Certificate generation failed"));
}
// Serialize both values, checking BIO and PEM results.
mkcert_free(certKeyPair);
```

In `LoadCert()`, parse into local `X509* nextCert` and
`EVP_PKEY* nextPrivateKey`, allocate the new hex string, and replace globals
only after all three succeed. Free local BIOs and objects on each error. Free
the previous globals after the successful replacement. Avoid `strdup()` by
passing the supplied lengths to `BIO_new_mem_buf()`.

- [ ] **Step 8: Add ownership wiring assertions**

Create `tests/pairing_ownership_wiring_tests.js` that reads the two source files
and asserts:

```js
assert.match(pairing, /gs_decode_hex_exact\(result,[\s\S]*challenge_response_data_enc/);
assert.match(pairing, /gs_decode_hex_exact\(result,[\s\S]*pairing_secret/);
assert.match(pairing, /OPENSSL_free\(signature\)/);
assert.match(pairing, /ASN1_STRING_length\(asnSignature\)\s*!=\s*256/);
assert.match(httpCpp, /mkcert_free\(certKeyPair\)/);
assert.doesNotMatch(httpCpp, /char\* _certStr = strdup/);
```

Run:

```powershell
rtk node tests/pairing_ownership_wiring_tests.js
```

Expected: `pairing_ownership_wiring_tests: PASS`.

- [ ] **Step 9: Add the decoder source to the WASM build**

Add `libgamestream/hex_utils.c` to the `libgamestream` target in
`CMakeLists.txt`, then rerun both Task 1 tests. Record both passing commands.

---

### Task 2: Per-request HTTP cancellation, timeouts, and response limits

**Files:**
- Create: `libgamestream/http_buffer.h`
- Create: `libgamestream/http_buffer.c`
- Create: `libgamestream/http_context.h`
- Create: `libgamestream/http_context.c`
- Create: `wasm/request_registry.hpp`
- Create: `tests/http_buffer_tests.c`
- Create: `tests/http_context_tests.c`
- Create: `tests/request_registry_tests.cpp`
- Create: `tests/http_bridge_tests.js`
- Modify: `libgamestream/http.h`
- Modify: `libgamestream/http.c`
- Modify: `libgamestream/errors.h`
- Modify: `libgamestream/pairing.h`
- Modify: `libgamestream/pairing.c`
- Modify: `wasm/moonlight_wasm.hpp`
- Modify: `wasm/http.cpp`
- Modify: `wasm/main.cpp`
- Modify: `wasm/platform/messages.js`
- Modify: `wasm/static/js/utils.js`
- Modify: `CMakeLists.txt`

**Interfaces:**
- Produces: `HTTP_REQUEST_CONTEXT`, initialized and cancelled through atomic helper functions.
- Produces: `HTTP_DATA* http_create_data(size_t)` and
  `int http_data_append(HTTP_DATA*, const void*, size_t)`.
- Produces: `int http_data_checked_size(size_t, size_t, size_t, size_t*)`.
- Changes: `http_request(url, ppk, context, data)`.
- Changes: `gs_pair(int, const char*, unsigned short, const char*,
  HTTP_REQUEST_CONTEXT*, char**)`.
- Produces: `HttpRequestRegistry::Create(int, long, long)`, `Cancel(int)`,
  `Remove(int)`, and `Size()`.
- Produces: JavaScript promises with numeric `.requestId` plus `cancelAsyncRequest(promise)`.

- [ ] **Step 1: Write bounded-buffer tests**

Create `tests/http_buffer_tests.c`:

```c
#include "libgamestream/errors.h"
#include "libgamestream/http_buffer.h"

#include <assert.h>
#include <string.h>

int main(void) {
  HTTP_DATA* data = http_create_data(8);
  assert(data != NULL);
  assert(http_data_append(data, "abcd", 4) == GS_OK);
  assert(http_data_append(data, "efgh", 4) == GS_OK);
  assert(data->size == 8);
  assert(memcmp(data->memory, "abcdefgh", 8) == 0);
  assert(data->memory[8] == '\0');
  assert(http_data_append(data, "i", 1) == GS_RESPONSE_TOO_LARGE);
  assert(data->size == 8);
  http_free_data(data);

  assert(http_data_checked_size((size_t)-1, 2, 8, NULL) == GS_RESPONSE_TOO_LARGE);
  return 0;
}
```

- [ ] **Step 2: Write cancellation-context tests**

Create `tests/http_context_tests.c`:

```c
#include "libgamestream/http_context.h"

#include <assert.h>

int main(void) {
  HTTP_REQUEST_CONTEXT context;
  http_request_context_init(&context, 3000, 5000, 2, 1);
  assert(!http_request_is_cancelled(&context));
  assert(context.connect_timeout_ms == 3000);
  assert(context.total_timeout_ms == 5000);
  http_cancel_request(&context);
  assert(http_request_is_cancelled(&context));
  return 0;
}
```

- [ ] **Step 3: Run the C tests and verify RED**

Run:

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && gcc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/http_buffer_tests.c libgamestream/http_buffer.c -o /tmp/http_buffer_tests"
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && gcc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/http_context_tests.c libgamestream/http_context.c -o /tmp/http_context_tests"
```

Expected: both fail because the new interfaces do not exist.

- [ ] **Step 4: Implement checked accumulation and request context**

Add these error codes to `errors.h`:

```c
#define GS_CANCELLED -7
#define GS_RESPONSE_TOO_LARGE -8
#define GS_TIMEOUT -9
```

Use these constants:

```c
#define HTTP_TEXT_MAX_BYTES (1024u * 1024u)
#define HTTP_BINARY_MAX_BYTES (8u * 1024u * 1024u)
```

`http_data_checked_size()` must reject multiplication/addition overflow before
allocation. `http_data_append()` must assign `realloc()` to a temporary pointer
and preserve the old allocation and size on failure.

`HTTP_REQUEST_CONTEXT` contains:

```c
typedef struct _HTTP_REQUEST_CONTEXT {
  volatile int cancelled;
  long connect_timeout_ms;
  long total_timeout_ms;
  long low_speed_time_seconds;
  long low_speed_bytes_per_second;
} HTTP_REQUEST_CONTEXT, *PHTTP_REQUEST_CONTEXT;
```

Use `__atomic_store_n(&context->cancelled, value, __ATOMIC_RELEASE)` and
`__atomic_load_n(&context->cancelled, __ATOMIC_ACQUIRE)` for cancellation.

- [ ] **Step 5: Run the C tests and verify GREEN**

Run:

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && gcc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/http_buffer_tests.c libgamestream/http_buffer.c -o /tmp/http_buffer_tests && /tmp/http_buffer_tests"
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && gcc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/http_context_tests.c libgamestream/http_context.c -o /tmp/http_context_tests && /tmp/http_context_tests"
```

Expected: both exit 0 with no sanitizer output.

- [ ] **Step 6: Write request-registry tests**

Create `tests/request_registry_tests.cpp`:

```cpp
#include "wasm/request_registry.hpp"

#include <cassert>

int main() {
  HttpRequestRegistry registry;
  auto first = registry.Create(41, 3000, 5000);
  auto second = registry.Create(42, 3000, 10000);
  assert(first && second && registry.Size() == 2);
  assert(registry.Cancel(41));
  assert(http_request_is_cancelled(first.get()));
  assert(!http_request_is_cancelled(second.get()));
  assert(!registry.Cancel(999));
  registry.Remove(41);
  assert(registry.Size() == 1);
  registry.Remove(42);
  assert(registry.Size() == 0);
  return 0;
}
```

Run and verify RED:

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && gcc -std=c11 -Wall -Wextra -Werror -I. -c libgamestream/http_context.c -o /tmp/http_context.o && g++ -std=c++17 -Wall -Wextra -Werror -pthread -I. tests/request_registry_tests.cpp /tmp/http_context.o -o /tmp/request_registry_tests"
```

Expected: compilation fails because `request_registry.hpp` does not exist.

- [ ] **Step 7: Implement the registry and verify GREEN**

Implement a mutex-protected
`std::unordered_map<int, std::shared_ptr<HTTP_REQUEST_CONTEXT>>`. `Create()`
must reject a duplicate callback ID, initialize the context, and return the
owned shared pointer. `Cancel()` must copy the shared pointer under the lock
and cancel it after releasing the lock. `Remove()` is idempotent.

Rerun the Task 2 registry command with `&& /tmp/request_registry_tests`.
Expected: exit code 0.

- [ ] **Step 8: Replace global libcurl cancellation**

Change `_progress_callback()` to read the context passed through
`CURLOPT_PROGRESSDATA`. Apply:

```c
curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, context->connect_timeout_ms);
curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, context->total_timeout_ms);
curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, context->low_speed_time_seconds);
curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, context->low_speed_bytes_per_second);
curl_easy_setopt(curl, CURLOPT_PROGRESSDATA, context);
```

Map `CURLE_ABORTED_BY_CALLBACK` with a cancelled context to `GS_CANCELLED`,
`CURLE_OPERATION_TIMEDOUT` to `GS_TIMEOUT`, and a response-limit callback
failure to `GS_RESPONSE_TOO_LARGE`. Remove `g_CancelHttpRequest`,
`http_reset_cancel()`, and the parameterless `http_cancel_request()`.

- [ ] **Step 9: Thread the context through pairing and URL requests**

Update:

```c
int gs_pair(int serverMajorVersion, const char* address,
            unsigned short httpPort, const char* pin,
            PHTTP_REQUEST_CONTEXT request_context,
            char** curl_ppk_string);
```

Every request in one pairing sequence shares that context. `gs_unpair()` uses
a local non-cancelled context so cleanup is still attempted after a pairing
failure.

In `MoonlightInstance`, add `HttpRequestRegistry m_HttpRequests`. `OpenUrl()`
creates a context keyed by callback ID; its dispatcher job captures the shared
pointer and removes the registry entry after exactly one resolve/reject.
Text uses 1 MiB and binary uses 8 MiB. `Pair()` follows the same registration
pattern and passes the context into `gs_pair()`.

- [ ] **Step 10: Make the JavaScript bridge expose request IDs**

Refactor `messages.js` around a testable `createMessageBridge()` factory.
Async promises retain normal Promise behavior and receive:

```js
promise.requestId = id;
promise.cancel = function() {
  return sendMessage('cancelRequest', [id]);
};
```

`cancelAsyncRequest(promise)` calls `.cancel()` only once. Change the sync
binding to `Module.cancelRequest(requestId)`. Guard `handlePromiseMessage()`
against a missing or already-settled callback and log the callback ID rather
than throwing.

- [ ] **Step 11: Write and run bridge tests**

Create `tests/http_bridge_tests.js` with stub sync/async functions. Assert:

```js
const request = bridge.sendMessage('openUrl', ['http://host', null, false, 5000]);
assert.strictEqual(request.requestId, 1);
request.cancel();
assert.deepStrictEqual(cancelledIds, [1]);
bridge.resolve(1, 'ok');
assert.strictEqual(await request, 'ok');
assert.strictEqual(bridge.pendingCount(), 0);
assert.doesNotThrow(() => bridge.resolve(1, 'late'));
```

Run first before the bridge refactor and expect RED, then after:

```powershell
rtk node tests/http_bridge_tests.js
```

Expected: `http_bridge_tests: PASS`.

- [ ] **Step 12: Remove JavaScript timeout races**

Change `_openUrlWithTimeout(url, ppkstr, timeoutMs)` to call:

```js
return sendMessage('openUrl', [url, ppkstr, false, timeoutMs]);
```

Use 5000 ms for server info and pair challenge, 10000 ms for app lists,
launch/resume/cancel, and box art. Remove every `Promise.race()` that exists
only to cancel native HTTP and remove parameterless `cancelRequest` calls.
Store the native pairing promise on the `NvHTTP` instance so
`cancelPairingRequest()` cancels its exact request ID.

- [ ] **Step 13: Register new C sources and rerun Task 2**

Add `http_buffer.c` and `http_context.c` to `libgamestream` in CMake. Run all
four Task 2 native tests, the bridge test, and the Task 1 tests. Record the
passing results.

---

### Task 3: Idempotent connection and dispatcher lifecycle

**Files:**
- Create: `wasm/connection_lifecycle.hpp`
- Create: `tests/connection_lifecycle_tests.cpp`
- Create: `tests/dispatcher_lifecycle_tests.cpp`
- Create: `tests/connection_wiring_tests.js`
- Modify: `wasm/moonlight_wasm.hpp`
- Modify: `wasm/main.cpp`
- Modify: `wasm/connectionlistener.cpp`
- Modify: `wasm/dispatcher/lib.hpp`
- Modify: `wasm/input.cpp`
- Modify: `wasm/wasmplayer.cpp`

**Interfaces:**
- Produces: `ConnectionState { Idle, Starting, Running, Stopping }`.
- Produces: `ConnectionLifecycle::TryStart`, `MarkRunning`, `BeginStop`, `MarkIdle`, and `state`.
- Changes: `StopConnection(int errorCode)` is the single teardown entry.
- Preserves: synchronous `stopStream()` acknowledgement to JavaScript.

- [ ] **Step 1: Write lifecycle-transition tests**

Create `tests/connection_lifecycle_tests.cpp`:

```cpp
#include "wasm/connection_lifecycle.hpp"

#include <cassert>
#include <thread>
#include <vector>

int main() {
  ConnectionLifecycle lifecycle;
  assert(lifecycle.state() == ConnectionState::Idle);
  assert(lifecycle.TryStart());
  assert(!lifecycle.TryStart());
  assert(lifecycle.MarkRunning());

  int winners = 0;
  std::vector<std::thread> callers;
  for (int i = 0; i < 16; ++i) {
    callers.emplace_back([&] {
      if (lifecycle.BeginStop()) {
        __atomic_add_fetch(&winners, 1, __ATOMIC_RELAXED);
      }
    });
  }
  for (auto& caller : callers) caller.join();
  assert(winners == 1);
  assert(lifecycle.state() == ConnectionState::Stopping);
  lifecycle.MarkIdle();
  assert(lifecycle.state() == ConnectionState::Idle);

  ConnectionLifecycle starting;
  assert(starting.TryStart());
  assert(starting.BeginStop());
  starting.MarkIdle();
  return 0;
}
```

- [ ] **Step 2: Run lifecycle tests and verify RED**

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -pthread -I. tests/connection_lifecycle_tests.cpp -o /tmp/connection_lifecycle_tests"
```

Expected: missing `connection_lifecycle.hpp`.

- [ ] **Step 3: Implement atomic lifecycle transitions**

Use `compare_exchange_strong()` for every transition. `BeginStop()` accepts
both `Starting` and `Running`, but only one caller can replace the observed
state with `Stopping`. `MarkIdle()` is valid only from `Stopping`.

Run the command with `&& /tmp/connection_lifecycle_tests`; expect exit 0.

- [ ] **Step 4: Write dispatcher idempotency tests**

Create `tests/dispatcher_lifecycle_tests.cpp`:

```cpp
#include "wasm/dispatcher/lib.hpp"

#include <atomic>
#include <cassert>

int main() {
  std::atomic<int> calls{0};
  Dispatcher dispatcher("test");
  assert(dispatcher.start());
  assert(!dispatcher.start());
  dispatcher.post_job([&] { calls.fetch_add(1); }, false);
  dispatcher.stop();
  dispatcher.stop();
  assert(calls.load() == 1);
  return 0;
}
```

Run before editing and expect compilation failure because `start()` returns
void and `stop()` double-joins:

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -pthread -I. tests/dispatcher_lifecycle_tests.cpp -o /tmp/dispatcher_lifecycle_tests"
```

- [ ] **Step 5: Make dispatcher lifecycle idempotent**

Protect start/stop with a mutex and booleans. `start()` returns true only when
it creates the thread. `stop()` posts one end entry, joins only a joinable
thread, and returns harmlessly on later calls. Remove the explicit
`m_Dispatcher.stop()` from `MoonlightInstance::~MoonlightInstance()` or retain
it only after proving the dispatcher destructor is harmless.

Rerun the dispatcher test with `&& /tmp/dispatcher_lifecycle_tests`.

- [ ] **Step 6: Add owned thread and termination state**

Replace raw lifecycle flags with:

```cpp
ConnectionLifecycle m_ConnectionLifecycle;
std::atomic<bool> m_ConnectionCancelled{false};
std::atomic<bool> m_ConnectionThreadCreated{false};
std::atomic<bool> m_InputThreadCreated{false};
std::atomic<bool> m_StopThreadCreated{false};
std::atomic<bool> m_TerminationReported{false};
std::atomic<int> m_StopErrorCode{0};
std::atomic<bool> m_Running{false};
```

Check each `pthread_create()` return value before setting its created flag.
Join only a created thread, clear the flag after joining, and never join
`pthread_self()`.

- [ ] **Step 7: Unify shutdown**

`StartStream()` must reject with `GS_WRONG_STATE` unless `TryStart()` succeeds.
`StopConnection(errorCode)`:

1. wins `BeginStop()` or returns;
2. stores the first error code;
3. sets cancellation and wakes media waits;
4. calls `LiInterruptConnection()` while startup may be active;
5. creates the one stop thread;
6. reports a thread-creation failure without pretending teardown completed.

`StopThreadFunc()` joins the connection thread if created, stops input through
`m_Running = false`, joins the input thread if created, invokes
`LiStopConnection()` once, closes media through Task 4's bounded routine,
marks lifecycle idle, and posts one termination event.

- [ ] **Step 8: Route remote termination through the owner**

Replace direct `LiStopConnection()` in `ClConnectionTerminated()` with:

```cpp
if (g_Instance) {
  g_Instance->StopConnection(errorCode);
}
```

`OnConnectionStopped()` uses `m_TerminationReported.exchange(true)` to prevent
duplicate UI notifications. A cancelled startup reports graceful error 0;
remote termination retains its supplied code.

- [ ] **Step 9: Synchronize shared input and video-stat state**

Use atomics for `m_MouseLocked`, `m_MouseDeltaX`, and `m_MouseDeltaY`.
Mouse callbacks use `fetch_add()`; `ReportMouseMovement()` uses `exchange(0)`.
Keep last pointer positions on the main callback thread.

Add one `std::mutex` around reset, update, aggregation, and formatting of the
three `VIDEO_STATS` instances in `wasmplayer.cpp`. Make performance-enabled
state atomic and use `.load()` from worker callbacks.

- [ ] **Step 10: Add lifecycle wiring assertions**

`tests/connection_wiring_tests.js` must assert that:

```js
assert.match(main, /LiInterruptConnection\(\)/);
assert.match(main, /m_ConnectionThreadCreated/);
assert.match(main, /m_InputThreadCreated/);
assert.match(main, /m_TerminationReported\.exchange/);
assert.doesNotMatch(listener, /ClConnectionTerminated[\s\S]*LiStopConnection\(\)/);
assert.match(listener, /StopConnection\(errorCode\)/);
assert.match(input, /m_MouseDeltaX\.exchange\(0\)/);
```

Run:

```powershell
rtk node tests/connection_wiring_tests.js
```

Expected: `connection_wiring_tests: PASS`. Rerun both Task 3 native tests.

---

### Task 4: Bounded EMSS operations and Opus cleanup

**Files:**
- Create: `wasm/operation_latch.hpp`
- Create: `tests/operation_latch_tests.cpp`
- Create: `tests/media_ownership_wiring_tests.js`
- Modify: `wasm/moonlight_wasm.hpp`
- Modify: `wasm/wasmplayer.cpp`
- Modify: `wasm/main.cpp`
- Modify: `wasm/auddec.cpp`

**Interfaces:**
- Produces: `OperationOutcome { Pending, Success, Failure, Cancelled, Timeout }`.
- Produces: `OperationLatch::Reset`, `Succeed`, `Fail`, `Cancel`, and `WaitFor`.
- Produces: `MoonlightInstance::CloseMediaSource()` with a three-second bound.

- [ ] **Step 1: Write operation-latch tests**

Create `tests/operation_latch_tests.cpp`:

```cpp
#include "wasm/operation_latch.hpp"

#include <atomic>
#include <cassert>
#include <chrono>
#include <thread>

using namespace std::chrono_literals;

int main() {
  std::atomic<bool> cancelled{false};

  OperationLatch success;
  std::thread worker([&] { std::this_thread::sleep_for(2ms); success.Succeed(); });
  assert(success.WaitFor(100ms, cancelled) == OperationOutcome::Success);
  worker.join();

  OperationLatch failure;
  failure.Fail();
  assert(failure.WaitFor(100ms, cancelled) == OperationOutcome::Failure);

  OperationLatch timeout;
  assert(timeout.WaitFor(2ms, cancelled) == OperationOutcome::Timeout);

  OperationLatch cancellation;
  cancelled.store(true);
  cancellation.Notify();
  assert(cancellation.WaitFor(100ms, cancelled) == OperationOutcome::Cancelled);

  cancellation.Reset();
  cancelled.store(false);
  cancellation.Succeed();
  cancellation.Fail();
  assert(cancellation.outcome() == OperationOutcome::Success);
  return 0;
}
```

- [ ] **Step 2: Run latch tests and verify RED**

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -pthread -I. tests/operation_latch_tests.cpp -o /tmp/operation_latch_tests"
```

Expected: missing `operation_latch.hpp`.

- [ ] **Step 3: Implement first-terminal-result semantics**

`OperationLatch` owns its mutex, condition variable, and outcome. Only the
first terminal result replaces `Pending`. `WaitFor()` uses `wait_until()` with
a fixed deadline and returns cancellation immediately when the supplied atomic
flag becomes true. `Notify()` wakes waiters without changing the result.

Rerun with `&& /tmp/operation_latch_tests`; expect exit 0.

- [ ] **Step 4: Add dedicated media latches**

Add latches for initial source close, source open, audio track open, video
track open, media-element play, and source close. Reset them before each
stream. On connection cancellation, call `Notify()` on all of them.

Listeners complete success only for the corresponding expected event.
Premature track closure completes the pending track latch as failure.

- [ ] **Step 5: Check every immediate and asynchronous result**

In `StartupVidDecSetup()`:

- reject an absent or invalid `m_Source`;
- reject missing audio or video `AddTrack()` results;
- set listeners before opening;
- call `Open()` with a callback that fails the source-open latch on a
  non-success result;
- call `Play()` with a callback that completes the play latch with success or
  failure;
- wait at most 10 seconds for each required phase;
- return a decoder setup failure for failure, timeout, or cancellation.

Log the stage and outcome but no sensitive data.

- [ ] **Step 6: Bound source close**

`CloseMediaSource()` starts from a reset close latch. If no source exists, it
returns success. Otherwise, call `Close()` and complete the latch in both
success and error callback cases. Wait at most three seconds, then reset
tracks, session IDs, media flags, and the source pointer regardless of result.
Return the close outcome so shutdown can log timeout or failure.

- [ ] **Step 7: Fix Opus decoder ownership**

In `AudDecInit()`:

```cpp
if (g_Instance->m_OpusDecoder) {
  opus_multistream_decoder_destroy(g_Instance->m_OpusDecoder);
  g_Instance->m_OpusDecoder = nullptr;
}
g_Instance->m_OpusDecoder = opus_multistream_decoder_create(/* existing args */, &rc);
if (rc != OPUS_OK || !g_Instance->m_OpusDecoder) {
  g_Instance->m_OpusDecoder = nullptr;
  return -1;
}
```

In `AudDecCleanup()`, destroy and null the decoder before releasing the decode
buffer. `AudDecDecodeAndPlaySample()` returns immediately when the pointer is
null.

- [ ] **Step 8: Add media ownership assertions**

Create `tests/media_ownership_wiring_tests.js` and assert:

```js
assert.match(audio, /opus_multistream_decoder_destroy\(g_Instance->m_OpusDecoder\)/);
assert.match(audio, /m_OpusDecoder\s*=\s*nullptr/);
assert.match(player, /10s/);
assert.match(main, /3s/);
assert.match(player, /add_track_result/);
assert.match(player, /OperationOutcome::Timeout/);
```

Run:

```powershell
rtk node tests/media_ownership_wiring_tests.js
```

Expected: `media_ownership_wiring_tests: PASS`. Rerun Task 4 native tests and
Task 3 lifecycle tests.

---

### Task 5: Discontinuity-aware adaptive frame pacing

**Files:**
- Modify: `wasm/video_timing.hpp`
- Modify: `tests/video_timing_tests.cpp`
- Modify: `wasm/wasmplayer.cpp`

**Interfaces:**
- Produces: `VideoTimestampUpdate { double seconds; bool discontinuity; }`.
- Produces: `UpdatePresentationTimestamp(uint32_t, VideoTimestampState&, uint32_t)`.
- Produces: `AdaptiveSpinWindow::ObserveOvershoot` and `value`.
- Preserves: monotonic media PTS and current packet submission metadata.

- [ ] **Step 1: Extend timing tests with discontinuities**

Add:

```cpp
VideoTimestampState discontinuous{};
auto first = UpdatePresentationTimestamp(1000, discontinuous, 250);
assert(first.discontinuity && first.seconds == 0.0);
auto normal = UpdatePresentationTimestamp(1016, discontinuous, 250);
assert(!normal.discontinuity);
auto jump = UpdatePresentationTimestamp(1400, discontinuous, 250);
assert(jump.discontinuity);
AssertNear(jump.seconds, 0.016);
auto backwards = UpdatePresentationTimestamp(1300, discontinuous, 250);
assert(backwards.discontinuity);
assert(backwards.seconds >= jump.seconds);

AdaptiveSpinWindow adaptive(200us, 50us, 300us, 0.25);
adaptive.ObserveOvershoot(400us);
assert(adaptive.value() <= 300us);
for (int i = 0; i < 20; ++i) adaptive.ObserveOvershoot(0us);
assert(adaptive.value() >= 50us && adaptive.value() < 200us);
```

Replace every existing `RebasePresentationTimestamp(timestamp, state)`
assertion in the same test with
`UpdatePresentationTimestamp(timestamp, state, 250).seconds` so the test suite
has one timestamp-update interface.

- [ ] **Step 2: Run timing tests and verify RED**

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. tests/video_timing_tests.cpp -o /tmp/video_timing_tests"
```

Expected: missing `VideoTimestampUpdate` and `AdaptiveSpinWindow`.

- [ ] **Step 3: Implement monotonic discontinuity handling**

On first input, report a discontinuity and zero PTS. For a signed delta below
zero or above 250 ms, update the raw baseline without adding the delta to
elapsed PTS and return `discontinuity=true`. Preserve unsigned wrap behavior
through the signed-delta calculation.

`AdaptiveSpinWindow` maintains an exponential moving average with alpha 0.25
and clamps rounded microseconds to 50-300.

- [ ] **Step 4: Run timing tests and verify GREEN**

Run the Task 5 command with `&& /tmp/video_timing_tests`. Expected: exit 0.

- [ ] **Step 5: Integrate absolute cancellable pacing**

Reset timestamp and adaptive state in `VidDecSetup()`. For each candidate
packet:

1. compute a transactional `VideoTimestampUpdate`;
2. on first frame or discontinuity, set the steady-clock origin to
   `now - packetPts`;
3. calculate the absolute target from origin, PTS, and the existing margin;
4. while more than the current spin window remains, sleep for at most 2 ms;
5. after each sleep, observe only positive overshoot;
6. exit immediately when `m_ConnectionCancelled` becomes true;
7. spin only inside the final adaptive window;
8. never spin for a late frame;
9. commit timestamp/origin state only after successful `AppendPacket()`.

Use `std::this_thread::yield()` inside a spin that lasts more than the current
window because of scheduler disturbance.

- [ ] **Step 6: Re-run timing and lifecycle tests**

Run Task 5 timing, Task 3 lifecycle, and Task 4 latch tests. Record all as
passing before moving to browser work.

---

### Task 6: One reliable JavaScript gamepad polling loop

**Files:**
- Create: `tests/gamepad_polling_tests.js`
- Modify: `wasm/platform/gamepad.js`
- Modify: `wasm/gamepad.cpp:153-188`

**Interfaces:**
- Produces: `createGamepadController(environment)` for browser use and Node tests.
- Preserves: global `Controller.startWatching()` and `Controller.stopWatching()`.
- Uses: one `requestAnimationFrame` handle and one gamepad-array read per frame.

- [ ] **Step 1: Write a deterministic fake-browser test**

Use fake `requestAnimationFrame`, `cancelAnimationFrame`, event listeners,
visibility state, `CustomEvent`, and `navigator.webkitGetGamepads`. Assert:

```js
controller.startWatching();
controller.startWatching();
assert.strictEqual(fake.pendingFrameCount(), 1);
fake.runFrame();
assert.strictEqual(fake.webkitGetGamepadsCalls, 1);

fake.gamepads[0].buttons[0] = { pressed: true, value: 1 };
fake.runFrame();
assert.strictEqual(events[0].detail.changes[0].type, 'button');

fake.gamepads[0].axes[0] = 0.0005;
fake.runFrame();
assert.strictEqual(events.length, 1);

fake.setHidden(true);
assert.strictEqual(fake.pendingFrameCount(), 0);
fake.setHidden(false);
assert.strictEqual(fake.pendingFrameCount(), 1);
controller.stopWatching();
assert.strictEqual(fake.pendingFrameCount(), 0);
```

- [ ] **Step 2: Run gamepad tests and verify RED**

```powershell
rtk node tests/gamepad_polling_tests.js
```

Expected: the current module has no factory, uses a 5 ms interval, and fails
to invoke `webkitGetGamepads`.

- [ ] **Step 3: Implement the animation-frame controller**

Use dependency injection only at the factory boundary:

```js
function createGamepadController(environment) {
  var rafId = null;
  var watching = false;
  var listenersInstalled = false;
  var snapshots = Object.create(null);
  var axisEpsilon = 0.001;
  // startWatching, stopWatching, schedule, poll, visibility handler
}
```

Invoke either `navigator.getGamepads()` or
`navigator.webkitGetGamepads()` with its navigator receiver. Read it once,
connect unknown pads discovered during polling, remove snapshots for missing
pads, reuse button/axis arrays, and dispatch button edges or axis differences
greater than epsilon. Install connection, disconnection, and visibility
listeners once.

- [ ] **Step 4: Verify gamepad tests GREEN**

Run the Task 6 Node command. Expected: `gamepad_polling_tests: PASS`.

- [ ] **Step 5: Remove the duplicate native sample**

Keep the successful `emscripten_sample_gamepad_data()` call before the loop and
delete the second call inside the per-controller loop. Do not change the native
5 ms send cadence.

Extend the Node test with a source assertion that exactly one
`emscripten_sample_gamepad_data()` occurrence exists in `PollGamepads()`.
Rerun Task 6.

---

### Task 7: Eight-worker cancellable subnet discovery

**Files:**
- Create: `wasm/static/js/mdns-browser/subnet_scanner.js`
- Create: `tests/subnet_scanner_tests.js`
- Modify: `wasm/static/js/mdns-browser/main.js:75-125`
- Modify: `wasm/index.html:488-493`

**Interfaces:**
- Produces: `createSubnetScanner(options)`.
- Produces: scanner methods `start(subnetPrefix)`, `cancel()`, and `generation()`.
- Preserves: `startSubnetScanner()` entry point and `findNvService()` validation.

- [ ] **Step 1: Write concurrency and cancellation tests**

Create 254 deferred fake fetches and assert:

```js
const scanner = createSubnetScanner({
  fetch: fakeFetch,
  onFound: (ip) => found.push(ip),
  concurrency: 8,
  timeoutMs: 3000,
  AbortController: FakeAbortController,
  setTimeout: fakeTimers.setTimeout,
  clearTimeout: fakeTimers.clearTimeout
});

const firstScan = scanner.start('192.168.1');
assert.strictEqual(fakeFetch.active, 8);
assert.strictEqual(fakeFetch.maximumActive, 8);
fakeFetch.resolveNext({ ok: false });
await flushMicrotasks();
assert.strictEqual(fakeFetch.active, 8);

scanner.cancel();
assert.strictEqual(fakeFetch.controllers.every((item) => item.aborted), true);
await firstScan;
assert.deepStrictEqual(found, []);
```

Add a success case where address `.42` resolves `ok: true`, all other probes
settle false, and `onFound('192.168.1.42')` runs once.

- [ ] **Step 2: Run scanner tests and verify RED**

```powershell
rtk node tests/subnet_scanner_tests.js
```

Expected: missing `subnet_scanner.js`.

- [ ] **Step 3: Implement the bounded scanner**

`start()` first cancels the previous generation. It creates addresses 1-254,
then launches exactly `min(8, addressCount)` async workers. Each worker:

1. stops when its generation is stale;
2. takes one address index;
3. creates an `AbortController`;
4. starts a 3000 ms abort timer;
5. performs one HTTP `/serverinfo` fetch;
6. clears the timer and active-controller entry in `finally`;
7. invokes `onFound` only for `response.ok` and a current generation;
8. continues until the queue is empty.

`cancel()` increments generation, aborts every active controller, clears the
active set, and prevents queued work from starting. Expected aborts are not
logged as errors.

- [ ] **Step 4: Verify scanner tests GREEN**

Run Task 7. Expected: `subnet_scanner_tests: PASS`.

- [ ] **Step 5: Wire discovery and script order**

Load `subnet_scanner.js` immediately before `mdns-browser/main.js`.
`startSubnetScanner()` validates the local IPv4 address, creates or reuses one
scanner, and calls `.start(prefix)`. Its `onFound` callback logs the address
and calls `findNvService('ipv4:' + ip)`.

Add a source assertion to the test that the old `for (var i = 1; i <= 254; i++)`
launch loop is absent. Rerun Task 7.

---

### Task 8: UI operation generations, storage safety, and navigation recovery

**Files:**
- Create: `wasm/platform/operation_guard.js`
- Create: `tests/operation_guard_tests.js`
- Create: `tests/ui_reliability_wiring_tests.js`
- Modify: `wasm/platform/index.js`
- Modify: `wasm/platform/navigation.js`
- Modify: `wasm/platform/messages.js`
- Modify: `wasm/static/js/utils.js`
- Modify: `wasm/index.html`

**Interfaces:**
- Produces: `createGenerationGate()` with `begin`, `cancel`, `isCurrent`, and `current`.
- Produces: `parseStoredJson(value, onError)`.
- Changes: `stopGame(host)` returns a promise that settles after refresh and app-list reload.
- Preserves: existing dialogs, labels, and TV navigation controls.

- [ ] **Step 1: Write operation-guard tests**

Create `tests/operation_guard_tests.js`:

```js
const assert = require('assert');
const guards = require('../wasm/platform/operation_guard.js');

const gate = guards.createGenerationGate();
const first = gate.begin();
assert(gate.isCurrent(first));
const second = gate.begin();
assert(!gate.isCurrent(first));
assert(gate.isCurrent(second));
gate.cancel();
assert(!gate.isCurrent(second));

const errors = [];
assert.strictEqual(guards.parseStoredJson(null, errors.push.bind(errors)), null);
assert.deepStrictEqual(guards.parseStoredJson('{"a":1}', errors.push.bind(errors)), { a: 1 });
assert.strictEqual(guards.parseStoredJson('{bad', errors.push.bind(errors)), null);
assert.strictEqual(errors.length, 1);
console.log('operation_guard_tests: PASS');
```

- [ ] **Step 2: Run guard tests and verify RED**

```powershell
rtk node tests/operation_guard_tests.js
```

Expected: missing `operation_guard.js`.

- [ ] **Step 3: Implement and load the guard**

Use a browser-global/CommonJS wrapper. A generation is a positive integer;
`begin()` increments and returns it; `cancel()` increments without returning an
active operation; `isCurrent(token)` uses strict equality.

`parseStoredJson()` returns null for null/undefined or invalid JSON and calls
the supplied logger once for invalid input.

Load `operation_guard.js` before `index.js`.

- [ ] **Step 4: Verify guard tests GREEN**

Run Task 8 guard tests. Expected: `operation_guard_tests: PASS`.

- [ ] **Step 5: Guard Add Host and pairing**

Create separate gates for Add Host and pairing.

Add Host:

- call `begin()` on Continue;
- disable Continue immediately, before network work;
- retain the token in both promise callbacks;
- on Cancel, call `cancel()`, close/reset the dialog, and re-enable the button;
- every late callback returns before changing dialog, host storage, navigation,
  polling, or pairing when its token is stale;
- use `finally` to re-enable controls only for the current token.

Pairing:

- call `begin()` when showing the PIN;
- on Cancel, call `cancel()`, invoke `nvhttpHost.cancelPairingRequest()`, and
  close the modal;
- success and failure mutate `nvhttpHost`, storage, dialog, and callbacks only
  for the active token;
- clear `isPairingInProgress` for the active terminal path.

- [ ] **Step 6: Make app loading settle and reset navigation**

At the start of `showApps()`, begin an apps generation. In every completion
callback, ignore stale generations. For an empty list:

```js
Views.Apps.view.reset();
showAppsMode();
resolve([]);
return;
```

On a populated list, reset the view before resolving. On failure, show the
error view, restore `showAppsMode()`, and reject. Remove fixed wrapper delays
that do not protect a platform requirement.

- [ ] **Step 7: Clamp `ListView` safely**

Add:

```js
normalize() {
  const array = this.func() || [];
  if (array.length === 0) {
    this.index = 0;
    return array;
  }
  this.index = Math.max(0, Math.min(this.index, array.length - 1));
  return array;
}

current() {
  const array = this.normalize();
  return array.length ? array[this.index] : undefined;
}
```

Call `normalize()` before every navigation method that indexes the collection.
`mark`, `unmark`, `focusElement`, and `blurElement` must remain harmless for an
undefined element. Export `ListView` under CommonJS for its Node test.

- [ ] **Step 8: Make IndexedDB callbacks total**

Define `let value = null` before each database try block. On successful reads,
use `OperationGuard.parseStoredJson()`. On read error, transaction error,
database open error, or exception, invoke `callCb(key, null, callbackFunction)`
exactly once. Protect the callback with a local `settled` boolean.

`openIndexDB(callback)` calls `callback(false)` on open error and
`callback(true)` on success. `getData()` treats `false` as missing data rather
than dereferencing a null database.

- [ ] **Step 9: Replace fixed stream-reload timers**

Fix:

```js
return sendMessage('openUrl', [
  this._baseUrlHttps + '/cancel?' + this._buildUidStr(),
  this.ppkstr, false, 10000
]).then(() => this.refreshServerInfo());
```

Make `stopGame(host)` return the complete promise chain. In the "quit current
app and start another" path:

```js
stopGame(host)
  .then(function() { return startGame(host, appID); })
  .catch(function(error) {
    snackbarLogLong('Unable to quit the running app.');
    console.error(error);
  });
```

For native stream termination, use
`showApps(api).then(function() { Navigation.switch(); Navigation.change(Views.Apps); })`
and switch navigation only after that promise settles successfully. Remove the
1500 ms and 3000 ms sequencing timers.

- [ ] **Step 10: Add UI wiring tests**

`tests/ui_reliability_wiring_tests.js` loads the pure guard and `ListView`, and
also checks source wiring:

```js
assert.match(indexSource, /Views\.Apps\.view\.reset\(\)[\s\S]*showAppsMode\(\)[\s\S]*resolve\(\[\]\)/);
assert.match(indexSource, /parseStoredJson/);
assert.doesNotMatch(utilsSource, /\.then\(this\.refreshServerInfo\(\)\)/);
assert.match(utilsSource, /\.then\(\(\)\s*=>\s*this\.refreshServerInfo\(\)\)/);
assert.doesNotMatch(indexSource, /setTimeout\(\(\)\s*=>\s*startGame\(host,\s*appID\),\s*3000\)/);
assert.match(messagesSource, /showApps\(api\)\.then/);
```

Behaviorally assert that a `ListView` index of 10 over two items clamps to 1
and that an empty view returns undefined without throwing.

Run:

```powershell
rtk node tests/ui_reliability_wiring_tests.js
```

Expected: `ui_reliability_wiring_tests: PASS`. Rerun Tasks 2, 6, and 7 JavaScript
tests to catch bridge and event-loop regressions.

---

### Task 9: Tizen 9 and dependency modernization

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tests/dependency_manifest_tests.js`
- Create or update after probe: `docs/tizen-9-build.md`
- Modify: `Dockerfile`
- Modify: `wasm/index.html`
- Modify: `res/config.xml`
- Modify: `README.md`
- Remove: `wasm/static/js/jquery-2.2.0.min.js`
- Temporary during probe only: `Dockerfile.modern-probe`

**Interfaces:**
- Produces: reproducible jQuery 4.0.0 from npm integrity
  `sha512-TXCHVR3Lb6TZdtw1l3RTLf8RBWVGexdxL6AC8/e0xZKEpBflBsjh9/8LXw+dkNFuOyW9B7iB3O1sP7hS0Kiacg==`.
- Produces: WGT manifest requiring Tizen 9.0.
- Preserves: Tizen Studio 6.1 and Samsung Emscripten 1.39.4.7 compatibility.

- [ ] **Step 1: Write dependency-manifest tests**

Create `tests/dependency_manifest_tests.js`:

```js
const assert = require('assert');
const fs = require('fs');

const pkg = require('../package.json');
const lock = require('../package-lock.json');
const html = fs.readFileSync('wasm/index.html', 'utf8');
const config = fs.readFileSync('res/config.xml', 'utf8');
const dockerfile = fs.readFileSync('Dockerfile', 'utf8');

assert.strictEqual(pkg.dependencies.jquery, '4.0.0');
assert.strictEqual(lock.packages['node_modules/jquery'].version, '4.0.0');
assert.strictEqual(
  lock.packages['node_modules/jquery'].integrity,
  'sha512-TXCHVR3Lb6TZdtw1l3RTLf8RBWVGexdxL6AC8/e0xZKEpBflBsjh9/8LXw+dkNFuOyW9B7iB3O1sP7hS0Kiacg=='
);
assert(html.includes('static/js/jquery-4.0.0.min.js'));
assert(!html.includes('jquery-2.2.0'));
assert(config.includes('required_version="9.0"'));
assert(dockerfile.includes('node:24.18.0-alpine'));
assert(dockerfile.includes('npm ci --omit=dev --ignore-scripts'));
console.log('dependency_manifest_tests: PASS');
```

- [ ] **Step 2: Run dependency tests and verify RED**

```powershell
rtk node tests/dependency_manifest_tests.js
```

Expected: missing `package.json`/lock and legacy manifest references.

- [ ] **Step 3: Add exact package metadata**

Create:

```json
{
  "name": "moonlight-tizen-build",
  "private": true,
  "version": "1.13.1",
  "engines": {
    "node": "24.18.0"
  },
  "dependencies": {
    "jquery": "4.0.0"
  },
  "scripts": {
    "test:js": "node tests/http_bridge_tests.js && node tests/gamepad_polling_tests.js && node tests/subnet_scanner_tests.js && node tests/operation_guard_tests.js && node tests/ui_reliability_wiring_tests.js && node tests/dependency_manifest_tests.js"
  }
}
```

The version-3 lock contains the root package and:

```json
"node_modules/jquery": {
  "version": "4.0.0",
  "resolved": "https://registry.npmjs.org/jquery/-/jquery-4.0.0.tgz",
  "integrity": "sha512-TXCHVR3Lb6TZdtw1l3RTLf8RBWVGexdxL6AC8/e0xZKEpBflBsjh9/8LXw+dkNFuOyW9B7iB3O1sP7hS0Kiacg=="
}
```

- [ ] **Step 4: Install jQuery reproducibly in Docker**

Add:

```dockerfile
FROM node:24.18.0-alpine AS frontend-dependencies
WORKDIR /frontend
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
```

After copying browser sources into the builder, copy:

```dockerfile
COPY --from=frontend-dependencies \
  /frontend/node_modules/jquery/dist/jquery.min.js \
  /home/moonlight/moonlight-tizen/wasm/static/js/jquery-4.0.0.min.js
```

Change `index.html`, delete the 2.2.0 asset, and scan application code for
removed jQuery APIs:

```powershell
rtk rg -n "\$\.trim|\$\.isArray|\$\.parseJSON|\.andSelf\(|\.size\(\)|\.delegate\(|\.undelegate\(" wasm --glob "*.js"
```

Expected: no application matches. Calls such as native
`String.prototype.trim()` and `Function.prototype.bind()` are not jQuery APIs.

- [ ] **Step 5: Set and document the platform target**

Change `required_version` to `9.0`. Change the README feature and prerequisite
text from Tizen 5.5+ to Tizen 9.0, naming the UE43CU7172UXXH as the primary
validation target without claiming it has been tested.

- [ ] **Step 6: Verify dependency tests GREEN**

Run:

```powershell
rtk node tests/dependency_manifest_tests.js
rtk npm ci --ignore-scripts --dry-run
rtk npm run test:js
```

Expected: exact dependency installation and all JavaScript tests pass.
Do not leave `node_modules` in the WGT or source delivery.

- [ ] **Step 7: Split the production builder and artifact stages**

Name the compilation stage `builder`. Do not delete its SDK before the stage
ends; this keeps it available for bounded inspection and avoids a cleanup layer
that does not reduce that stage. Make the default final stage contain only the
WGT at `/home/moonlight/Moonlight.wgt`:

```dockerfile
FROM scratch AS artifact
COPY --from=builder /home/moonlight/Moonlight.wgt /home/moonlight/Moonlight.wgt
```

Preserve Tizen Studio 6.1 and Samsung Emscripten 1.39.4.7. Verify the legacy
builder target still completes:

```powershell
rtk docker build --progress=plain --target builder -t moonlight-tizen-toolchain-inspect .
```

- [ ] **Step 8: Run the Python 3 compatibility probe**

Create `Dockerfile.modern-probe` as an exact copy of the refactored production
Dockerfile with only these dependency changes:

```dockerfile
python3
RUN ln -sf /usr/bin/python3 /usr/bin/python
RUN python --version
```

Remove `python2`. Build the complete builder:

```powershell
rtk docker build --progress=plain --target builder -f Dockerfile.modern-probe -t moonlight-tizen-python3-probe .
```

Acceptance: the complete CMake, Emscripten, Tizen signing, packaging, and WGT
steps exit 0. If accepted, apply the two Python changes to the production
Dockerfile. If the Samsung SDK fails because it requires Python 2
syntax/runtime, retain the production Python 2 lines and record the exact
failing command and message in `docs/tizen-9-build.md`.

- [ ] **Step 9: Run the OpenSSL 3.5.7 compatibility probe**

Inspect the Samsung scripts from the successful Python probe, or from the
legacy inspection image when Python 3 was rejected:

```powershell
rtk docker run --rm --entrypoint /bin/bash moonlight-tizen-toolchain-inspect -lc "grep -nE '1\\.1\\.1|URL|HASH|patch|Configure' /home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/tools/ports/tizen/ssl.py /home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/tools/ports/tizen/crypto.py"
```

Attempt OpenSSL 3.5.7 only when the scripts expose source version, URL, and
integrity values without applying 1.1.1-specific source patches. Point both
ports at the official `openssl-3.5.7.tar.gz` and require SHA-256
`a8c0d28a529ca480f9f36cf5792e2cd21984552a3c8e4aa11a24aa31aeac98e8`.
Build the complete probe builder and default artifact stages.

Acceptance requires a clean WASM link, all native/JavaScript tests, expected
Samsung socket/WASM Player artifacts, and a signed WGT. If any condition fails,
retain Samsung's pinned OpenSSL in production and record the incompatibility.
Do not disable TLS verification, reduce security flags, or add an unreviewed
source patch to make the probe pass.

After both decisions, delete only `Dockerfile.modern-probe` through a patch.
Keep only accepted dependency changes in the production Dockerfile.

- [ ] **Step 10: Document the bounded modernization result**

In `docs/tizen-9-build.md`, include a table with Tizen Studio 6.1, Samsung
Emscripten 1.39.4.7, Node.js 24.18.0, jQuery 4.0.0, selected Python, selected
OpenSSL, probe command, result, and reason. State that old build dependencies,
if unavoidable, exist only in Docker and are not TV runtime components.

---

### Task 10: Full regression verification and WGT delivery

**Files:**
- Modify after evidence is available: `docs/tizen-9-build.md`
- Produce: `Moonlight.wgt`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: signed WGT, byte size, SHA-256, package inspection, and TV smoke checklist.

- [ ] **Step 1: Run all native host tests with sanitizers**

Run the exact native commands from Tasks 1-5, then existing native tests:

```powershell
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -pthread -I. tests/diagnostic_log_tests.cpp wasm/diagnostic_log.cpp -o /tmp/diagnostic_log_tests && /tmp/diagnostic_log_tests"
rtk wsl.exe sh -lc "cd /mnt/c/Users/madej/Downloads/moonlight-tizen-master && g++ -std=c++17 -Wall -Wextra -Werror -I. tests/speculative_rfi_policy_tests.cpp -o /tmp/speculative_rfi_policy_tests && /tmp/speculative_rfi_policy_tests"
```

Expected: every test exits 0 and sanitizers report no finding.

- [ ] **Step 2: Run all JavaScript regressions**

Run the new npm script plus existing tests not included in it:

```powershell
rtk npm run test:js
rtk node tests/diagnostic_logs_js_tests.js
rtk node tests/diagnostic_log_manager_tests.js
rtk node tests/common_log_capture_wiring_tests.js
```

Expected: every script prints its PASS marker and exits 0.

- [ ] **Step 3: Run the receiver integration test**

```powershell
rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/receiver_integration_test.ps1
```

Expected: `receiver_integration_test: PASS`.

- [ ] **Step 4: Build the production Docker image**

Confirm the Linux engine:

```powershell
rtk docker info --format "{{.ServerVersion}}|{{.OSType}}|{{.Architecture}}"
```

Then build without using the modernization probe image:

```powershell
rtk docker build --progress=plain -t moonlight-tizen-9-reliability .
```

Expected: CMake compilation, Tizen signing, packaging, and artifact stage all
exit 0.

- [ ] **Step 5: Extract the exact WGT**

Create one uniquely named container from `moonlight-tizen-9-reliability`, copy
`/home/moonlight/Moonlight.wgt` to the workspace as `Moonlight.wgt`, and remove
only that exact temporary container. Verify the copied timestamp is from this
build.

- [ ] **Step 6: Inspect package contents**

Treat the WGT as ZIP-compatible and verify:

- `config.xml` declares Tizen 9.0;
- author and distributor signature files exist;
- `jquery-4.0.0.min.js` exists and `jquery-2.2.0.min.js` does not;
- WASM, worker, platform, media, curl, icons, and new browser helpers exist;
- `node_modules`, tests, Dockerfiles, source files, and private keys do not;
- the package contains no unresolved reference to the old jQuery filename.

- [ ] **Step 7: Record artifact identity**

Run:

```powershell
rtk powershell.exe -NoProfile -Command "Get-Item -LiteralPath 'Moonlight.wgt' | Select-Object FullName,Length,LastWriteTimeUtc; Get-FileHash -Algorithm SHA256 -LiteralPath 'Moonlight.wgt'"
```

Record the absolute path, exact byte count, UTC timestamp, and SHA-256 in
`docs/tizen-9-build.md`.

- [ ] **Step 8: Add the UE43CU7172UXXH smoke checklist**

Document these physical-TV checks without marking them complete:

1. install and launch on Tizen 9.0;
2. add a host, cancel once, then add successfully;
3. pair, cancel once, then pair successfully;
4. verify automatic /24 discovery finds the host without UI stalls;
5. load populated and empty app lists;
6. connect, disconnect, and reconnect a controller;
7. verify buttons, axes, rumble, and the stop-stream combo;
8. stream H.264 and the TV-supported HEVC/AV1 modes;
9. compare frame pacing disabled/enabled at 60 FPS;
10. stop, remote-terminate, and reconnect repeatedly;
11. leave media setup during startup and confirm no hang;
12. export diagnostics after the session.

- [ ] **Step 9: Perform final source and scope review**

Scan for obsolete constructs:

```powershell
rtk rg -n "jquery-2\\.2\\.0|g_CancelHttpRequest|Promise\\.race|setInterval\\(pollGamepads|emscripten_sample_gamepad_data\\(\\)" wasm libgamestream res
```

Expected:

- no old jQuery, global HTTP cancellation, native-HTTP timeout races, or gamepad interval;
- exactly one native gamepad sampling call in `PollGamepads()`;
- unrelated codec profiles, hardware-decoding selection, decoder queue policy,
  and diagnostic controls remain unchanged.

- [ ] **Step 10: Report verification limits**

Report all test groups, Docker build result, package inspection, artifact path,
size, and SHA-256. State plainly that the package is not physically validated
until the user completes the television checklist.
