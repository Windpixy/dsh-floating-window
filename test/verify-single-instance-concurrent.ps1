# verify-single-instance-concurrent.ps1 -- **同时**启动多个卡片，验证不叠卡
#
# 【为什么需要这个，而 verify-single-instance-real.ps1 不够】
#   那个脚本是**顺序**起两个：第一个完全跑起来、心跳稳定了，才起第二个。
#   实测证明这种顺序场景下，**改前版本也能通过** —— 因为第二个进程读到的是
#   一份写完整了的心跳，判断自然正确。
#
#   真实事故（2026-11-03：3 张卡片同时运行）不是这样发生的。
#   它是**并发**的：插件在某段时间里反复拉起，多个进程几乎同时进入
#   "读心跳 → 判断 → 写心跳"这一段，互相踩到了对方的**半截心跳**。
#
#   所以这个脚本刻意制造那个时间窗：几乎无间隔地同时拉起 N 个，
#   然后看最后活下来几个。正确答案是**只能活 1 个**。
#
# 【这个测试在改前版本上应该失败（活下来多个）】
#   如果它在两边都通过，说明它没测到真正的问题 —— 那它就没有价值，
#   必须重新设计，而不是当成"验证通过"。
#
# 跑法：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\verify-single-instance-concurrent.ps1

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
Write-Output '并发启动单实例验证（模拟真实事故时间窗）'
Write-Output ('=' * 66)

if (-not (Test-Path $panelFile)) {
    Write-Output ("MISSING: " + $panelFile)
    exit 1
}

$iso = Join-Path $env:TEMP ('dsh-si-conc-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $iso -Force | Out-Null

Write-Output ''
Write-Output ("隔离数据目录: " + $iso)
Write-Output ''

$procs = @()

try {
    $env:DSH_CARD_DATA_DIR = $iso

    # 先清干净：确保没有历史心跳干扰
    Remove-Item (Join-Path $iso 'heartbeat.json') -Force -ErrorAction SilentlyContinue

    # ================================================================
    # 并发拉起 5 个（几乎无间隔）
    # ================================================================
    $N = 5
    Write-Output ("--- 几乎同时拉起 " + $N + " 个卡片进程 ---")

    for ($i = 0; $i -lt $N; $i++) {
        $p = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $panelFile + '"')) `
            -PassThru -WindowStyle Hidden
        $procs += $p
        # 【故意几乎不间隔】
        #   这个极短间隔正是真实事故的形态：插件连着调了几次启动。
        #   加长间隔会让"先起来的那个"有充足时间写完整心跳，就测不出竞态了。
        [System.Threading.Thread]::Sleep(120)
    }

    Write-Output ("   拉起完毕，pid: " + (($procs | ForEach-Object { $_.Id }) -join ', '))
    Write-Output '   等 12 秒让多余的进程自己退出…'
    [System.Threading.Thread]::Sleep(12000)

    # ================================================================
    # 统计还活着的
    # ================================================================
    $alive = @($procs | Where-Object { -not $_.HasExited })
    $dead  = @($procs | Where-Object { $_.HasExited })

    Write-Output ''
    Write-Output ("--- 结果：存活 " + $alive.Count + " 个 / 退出 " + $dead.Count + " 个 ---")
    if ($alive.Count -gt 0) {
        Write-Output ("   存活 pid: " + (($alive | ForEach-Object { $_.Id }) -join ', '))
    }

    # 【核心断言】只能活 1 个
    Check ('【核心】并发 ' + $N + ' 个只活下来 1 个（不叠卡）') ($alive.Count -eq 1) `
        ("实际存活 " + $alive.Count + " 个")

    # 退出的那些应该是 0 退出码（安静退出，不是崩溃）
    $badExit = @($dead | Where-Object { $_.ExitCode -ne 0 })
    Check '退出的进程都是安静退出（ExitCode=0，不是崩溃）' ($badExit.Count -eq 0) `
        (($badExit | ForEach-Object { "pid=" + $_.Id + " code=" + $_.ExitCode }) -join ', ')

    # ================================================================
    # 心跳只能来自存活的那个
    # ================================================================
    Write-Output ''
    Write-Output '--- 心跳归属检查 ---'

    $hbPath = Join-Path $iso 'heartbeat.json'
    $hbPids = @{}
    for ($i = 0; $i -lt 8; $i++) {
        try {
            $hh = Get-Content $hbPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $hbPids[[string]$hh.pid] = $true
        } catch { }
        [System.Threading.Thread]::Sleep(250)
    }

    Check '【关键】心跳里只有一个 pid（没有多进程轮流覆盖）' ($hbPids.Keys.Count -le 1) `
        ((($hbPids.Keys) -join ', ') + ' 共 ' + $hbPids.Keys.Count + ' 个')

    if ($alive.Count -eq 1) {
        $survivorPid = [string]$alive[0].Id
        Check '心跳的 pid 就是存活的那个进程' ($hbPids.ContainsKey($survivorPid)) `
            ("心跳 " + (($hbPids.Keys) -join ',') + " vs 存活 " + $survivorPid)
    }

    # ================================================================
    # 没有残留临时文件
    # ================================================================
    Write-Output ''
    Write-Output '--- 临时文件检查 ---'

    # 【这里允许有极少量瞬时 tmp】
    #   存活的进程正在每 2 秒写一次，采样瞬间可能刚好有个 tmp。
    #   真正要禁止的是"写了却永远清不掉"的残留：给 2 秒再看。
    [System.Threading.Thread]::Sleep(2000)
    $tmps = @(Get-ChildItem -Path $iso -Filter '*.tmp' -File -ErrorAction SilentlyContinue)
    Check '没有持续残留的 .tmp 文件' ($tmps.Count -le 1) `
        (($tmps | ForEach-Object { $_.Name }) -join ', ')

    $legacy = Join-Path $iso 'heartbeat.json.tmp'
    Check '旧固定名 heartbeat.json.tmp 没被继续使用/残留' (-not (Test-Path $legacy))

    # 心跳文件本身必须是完整合法 JSON（没有写坏）
    $hbValid = $false
    try {
        $raw = Get-Content $hbPath -Raw -Encoding UTF8
        $null = $raw | ConvertFrom-Json
        $hbValid = $true
    } catch { }
    Check '【关键】心跳文件是完整合法 JSON（没被写坏）' $hbValid
}
finally {
    Write-Output ''
    Write-Output '--- 清理测试进程（只杀本脚本 spawn 的 pid） ---'
    foreach ($proc in $procs) {
        try {
            if (-not $proc.HasExited) {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                Write-Output ("   已结束 pid=" + $proc.Id)
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
