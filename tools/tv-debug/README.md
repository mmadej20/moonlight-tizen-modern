# TV debugging tools

Scripts used to chase the freezes described in `docs/2026-10-18-stream-hang-investigation.md` on a real TV. They talk
to the Chrome DevTools Protocol of the application, which Tizen exposes in debug mode. Node 22 or newer (global
`WebSocket` and `fetch`); no packages.

## Getting a debug session

Plain `sdb shell` is blocked on the TV, only `sdb shell 0 <command>` works. With the Tizen SDK image of this repository
(`docker build --target sdk -t mt-sdk-probe .`) and the TV in Developer Mode:

```
docker run --rm mt-sdk-probe bash -lc 'S=/home/moonlight/tizen-studio/tools/sdb; $S connect <tv>; $S -s <tv>:26101 shell 0 debug MoonLightS.MoonlightWasm'
```

It prints `... with debug 1 port: <port>`. The inspector is then at `http://<tv>:<port>/json`; the
`webSocketDebuggerUrl` of the page (without `ws://`) is the `<host:port/devtools/page/ID>` argument below. The port
changes with every launch. If the application is already running, the launch can hang: close the application first.

## forensics.js

`node forensics.js <host:port/devtools/page/ID> <log file> [command file]`

Attaches to the page and to every worker (a pthread is a worker) and writes everything they print to the log.

- Every 15 s it walks the dlmalloc chunk chain of the shared heap (`heap_walker.js`) through the page. A break that is
  still there 250 ms later is logged in full with the bytes around it (`HEAP CORRUPTION DETECTED`).
- Every worker pauses on exceptions. A wasm trap (`memory access out of bounds` and the like) **keeps that thread
  paused**, so the process and its heap stay as they were; the wasm locals and a heap walk are logged.
- A main thread that does not answer for 8 s is reported as a freeze: all threads are paused, their stacks and a heap
  walk are logged, and the script **stays attached** (it exits only when the page closes). Do not close the application
  until the analysis is done.
- With a command file (a JSON file `{"thread": "main" | "<worker id prefix>", "expression": "..."}`) it evaluates the
  expression on the paused thread, one file at a time, and logs the answer. Evaluating on a worker works; on the paused
  main thread it times out. `run_cmds.js <log> <command file> <expression file> <worker id> ...` sends the same
  expression to several workers.

Cost: the debugger on every worker slows the module down (audio decoding averaged 1341 µs with it against 1142 µs without; one comparison, so tentative).

## heap_walker.js

The walker itself, as a string that is injected into the page. A chunk is consistent when its size is a multiple of 8
and at least 16, it ends inside the heap, and the next chunk's `PINUSE` bit equals this chunk's `CINUSE` bit; a free
chunk also repeats its size in the next chunk's `prev_foot`. Layout assumptions: dlmalloc 2.8, 32-bit, no footers.

## Allocator stress test

`wasm/alloc_stress.hpp` is a stress test of the primitives the freezes involve (a `std::mutex`, a 32-bit atomic, a spin
lock, `malloc`/`realloc`/`free` with blocks freed by another thread than the one that allocated them). It is compiled
into the module only by a diagnostic build: `docker build --build-arg ALLOC_STRESS=ON`.

`stress_matrix.js <log dir> <seconds> [variant ...]` (set `TV_IP`, optionally `SDK_IMAGE`) launches the application in
debug mode for each variant and runs `alloc_stress_run.js`, which starts the test, follows its report, aborts when the
main thread answers slowly, and walks the heap at the end.

Keep the load low. A first version with 12 threads and no pauses made the whole TV lag until it was restarted; the
threads of the stream mostly wait. The variants use 3 or 4 threads that sleep after every few iterations.

## Static stack analysis

`stack_frames.js` works on a disassembly of the module and needs neither the TV nor a stream. It lists the frame size
of every function, the functions that allocate on the stack at run time (`alloca`, variable length arrays), and the
heaviest chain of direct calls from each thread entry. The stack of a thread of this module grows upward and is a
2 MB block from `malloc`, so an overflow would land in the header of the next heap chunk.

```
docker build --target builder -t mt-builder .
docker run --rm -v <dir with the wasm>:/work mt-builder /home/moonlight/emscripten-release-bundle/emsdk/fastcomp/bin/wasm-dis /work/moonlight-wasm.wasm -o /work/module.wat
node stack_frames.js module.wat <wasm with names, or ->
```

Result for the `-O2` module: the biggest frame is `reed_solomon_reconstruct` with 70 KB, the heaviest direct chain
(video and audio receive threads) is about 75 KB, there is no recursion among direct calls, and the 35 functions with a
dynamic allocation are Opus decoding, `invert_mat` of the FEC and a few small ones. That is a 2 MB limit with a margin
of more than 25 times; calls through function pointers are not followed.

## UDP receive probe and the video packet canary

A diagnostic build (`docker build --build-arg ALLOC_STRESS=ON`) also contains two checks of the video receive path, for
the damaged packet buffer described in section 12 of the investigation:

- `wasm/udp_recv_probe.hpp`: receives one datagram the way the video thread does (`recvfrom(s, buffer, size, 0, NULL,
  NULL)`) into a buffer with a guard pattern before and after it, and reports how many guard bytes changed.
  `udp_probe_run.js <host:port/devtools/page/ID> <tv address> [port]` starts it on a worker thread and sends datagrams
  of different lengths from this computer (shorter, equal, longer than the buffer, with and without a source address),
  so that it shows whether the native host binding of the TV (`tizentvwasm.SocketsHostBindings.recvFrom`, whose source is
  not available) writes only what it was asked for.
- `moonlight-common-c/src/VideoStream.c` (only with `MOONLIGHT_VIDEO_CANARY`, which the same option defines): 16 guard
  bytes behind every video packet buffer, checked right after each receive and before a kept buffer is received into
  again. A change is logged as `VideoCanary: ...` with where it was noticed, the received length and the buffer size.

## Squeezing a stream with a Windows QoS policy

`tools/Start-QosThrottle.ps1` limits the bandwidth of the traffic that the streaming host sends to the TV, so that the
stream loses packets in bursts: the FEC recovery and the reference frame invalidation that the freezes were seen in.
Nothing is sent to the TV, the stream itself is what gets squeezed. Run it from an elevated PowerShell, with a rate below
the bitrate of the stream:

```
.\tools\Start-QosThrottle.ps1 -TvAddress <tv address> -Mbps 20 -Minutes 15
.\tools\Stop-QosThrottle.ps1
```

The first one removes its policy itself after `-Minutes` (default 30), on Ctrl+C and on an error; `-Minutes 0` applies the
limit and returns. The second one removes the policy of the same name from both stores and can be run at any time. Both
have `-DryRun`, which changes nothing and needs no administrator rights. The policy is not removed by a restart, so a
policy that was left behind by a window that was closed has to be removed with the second script.
