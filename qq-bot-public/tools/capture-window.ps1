#requires -Version 5.1
<#
  capture-window.ps1 -- capture a window to a PNG file using GDI PrintWindow.

  PrintWindow with PW_RENDERFULLCONTENT (flag 2) works for Chromium/Electron
  windows even when they are partially covered, which CopyFromScreen does not
  handle. Falls back to flag 0, then reports failure rather than writing garbage.

  Prints one JSON object on stdout.

  ASCII-only source: Windows PowerShell 5.1 decodes BOM-less UTF-8 as ANSI and
  corrupts non-ASCII source text.
#>
param(
  [string]$ProcessName = 'QQ',
  [long]$Handle = 0,
  [string]$TitleMatch = '',
  [string]$OutImage = '',
  [int]$CropTop = 0,
  [int]$CropBottom = 0,
  [switch]$BringToFront,
  [int]$FocusWaitMs = 300
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

function Emit($o) { $o | ConvertTo-Json -Depth 5 -Compress; exit 0 }
function Fail($m, $stage) { Emit ([ordered]@{ ok = $false; stage = $stage; error = [string]$m; target = $null }) }

$cs = @'
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class Cap {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")]
  static extern int GetWindowTextW(IntPtr h, [Out] StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")]
  static extern int GetClassNameW(IntPtr h, [Out] StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);

  delegate bool EnumProc(IntPtr h, IntPtr p);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public class Row {
    public uint Pid; public long Handle; public bool Visible; public bool Minimized;
    public string Cls; public string Title; public int W; public int H;
  }

  public static List<Row> ForPids(uint[] pids) {
    var want = new HashSet<uint>(pids);
    var r = new List<Row>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!want.Contains(pid)) return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, t.Capacity);
      var c = new StringBuilder(256); GetClassNameW(h, c, c.Capacity);
      RECT rc; GetWindowRect(h, out rc);
      r.Add(new Row {
        Pid = pid, Handle = h.ToInt64(), Visible = IsWindowVisible(h), Minimized = IsIconic(h),
        Cls = c.ToString(), Title = t.ToString(), W = rc.Right - rc.Left, H = rc.Bottom - rc.Top
      });
      return true;
    }, IntPtr.Zero);
    return r;
  }

  public static bool ForceForeground(long h) {
    IntPtr target = new IntPtr(h);
    uint tt = GetWindowThreadProcessId(target, IntPtr.Zero);
    uint ct = GetCurrentThreadId();
    bool attached = false;
    if (tt != ct) { attached = AttachThreadInput(ct, tt, true); }
    if (IsIconic(target)) { ShowWindow(target, 9); }
    bool ok = SetForegroundWindow(target);
    if (attached) { AttachThreadInput(ct, tt, false); }
    return ok;
  }

  public static long Foreground() { return GetForegroundWindow().ToInt64(); }

  public static string Capture(long handle, string path, int cropTop, int cropBottom, out int outW, out int outH, out uint usedFlag) {
    outW = 0; outH = 0; usedFlag = 0;
    IntPtr h = new IntPtr(handle);
    RECT r;
    if (!GetWindowRect(h, out r)) { return "GetWindowRect failed"; }
    int w = r.Right - r.Left;
    int ht = r.Bottom - r.Top;
    if (w <= 0 || ht <= 0) { return "window rect is empty (" + w + "x" + ht + ")"; }

    IntPtr hdcScreen = IntPtr.Zero, hdcMem = IntPtr.Zero, hBmp = IntPtr.Zero, hOld = IntPtr.Zero;
    try {
      hdcScreen = GetDC(IntPtr.Zero);
      if (hdcScreen == IntPtr.Zero) { return "GetDC failed"; }
      hdcMem = CreateCompatibleDC(hdcScreen);
      if (hdcMem == IntPtr.Zero) { return "CreateCompatibleDC failed"; }
      hBmp = CreateCompatibleBitmap(hdcScreen, w, ht);
      if (hBmp == IntPtr.Zero) { return "CreateCompatibleBitmap failed"; }
      hOld = SelectObject(hdcMem, hBmp);

      bool ok = PrintWindow(h, hdcMem, 2);   // PW_RENDERFULLCONTENT
      usedFlag = 2;
      if (!ok) { ok = PrintWindow(h, hdcMem, 0); usedFlag = 0; }
      if (!ok) { return "PrintWindow failed with both flags"; }

      using (Bitmap bmp = Image.FromHbitmap(hBmp)) {
        int top = cropTop < 0 ? 0 : cropTop;
        int bottom = cropBottom < 0 ? 0 : cropBottom;
        if (top + bottom >= ht) { top = 0; bottom = 0; }
        int ch = ht - top - bottom;
        if (ch <= 0) { ch = ht; top = 0; }
        using (Bitmap cropped = new Bitmap(w, ch, PixelFormat.Format32bppArgb)) {
          using (Graphics g = Graphics.FromImage(cropped)) {
            g.DrawImage(bmp, new Rectangle(0, 0, w, ch), new Rectangle(0, top, w, ch), GraphicsUnit.Pixel);
          }
          cropped.Save(path, ImageFormat.Png);
        }
        outW = w; outH = ch;
      }
      return "";
    } catch (Exception e) {
      return "capture threw: " + e.GetType().Name + ": " + e.Message;
    } finally {
      if (hOld != IntPtr.Zero) { SelectObject(hdcMem, hOld); }
      if (hBmp != IntPtr.Zero) { DeleteObject(hBmp); }
      if (hdcMem != IntPtr.Zero) { DeleteDC(hdcMem); }
      if (hdcScreen != IntPtr.Zero) { ReleaseDC(IntPtr.Zero, hdcScreen); }
    }
  }
}
'@

