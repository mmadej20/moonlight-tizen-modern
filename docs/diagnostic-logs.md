# Collecting diagnostic logs from a Samsung TV

Moonlight keeps the current and previous streaming-session logs in the TV application's private storage. The logs can be viewed under **Settings > Diagnostic Logs** and sent on demand to the current streaming PC.

## Start the receiver

Open PowerShell in the repository directory and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Receive-MoonlightLogs.ps1
```

The default endpoint is `http://0.0.0.0:48150/moonlight-logs` and files are stored under `moonlight-tv-logs` in the current directory. Windows Firewall may ask whether PowerShell can accept connections; allow it for the private network used by the TV.

Optional parameters:

```powershell
.\tools\Receive-MoonlightLogs.ps1 -ListenAddress 192.168.1.20 -Port 48150 -OutputDirectory C:\Temp\MoonlightLogs -Once
```

`-Once` exits after handling one POST request. Without it, stop the receiver with `Ctrl+C` after collecting logs.

## Send from the TV

1. Reproduce the video freeze.
2. Return to **Settings > Diagnostic Logs**.
3. Select **Current session** or **Previous session**.
4. Confirm that **Host** is the PC running the receiver and **Port** is `48150`.
5. Select **Send logs to PC**.

The TV retains its local copy whether export succeeds or fails. Exported data is redacted for known PIN, password, key, secret, and token values, but it includes local IP addresses and stream diagnostics.

## Troubleshooting

- **Connection refused:** start the receiver and confirm the selected host address.
- **Timeout:** allow PowerShell through Windows Firewall and verify that the TV and PC can reach each other on the LAN.
- **Wrong host:** edit the Host field on the TV; it is only prefilled from the latest streaming host.
- **No previous session:** complete or start a second stream so the first session rotates into Previous session.

## Diagnosing a freeze

The log is written by the application's main thread, so a frozen main thread stops the log exactly like a crash. These additions make a freeze leave evidence.

**Heartbeat.** While the stream view is shown, the application stores one small record per second (`moonlightStreamHeartbeat` in local storage): wall clock time, how long the stream had been running, the stream health line below and the JavaScript heap use. It never contains the host address.

**After a freeze:**

1. Close the application (hold Back) and start it again.
2. Open **Settings > Diagnostic Logs** and select **Current session** before starting another stream. Starting a stream rotates that log into Previous session.
3. The log ends with this line, added by the new run:

```text
[js 2026-10-18T10:21:07.000Z] Previous run ended while streaming: last heartbeat 2026-10-18T10:19:42.000Z, the stream had been running 347 s, 85 s ago. Last health: video=...
```

Send the whole log. A stream that ended in an orderly way is recorded as such and never produces this line.

**Stream health.** `StreamHealth up=<s>s ...` is logged at the first heartbeat and then every 10 s. The last heartbeat before a freeze carries the same fields.

| Field | Meaning |
| --- | --- |
| `video=<n>/<age>ms`, `audio=<n>/<age>ms` | Packets handed to the player and the age of the newest one. A growing age means that part stopped. `-1` means none yet. |
| `videoAppend*`, `audioAppend*` | The call into the platform media pipeline: number of calls, the longest call in the last second, and `BlockedMs`, which is above 0 while a thread is inside the call right now. |
| `inputPoll*` | One poll of the controllers by the input thread: a single synchronous call to the main thread, every 5 ms while a controller is in use and every 25 ms while none is (`inputPolls` therefore grows by about 200 or 40 per second). A long `inputPollMaxMs` or a growing `inputPollBlockedMs` means the main thread is not answering. |
| `mainCall*` | Worker threads waiting for the main thread through synchronous messages to the interface. |
| `controllers=<n>` | Controllers in use at the last poll. |
| `controllerSent=<n>` | Controller states sent to the host since the stream started. A state is sent when it differs from the previous one, plus a reminder every 100 ms, so an idle controller adds about 10 per second (it used to add about 110). |
| `controllerSkipped=<n>` | Controller states that were not sent because they equal the one the host already has. |
| `rumbleReceived=<n>` / `rumblePosted=<n>` | Rumble messages from the host, and the ones passed on to the interface. The rest repeated the previous values of the controller. |
| `mainJitterMaxMs=<n>` | Added by the interface at the end of the line: the worst lateness of the one second heartbeat timer in the last 10 s. It is how long the main thread was busy, for example in a garbage collection, even when nothing stalled for seconds. |
| `heap=<used>/<total>MB` | The wasm heap, which has a fixed size. Close to the total means the stream may be running out of memory. |

