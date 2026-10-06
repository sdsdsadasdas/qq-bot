#requires -Version 5.1
<#
  brace-balance.ps1 -- report where curly-brace nesting goes wrong in a script.

  Prints each line's brace delta and the running depth, so the first line where
  depth goes negative (or ends non-zero) pinpoints the imbalance.

  Naive scanner on purpose: it ignores braces inside single-quoted strings and
  after a # comment, which is enough for these scripts.
  ASCII-only source.
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$From = 1,
  [int]$To = 0
)

$lines = Get-Content -LiteralPath $Path -Encoding UTF8
if ($To -le 0) { $To = $lines.Count }

$depth = 0
for ($i = 1; $i -le $lines.Count; $i++) {
  $line = $lines[$i - 1]
  $delta = 0
  $inSingle = $false
  for ($j = 0; $j -lt $line.Length; $j++) {
    $ch = $line[$j]
    if ($inSingle) {
      if ($ch -eq "'") { $inSingle = $false }
      continue
    }
    if ($ch -eq "'") { $inSingle = $true; continue }
    if ($ch -eq '#') { break }
    if ($ch -eq '{') { $delta++ }
    elseif ($ch -eq '}') { $delta-- }
  }
  $depth += $delta
  if ($i -ge $From -and $i -le $To) {
    $flag = ''
    if ($depth -lt 0) { $flag = '   <== DEPTH NEGATIVE' }
    elseif ($depth -eq 0) { $flag = '   (depth 0)' }
    $shown = $line
    if ($shown.Length -gt 70) { $shown = $shown.Substring(0, 70) }
    Write-Host ("{0,4}  d={1,3}  depth={2,3}  {3}{4}" -f $i, $delta, $depth, $shown, $flag)
  }
}
Write-Host ""
Write-Host ("final depth = " + $depth)
