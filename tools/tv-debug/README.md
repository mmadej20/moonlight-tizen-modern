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
