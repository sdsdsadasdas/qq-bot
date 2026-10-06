#requires -Version 5.1
<#
  uia-read.ps1 -- read the QQ chat via UI Automation, activating accessibility first.

  Background (measured on this machine):
    Electron/Chromium builds no accessibility tree until a client sends
    WM_GETOBJECT with OBJID_CLIENT. A plain UIA client therefore sees only an
    HWND wrapper -- the first probe of this window returned 9 unnamed Pane
    containers and zero text. After activation the same window exposes ~340
    descendants including every message, sender names, the input box content and
    the send button.

    This was the most important discovery of the project: UIA, correctly
    activated, beats OCR -- exact text, exact positions, no geometry calibration.
    OCR stays only as a fallback.

    So this script always sends the activation message before reading, which makes
    the good result reproducible instead of depending on some earlier tool having
    happened to activate the tree.

  Chinese UI names are written as [char] escapes on purpose: it keeps this source
  pure ASCII, so Windows PowerShell 5.1 cannot mangle it by decoding BOM-less
  UTF-8 as ANSI. That failure mode bit this project repeatedly.

  Output: one JSON object on stdout.
  READ-ONLY: no clicks, no keyboard input.
#>
param(
  [string]$ProcessName = 'QQ',
  [long]$Handle = 0,
  [switch]$AllTypes
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

function Emit($o) { $o | ConvertTo-Json -Depth 6 -Compress; exit 0 }
function Fail($m) { Emit ([ordered]@{ ok = $false; error = [string]$m; texts = @() }) }

# UI strings as escapes, so the source stays ASCII
$NAME_SEARCH = [string]([char]0x641C) + [string]([char]0x7D22)   # search box
$NAME_SEND   = [string]([char]0x53D1) + [string]([char]0x9001)   # send button

$cs = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class UiaAct {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")]
  static extern int GetWindowTextW(IntPtr h, [Out] StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam,
                                          uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);

  delegate bool EnumProc(IntPtr h, IntPtr p);

  const uint WM_GETOBJECT = 0x003D;
  const uint OBJID_CLIENT = 0xFFFFFFFC;
  const uint SMTO_ABORTIFHUNG = 0x0002;
  const uint SMTO_BLOCK = 0x0001;

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public class Row { public uint Pid; public long Handle; public bool Visible; public string Title; public int W; public int H; }

  public static List<Row> ForPids(uint[] pids) {
    var want = new HashSet<uint>(pids);
    var r = new List<Row>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!want.Contains(pid)) return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, t.Capacity);
      RECT rc; GetWindowRect(h, out rc);
      r.Add(new Row { Pid = pid, Handle = h.ToInt64(), Visible = IsWindowVisible(h), Title = t.ToString(),
                      W = rc.Right - rc.Left, H = rc.Bottom - rc.Top });
      return true;
    }, IntPtr.Zero);
    return r;
  }

  // Chromium only builds its accessibility tree after receiving this message.
  public static bool Activate(long handle) {
    IntPtr res;
    try {
      SendMessageTimeout(new IntPtr(handle), WM_GETOBJECT, IntPtr.Zero, new IntPtr(OBJID_CLIENT),
                         SMTO_ABORTIFHUNG | SMTO_BLOCK, 5000, out res);
      return true;
    } catch { return false; }
  }
}
'@

try {
  if (-not ('UiaAct' -as [type])) { Add-Type -TypeDefinition $cs -Language CSharp }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch { Fail ('init failed: ' + $_.Exception.Message) }

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

# ---- pick the target window ------------------------------------------------
$target = $null
if ($Handle -ne 0) {
  try { $target = $AE::FromHandle([IntPtr]$Handle) } catch {}
}
if ($null -eq $target) {
  $procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { Fail "no process $ProcessName" }
  $pidArr = [uint32[]]@($procs | ForEach-Object { [uint32]$_.Id })
  $wins = @([UiaAct]::ForPids($pidArr) | Where-Object { $_.Visible -and $_.W -gt 300 })
  if ($wins.Count -eq 0) { Fail 'no visible QQ window wide enough for a chat UI' }
  $w = $wins | Sort-Object { $_.W * $_.H } -Descending | Select-Object -First 1
  $Handle = [long]$w.Handle
  try { $target = $AE::FromHandle([IntPtr]$Handle) } catch {}
}
if ($null -eq $target) { Fail 'could not obtain an AutomationElement for the QQ window' }

# ---- activate accessibility, then read -------------------------------------
$activated = [UiaAct]::Activate($Handle)
Start-Sleep -Milliseconds 450

$all = $target.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

$texts = New-Object System.Collections.ArrayList
foreach ($e in $all) {
  try {
    $ct = $e.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    $nm = [string]$e.Current.Name
    if ($nm -eq '') { continue }
    $r = $e.Current.BoundingRectangle
    if ([double]::IsNaN($r.X) -or $r.Width -le 0 -or $r.Height -le 0) { continue }
    # Group = avatars. They are NOT decoration here: in a group where QQ draws no
    # LV badge (measured in one real group: not a single one on screen), the avatar
    # is the ONLY anchor for "this row is a sender row, and the sender is <name>".
    # Without it the sender's nickname is parsed as message text ("UserA" + "miss you"
    # glued together), which is the bug the user reported after switching to a small
    # model. So Group is always emitted, even without -AllTypes.
    if (-not $AllTypes -and $ct -ne 'Text' -and $ct -ne 'Button' -and $ct -ne 'Edit' -and $ct -ne 'Group') { continue }
    [void]$texts.Add([pscustomobject]@{
      name = ($nm -replace "`r?`n", ' ')
      type = $ct
      x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
    })
  } catch {}
}

# ---- locate the chat input box and the send button -------------------------
$editBox = $null
$valPat = [System.Windows.Automation.ValuePattern]::Pattern
$editCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit)
$editList = @($target.FindAll($TS::Descendants, $editCond))
foreach ($e in $editList) {
  try {
    $nm = [string]$e.Current.Name
    if ($nm -eq $NAME_SEARCH) { continue }
    $r = $e.Current.BoundingRectangle
    $val = $null
    $hasVal = $false
    try {
      $vp = $e.GetCurrentPattern($valPat)
      if ($null -ne $vp) { $val = [string]$vp.Current.Value; $hasVal = $true }
    } catch {}
    $editBox = [pscustomobject]@{
      name = $nm
      x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
      value = [string]$val
      valuePattern = $hasVal
    }
    break
  } catch {}
}

