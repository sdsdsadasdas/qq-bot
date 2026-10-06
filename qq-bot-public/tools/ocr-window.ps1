#requires -Version 5.1
<#
  ocr-window.ps1 -- capture a window with GDI PrintWindow and OCR it with the
  built-in Windows.Media.Ocr engine.

  Why OCR: QQ NT is Chromium-based and does not expose its web contents through
  UI Automation or MSAA. Verified on this machine -- an activated accessibility
  tree yields only 9 unnamed Pane containers and zero text elements. Pixels are
  the only reliable source.

  Prints one JSON object on stdout:
    { ok, error, target:{...}, lines:[{text,x,y,w,h,words}], engine, imagePath }

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
  [int]$MinConfidence = 0,
  [switch]$NoOcr
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

function Emit($o) { $o | ConvertTo-Json -Depth 6 -Compress; exit 0 }
function Fail($m, $stage) { Emit ([ordered]@{ ok = $false; stage = $stage; error = [string]$m; lines = @(); target = $null }) }

# ---------------------------------------------------------------- native ----
$cs = @'
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

public class WinOcr {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")]
  static extern int GetWindowTextW(IntPtr h, [Out] StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetClassNameW")]
  static extern int GetClassNameW(IntPtr h, [Out] StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr hmon, int dpiType, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  delegate bool EnumProc(IntPtr h, IntPtr p);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public class Row { public uint Pid; public long Handle; public bool Visible; public bool Minimized; public string Cls; public string Title; }
  public class Line { public string Text; public int X; public int Y; public int W; public int H; public int Words; }

  public static List<Row> ForPids(uint[] pids) {
    var want = new HashSet<uint>(pids);
    var r = new List<Row>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!want.Contains(pid)) return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, t.Capacity);
      var c = new StringBuilder(256); GetClassNameW(h, c, c.Capacity);
      r.Add(new Row {
        Pid = pid, Handle = h.ToInt64(), Visible = IsWindowVisible(h),
        Minimized = IsIconic(h), Cls = c.ToString(), Title = t.ToString()
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

  public static string CaptureToFile(long handle, string path, int cropTop, int cropBottom, out int outW, out int outH) {
    outW = 0; outH = 0;
    IntPtr h = new IntPtr(handle);
    RECT r;
    if (!GetWindowRect(h, out r)) { return "GetWindowRect failed"; }
    int w = r.Right - r.Left;
    int ht = r.Bottom - r.Top;
    if (w <= 0 || ht <= 0) { return "window rect is empty"; }

    IntPtr hdcScreen = IntPtr.Zero;
    IntPtr hdcMem = IntPtr.Zero;
    IntPtr hBmp = IntPtr.Zero;
    IntPtr hOld = IntPtr.Zero;
    try {
      hdcScreen = GetDC(IntPtr.Zero);
      hdcMem = CreateCompatibleDC(hdcScreen);
      hBmp = CreateCompatibleBitmap(hdcScreen, w, ht);
      hOld = SelectObject(hdcMem, hBmp);

      bool ok = PrintWindow(h, hdcMem, 2); // PW_RENDERFULLCONTENT
      if (!ok) { ok = PrintWindow(h, hdcMem, 0); }
      if (!ok) { return "PrintWindow failed"; }

      using (Bitmap bmp = Image.FromHbitmap(hBmp)) {
        int top = cropTop < 0 ? 0 : cropTop;
        int bottom = cropBottom < 0 ? 0 : cropBottom;
        int ch = ht - top - bottom;
        if (ch <= 0) { ch = ht; top = 0; }
        using (Bitmap cropped = new Bitmap(w, ch)) {
          using (Graphics g = Graphics.FromImage(cropped)) {
            g.DrawImage(bmp, new Rectangle(0, 0, w, ch), new Rectangle(0, top, w, ch), GraphicsUnit.Pixel);
          }
          cropped.Save(path, ImageFormat.Png);
          outW = w; outH = ch;
        }
      }
      return "";
    } catch (Exception e) {
      return "capture threw: " + e.Message;
    } finally {
      if (hOld != IntPtr.Zero) { SelectObject(hdcMem, hOld); }
      if (hBmp != IntPtr.Zero) { DeleteObject(hBmp); }
      if (hdcMem != IntPtr.Zero) { DeleteDC(hdcMem); }
      if (hdcScreen != IntPtr.Zero) { ReleaseDC(IntPtr.Zero, hdcScreen); }
    }
  }

  public static List<Line> OcrFile(string path, out string err, out string engineLang) {
    err = ""; engineLang = "";
    var list = new List<Line>();
    try {
      var engine = OcrEngine.TryCreateFromLanguage(new Language("zh-Hans-CN"));
      if (engine == null) { engine = OcrEngine.TryCreateFromUserProfileLanguages(); }
      if (engine == null) { err = "no OCR engine available"; return list; }
      engineLang = engine.RecognizerLanguage.LanguageTag;

      var file = null as Windows.Storage.StorageFile;
      var t1 = Windows.Storage.StorageFile.GetFileFromPathAsync(path).AsTask();
      t1.Wait();
      file = t1.Result;

      var t2 = file.OpenAsync(Windows.Storage.FileAccessMode.Read).AsTask();
      t2.Wait();
      var stream = t2.Result;

      var t3 = BitmapDecoder.CreateAsync(stream).AsTask();
      t3.Wait();
      var decoder = t3.Result;

      var t4 = decoder.GetSoftwareBitmapAsync().AsTask();
      t4.Wait();
      var sb = t4.Result;

      var t5 = engine.RecognizeAsync(sb).AsTask();
      t5.Wait();
      var result = t5.Result;

      foreach (var line in result.Lines) {
        var words = new List<OcrWord>();
        foreach (var wd in line.Words) { words.Add(wd); }
        if (words.Count == 0) { continue; }

        int minX = int.MaxValue, minY = int.MaxValue, maxX = int.MinValue, maxY = int.MinValue;
        foreach (var wd in words) {
          var rr = wd.BoundingRect;
          int x0 = (int)rr.X, y0 = (int)rr.Y;
          int x1 = (int)(rr.X + rr.Width), y1 = (int)(rr.Y + rr.Height);
          if (x0 < minX) minX = x0;
          if (y0 < minY) minY = y0;
          if (x1 > maxX) maxX = x1;
          if (y1 > maxY) maxY = y1;
        }
        list.Add(new Line {
          Text = line.Text, X = minX, Y = minY,
          W = maxX - minX, H = maxY - minY, Words = words.Count
        });
      }
      return list;
    } catch (Exception e) {
      err = e.GetType().Name + ": " + e.Message + (e.InnerException != null ? " / " + e.InnerException.Message : "");
      return list;
    }
  }

  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
}
'@

$initErr = ''
try {
  if (-not ('WinOcr' -as [type])) {
    Add-Type -TypeDefinition $cs -Language CSharp -ReferencedAssemblies 'System.Drawing', 'System.Runtime.WindowsRuntime'
  }
} catch { $initErr = $_.Exception.Message }

if ($initErr -ne '') { Fail $initErr 'compile' }

$procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Fail "no process named $ProcessName" 'find' }

$pidArr = [uint32[]]@($procs | ForEach-Object { [uint32]$_.Id })
$wins = @([WinOcr]::ForPids($pidArr) | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.Pid; handle = [int64]$_.Handle; visible = [bool]$_.Visible
    minimized = [bool]$_.Minimized; cls = [string]$_.Cls; title = [string]$_.Title
  }
})

