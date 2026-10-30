# check-panel-syntax.ps1 -- Parse the plugin's .ps1 files with the PowerShell 5.1 parser.
#
# Why this exists:
#   The card scripts carry Chinese comments. Windows PowerShell 5.1 needs a UTF-8
#   BOM to read those correctly; without one it reads the file as ANSI, the
#   Chinese turns into garbage, and the script fails to parse. PowerShell 7 reads
#   the same file fine, so a check done with 7 gives false confidence.
#   -> always validate with the 5.1 parser, and always assert the BOM.
#
# Pure ASCII on purpose (see the warning above about encoding).
#
# Usage:  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\check-panel-syntax.ps1

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$panelRoot = Join-Path (Split-Path -Parent $scriptRoot) 'panel'

$files = @(
    'Panel.ps1',
    'PanelVisual.ps1',
    'Settings.ps1'
)

if (-not (Test-Path $panelRoot)) {
    Write-Output ("PANEL DIR MISSING: " + $panelRoot)
    exit 1
}

Write-Output ("panel dir: " + $panelRoot)
Write-Output ("parser   : PowerShell " + $PSVersionTable.PSVersion.ToString())
Write-Output ''

$failed = 0

foreach ($f in $files) {
    $path = Join-Path $panelRoot $f
    if (-not (Test-Path $path)) {
        Write-Output ("MISSING     " + $f)
        $failed++
        continue
    }

    # BOM check: PS 5.1 needs a BOM to read UTF-8 with Chinese comments.
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)

    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)

    if ($errors -and $errors.Count -gt 0) {
        Write-Output ("SYNTAX FAIL " + $f + "  errors=" + $errors.Count)
        foreach ($e in $errors) {
            Write-Output ("            line " + $e.Extent.StartLineNumber + ": " + $e.Message)
        }
        $failed++
        continue
    }

    if (-not $hasBom) {
        Write-Output ("NO BOM      " + $f + "  (PowerShell 5.1 may misread Chinese comments)")
        $failed++
        continue
    }

    Write-Output ("OK          " + $f + "  bytes=" + $bytes.Length)
}

Write-Output ''
if ($failed -eq 0) {
    Write-Output 'ALL PS1 FILES OK'
    exit 0
} else {
    Write-Output ("FAILED: " + $failed)
    exit 1
}
