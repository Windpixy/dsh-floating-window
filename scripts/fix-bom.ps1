# 给 panel 目录下所有 .ps1 补回 UTF-8 BOM
#
# 【为什么需要这个】
#   这几个 .ps1 里有大量中文（注释、界面文字）。
#   PowerShell 5.1 读文件时**没有 BOM 就按系统 ANSI（GBK）解码**，
#   中文变乱码，随后整份脚本解析出错 —— 实测一次能报 33 个语法错误，
#   而且错误信息本身也是乱码，极难定位。
#
#   很多编辑器/工具（包括我自己改文件时）会默默把 BOM 去掉，
#   所以每次改完 panel 下的 .ps1，都应该跑一次这个脚本。
#
# 跑法：powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\fix-bom.ps1
$ErrorActionPreference = 'Stop'

$root  = Split-Path -Parent $PSScriptRoot
$panel = Join-Path $root 'panel'
if (-not (Test-Path $panel)) { $panel = Join-Path $PSScriptRoot 'panel' }

$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$changed = 0
$already = 0

Write-Host "package root: $root"

# 【为什么要扫三个目录，而不是只扫 panel】
#   原来只修 panel/*.ps1。结果踩了两次：
#     1) test/*.ps1 丢 BOM 后崩掉，看起来像"产品坏了"（第二轮"空闲状态高度 0"就是）
#     2) scripts/*.ps1 丢 BOM 后中文乱码
#   凡是 .ps1 就可能丢 BOM，凡是丢了就会坏，所以全部扫。
$dirs = @($panel, (Join-Path $root 'scripts'), (Join-Path $root 'test')) |
    Where-Object { Test-Path $_ } | Select-Object -Unique

foreach ($dir in $dirs) {
    Write-Host "--- $dir ---"
    foreach ($f in Get-ChildItem $dir -Filter *.ps1 -File) {
        $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
        $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
        if ($hasBom) {
            Write-Host ("  already  {0}" -f $f.Name)
            $already++
            continue
        }
        # 内容按「无 BOM 的 UTF-8」解码再带 BOM 写回
        $text = $utf8Bom.GetString($bytes)
        if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
        [System.IO.File]::WriteAllText($f.FullName, $text, $utf8Bom)
        Write-Host ("  FIXED    {0}  ({1} bytes)" -f $f.Name, $bytes.Length)
        $changed++
    }
}

Write-Host ""
if ($changed -eq 0) {
    Write-Host ("ALL OK - {0} 个文件都已有 BOM" -f $already)
}
else {
    Write-Host ("修复了 {0} 个文件（原本没问题的 {1} 个）。请再跑一次 check-panel-syntax.ps1 确认。" -f $changed, $already)
    exit 1
}
