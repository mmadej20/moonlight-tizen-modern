$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot
$receiver = Join-Path $workspace 'tools\Receive-MoonlightLogs.ps1'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("moonlight-receiver-test-" + [guid]::NewGuid().ToString('N'))
$outputDirectory = Join-Path $testRoot 'logs'
$stdout = Join-Path $testRoot 'receiver.out'
$stderr = Join-Path $testRoot 'receiver.err'
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
$process = $null

try {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    $process = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
        -ArgumentList @('-NoProfile', '-File', $receiver, '-ListenAddress', '127.0.0.1', '-Port', $port, '-OutputDirectory', $outputDirectory, '-Once')

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ((Test-Path $stdout) -and (Get-Content -Raw $stdout -ErrorAction SilentlyContinue) -match 'Listening on') {
            break
        }
        if ($process.HasExited) {
            throw "Receiver exited early: $(Get-Content -Raw $stderr -ErrorAction SilentlyContinue)"
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path $stdout) -or (Get-Content -Raw $stdout) -notmatch 'Listening on') {
        throw 'Receiver did not become ready.'
    }

    $body = "Moonlight diagnostic export v1`nframe=42`nżółć`n"
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/moonlight-logs" `
        -Method Post -ContentType 'text/plain; charset=utf-8' `
        -Headers @{'X-Moonlight-Filename' = 'moonlight-current-session-test.log'} `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
    if ($response.StatusCode -ne 200) {
        throw "Expected HTTP 200, received $($response.StatusCode)."
    }

    $process.WaitForExit(10000) | Out-Null
    $files = @(Get-ChildItem -LiteralPath $outputDirectory -Filter '*.log')
    if ($files.Count -ne 1) {
        throw "Expected exactly one log file, found $($files.Count)."
    }
    $saved = [System.IO.File]::ReadAllText($files[0].FullName, [System.Text.Encoding]::UTF8)
    if ($saved -ne $body) {
        throw 'Saved UTF-8 body does not match the request body.'
    }

    Write-Output 'receiver_integration_test: PASS'
}
finally {
    if ($process -and -not $process.HasExited) {
        $process.Kill()
        $process.WaitForExit()
    }
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