$sendButton = $null
foreach ($t in $texts) {
  if ($t.type -eq 'Button' -and $t.name -eq $NAME_SEND) { $sendButton = $t; break }
}

# ---- conversation list (for auto-switching between chats) ------------------
#
# Why this exists: the bot used to read only whatever chat happened to be open,
# so covering N conversations meant opening them by hand. To switch
# automatically we need to know *which* conversations exist and *where* they are
# on screen (so they can be clicked).
#
# Shape measured on this machine: a Pane whose Name is the Chinese word for
# "session list" (built below from [char] codes - this file stays ASCII-only).
# Its descendants are Text elements. Each conversation occupies a band of ~80px:
#     y=284 h=22  <conversation name>      <- topmost in the band, h=22
#     y=313 h=19  <last message preview>   <- below it, h=19
# So: cluster the Texts by y, and the name is the TOPMOST element of a cluster.
# Width is NOT a usable discriminator - the preview can be wider than the name
# (measured: name w=91, preview w=105 on the same row).
#
# The list items are Text elements, which usually do not implement
# SelectionItem/Invoke, so switching is done by clicking the centre point.
$NAME_SESSIONS = [string]([char]0x4F1A) + [string]([char]0x8BDD) + [string]([char]0x5217) + [string]([char]0x8868)
$conversations = New-Object System.Collections.ArrayList
try {
  $paneCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $NAME_SESSIONS)
  $pane = $target.FindFirst($TS::Descendants, $paneCond)
  if ($null -ne $pane) {
    $items = New-Object System.Collections.ArrayList
    $kids = $pane.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $kids) {
      try {
        if ($e.Current.ControlType.ProgrammaticName -ne 'ControlType.Text') { continue }
        $nm = [string]$e.Current.Name
        if ($nm -eq '') { continue }
        $br = $e.Current.BoundingRectangle
        if ([double]::IsNaN($br.X) -or $br.Width -le 0 -or $br.Height -le 0) { continue }
        [void]$items.Add([pscustomobject]@{
          name = ($nm -replace "`r?`n", ' ')
          x = [int]$br.X; y = [int]$br.Y; w = [int]$br.Width; h = [int]$br.Height
        })
      } catch {}
    }
    # Cluster by y: a jump of more than 30px means a new conversation.
    $sorted = @($items | Sort-Object y)
    $cluster = New-Object System.Collections.ArrayList
    $lastY = -100000
    foreach ($it in $sorted) {
      if ($cluster.Count -gt 0 -and (($it.y - $lastY) -gt 30)) {
        [void]$conversations.Add($cluster[0])
        $cluster.Clear()
      }
      [void]$cluster.Add($it)
      $lastY = $it.y
    }
    if ($cluster.Count -gt 0) { [void]$conversations.Add($cluster[0]) }
  }
} catch {}

# ---- panes (so a GROUP chat can be told apart from a 1:1 chat) -------------
#
# Why this exists: the two layouts are different, and the difference breaks
# every offset measured from the send button.
#   * a group chat has the member list on the right -> the message column is
#     narrower and the send button sits further LEFT
#   * a 1:1 chat has no member list -> the panel is wider, so the same
#     send-button-relative offsets land ~250px off and no message is found
#     (measured: send button at x=2086 in a group vs x=2338 in a 1:1 chat,
#      same window, same size)
# The chat PANEL is the layout-stable anchor, so emit every Pane with its
# rectangle and let parse-uia.js decide. Unnamed panes are kept on purpose --
# the member list is exactly one of the unnamed ones.
$panes = New-Object System.Collections.ArrayList
foreach ($e in $all) {
  try {
    if ($e.Current.ControlType.ProgrammaticName -ne 'ControlType.Pane') { continue }
    $r = $e.Current.BoundingRectangle
    if ([double]::IsNaN($r.X) -or $r.Width -le 0 -or $r.Height -le 0) { continue }
    [void]$panes.Add([pscustomobject]@{
      name = ([string]$e.Current.Name -replace "`r?`n", ' ')
      x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
    })
  } catch {}
}

Emit ([ordered]@{
  ok = $true
  activated = $activated
  handle = $Handle
  descendantCount = $all.Count
  texts = @($texts)
  editBox = $editBox
  sendButton = $sendButton
  conversations = @($conversations)
  panes = @($panes)
})
