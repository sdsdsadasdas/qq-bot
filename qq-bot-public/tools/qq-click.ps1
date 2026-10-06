#requires -Version 5.1
<#
  qq-click.ps1 -- move the real mouse to a point and click.

  Why this and not the UIA Invoke/SelectionItem patterns: the conversation-list
  items are plain Text elements (measured), and Text almost never implements
  those patterns. So switching chats has to go through a real click.

  Consequences worth knowing before you use it:
    * it MOVES THE USER'S CURSOR. With -Restore the original position is put
      back right after the click, which keeps the cursor from being left on the
      conversation list - but focus still moves to the QQ window.
    * it clicks whatever is at that point. Coordinates come from UIA reading,
      so they are as fresh as the last read; a window that moved in between
      means clicking the wrong thing. Callers should re-read right before.

  IMPORTANT: ASCII-only and no BOM. Windows PowerShell 5.1 decodes a BOM-less
  file as ANSI (GBK here), so any Chinese text above turns into mojibake and
  mojibake at the start of a line gets executed as a command. Measured twice.

  Output: one JSON object on stdout.
#>
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [switch]$Restore,
  [int]$DelayMs = 40,
  # Window to bring to the foreground before clicking (0 = do not touch focus).
  #
  # Why this is needed: clicking on a window that is NOT in the foreground only
  # ACTIVATES it on Windows - the click does not reach the control underneath.
  # Measured: the click landed exactly on the conversation-list row (verified by
  # reading the cursor back), QQ came to the front, and the chat never switched.
  # Activating first makes the same click work.
  [long]$ForegroundHandle = 0
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class Mouse {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP   = 0x0004;

  public static int[] GetPos() {
    POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y };
  }

  public static bool Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(30);
    mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
    return true;
  }
}
"@

# VERY IMPORTANT: become DPI-aware *before* touching coordinates.
#
# UIA reports PHYSICAL pixels. A process that is not DPI-aware lives in a
# virtualised coordinate space, so SetCursorPos(physicalX, physicalY) lands
# somewhere else entirely - the click reports success, the cursor really does
# move, and nothing happens, because it clicked the wrong place.
#
# Measured: without this call the conversation list click silently did nothing
# (the chat never switched) while the script still returned ok:true.
[void][Mouse]::SetProcessDPIAware()

function Emit($o) { $o | ConvertTo-Json -Depth 6 -Compress }

try {
  $before = [Mouse]::GetPos()

  # Bring the target window forward first, otherwise the click below is consumed
  # by the activation and never reaches the list item (measured).
  $activated = $false
  if ($ForegroundHandle -ne 0) {
    try {
      [void][Mouse]::ShowWindow([IntPtr]$ForegroundHandle, 9)   # SW_RESTORE
      [void][Mouse]::SetForegroundWindow([IntPtr]$ForegroundHandle)
      Start-Sleep -Milliseconds 220
      $activated = ([Mouse]::GetForegroundWindow() -eq [IntPtr]$ForegroundHandle)
    } catch {}
  }

  [Mouse]::Click($X, $Y)
  Start-Sleep -Milliseconds $DelayMs

  # Read the cursor back and report HOW FAR OFF it landed. This check is what
  # caught the DPI bug above (a virtualized process landed hundreds of px away).
  #
  # Why a distance and not a yes/no: the read-back is occasionally off by a few
  # pixels even when the click is perfect (measured 452 vs 455, 1503 vs 1499 -
  # most likely pointer acceleration or another process nudging the cursor
  # between SetCursorPos and GetCursorPos). Treating any difference as failure
  # made a working switch look broken. So this script now just measures, and
  # src/switch.js decides what counts as acceptable.
  $landed = [Mouse]::GetPos()
  $drift = [Math]::Max([Math]::Abs($landed[0] - $X), [Math]::Abs($landed[1] - $Y))

  $after = $before
  $restored = $false
  if ($Restore) {
    [void][Mouse]::SetCursorPos($before[0], $before[1])
    Start-Sleep -Milliseconds $DelayMs
    $after = [Mouse]::GetPos()
    $restored = ($after[0] -eq $before[0] -and $after[1] -eq $before[1])
  }

  # ok = "the click was issued without throwing". Whether it worked is decided
  # by reading the UI afterwards (src/switch.js), because a click can land
  # perfectly and still not switch the chat (that was the foreground bug).
  Emit ([ordered]@{
    ok = $true
    clicked = @{ x = $X; y = $Y }
    landed = @{ x = $landed[0]; y = $landed[1] }
    drift = $drift
    hint = $(if ($drift -gt 4) { "cursor landed $drift px away from the requested point" } else { '' })
    cursorBefore = @{ x = $before[0]; y = $before[1] }
    cursorAfter = @{ x = $after[0]; y = $after[1] }
    restored = $restored
    activated = $activated
  })
} catch {
  Emit ([ordered]@{ ok = $false; error = $_.Exception.Message })
  exit 1
}
