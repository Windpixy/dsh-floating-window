# verify-single-instance-real.ps1 -- 真实双进程验证：第二张卡必须自己退出
#
# 【为什么要单独写这个，而不是只跑 node 测试】
#   node 那边的测试是"抠出函数、造半截文件、看返回值" —— 证明了**判断逻辑**对。
#   但还有两件事是它证明不了的：
#     ① 真实启动 Panel.ps1 时，那个 if 真的会被执行到（不是被前面的代码挡住）
#     ② 第二个进程真的会 exit 0，而不是继续跑完初始化、把窗口显示出来
#   这两件只有"真的起两个 PowerShell 进程"才能确认。
#
# 【为什么用隔离数据目录】
#   绝不能碰用户真实的 %USERPROFILE%\.dsh\desktop-card\。
#   这里用 %TEMP% 下的独立目录，通过 DSH_CARD_DATA_DIR 环境变量指过去。
#   Panel.ps1 第 30 行左右就是读这个变量决定 $DataDir 的。
#
# 【注意：本脚本会短暂起两个真实的 WPF 卡片窗口】
#   用的是隔离数据目录，不会影响用户正在用的卡片。
#   第二个进程应该在窗口出现之前就 exit 0，所以理论上只闪一下。
#
# 跑法：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\verify-single-instance-real.ps1

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot   = Split-Path -Parent $scriptRoot
$panelFile  = Join-Path $repoRoot 'panel\Panel.ps1'

$passed = 0
$failed = 0

function Check {
    param([string]$Name, [bool]$Cond, [string]$Detail = '')
    if ($Cond) {
        Write-Output ("  OK   " + $Name)
        $script:passed++
    }
    else {
        Write-Output ("  FAIL " + $Name + $(if ($Detail) { "   [" + $Detail + "]" } else { '' }))
        $script:failed++
    }
}

Write-Output ('=' * 66)
Write-Output '真实双进程单实例验证'
Write-Output ('=' * 66)

if (-not (Test-Path $panelFile)) {
    Write-Output ("MISSING panel/Panel.ps1: " + $panelFile)
    exit 1
}

