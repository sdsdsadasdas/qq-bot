#requires -Version 5.1
<#
  list-windows.ps1 -- list top-level windows (visible by default) with owner process.
  ASCII-only source: Windows PowerShell 5.1 mis-decodes BOM-less UTF-8.
#>
param(
  [switch]$All,
  [string]$Filter = ''
)

$ErrorActionPreference = 'Stop'

$q = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinLister {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  public static List<string> All() {
    var r = new List<string>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      r.Add(pid + "|" + h.ToInt64() + "|" + (IsWindowVisible(h) ? "vis" : "hid") + "|" +
            (IsIconic(h) ? "min" : "norm") + "|" + c.ToString() + "|" + t.ToString());
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
'@

if (-not ('WinLister' -as [type])) {
  Add-Type -TypeDefinition $q -Language CSharp
}

$rows = foreach ($line in [WinLister]::All()) {
  $parts = $line -split '\|', 6
  $procId = [int]$parts[0]
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  [pscustomobject]@{
    Pid     = $procId
    Process = if ($p) { $p.ProcessName } else { '?' }
    State   = $parts[2]
    Min     = $parts[3]
    Class   = $parts[4]
    Title   = $parts[5]
    Handle  = $parts[1]
  }
}

if (-not $All) { $rows = $rows | Where-Object { $_.State -eq 'vis' } }
if ($Filter -ne '') {
  $rows = $rows | Where-Object { $_.Title -match $Filter -or $_.Process -match $Filter }
}

$rows | Sort-Object Process, Pid |
  Format-Table Pid, Process, State, Min, Class, Title -AutoSize |
  Out-String -Width 400
