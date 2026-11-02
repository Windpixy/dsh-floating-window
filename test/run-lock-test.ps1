 run-lock-test.ps1 -- 极简双进程互斥验证（替代复杂的 d1-lock-ps.ps1）
#
# 【为什么重写】
#   d1-lock-ps.ps1 在 PowerShell 5.1 下反复报 "call depth overflow"。
#   原因不在被测代码，而在测试脚本自身：
#     · 用 Invoke-Expression 动态加载了大量函数
#     · 外层 try/finally + 内层大量函数调用
#     · PowerShell 5.1 的调用深度计数在这种结构下会累积
#
#   本脚本刻意保持**极简**：不用 try/finally 包大段代码，
#   不动态加载函数（改由子进程自己加载），只做"起两个进程 + 看结果"。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$panelFile = Join-Path $root 'panel\Panel.ps1'
$childScript = Join-Path $root 'test\child-locker.ps1'

$passed = 0
$failed = 0

function Check {
    param([string]$Name, [bool]$Cond, [string]$Detail = '')
    if ($Cond) { Write-Output ("  OK   " + $Name); $script:passed++ }
    else { Write-Output ("  FAIL " + $Name + $(if ($Detail) { "   [" + $Detail + "]" } else { '' })); $script:failed++ }
}

Write-Output ('=' * 66)
Write-Output '真实双进程锁互斥验证'
Write-Output ('=' * 66)

$tmpRoot = Join-Path $env:TEMP ('dsh-lockrun-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null
$target = Join-Path $tmpRoot 'settings.json'
[System.IO.File]::WriteAllText($target, '{"width":320}', (New-Object System.Text.UTF8Encoding($false)))

$out1 = Join-Path $tmpRoot 'out1.txt'
$out2 = Join-Path $tmpRoot 'out2.txt'

$q = { param($s) return '"' + $s + '"' }

$args1 = @('-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', (& $q $childScript),
    '-TargetPath', (& $q $target),
    '-PanelPath', (& $q $panelFile),
    '-HoldMs', '700',
    '-OutFile', (& $q $out1))

$args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', (& $q $childScript),
    '-TargetPath', (& $q $target),
    '-PanelPath', (& $q $panelFile),
    '-HoldMs', '700',
    '-OutFile', (& $q $out2))

Write-Output ''
Write-Output '启动两个真实 PowerShell 进程抢同一把锁（每个持有 700ms）...'

$p1 = Start-Process powershell.exe -ArgumentList $args1 -PassThru -WindowStyle Hidden
$p2 = Start-Process powershell.exe -ArgumentList $args2 -PassThru -WindowStyle Hidden

[void]$p1.WaitForExit(30000)
[void]$p2.WaitForExit(30000)

$text1 = if (Test-Path $out1) { [System.IO.File]::ReadAllText($out1) } else { '' }
$text2 = if (Test-Path $out2) { [System.IO.File]::ReadAllText($out2) } else { '' }

Write-Output ''
Write-Output '进程1 输出:'
Write-Output ('  ' + (($text1 -replace "`r`n", ' / ').Trim()))
Write-Output '进程2 输出:'
Write-Output ('  ' + (($text2 -replace "`r`n", ' / ').Trim()))
Write-Output ''

$got1 = $text1 -match 'GOT=YES'
$got2 = $text2 -match 'GOT=YES'

Check '进程1 成功获取锁' $got1
Check '进程2 成功获取锁' $got2
Check '两个进程都成功释放' (($text1 -match 'RELEASED=True') -and ($text2 -match 'RELEASED=True'))
Check '没有致命错误' (($text1 -notmatch 'FATAL') -and ($text2 -notmatch 'FATAL') -and ($text1 -notmatch 'MISSING_FN') -and ($text2 -notmatch 'MISSING_FN'))
Check '最终没有锁文件残留' (-not (Test-Path ($target + '.lock')))

# 【核心断言】两次进入必须错开 >= 500ms
$atMatches = [regex]::Matches(($text1 + "`r`n" + $text2), 'AT=(\d+)')
if ($atMatches.Count -eq 2) {
    $t1 = [long]$atMatches[0].Groups[1].Value
    $t2 = [long]$atMatches[1].Groups[1].Value
    $gap = [Math]::Abs($t1 - $t2)
    Write-Output ("两次进入相隔: ${gap}ms（互斥成立应 >= 650ms 左右）")
    Check '【核心】两次进入明显错开（证明确实互斥）' ($gap -ge 500) "相隔 ${gap}ms"
}
else {
    Check '【核心】两次进入明显错开' $false "只抓到 $($atMatches.Count) 个时间戳"
}

Write-Output ''
Write-Output '--- 检查同时进入的证据（marker 文件）---'
$markers = @(Get-ChildItem $tmpRoot -Filter '*.inside.*' -ErrorAction SilentlyContinue)
Check '没有残留的"我在里面"标记' ($markers.Count -eq 0) "$($markers.Count) 个"

Remove-Item $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue

Write-Output ''
Write-Output ('=' * 66)
Write-Output ('通过 ' + $script:passed + '   失败 ' + $script:failed)
if ($script:failed -eq 0) { Write-Output '全部通过'; exit 0 }
else { Write-Output '有失败项'; exit 1 }