How to read the last heartbeat:

- everything stops together and the heartbeat stops too: the whole application was frozen or killed by the TV;
- `videoAppendBlockedMs` keeps growing while heartbeats continue: the platform media pipeline stopped returning;
- `inputPollBlockedMs` and `mainCallBlockedMs` keep growing while `video` is still fresh: the main thread is stuck;
- `heap` close to its total shortly before: memory exhaustion.

**Main thread stalls.** `Main thread stalled for <n> ms` is added after the thread recovers whenever a heartbeat arrives more than 2.5 s late.

**HTTP queue.** All HTTP requests share one thread. `HTTP request /path waited <n> ms in the queue` is logged when a request waited 1 s or more, and `HTTP request /path ran for <n> ms` when one ran for 3 s or more. Only the path is logged, never the query string.

## Start-up and input telemetry

These lines are written by the interface (they start with `[js <time>]`) or by the input code, once per event.

| Line | Meaning |
| --- | --- |
| `Stream start took <n> ms: server info <a> ms, app lookup <b> ms, launch <c> ms, native start <d> ms, connection <e> ms` | Where the time between pressing an app and the connection being up went. `launch` is the host starting the game, `native start` is the TV creating the connection thread, `connection` is the RTSP handshake plus the media pipeline set up on the TV. |
| `Stream start request was rejected: <code>` | The native side refused to start the stream. This answer was ignored before. |
| `Box art: <n> requested in <t> ms: cached=<c> downloaded=<d> failed=<f> dropped=<x>; downloads avg <a> ms max <m> ms, waited for a slot avg <w> ms max <wm> ms` | One line per app list, when every picture has settled. `dropped` pictures belonged to a list that was left (or a stream started) before their turn. A large `waited for a slot` with small `downloads` means the queue, not the host, is slow. |
| `Subnet scan skipped: every known host is online` / `Subnet scan started (...)` / `Subnet scan finished in <n> ms` | The sweep of the local network (254 probes) now only runs when there is no known host or one of them does not answer. |
| `UI gamepad watching paused for the stream (polls=<n> events=<m> since the app started)` / `... resumed after the stream` | The interface stops polling the controllers during a stream; the native input thread does it. |
| `Rumble: received=<n> played=<m> coalesced=<k> errors=<e>` | Added to the periodic `StreamHealth` line and written once when the stream ends. `received` is what reached the interface, `played` is how many effects were started on the controller (at most one every 50 ms per controller), `coalesced` is what was merged into a later value or ignored because it changed by less than 2%, `errors` is failures of the platform call. |
| `HTTP request <path> timing: dns <a> ms, connect <b> ms, tls <c> ms, host <d> ms, transfer <e> ms, total <t> ms (result <r>)` | Written for every request that took a second or more (the path only). `tls` is the handshake that this device does in software (it is missing for plain HTTP), `host` is the wait for the host to start answering. It says whether a slow start is the TV or the host. |
| `Build optimization: -O2` | The optimization level the module was built with (-O2 or -Os), written at every stream start so that two exported logs can be compared. |
| `Gamepad sampling: one call to the main thread per poll` | The controllers are read with one synchronous call per poll. The other text, `one call to the main thread per slot (the bulk call is not available)`, means the old way is used. `the browser failed to read the controllers` means the browser threw and the poll was skipped. |

## Audio diagnostic telemetry

Builds containing the audio diagnostic patches emit two aggregate records. Each
record is written at most once per second while packets are flowing, plus one
partial record during shutdown. There are no new per-packet log writes.

### `AudioPipelineStats`

This record is produced by the WASM audio renderer:

```text
AudioPipelineStats windowMs=1003 packets=201 appended=198 plc=1 softDrop=2 hardDrop=0 decodeFail=0 appendIgnored=0 appendBufferFull=0 appendOther=0 decodeAvgUs=61 decodeMaxUs=133 appendAvgUs=84 appendMaxUs=520 callbackAvgUs=151 callbackMaxUs=702 mediaOffsetMs=12.000 mediaOffsetMaxMs=18.000 leadMaxMs=207.000 session=4 lastAppendResult=0
```

Fields:

