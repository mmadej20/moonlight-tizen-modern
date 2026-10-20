# Installs a WGT on the TV through the Apps2Samsung window (UI Automation for its own controls, Win32 messages for the
# system file dialog, because UI Automation hangs on that dialog). Usage: install_wgt.ps1 -Wgt <path>
param([Parameter(Mandatory = $true)][string]$Wgt)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class A2S {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
}
'@
if (-not (Test-Path $Wgt)) { throw "WGT not found: $Wgt" }
$AE = [System.Windows.Automation.AutomationElement]
$exe = Join-Path $env:USERPROFILE 'Downloads\Apps2Samsung-v2.8.3-beta-win-x64\Apps2Samsung.exe'
$p = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru
Start-Sleep -Seconds 12
$root = $AE::RootElement
$win = $root.FindFirst('Children', (New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $p.Id)))
if (-not $win) { throw 'Apps2Samsung window not found' }

function Select-ComboItem($combo, $pattern) {
  $combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
  Start-Sleep -Milliseconds 800
  $items = @($root.FindAll('Descendants', (New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $p.Id))) |
    Where-Object { $_.Current.ControlType.ProgrammaticName -eq 'ControlType.ListItem' -and $_.Current.Name -like $pattern })
  if (-not $items.Count) { throw "combo item not found: $pattern" }
  $items[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
  Start-Sleep -Seconds 1
}

$combos = $win.FindAll('Descendants', (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ComboBox)))
Select-ComboItem $combos[0] 'Tools*'
Select-ComboItem $combos[1] 'Custom WGT*'

$edit = $win.FindFirst('Descendants', (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
$browse = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetNextSibling($edit)
$browse.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()

$dlg = [IntPtr]::Zero
for ($i = 0; $i -lt 40 -and $dlg -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 500; $dlg = [A2S]::FindWindow('#32770', 'Select WGT/TPK File') }
if ($dlg -eq [IntPtr]::Zero) { throw 'file dialog did not open' }
$combo = [A2S]::FindWindowEx($dlg, [IntPtr]::Zero, 'ComboBoxEx32', $null)
$inner = [A2S]::FindWindowEx($combo, [IntPtr]::Zero, 'ComboBox', $null)
$nameBox = [A2S]::FindWindowEx($inner, [IntPtr]::Zero, 'Edit', $null)
if ($nameBox -eq [IntPtr]::Zero) { throw 'file name box not found' }
[void][A2S]::SendMessage($nameBox, 0x000C, [IntPtr]::Zero, (Resolve-Path $Wgt).Path)
Start-Sleep -Milliseconds 400
[void][A2S]::SendMessage([A2S]::GetDlgItem($dlg, 1), 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Seconds 2

$edit = $win.FindFirst('Descendants', (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
$chosen = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
"path in the app: $chosen"
if ($chosen -ne (Resolve-Path $Wgt).Path) { throw 'the app did not take the chosen file' }

$button = $win.FindFirst('Descendants', (New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
  (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Download & Install')))))
$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
'clicked Download & Install'
$last = ''
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  $texts = @($win.FindAll('Descendants', (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text))) |
    ForEach-Object { $_.Current.Name } | Where-Object { $_ -match 'success|installed|fail|error|Error|Failed' })
  $line = $texts -join ' | '
  if ($line -ne $last) { "[$i] $line"; $last = $line }
  if ($line -match 'successfully installed') { break }
  if ($line -match 'ail|rror') { break }
}
Stop-Process -Id $p.Id -ErrorAction SilentlyContinue
