# TV debugging tools

Small scripts for working with a real TV. The tooling that was used to hunt the freeze described in
`docs/2026-10-18-stream-hang-investigation.md` (the DevTools forensics watcher, the heap walker, the allocator stress
test and the diagnostic dlmalloc, the video packet canary, the QoS throttle scripts) is not on `main` any more. It lives
on the branch `diagnostics/freeze-hunt`, which also has the tests for it and the notes on how to use it.

## Getting a debug session

Plain `sdb shell` is blocked on the TV, only `sdb shell 0 <command>` works. With the Tizen SDK image of this repository
(`docker build --target sdk -t mt-sdk-probe .`) and the TV in Developer Mode:

```
docker run --rm mt-sdk-probe bash -lc 'S=/home/moonlight/tizen-studio/tools/sdb; $S connect <tv>; $S -s <tv>:26101 shell 0 debug MoonLightS.MoonlightWasm'
```

It prints `... with debug 1 port: <port>`. The inspector is then at `http://<tv>:<port>/json`; the
`webSocketDebuggerUrl` of the page (without `ws://`) is the `<host:port/devtools/page/ID>` argument of `page_eval.js`.
The port changes with every launch. If the application is already running, the launch can hang: close the application
first.

## Installing a WGT

`install_wgt_apps2samsung.ps1 -Wgt <file>` installs a WGT on the TV through the Apps2Samsung window (expects it in
`Downloads\Apps2Samsung-v2.8.3-beta-win-x64`): UI Automation for its own controls, Win32 messages for the system file
dialog, because UI Automation hangs on that dialog. Do not use the mouse while it runs.

## page_eval.js

`node page_eval.js <host:port/devtools/page/ID> <expression file>` evaluates a JavaScript expression in the page of a
debug-launched application and prints the result. Node 22 or newer (global `WebSocket` and `fetch`); no packages.
