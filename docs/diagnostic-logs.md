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