- `windowMs` is the duration represented by the record.
- `packets` counts renderer callbacks, including callbacks dropped by Audio
  Sync.
- `appended` counts successful Samsung `AppendPacket()` calls.
- `plc` counts callbacks where Opus received a null, zero-length loss
  concealment input.
- `softDrop` and `hardDrop` are the two Audio Sync correction paths.
- `decodeFail` counts `opus_multistream_decode()` results less than or equal to
  zero.
- `appendIgnored`, `appendBufferFull`, and `appendOther` split failed Samsung
  append results. `lastAppendResult` retains the numeric result of the last
  append failure in the window.
- `decodeAvgUs`/`decodeMaxUs` use callbacks that reached Opus.
- `appendAvgUs`/`appendMaxUs` use callbacks that reached Samsung append.
- `callbackAvgUs`/`callbackMaxUs` cover the renderer callback through the sync,
  decode, append, and timestamp decisions, but not log formatting.
- `mediaOffsetMs` is elapsed wall time since the first callback minus the next
  audio packet PTS before processing. A growing positive value means the audio
  media timeline is falling behind wall time.
- `mediaOffsetMaxMs` and `leadMaxMs` are the largest media offset and estimated
  Audio Sync lead observed in the window.
- `session` is the EMSS audio session used by the last callback.

### `AudioTransportStats`

This record is produced by `moonlight-common-c` after the initial startup
resynchronization drop:

```text
AudioTransportStats windowMs=1004 audio=201 fec=100 invalidAudio=0 invalidFec=0 oos=0 recovered=1 fecFailed=0 fullBlockSkipped=0 plc=0 totalAudio=201 totalFec=100 totalInvalidAudio=0 totalInvalidFec=0 totalOos=0 totalRecovered=7 totalFecFailed=1 totalFullBlockSkipped=4 totalPlc=2
```

The unprefixed counters are deltas for this window. The `total...` counters are
cumulative for the current stream:

- `audio` and `fec` count all recognized RTP audio and FEC datagrams passed to
  the audio queue. Malformed recognized datagrams remain in these totals, so
  `invalidAudio` and `invalidFec` are subsets rather than additional traffic.
- `invalidAudio` and `invalidFec` count rejected malformed or incompatible
  datagrams.
- `oos` counts audio datagrams older than the queue's current FEC base.
- `recovered` counts missing audio data shards reconstructed by Reed-Solomon.
- `fecFailed` counts FEC blocks released with unrecovered data.
- `fullBlockSkipped` counts packets skipped when an entire earlier FEC block is
  absent. These packets do not currently produce PLC callbacks.
- `plc` counts zero-length placeholders returned for missing packets inside a
  known but unrecoverable block.

`fullBlockSkipped` and `plc` are intentionally separate. Their difference makes
the existing full-block loss behavior visible; the telemetry does not change
that behavior.

### Track lifecycle records

Audio and video track events are logged immediately because they are rare:

```text
AUDIO track closed reason=kSourceSuspended(3) storedSession=4
AUDIO session changed old=4 new=5
AUDIO track open storedSession=5 currentSession=5
```

If `GetSessionId()` fails during open, the last field is
`currentSessionError=<numeric OperationResult>`. Correlate lifecycle events with
`appendIgnored`, because an append using a stale session is expected to be
ignored rather than treated as a fatal player error.

## Post-change TV comparison checklist

Use the same resolution, FPS, codec, bitrate, Audio Sync setting, and frame
pacing setting as the pre-change session. Then check:

1. If `callbackMaxUs` spikes, determine whether the spike is in `decodeMaxUs`,
   `appendMaxUs`, or neither.
2. Compare `softDrop`/`hardDrop` with `mediaOffsetMs` and `leadMaxMs`. The new
   controller should produce far fewer corrections than the old per-packet
   implementation.
3. Correlate `appendIgnored` or other append failures with track close, session
   change, and track open records.
4. Correlate `recovered`, `fecFailed`, `fullBlockSkipped`, and `plc` with
   `Network dropped audio data` and audible gaps.
5. For HEVC, correlate lifecycle records and audio loss windows with video PTS
   gaps, `Waiting for IDR frame`, and IDR requests. This separates media-track
   reopen effects from transport loss and video pacing.
6. Export the whole previous-session log. A single maximum without the nearby
   transport and lifecycle windows is not enough to identify the cause.
