<#
.SYNOPSIS
  Removes the bandwidth limit that Start-QosThrottle.ps1 put on the traffic to the TV.

.DESCRIPTION
  Removes the QoS policy of the given name, from the local store where Start-QosThrottle.ps1 creates it and, if it
  accepts the removal, from the active store. It is safe to run when there is no such policy. Needs an elevated
  PowerShell (Run as administrator).

.PARAMETER PolicyName
  Name of the policy, as given to Start-QosThrottle.ps1. Defaults to MoonlightQosTest.

.PARAMETER DryRun
  Prints what would be done and changes nothing. Works without administrator rights.

.EXAMPLE
  .\tools\Stop-QosThrottle.ps1
#>
[CmdletBinding()]
param(
  [string]$PolicyName = 'MoonlightQosTest',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

Write-Host "Removing the QoS policy '$PolicyName' (local store and active store)."

if ($DryRun) {
  Write-Host 'Dry run: nothing was changed.'
  return
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'This needs administrator rights. Start an elevated PowerShell and run it again, for example:'
  Write-Host "  Start-Process powershell -Verb RunAs -ArgumentList '-NoExit -File ""$PSCommandPath"" -PolicyName $PolicyName'"
  exit 1
}

$found = $false
if (Get-NetQosPolicy -Name $PolicyName -ErrorAction SilentlyContinue) {
  $found = $true
  Remove-NetQosPolicy -Name $PolicyName -Confirm:$false
  Write-Host 'Removed it from the local store.'
}
if (Get-NetQosPolicy -Name $PolicyName -PolicyStore ActiveStore -ErrorAction SilentlyContinue) {
  $found = $true
  try {
    Remove-NetQosPolicy -Name $PolicyName -PolicyStore ActiveStore -Confirm:$false
    Write-Host 'Removed it from the active store.'
  } catch {
    Write-Host "The active store did not take the removal ($($_.Exception.Message)); that is fine if the policy is gone from it now."
  }
}
if (-not $found) {
  Write-Host "There was no policy '$PolicyName'; nothing to remove."
}

if (Get-NetQosPolicy -Name $PolicyName -PolicyStore ActiveStore -ErrorAction SilentlyContinue) {
  Write-Host "WARNING: the policy '$PolicyName' is still in effect."
  exit 2
}
Write-Host 'The traffic to the TV is no longer limited.'
