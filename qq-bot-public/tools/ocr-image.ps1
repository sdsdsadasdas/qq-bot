#requires -Version 5.1
<#
  ocr-image.ps1 -- OCR a PNG with the built-in Windows.Media.Ocr engine.

  Implemented in pure PowerShell via WinRT projection. It is NOT done in Add-Type
  C#: the C# compiler used by Windows PowerShell 5.1 has no WinRT reference
  assemblies, so "using Windows.Globalization;" fails to compile there.

  Output: one JSON object on stdout:
    { ok, engine, error, imageW, imageH, lines:[{text,x,y,w,h,words}] }

  Coordinates are in image pixels. For a full-window capture these are also
  window-relative pixels (window rect origin = 0,0).

  ASCII-only source: Windows PowerShell 5.1 decodes BOM-less UTF-8 as ANSI.
#>
param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [string]$Language = 'zh-Hans-CN'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

function Emit($o) { $o | ConvertTo-Json -Depth 6 -Compress; exit 0 }
function Fail($m, $stage) { Emit ([ordered]@{ ok = $false; stage = $stage; error = [string]$m; engine = ''; lines = @() }) }

if (-not (Test-Path $ImagePath)) { Fail "image not found: $ImagePath" 'input' }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
} catch { Fail ("System.Runtime.WindowsRuntime unavailable: " + $_.Exception.Message) 'init' }

# WinRT type projection
try {
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.FileAccessMode, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
} catch { Fail ("WinRT projection failed: " + $_.Exception.Message) 'init' }

# AsTask bridge
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

if ($null -eq $asTaskGeneric) { Fail 'AsTask(IAsyncOperation<T>) not found' 'init' }

function Await($op, $resultType) {
  $m = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $m.Invoke($null, @($op))
  $task.Wait(60000) | Out-Null
  return $task.Result
}

# engine
$engine = $null
try {
  $lang = New-Object Windows.Globalization.Language $Language
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
} catch {}
if ($null -eq $engine) {
  try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch {}
}
if ($null -eq $engine) { Fail 'no OCR engine could be created for the requested language' 'engine' }

$engineLang = ''
try { $engineLang = $engine.RecognizerLanguage.LanguageTag } catch {}

# decode image
$sb = $null
$imgW = 0; $imgH = 0
try {
  $file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $imgW = [int]$decoder.PixelWidth
  $imgH = [int]$decoder.PixelHeight
  $sb    = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
} catch { Fail ("decode failed: " + $_.Exception.Message) 'decode' }

if ($null -eq $sb) { Fail 'decoded SoftwareBitmap is null' 'decode' }

# OCR
$result = $null
try {
  $result = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
} catch { Fail ("recognize failed: " + $_.Exception.Message) 'ocr' }

if ($null -eq $result) { Fail 'OCR returned null result' 'ocr' }

$lines = New-Object System.Collections.ArrayList
foreach ($line in $result.Lines) {
  $words = @($line.Words)
  if ($words.Count -eq 0) { continue }

  $minX = [int]::MaxValue; $minY = [int]::MaxValue
  $maxX = [int]::MinValue; $maxY = [int]::MinValue
  foreach ($wd in $words) {
    $r = $wd.BoundingRect
    $x0 = [int]$r.X; $y0 = [int]$r.Y
    $x1 = [int]($r.X + $r.Width); $y1 = [int]($r.Y + $r.Height)
    if ($x0 -lt $minX) { $minX = $x0 }
    if ($y0 -lt $minY) { $minY = $y0 }
    if ($x1 -gt $maxX) { $maxX = $x1 }
    if ($y1 -gt $maxY) { $maxY = $y1 }
  }

  [void]$lines.Add([pscustomobject]@{
    text  = [string]$line.Text
    x = $minX; y = $minY; w = ($maxX - $minX); h = ($maxY - $minY)
    words = $words.Count
  })
}

Emit ([ordered]@{
  ok = $true; stage = 'done'; error = ''
  engine = $engineLang
  imagePath = $ImagePath
  imageW = $imgW
  imageH = $imgH
  lines = @($lines)
})
