#requires -Version 5.1
<#
  qq-send-message.ps1 -- send one chat message to the focused QQ conversation.

  Clean rewrite. Every behaviour here was measured on this machine; the failed
  approaches are documented so they are not retried.

  WHAT WORKS
    - Reading the window through UI Automation, AFTER sending WM_GETOBJECT with
      OBJID_CLIENT. Chromium builds no accessibility tree until a client asks, so
      before activation the window exposes 1 node; afterwards ~340, including the
      message list, sender names, the input box text and the send button.
    - Typing text with per-character KEYEVENTF_UNICODE SendInput. Verified: the text
      appears in the input box and is readable back through UIA.
    - Clearing the input box with End followed by many Backspace down/up pairs.
    - Submitting by clicking the send button found through UIA.

  WHAT DOES NOT WORK (measured -- do not retry)
    - Ctrl+A, Ctrl+V, Ctrl+anything: the Ctrl modifier never reaches QQ's Electron
      input box. Pressing Ctrl down and then A inserts a literal "a". This is why
      the first version of this project posted a bare "v" instead of pasting.
    - Sending Backspace slowly (one SendInput per key with long sleeps): no effect.
    - Setting the input box through UIA ValuePattern: the chat input is not exposed
      as an Edit control at all; only the search box is.

  USAGE
    powershell -File tools/qq-send-message.ps1 -Text "hello"
    add -Submit to actually press send; without it the text is only staged.

  Prints one JSON object on stdout.
  ASCII-only source on purpose: Windows PowerShell 5.1 decodes BOM-less UTF-8 as
  ANSI, which corrupts non-ASCII source text and produces bogus parse errors.
#>
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$ProcessName = 'QQ',
  [long]$Handle = 0,
  [switch]$Submit,
  [switch]$DryRun,
  [switch]$NoClear,
  [switch]$DebugVars,
  [int]$TypeDelayMs = 8,
  [int]$Backspaces = 80
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

$absHere = (Resolve-Path (Split-Path -Parent $PSCommandPath)).Path
function Emit($o) { $o | ConvertTo-Json -Depth 6 -Compress; exit 0 }

# Send button label as an escape, so this source stays ASCII.
$NAME_SEND = [string]([char]0x53D1) + [string]([char]0x9001)

if ($DryRun) {
  Emit ([ordered]@{ ok = $true; dryRun = $true; sent = $false; wouldSend = $Text })
}

$cs = @'
using System;
using System.Runtime.InteropServices;

public class QQInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint n, INPUT[] p, int cb);

  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }

  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;

  static INPUT MakeKey(ushort vk, uint flags) {
    INPUT i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.u.ki.wVk = vk;
    i.u.ki.wScan = 0;
    i.u.ki.dwFlags = flags;
    i.u.ki.time = 0;
    i.u.ki.dwExtraInfo = IntPtr.Zero;
    return i;
  }

  public static uint TapKey(ushort vk) {
    INPUT[] a = new INPUT[2];
    a[0] = MakeKey(vk, 0);
    a[1] = MakeKey(vk, KEYEVENTF_KEYUP);
    return SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }

  public static uint TypeChar(char ch) {
    INPUT[] a = new INPUT[2];
    a[0] = MakeKey(0, KEYEVENTF_UNICODE);
    a[0].u.ki.wScan = (ushort)ch;
    a[1] = a[0];
    a[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    return SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }

  public static int TapKeyMany(ushort vk, int count, int gapMs) {
    int done = 0;
    for (int i = 0; i < count; i++) {
      if (TapKey(vk) == 2) { done++; }
      if (gapMs > 0) { System.Threading.Thread.Sleep(gapMs); }
    }
    return done;
  }

  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(90);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(70);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }

  public static bool ForceForeground(long h) {
    IntPtr t = new IntPtr(h);
    uint tt = GetWindowThreadProcessId(t, IntPtr.Zero);
    uint ct = GetCurrentThreadId();
    bool attached = false;
    if (tt != ct) { attached = AttachThreadInput(ct, tt, true); }
    bool ok = SetForegroundWindow(t);
    if (attached) { AttachThreadInput(ct, tt, false); }
    return ok;
  }

  public static long Foreground() { return GetForegroundWindow().ToInt64(); }
}
'@

