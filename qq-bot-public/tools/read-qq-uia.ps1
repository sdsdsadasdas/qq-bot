#requires -Version 5.1
<#
  read-qq-uia.ps1 -- dump text elements of a QQ window via UI Automation.
  READ-ONLY: no clicks, no keyboard input, no injection.

  Uses EnumWindows instead of Process.MainWindowHandle, because MainWindowHandle
  is 0 for hidden windows and QQ keeps its Electron shells hidden when the main
  panel is not on screen.

  Output: one JSON object on stdout:
    { ok, error, windows:[{pid,handle,title,cls,visible}],
      target:{...}, nodes:[{t,n,x,y,w,h}], count, truncated }

  ASCII-only source: Windows PowerShell 5.1 decodes BOM-less UTF-8 as ANSI and
  corrupts non-ASCII source text.
#>
param(
  [string]$ProcessName = 'QQ',
  [string]$TitleMatch = '',
  [int]$MaxDepth = 30,
  [int]$MaxNodes = 4000,
  [int]$MinWidth = 8,
  [int]$MinHeight = 8
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

function Fail($msg) {
  $o = [ordered]@{ ok = $false; error = [string]$msg; windows = @(); target = $null; nodes = @(); count = 0; truncated = $false }
  $o | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

# ---- native window enumeration --------------------------------------------
$cs = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class UiaWinEnum {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")]
  static extern int GetWindowTextW(IntPtr h, [Out] StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")]
  static extern int GetClassNameW(IntPtr h, [Out] StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  public class Row {
    public uint Pid; public long Handle; public bool Visible; public string Cls; public string Title;
  }
  public static List<Row> ForPids(uint[] pids) {
    var want = new HashSet<uint>(pids);
    var r = new List<Row>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!want.Contains(pid)) return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, t.Capacity);
      var c = new StringBuilder(256); GetClassNameW(h, c, c.Capacity);
      r.Add(new Row { Pid = pid, Handle = h.ToInt64(), Visible = IsWindowVisible(h), Cls = c.ToString(), Title = t.ToString() });
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
'@

try {
  if (-not ('UiaWinEnum' -as [type])) { Add-Type -TypeDefinition $cs -Language CSharp }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  Fail ("init failed: " + $_.Exception.Message)
}

$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$Cond = [System.Windows.Automation.Condition]::TrueCondition

$procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Fail "no process named $ProcessName" }

$pidArr = [uint32[]]@($procs | ForEach-Object { [uint32]$_.Id })
$raw = [UiaWinEnum]::ForPids($pidArr)

$wins = @()
foreach ($r in $raw) {
  $wins += [pscustomobject]@{
    pid     = [int]$r.Pid
    handle  = [int64]$r.Handle
    title   = [string]$r.Title
    cls     = [string]$r.Cls
    visible = [bool]$r.Visible
  }
}

if ($wins.Count -eq 0) { Fail 'no top-level windows found for the process' }

# ---- pick the best candidate ----------------------------------------------
# Prefer: visible > Chrome_WidgetWin (QQ NT render shell) > non-empty title.
$scored = foreach ($w in $wins) {
  $s = 0
  if ($w.visible) { $s += 100 }
  if ($w.cls -like 'Chrome_Widget*') { $s += 20 }
  if ($w.title -ne '') { $s += 5 }
  if ($w.cls -match 'IME|MSCTF|NotifyIcon|PowerMessage|Dummy') { $s -= 200 }
  [pscustomobject]@{ score = $s; win = $w }
}
$ordered = @($scored | Sort-Object -Property score -Descending)

$target = $null
if ($TitleMatch -ne '') {
  foreach ($s in $ordered) {
    if ($s.win.title -like ("*" + $TitleMatch + "*")) { $target = $s.win; break }
  }
}
if ($null -eq $target) { $target = $ordered[0].win }

# ---- walk the UIA tree -----------------------------------------------------
$script:nodes = New-Object System.Collections.ArrayList
$script:count = 0
$script:truncated = $false

function Walk($el, $depth) {
  if ($script:count -ge $MaxNodes) { $script:truncated = $true; return }
  $script:count++

  $type = ''
  try { $type = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '' } catch {}
  $name = ''
  try { $name = $el.Current.Name } catch {}
  if ($null -eq $name) { $name = '' }
  $name = ([string]$name) -replace "`r?`n", ' '
  if ($name.Length -gt 300) { $name = $name.Substring(0, 300) }

  $x = 0; $y = 0; $w = 0; $h = 0
  $off = $false
  try {
    $r = $el.Current.BoundingRectangle
    if (-not [double]::IsNaN($r.X)) {
      $x = [int]$r.X; $y = [int]$r.Y; $w = [int]$r.Width; $h = [int]$r.Height
    }
    $off = [bool]$el.Current.IsOffscreen
  } catch {}

  if ($name -ne '' -and -not $off -and $w -ge $MinWidth -and $h -ge $MinHeight) {
    [void]$script:nodes.Add([pscustomobject]@{ t = $type; n = $name; x = $x; y = $y; w = $w; h = $h })
  }

  if ($depth -ge $MaxDepth) { return }

  $kids = $null
  try { $kids = $el.FindAll($Scope.Children, $Cond) } catch { return }
  foreach ($k in $kids) {
    if ($script:count -ge $MaxNodes) { $script:truncated = $true; break }
    Walk $k ($depth + 1)
  }
}

$root = $null
try { $root = $AE::FromHandle([IntPtr]$target.handle) } catch {
  Fail ("FromHandle failed: " + $_.Exception.Message)
}
if ($null -eq $root) { Fail 'no AutomationElement for the target window' }

Walk $root 0

$out = [ordered]@{
  ok        = $true
  error     = ''
  windows   = @($wins)
  target    = $target
  nodes     = @($script:nodes)
  count     = $script:count
  truncated = $script:truncated
}
$out | ConvertTo-Json -Depth 6 -Compress
