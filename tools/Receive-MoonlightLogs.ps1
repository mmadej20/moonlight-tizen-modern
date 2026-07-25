[CmdletBinding()]
param(
    [string]$ListenAddress = '0.0.0.0',
    [ValidateRange(1, 65535)]
    [int]$Port = 48150,
    [string]$OutputDirectory = (Join-Path (Get-Location) 'moonlight-tv-logs'),
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
$MaxHeaderBytes = 32768
$MaxBodyBytes = 3 * 1024 * 1024

function Send-HttpResponse {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$StatusCode,
        [string]$Reason,
        [string]$Body = ''
    )

    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $header = "HTTP/1.1 $StatusCode $Reason`r`n" +
        "Content-Type: text/plain; charset=utf-8`r`n" +
        "Content-Length: $($bodyBytes.Length)`r`n" +
        "Access-Control-Allow-Origin: *`r`n" +
        "Access-Control-Allow-Methods: POST, OPTIONS`r`n" +
        "Access-Control-Allow-Headers: Content-Type, X-Moonlight-Filename`r`n" +
        "Connection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($bodyBytes.Length -gt 0) {
        $Stream.Write($bodyBytes, 0, $bodyBytes.Length)
    }
    $Stream.Flush()
}

function Read-HttpHeader {
    param([System.Net.Sockets.NetworkStream]$Stream)

    $bytes = New-Object System.Collections.Generic.List[byte]
    while ($bytes.Count -lt $MaxHeaderBytes) {
        $value = $Stream.ReadByte()
        if ($value -lt 0) {
            throw 'Connection closed before the HTTP header was complete.'
        }
        $bytes.Add([byte]$value)
        $count = $bytes.Count
        if ($count -ge 4 -and
            $bytes[$count - 4] -eq 13 -and $bytes[$count - 3] -eq 10 -and
            $bytes[$count - 2] -eq 13 -and $bytes[$count - 1] -eq 10) {
            return [System.Text.Encoding]::ASCII.GetString($bytes.ToArray())
        }
    }
    throw "HTTP header exceeds $MaxHeaderBytes bytes."
}

function Read-ExactBody {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$Length
    )

    $body = New-Object byte[] $Length
    $offset = 0
    while ($offset -lt $Length) {
        $read = $Stream.Read($body, $offset, $Length - $offset)
        if ($read -le 0) {
            throw 'Connection closed before the declared request body was received.'
        }
        $offset += $read
    }
    return $body
}

function Parse-Headers {
    param([string[]]$Lines)

    $headers = @{}
    foreach ($line in $Lines) {
        if (-not $line) { continue }
        $separator = $line.IndexOf(':')
        if ($separator -le 0) {
            throw 'Malformed HTTP header line.'
        }
        $name = $line.Substring(0, $separator).Trim().ToLowerInvariant()
        $value = $line.Substring($separator + 1).Trim()
        if ($headers.ContainsKey($name)) {
            throw "Duplicate HTTP header: $name"
        }
        $headers[$name] = $value
    }
    return $headers
}

function Get-SafeLogPath {
    param(
        [string]$RequestedName,
        [string]$RootDirectory
    )

    $name = [System.IO.Path]::GetFileName($RequestedName)
    $name = [regex]::Replace($name, '[^A-Za-z0-9_.-]', '-')
    $name = $name.Trim('.', '-')
    if (-not $name) {
        $name = 'moonlight-diagnostics-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.log'
    }
    if (-not $name.EndsWith('.log', [StringComparison]::OrdinalIgnoreCase)) {
        $name += '.log'
    }

    $root = [System.IO.Path]::GetFullPath($RootDirectory).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $root $name))
    if (-not $candidate.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Requested filename escapes the output directory.'
    }
    if (Test-Path -LiteralPath $candidate) {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($name)
        $candidate = Join-Path $root ($base + '-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff') + '.log')
    }
    return $candidate
}

$ipAddress = $null
if (-not [System.Net.IPAddress]::TryParse($ListenAddress, [ref]$ipAddress)) {
    throw "ListenAddress must be an IPv4 or IPv6 address: $ListenAddress"
}
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null

$listener = [System.Net.Sockets.TcpListener]::new($ipAddress, $Port)
$listener.Start()
Write-Output "Listening on http://$ListenAddress`:$Port/moonlight-logs"
Write-Output "Saving logs inside: $resolvedOutput"

try {
    $completedPosts = 0
    while (-not $Once -or $completedPosts -eq 0) {
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 10000
            $client.SendTimeout = 10000
            $stream = $client.GetStream()
            try {
                $headerText = Read-HttpHeader -Stream $stream
                $lines = $headerText -split "`r`n"
                $request = $lines[0] -split ' '
                if ($request.Count -ne 3) {
                    Send-HttpResponse $stream 400 'Bad Request' 'Malformed request line.'
                    continue
                }
                $method = $request[0].ToUpperInvariant()
                $path = $request[1]
                $headers = Parse-Headers -Lines $lines[1..($lines.Count - 1)]

                if ($path -ne '/moonlight-logs') {
                    Send-HttpResponse $stream 404 'Not Found' 'Expected /moonlight-logs.'
                    continue
                }
                if ($method -eq 'OPTIONS') {
                    Send-HttpResponse $stream 204 'No Content'
                    continue
                }
                if ($method -ne 'POST') {
                    Send-HttpResponse $stream 405 'Method Not Allowed' 'Only POST is accepted.'
                    continue
                }
                $completedPosts++
                if ($headers.ContainsKey('transfer-encoding')) {
                    Send-HttpResponse $stream 400 'Bad Request' 'Transfer-Encoding is not supported.'
                    continue
                }
                if (-not $headers.ContainsKey('content-length')) {
                    Send-HttpResponse $stream 411 'Length Required' 'Content-Length is required.'
                    continue
                }
                $contentLength = 0
                if (-not [int]::TryParse($headers['content-length'], [ref]$contentLength) -or
                    $contentLength -lt 1 -or $contentLength -gt $MaxBodyBytes) {
                    Send-HttpResponse $stream 413 'Payload Too Large' "Body must contain 1 to $MaxBodyBytes bytes."
                    continue
                }

                $body = Read-ExactBody -Stream $stream -Length $contentLength
                $requestedName = if ($headers.ContainsKey('x-moonlight-filename')) { $headers['x-moonlight-filename'] } else { '' }
                $outputPath = Get-SafeLogPath -RequestedName $requestedName -RootDirectory $resolvedOutput
                $temporaryPath = Join-Path $resolvedOutput ('.moonlight-log-' + [guid]::NewGuid().ToString('N') + '.tmp')
                try {
                    [System.IO.File]::WriteAllBytes($temporaryPath, $body)
                    Move-Item -LiteralPath $temporaryPath -Destination $outputPath
                }
                finally {
                    if (Test-Path -LiteralPath $temporaryPath) {
                        Remove-Item -LiteralPath $temporaryPath -Force
                    }
                }
                Write-Output "Saved: $outputPath"
                Send-HttpResponse $stream 200 'OK' ([System.IO.Path]::GetFileName($outputPath))
            }
            catch {
                Write-Warning $_.Exception.Message
                try { Send-HttpResponse $stream 400 'Bad Request' $_.Exception.Message } catch {}
            }
        }
        finally {
            $client.Close()
        }
    }
}
finally {
    $listener.Stop()
}
