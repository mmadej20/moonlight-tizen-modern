<#
.SYNOPSIS
  Limits the bandwidth of the traffic that this computer sends to the TV, to make a stream suffer from congestion.

.DESCRIPTION
  Creates a Windows QoS policy that throttles the UDP traffic from this computer (the streaming host) to the TV below
  the bitrate of the stream. The host then loses packets in bursts, which is what drives the FEC recovery and the
  reference frame invalidation of the client (docs/2026-10-18-stream-hang-investigation.md). Nothing is sent to the TV by
  this script, the stream itself is what gets squeezed.

  The policy is created in the active store, where it takes effect at once and is not kept across a restart. If that
  store refuses it, the policy goes to the local store, which Windows applies after a policy refresh, and the script runs
  gpupdate to get it applied. In both cases the script checks that the policy is in effect and says so loudly when it is
  not.

  By default the script waits for -Minutes and removes the policy itself when the time is up or when it is stopped with
  Ctrl+C. If the window is closed in some other way, or with -Minutes 0, remove the policy with Stop-QosThrottle.ps1.

  Needs an elevated PowerShell (Run as administrator).

.PARAMETER TvAddress
  IPv4 address of the TV. Defaults to the TV_IP environment variable.

.PARAMETER Mbps
  Rate limit in megabits per second. Pick a value below the bitrate of the stream, for example 20 for a 43 Mbps stream.

.PARAMETER Minutes
  How long to keep the limit; the script removes the policy afterwards. 0 applies the limit and returns at once, and the
  limit stays until Stop-QosThrottle.ps1 is run. Default 30.

.PARAMETER Protocol
  UDP (default), TCP or Both. The stream itself is UDP.

.PARAMETER PolicyName
  Name of the policy. Stop-QosThrottle.ps1 removes the policy of the same name.

.PARAMETER DryRun
  Prints what would be done and changes nothing. Works without administrator rights.

.EXAMPLE
  .\tools\Start-QosThrottle.ps1 -TvAddress 192.168.1.50 -Mbps 20 -Minutes 15
#>
[CmdletBinding()]
param(
  [string]$TvAddress = $env:TV_IP,
  [ValidateRange(1, 10000)][double]$Mbps = 20,
  [ValidateRange(0, 1440)][int]$Minutes = 30,
  [ValidateSet('UDP', 'TCP', 'Both')][string]$Protocol = 'UDP',
  [string]$PolicyName = 'MoonlightQosTest',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($TvAddress)) {
  throw 'Give the address of the TV with -TvAddress, or set the TV_IP environment variable.'
}
$parsed = $null
if (-not [System.Net.IPAddress]::TryParse($TvAddress, [ref]$parsed) -or $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
  throw "'$TvAddress' is not an IPv4 address."
}

$bitsPerSecond = [int64]($Mbps * 1000000)
$prefix = "$TvAddress/32"
$duration = if ($Minutes -gt 0) { "for $Minutes min, then it is removed" } else { 'until Stop-QosThrottle.ps1 is run' }

Write-Host "Policy '$PolicyName': throttle $Protocol traffic to $prefix to $Mbps Mbps ($bitsPerSecond bit/s), $duration."

if ($DryRun) {
  Write-Host 'Dry run: nothing was changed.'
  return
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'This needs administrator rights. Start an elevated PowerShell and run it again, for example:'
  Write-Host "  Start-Process powershell -Verb RunAs -ArgumentList '-NoExit -File ""$PSCommandPath"" -TvAddress $TvAddress -Mbps $Mbps -Minutes $Minutes'"
  exit 1
}

# Removes the policy from the active store and from the local store; a store that does not have it or refuses is skipped
function Remove-QosPolicy {
  try { Remove-NetQosPolicy -Name $PolicyName -PolicyStore ActiveStore -Confirm:$false -ErrorAction Stop } catch { }
  try { Remove-NetQosPolicy -Name $PolicyName -Confirm:$false -ErrorAction Stop } catch { }
}

function Test-QosPolicyInEffect {
  return [bool](Get-NetQosPolicy -Name $PolicyName -PolicyStore ActiveStore -ErrorAction SilentlyContinue)
}

# A policy of the same name from an earlier run is replaced, so that the rate is always the one asked for now
if ((Test-QosPolicyInEffect) -or (Get-NetQosPolicy -Name $PolicyName -ErrorAction SilentlyContinue)) {
  Write-Host "Replacing the existing policy '$PolicyName'."
  Remove-QosPolicy
}

$policyArguments = @{
  Name = $PolicyName
  IPDstPrefixMatchCondition = $prefix
  IPProtocolMatchCondition = $Protocol
  NetworkProfile = 'All'
  ThrottleRateActionBitsPerSecond = $bitsPerSecond
}

$store = 'the active store'
try {
  New-NetQosPolicy @policyArguments -PolicyStore ActiveStore | Out-Null
} catch {
  Write-Host "The active store refused the policy ($($_.Exception.Message)); using the local store and a policy refresh."
  $store = 'the local store'
  New-NetQosPolicy @policyArguments | Out-Null
  & gpupdate.exe /target:computer /force | Out-Null
}

# Give a policy refresh a moment, then say plainly whether the limit is really in effect
for ($i = 0; $i -lt 6 -and -not (Test-QosPolicyInEffect); $i++) { Start-Sleep -Seconds 2 }

if (Test-QosPolicyInEffect) {
  Get-NetQosPolicy -Name $PolicyName -PolicyStore ActiveStore | Format-List Name, PolicyStore, IPDstPrefixMatchCondition, IPProtocolMatchCondition, NetworkProfile, ThrottleRateAction
  Write-Host "The policy is in effect (created in $store): the traffic to $TvAddress is limited to $Mbps Mbps now."
} else {
  Write-Host "WARNING: the policy was created in $store but is NOT in effect: Get-NetQosPolicy -PolicyStore ActiveStore does not list it."
  Write-Host 'The limit does not work yet. Run gpupdate /force, or give the system a few minutes, and check again.'
}

if ($Minutes -eq 0) {
  Write-Host 'Remove the limit with:'
  Write-Host "  .\tools\Stop-QosThrottle.ps1 -PolicyName $PolicyName"
  return
}

# Hold the limit for the asked time and take it away in any case: when the time is up, on Ctrl+C, or on an error
try {
  $end = (Get-Date).AddMinutes($Minutes)
  Write-Host "Keeping the limit until $($end.ToString('HH:mm:ss')). Press Ctrl+C to remove it earlier."
  while ((Get-Date) -lt $end) {
    Start-Sleep -Seconds 5
  }
}
finally {
  Remove-QosPolicy
  if ((Test-QosPolicyInEffect) -or (Get-NetQosPolicy -Name $PolicyName -ErrorAction SilentlyContinue)) {
    Write-Host "WARNING: the policy '$PolicyName' could not be removed; run Stop-QosThrottle.ps1."
  } else {
    Write-Host "The limit was removed; the traffic to $TvAddress is no longer limited."
  }
}