if ($wins.Count -eq 0) { Fail 'process has no top-level windows' 'find' }

$target = $null
if ($Handle -ne 0) { $target = $wins | Where-Object { $_.handle -eq $Handle } | Select-Object -First 1 }
if ($null -eq $target -and $TitleMatch -ne '') { $target = $wins | Where-Object { $_.title -like ("*" + $TitleMatch + "*") } | Select-Object -First 1 }
if ($null -eq $target) { $target = $wins | Where-Object { $_.visible -and $_.cls -like 'Chrome_Widget*' } | Select-Object -First 1 }
if ($null -eq $target) { $target = $wins | Where-Object { $_.visible } | Select-Object -First 1 }
if ($null -eq $target) { Fail 'no usable window (all hidden or minimized)' 'find' }

$rect = New-Object WinOcr+RECT
$rectOk = $false

# capture
if ($OutImage -eq '') {
  $OutImage = Join-Path $env:TEMP ('qq-ocr-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.png')
}

$w = 0; $h = 0
$capErr = [WinOcr]::CaptureToFile($target.handle, $OutImage, $CropTop, $CropBottom, [ref]$w, [ref]$h)
if ($capErr -ne '') { Fail $capErr 'capture' }

if (-not (Test-Path $OutImage)) { Fail 'capture produced no file' 'capture' }
$imgLen = (Get-Item $OutImage).Length

$out = [ordered]@{
  ok        = $true
  stage     = 'capture'
  error     = ''
  engine    = ''
  target    = $target
  imagePath = $OutImage
  imageW    = $w
  imageH    = $h
  imageBytes = $imgLen
  lines     = @()
}

if ($NoOcr) { Emit $out }

$ocrErr = ''
$lang = ''
$lines = [WinOcr]::OcrFile($OutImage, [ref]$ocrErr, [ref]$lang)

if ($ocrErr -ne '') { Fail $ocrErr 'ocr' }

$out.stage = 'done'
$out.engine = $lang
$out.lines = @($lines | ForEach-Object {
  [pscustomobject]@{ text = $_.Text; x = $_.X; y = $_.Y; w = $_.W; h = $_.H; words = $_.Words }
})
Emit $out
