# verify-d6-real.ps1 -- D6 真实场景验证：心跳过期但进程还活着时不能叠卡
#
# 【为什么必须真跑一遍】
#   node 那边的测试证明了"判断函数对"（喂 pidAlive=true 就返回不拉起）。
#   但我没证明：**真实环境里那个 pid 真的被查到了**。
#   如果 isProcessAlive / Get-Process 在老卡片留下的 pid 上返回错值，
#   逻辑再对也没用。
#
# 【怎么造这个场景】
#   1. 起一个真实的卡片进程（隔离数据目录）
#   2. 等它写出心跳
#   3. **手动把心跳的 updatedAtMs 改成 20 秒前**（模拟"进程被挂起没写心跳"）
#   4. 此时：
#      · 心跳看起来"过期 20 秒"
#      · 但进程确实还活着
#   5. 再起第二个卡片 → 它应该看到"过期 + pid 还活着" → 拒绝启动、安静退出
#
#   改前版本会在第 5 步放行（因为只看"过期"），于是叠出第二张卡。
#   改后版本应该在"过期但进程活着"时挡住。
#
# 跑法：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\verify-d6-real.ps1

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
Write-Output 'D6 真实场景：心跳过期但进程还活着'
Write-Output ('=' * 66)

if (-not (Test-Path $panelFile)) {
    Write-Output ("MISSING panel/Panel.ps1: " + $panelFile)
    exit 1
}

