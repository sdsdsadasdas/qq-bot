# user-idle.ps1 -- how long since the user last touched keyboard or mouse.
#
# Why this exists:
#   Auto-polling has to click QQ's conversation list, and that click needs the
#   window in the foreground. Windows refuses to let a background process steal
#   the foreground while the user is active, so polling during typing does not
#   just fail politely -- the cursor jumps away and the keystrokes land in QQ.
#   The bot asks this script "is the user busy?" and skips the round if so.
#
# Output (single JSON line, UTF-8):
#   { "ok": true, "idleMs": 12345 }
#   { "ok": false, "error": "..." }
#
# GetLastInputInfo reports **tick count** (ms since boot) of the last input,
# and tick count wraps at ~49.7 days. Subtracting two tick counts and masking
# with 0xFFFFFFFF handles the wrap; a negative result would otherwise turn into
# "the user has been idle for 49 days" and polling would never pause.
#
# This file stays ASCII-only on purpose: PowerShell 5.1 reads .ps1 as ANSI
# unless there is a BOM, and mojibake at the start of a line gets executed.

param(
  [switch]$Raw
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

function Emit($o) { $o | ConvertTo-Json -Depth 4 -Compress; exit 0 }

$cs = @'
using System;
using System.Runtime.InteropServices;

public class IdleProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }

  [DllImport("user32.dll")]
  static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

  [DllImport("kernel32.dll")]
  static extern uint GetTickCount();

  // Returns milliseconds since the last keyboard/mouse input, or -1 on failure.
  public static long IdleMs() {
    LASTINPUTINFO lii = new LASTINPUTINFO();
    lii.cbSize = (uint)Marshal.SizeOf(lii);
    if (!GetLastInputInfo(ref lii)) return -1;
    uint now = GetTickCount();
    // unchecked wrap-around subtraction, then mask to 32 bits
    long diff = (long)((now - lii.dwTime) & 0xFFFFFFFF);
    return diff;
  }
}
'@

try {
  if (-not ('IdleProbe' -as [type])) {
    Add-Type -TypeDefinition $cs -Language CSharp | Out-Null
  }
  $ms = [IdleProbe]::IdleMs()
  if ($ms -lt 0) { Emit ([ordered]@{ ok = $false; error = 'GetLastInputInfo failed' }) }
  Emit ([ordered]@{ ok = $true; idleMs = [int]$ms })
} catch {
  Emit ([ordered]@{ ok = $false; error = [string]$_.Exception.Message })
}
