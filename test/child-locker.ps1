# child-locker.ps1 -- 供 d1-lock-ps.ps1 起的真实子进程用
#
# 作用：从 Panel.ps1 加载真实的锁函数，抢同一把锁，持有指定时长后释放。
# 由父测试同时起两个，用来验证跨进程互斥。
#
# 单独成文件（而不是父脚本里的 here-string）的原因：
#   脚本正文里有大量花括号，放进 here-string 再写文件时，
#   PowerShell 5.1 的解析器容易把外层 try 块的花括号配平算错，
#   报 "call depth overflow"。独立文件最稳。

param(
    [string]$TargetPath,
    [string]$PanelPath,
    [int]$HoldMs = 800,
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

function Emit {
    param([string]$Line)
    Write-Output $Line
    if (-not [string]::IsNullOrEmpty($OutFile)) {
        try {
            [System.IO.File]::AppendAllText($OutFile, ($Line + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
        } catch { }
    }
}

function Get-FnSrc {
    param([string]$Src, [string]$Name)
    $pattern = '(?m)^function\s+' + [regex]::Escape($Name) + '\s*\{'
    $m = [regex]::Match($Src, $pattern)
    if (-not $m.Success) { return $null }
    $start = $m.Index
    $i = $Src.IndexOf('{', $start)
    $depth = 0
    for ($p = $i; $p -lt $Src.Length; $p++) {
        $ch = $Src[$p]
        if ($ch -ceq '{') { $depth++ }
        elseif ($ch -ceq '}') {
            $depth--
            if ($depth -eq 0) { return $Src.Substring($start, $p - $start + 1) }
        }
    }
    return $null
}

try {
    Emit ('START PID=' + $PID)

    $src = [System.IO.File]::ReadAllText($PanelPath)

    foreach ($fn in @('Get-LockPath', 'Read-LockInfo', 'Test-LockStale', 'Try-AcquireLockOnce', 'Enter-FileLock', 'Exit-FileLock')) {
        $fs = Get-FnSrc -Src $src -Name $fn
        if ($null -ne $fs) {
            Invoke-Expression ($fs + "`r`n")
        } else {
            Emit ('MISSING_FN=' + $fn)
        }
    }

    foreach ($cn in @('LockTimeoutMs', 'LockStaleMs', 'LockPollMs')) {
        $cm = [regex]::Match($src, '\$script:' + $cn + '\s*=\s*(\d+)')
        if ($cm.Success) {
            Set-Variable -Name $cn -Value ([int]$cm.Groups[1].Value) -Scope Script
        }
    }

    Emit ('LOADED PID=' + $PID)

    $mine = Enter-FileLock -Path $TargetPath -TimeoutMs 4000

    if ($null -eq $mine -or $mine.Failed) {
        $why = if ($null -ne $mine) { $mine.Reason } else { 'null' }
        Emit ('GOT=NO PID=' + $PID + ' REASON=' + $why)
        exit 0
    }

    Emit ('GOT=YES PID=' + $PID + ' AT=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())

    $marker = $TargetPath + '.inside.' + $PID
    try {
        [System.IO.File]::WriteAllText($marker, 'in', (New-Object System.Text.UTF8Encoding($false)))
    } catch { }

    Start-Sleep -Milliseconds $HoldMs

    try { [System.IO.File]::Delete($marker) } catch { }
    $rel = Exit-FileLock -Lock $mine
    Emit ('RELEASED=' + $rel + ' PID=' + $PID)
    exit 0
}
catch {
    Emit ('FATAL=' + $_.Exception.Message)
    exit 1
}