$iso = Join-Path $env:TEMP ('dsh-d6-real-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $iso -Force | Out-Null

$p1 = $null
$p2 = $null

try {
    $env:DSH_CARD_DATA_DIR = $iso
    $hbPath = Join-Path $iso 'heartbeat.json'

    # ================================================================
    # 1. 起第一个卡片
    # ================================================================
    Write-Output ''
    Write-Output '--- 1. 起第一个卡片，等它稳定 ---'

    $p1 = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $panelFile + '"')) `
        -PassThru -WindowStyle Hidden

    Write-Output ("   pid=" + $p1.Id)

    # 等心跳出现且 pid 对得上
    $waited = 0
    $hbOk = $false
    while ($waited -lt 20000) {
        if (Test-Path $hbPath) {
            try {
                $h = Get-Content $hbPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($h.alive -eq $true -and [long]$h.pid -eq [long]$p1.Id) { $hbOk = $true; break }
            } catch { }
        }
        [System.Threading.Thread]::Sleep(300)
        $waited += 300
    }
    Check '第一个卡片写出了心跳且 pid 对得上' $hbOk

    if (-not $hbOk) {
        Write-Output '   心跳没出来，后面的验证没法做，提前结束'
        throw 'no heartbeat'
    }

    # ================================================================
    # 2. 伪造"心跳过期"：把 updatedAtMs 改成 20 秒前
    # ================================================================
    Write-Output ''
    Write-Output '--- 2. 把心跳时间改成 20 秒前（模拟进程被挂起没写心跳） ---'

    # 【先停掉第一个进程的心跳定时器不行】没法从外部停。
    #   所以这里用另一个办法：直接把心跳文件改成"过期"，并让它保持过期。
    #   第一个进程每 2 秒会重新写一次（写回"新鲜"），所以必须在改完之后
    #   立刻起第二个进程 —— 时间窗只有不到 2 秒。
    #
    #   【更可靠的办法】：先杀掉第一个进程但**不更新心跳**（模拟强杀）。
    #   但那样 pid 就真的不存在了，测不到"进程活着"这个关键点。
    #
    #   所以用第三种办法：**让心跳里的 pid 指向一个真实存活的进程，
    #   但那个进程不是卡片**。最方便的真实存活进程就是本脚本自己。
    #   这样：
    #     · 心跳 = 过期 20 秒
    #     · 心跳里的 pid = 本脚本（确实活着）
    #     · 第二个卡片的单实例判断应该挡住
    #   这精确复现了"进程还活着但心跳过期"的判定条件。
    $fake = [ordered]@{
        pid         = $PID
        hwnd        = 12345
        alive       = $true
        dataDir     = $iso
        updatedAtMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) - 20000
        scriptStampMs = 0
    }
    $fakeJson = $fake | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($hbPath, $fakeJson, (New-Object System.Text.UTF8Encoding($false)))

    # 确认写好了
    $h2 = Get-Content $hbPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ageMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) - [long]$h2.updatedAtMs
    Check ('心跳确实过期了（' + [int]($ageMs/1000) + ' 秒）') ($ageMs -ge 15000)
    Check '心跳里的 pid 是一个真实存活的进程（本脚本自己）' `
        ($null -ne (Get-Process -Id $h2.pid -ErrorAction SilentlyContinue))

    # ================================================================
    # 3. 起第二个卡片：它应该被挡住
    # ================================================================
    Write-Output ''
    Write-Output '--- 3. 立刻起第二个卡片（应被挡住并安静退出） ---'

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $p2 = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $panelFile + '"')) `
        -PassThru -WindowStyle Hidden

    Write-Output ("   第二个 pid=" + $p2.Id)

    $exited = $p2.WaitForExit(25000)
    $sw.Stop()
    $elapsed = [int]$sw.Elapsed.TotalMilliseconds

    Check '【核心】第二个卡片自己退出了（没有叠卡）' $exited ("等待 " + $elapsed + "ms")

    if ($exited) {
        Check '退出码是 0（安静退出，不是崩溃）' ($p2.ExitCode -eq 0) ("ExitCode=" + $p2.ExitCode)
        Check '退出很快（<10 秒，说明没建窗口就退了）' ($elapsed -lt 10000) ($elapsed.ToString() + 'ms')
    }

    # ================================================================
    # 4. 反例：pid 指向一个不存在的进程时，必须放行
    # ================================================================
    Write-Output ''
    Write-Output '--- 4. 反例：心跳过期 + pid 不存在 → 必须放行（不能永远挡住） ---'

    # 把心跳的 pid 改成一个绝对不存在的进程
    $fake2 = [ordered]@{
        pid         = 0x7FFFFFF0
        hwnd        = 0
        alive       = $true
        dataDir     = $iso
        updatedAtMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) - 20000
        scriptStampMs = 0
    }
    [System.IO.File]::WriteAllText($hbPath, ($fake2 | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))

    Check '伪造的心跳里 pid 确实不存在' `
        ($null -eq (Get-Process -Id 0x7FFFFFF0 -ErrorAction SilentlyContinue))

    # 【这一步很关键】它证明了"不会永远挡住"
    #   如果这里第二个进程也退出，说明判据太严，会导致
    #   "真的崩溃后卡片再也起不来" —— 那比叠卡严重得多。
    $p3 = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $panelFile + '"')) `
        -PassThru -WindowStyle Hidden
    Write-Output ("   第三个 pid=" + $p3.Id + "（这次应该能起来）")

    # 等它写心跳（说明它真的跑起来了）
    $waited2 = 0
    $started = $false
    while ($waited2 -lt 20000) {
        try {
            $h3 = Get-Content $hbPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([long]$h3.pid -eq [long]$p3.Id -and $h3.alive -eq $true) { $started = $true; break }
        } catch { }
        [System.Threading.Thread]::Sleep(300)
        $waited2 += 300
    }
    Check '【关键】pid 不存在时会放行，卡片能正常起来（不会永远挡住）' $started

    if ($started) {
        # 这个进程就是新的"真卡片"，记下来最后一起清
        $p1 = $p3
    }
}
catch {
    if ($_.Exception.Message -ne 'no heartbeat') {
        Write-Output ("  FAIL 验证过程异常: " + $_.Exception.Message)
        $script:failed++
    }
}
finally {
    Write-Output ''
    Write-Output '--- 清理测试进程（只杀本脚本 spawn 的） ---'
    foreach ($proc in @($p1, $p2)) {
        if ($null -eq $proc) { continue }
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
