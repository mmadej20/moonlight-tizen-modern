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