# ---------------------------------------------------------------- 隔离目录
$iso = Join-Path $env:TEMP ('dsh-si-real-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $iso -Force | Out-Null

Write-Output ''
Write-Output ("隔离数据目录: " + $iso)
Write-Output ''

$p1 = $null
$p2 = $null

try {
    # ================================================================
    # 场景 1：先起第一个（它应该正常跑起来并写心跳）
    # ================================================================
    Write-Output '--- 1. 起第一个卡片（应正常启动） ---'

    $env:DSH_CARD_DATA_DIR = $iso
    $p1 = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $panelFile + '"')) `
        -PassThru -WindowStyle Hidden

    Write-Output ("   第一个 pid=" + $p1.Id + "，等它写心跳…")

    # 等心跳出现（最多 15 秒）
    $hbPath = Join-Path $iso 'heartbeat.json'
    $waited = 0
    while ($waited -lt 15000) {
        if (Test-Path $hbPath) {
            try {
                $h = Get-Content $hbPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($h.alive -eq $true) { break }
            } catch { }
        }
        [System.Threading.Thread]::Sleep(300)
        $waited += 300
    }

    $hbOk = $false
    if (Test-Path $hbPath) {
        try {
            $h = Get-Content $hbPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $hbOk = ($h.alive -eq $true)
            Check '第一个卡片写出了有效心跳' $hbOk ("pid=" + $h.pid)
            Check '心跳里的 pid 就是第一个进程' ([long]$h.pid -eq [long]$p1.Id) ("心跳 " + $h.pid + " vs 实际 " + $p1.Id)
        } catch {
            Check '第一个卡片写出了有效心跳' $false ("解析失败: " + $_.Exception.Message)
        }
    } else {
        Check '第一个卡片写出了有效心跳' $false '15 秒内没有心跳文件'
    }

    # ================================================================
    # 场景 2：立刻起第二个（它必须自己退出，且很快）
    # ================================================================
    Write-Output ''
    Write-Output '--- 2. 立刻起第二个（必须自己安静退出） ---'

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $p2 = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $panelFile + '"')) `
        -PassThru -WindowStyle Hidden

    Write-Output ("   第二个 pid=" + $p2.Id)

    # 等它退出（最多 20 秒）
    $exited = $p2.WaitForExit(20000)
    $sw.Stop()
    $elapsed = [int]$sw.Elapsed.TotalMilliseconds

    Check '【关键】第二个卡片自己退出了（没有叠出第二张卡）' $exited ("等待 " + $elapsed + "ms")

    if ($exited) {
        Check '第二个卡片退出码是 0（安静退出，不是崩溃）' ($p2.ExitCode -eq 0) ("ExitCode=" + $p2.ExitCode)
        # 【为什么设 8 秒这个线】
        #   正常退出路径 = 读心跳 + 判断 + exit，几十毫秒就该完。
        #   如果它跑了很久才退出，说明它先做了一大堆初始化（建窗口、起定时器）
        #   才走到单实例判断 —— 那时候用户已经看到第二张卡闪了一下。
        Check '【关键】退出很快（<8 秒，说明窗口没建出来就退了）' ($elapsed -lt 8000) ($elapsed.ToString() + 'ms')
    }

    # ================================================================
    # 场景 3：第一个还在跑、心跳还在更新
    # ================================================================
    Write-Output ''
    Write-Output '--- 3. 第一个没被影响（心跳仍在更新） ---'

    $alive1 = -not $p1.HasExited
    Check '第一个卡片仍在运行' $alive1

    if ($alive1) {
        $before = $null
        try { $before = (Get-Content $hbPath -Raw -Encoding UTF8 | ConvertFrom-Json).updatedAtMs } catch { }
        [System.Threading.Thread]::Sleep(2500)
        $after = $null
        try { $after = (Get-Content $hbPath -Raw -Encoding UTF8 | ConvertFrom-Json).updatedAtMs } catch { }
        Check '【关键】第一个卡片的心跳还在更新（没被第二个搞乱）' `
            ($null -ne $before -and $null -ne $after -and $after -gt $before) `
            ("before=" + $before + " after=" + $after)
    }

    # ================================================================
    # 场景 4：心跳里只有一个 pid（证明没有两个进程在轮流写）
    # ================================================================
    Write-Output ''
    Write-Output '--- 4. 心跳里只出现一个 pid（不再轮流覆盖） ---'

    $seen = @{}
    for ($i = 0; $i -lt 10; $i++) {
        try {
            $hh = Get-Content $hbPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $seen[[string]$hh.pid] = $true
        } catch { }
        [System.Threading.Thread]::Sleep(300)
    }
    Check '【关键】心跳里始终是同一个 pid（没有多进程争抢）' ($seen.Keys.Count -eq 1) `
        ((($seen.Keys) -join ', ') + '  共 ' + $seen.Keys.Count + ' 个')

    # ================================================================
    # 场景 5：没有残留临时文件
    # ================================================================
    Write-Output ''
    Write-Output '--- 5. 没有残留的临时文件 ---'

    $tmps = @(Get-ChildItem -Path $iso -Filter '*.tmp' -File -ErrorAction SilentlyContinue)
    Check '数据目录里没有残留 .tmp' ($tmps.Count -eq 0) (($tmps | ForEach-Object { $_.Name }) -join ', ')

    $legacy = Join-Path $iso 'heartbeat.json.tmp'
    Check '旧固定名 heartbeat.json.tmp 没有残留' (-not (Test-Path $legacy))

}
finally {
    # ---------------------------------------------------------------- 清理
    # 【只杀自己 spawn 的 pid】绝不按进程名批量结束 ——
    # 用户真实在用的卡片也叫 powershell.exe，批量杀会误伤。
    Write-Output ''
    Write-Output '--- 清理测试进程 ---'

    foreach ($proc in @($p1, $p2)) {
        if ($null -eq $proc) { continue }
        try {
            if (-not $proc.HasExited) {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                Write-Output ("   已结束测试进程 pid=" + $proc.Id)
            }
        } catch { }
    }

    Remove-Item Env:\DSH_CARD_DATA_DIR -ErrorAction SilentlyContinue
    try { Remove-Item $iso -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

Write-Output ''
Write-Output ('=' * 66)
Write-Output ('通过 ' + $passed + '   失败 ' + $failed)
if ($failed -eq 0) {
    Write-Output '全部通过 ✅'
    exit 0
} else {
    Write-Output '有失败项'
    exit 1
}