$initErr = ''
try {
  if (-not ('Cap' -as [type])) {
    Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies 'System.Drawing'
  }
} catch { $initErr = $_.Exception.Message }
if ($initErr -ne '') { Fail $initErr 'compile' }

$procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Fail "no process named $ProcessName" 'find' }

$pidArr = [uint32[]]@($procs | ForEach-Object { [uint32]$_.Id })
$wins = @([Cap]::ForPids($pidArr) | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.Pid; handle = [int64]$_.Handle; visible = [bool]$_.Visible
    minimized = [bool]$_.Minimized; cls = [string]$_.Cls; title = [string]$_.Title
    w = [int]$_.W; h = [int]$_.H
  }
})

if ($wins.Count -eq 0) { Fail 'process has no top-level windows' 'find' }

$target = $null
if ($Handle -ne 0) { $target = $wins | Where-Object { $_.handle -eq $Handle } | Select-Object -First 1 }
if ($null -eq $target -and $TitleMatch -ne '') { $target = $wins | Where-Object { $_.title -like ("*" + $TitleMatch + "*") } | Select-Object -First 1 }
if ($null -eq $target) { $target = $wins | Where-Object { $_.visible -and $_.cls -like 'Chrome_Widget*' } | Select-Object -First 1 }
if ($null -eq $target) { $target = $wins | Where-Object { $_.visible } | Select-Object -First 1 }
if ($null -eq $target) { Fail 'no usable window (all hidden or minimized)' 'find' }

if ($OutImage -eq '') {
  $OutImage = Join-Path $env:TEMP ('wincap-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.png')
}

$brought = $false
$fg = 0
if ($BringToFront) {
  $brought = [Cap]::ForceForeground($target.handle)
  Start-Sleep -Milliseconds $FocusWaitMs
  $fg = [Cap]::Foreground()
}

$w = 0; $h = 0; $flag = 0
$err = [Cap]::Capture($target.handle, $OutImage, $CropTop, $CropBottom, [ref]$w, [ref]$h, [ref]$flag)
if ($err -ne '') { Fail $err 'capture' }
if (-not (Test-Path $OutImage)) { Fail 'capture produced no file' 'capture' }

Emit ([ordered]@{
  ok = $true; stage = 'done'; error = ''
  target = $target
  imagePath = $OutImage
  imageW = $w
  imageH = $h
  imageBytes = (Get-Item $OutImage).Length
  printWindowFlag = $flag
  broughtToFront = $brought
  foregroundHandle = $fg
})