try {
  if (-not ('QQInput' -as [type])) { Add-Type -TypeDefinition $cs -Language CSharp -ErrorAction Stop }
} catch {
  $m = $_.Exception.Message
  if ($_.Exception.InnerException) { $m = $m + ' / ' + $_.Exception.InnerException.Message }
  Emit ([ordered]@{ ok = $false; stage = 'compile'; error = $m })
}

# ---------------------------------------------------------------- UIA read ---
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

function Get-UiaJson {
  $raw = & (Join-Path $absHere 'uia-read.ps1') -ProcessName $ProcessName | Out-String
  try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

# Input box content = Text elements to the left of the send button, same row.
#
# WHY the left edge is not simply "send button minus 600" (measured):
#   that constant was tuned on a GROUP chat, where the member list on the right
#   pushes the send button left. In a 1:1 chat there is no member list, so the
#   send button sits ~250px further right -- and the input box starts at the
#   panel's left edge (x=1645), which falls OUTSIDE "sbx - 600" (=1738).
#   Result: the text we had just typed was not found, the script refused to
#   submit ("typed text is not present in the chat input box") and the message
#   was silently never sent. The refusal was correct; the band was wrong.
#   So: when the message-list Pane is available, anchor the band on the panel
#   (same in both layouts). Fall back to the old constant otherwise.
#
# The Chinese pane name is built from char codes because this file must stay
# pure ASCII (PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as GBK and mangles it).
$NAME_MSGLIST = [string]([char]0x6D88) + [string]([char]0x606F) + [string]([char]0x5217) + [string]([char]0x8868)

function Get-PaneLeft($u) {
  if ($null -eq $u) { return 0 }
  if ($null -eq $u.panes) { return 0 }
  foreach ($p in $u.panes) {
    try {
      if ([string]$p.name -eq $NAME_MSGLIST) { return [int]$p.x }
    } catch {}
  }
  return 0
}

function Get-InputText($u) {
  if ($null -eq $u) { return '' }
  if (-not $u.ok) { return '' }
  if ($null -eq $u.sendButton) { return '' }
  $sbx = [int]$u.sendButton.x
  $sby = [int]$u.sendButton.y
  $xMin = $sbx - 600
  $paneLeft = Get-PaneLeft $u
  if ($paneLeft -gt 0 -and ($paneLeft - 20) -lt $xMin) { $xMin = $paneLeft - 20 }
  $parts = @()
  foreach ($t in $u.texts) {
    if ($t.type -ne 'Text') { continue }
    if ([int]$t.x -lt $xMin) { continue }
    if ([int]$t.x -gt $sbx) { continue }
    if ([math]::Abs([int]$t.y - $sby) -gt 200) { continue }
    $parts += [string]$t.name
  }
  return ($parts -join '')
}

$uia = Get-UiaJson
if ($null -eq $uia) { Emit ([ordered]@{ ok = $false; stage = 'uia'; error = 'uia-read returned unparseable output' }) }
if (-not $uia.ok) { Emit ([ordered]@{ ok = $false; stage = 'uia'; error = [string]$uia.error }) }
if ($null -eq $uia.sendButton) { Emit ([ordered]@{ ok = $false; stage = 'uia'; error = 'send button not present in the UIA tree' }) }

if ($Handle -eq 0) { $Handle = [long]$uia.handle }
$sbX = [int]$uia.sendButton.x
$sbY = [int]$uia.sendButton.y
$sbW = [int]$uia.sendButton.w
$sbH = [int]$uia.sendButton.h

# The input box sits roughly up-and-left of the send button.
$boxX = $sbX - 340
$boxY = $sbY - 25

# ------------------------------------------------------------------ focus ---
$fg = $false
for ($i = 1; $i -le 5; $i++) {
  [void][QQInput]::ForceForeground($Handle)
  Start-Sleep -Milliseconds 250
  if ([QQInput]::Foreground() -eq $Handle) { $fg = $true; break }
}
if (-not $fg) {
  Emit ([ordered]@{ ok = $false; stage = 'focus'
                    error = 'could not bring the QQ window to the foreground'
                    foreground = [QQInput]::Foreground(); want = $Handle })
}

[QQInput]::Click($boxX, $boxY)
Start-Sleep -Milliseconds 400

# ------------------------------------------------------------------ clear ---
$before = Get-InputText (Get-UiaJson)
$clearRounds = 0

if ($before -ne '') {
  if ($NoClear) {
    Emit ([ordered]@{ ok = $false; stage = 'clear'; error = 'input box is not empty and -NoClear was given'
                      leftover = $before })
  }
  for ($r = 1; $r -le 3; $r++) {
    $clearRounds = $r
    [void][QQInput]::TapKey(0x23)                     # End
    Start-Sleep -Milliseconds 120
    [void][QQInput]::TapKeyMany(0x08, $Backspaces, 12) # Backspace
    Start-Sleep -Milliseconds 350
    $before = Get-InputText (Get-UiaJson)
    if ($before -eq '') { break }
  }
  if ($before -ne '') {
    Emit ([ordered]@{ ok = $false; stage = 'clear'
                      error = 'could not clear the chat input box; refusing to type'
                      leftover = $before; clearRounds = $clearRounds })
  }
}

# ------------------------------------------------------------------- type ---
$typed = 0
$failAt = -1
for ($i = 0; $i -lt $Text.Length; $i++) {
  $ch = $Text[$i]
  $code = [int]$ch
  if ($code -eq 13 -or $code -eq 10) { continue }
  if ($code -ge 0xD800 -and $code -le 0xDBFF) { continue }
  $n = [QQInput]::TypeChar($ch)
  if ($n -ne 2) { $failAt = $i; break }
  $typed++
  if ($TypeDelayMs -gt 0) { Start-Sleep -Milliseconds $TypeDelayMs }
}
Start-Sleep -Milliseconds 500

if ($failAt -ge 0) {
  Emit ([ordered]@{ ok = $false; stage = 'type'
                    error = ('SendInput did not accept the character at index ' + $failAt)
                    typedChars = $typed })
}

# ----------------------------------------------------------------- verify ---
$after = Get-InputText (Get-UiaJson)
$flatAfter = $after -replace '\s', ''
$probe = $Text -replace '\s', ''
if ($probe.Length -gt 10) { $probe = $probe.Substring(0, 10) }
$ok = ($probe -ne '') -and ($flatAfter.Contains($probe))

if ($DebugVars) {
  $dbg = @()
  $dbg += 'sendButton x=' + $sbX + ' y=' + $sbY + ' w=' + $sbW + ' h=' + $sbH
  $dbg += 'boxClick ' + $boxX + ',' + $boxY
  $dbg += 'beforeClear=[' + $before + '] clearRounds=' + $clearRounds
  $dbg += 'afterType=[' + $after + ']'
  $dbg += 'typed=' + $typed + ' probe=[' + $probe + '] ok=' + $ok
  $dbg | Set-Content -Path (Join-Path $absHere '.qq-send-debug.txt') -Encoding UTF8
}

if (-not $ok) {
  Emit ([ordered]@{ ok = $false; stage = 'verify'
                    error = 'typed text is not present in the chat input box; not submitting'
                    boxClick = ($boxX.ToString() + ',' + $boxY.ToString())
                    typedChars = $typed
                    beforeText = $before
                    afterText = $after })
}

# ---------------------------------------------------------------- submit ----
if (-not $Submit) {
  Emit ([ordered]@{ ok = $true; sent = $false; submitted = $false
                    method = 'uia-read + sendinput-unicode'
                    boxClick = ($boxX.ToString() + ',' + $boxY.ToString())
                    typedChars = $typed; afterText = $after
                    inputClearedBefore = $clearRounds })
}

$cx = [int]($sbX + ($sbW / 2))
$cy = [int]($sbY + ($sbH / 2))
[QQInput]::Click($cx, $cy)
Start-Sleep -Milliseconds 800

# Clear after sending so the next message starts from an empty box.
$post = Get-InputText (Get-UiaJson)
$postCleared = ($post -eq '')
if (-not $postCleared) {
  [void][QQInput]::TapKey(0x23)
  Start-Sleep -Milliseconds 120
  [void][QQInput]::TapKeyMany(0x08, $Backspaces, 12)
  Start-Sleep -Milliseconds 350
  $post = Get-InputText (Get-UiaJson)
  $postCleared = ($post -eq '')
}

Emit ([ordered]@{ ok = $true; sent = $true; submitted = $true
                  method = 'uia-read + sendinput-unicode + send-button-click'
                  boxClick = ($boxX.ToString() + ',' + $boxY.ToString())
                  sendButtonClick = ($cx.ToString() + ',' + $cy.ToString())
                  typedChars = $typed
                  beforeText = $before
                  afterText = $post
                  inputClearedAfter = $postCleared
                  verifiedInBoxBeforeSubmit = $ok })
