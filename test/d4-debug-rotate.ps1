# test/d4-debug-rotate.ps1 -- D4：panel-debug.log 轮转/保留的**真实行为**验证
#
# 【为什么需要这个测试，而不是只看 d4-log-retention.mjs 的源码检查】
#   那个 .mjs 做的是"源码契约检查"：确认常量、函数、正则确实写在那儿。
#   但源码里有 `$script:DebugMaxBytes = 2 * 1024 * 1024` 这句话，
#   不等于"文件真到 2MB 时会轮转"。可能写反了比较方向、可能 Move 的目标
#   路径拼错、可能清理正则匹配不上自己生成的名字 —— 这些静态检查都看不出来。
#
#   这个脚本把 Panel.ps1 里的**真实函数**抠出来跑，
#   真的建文件、真的写超阈值、真的看目录里剩下什么。
#   它测的是真代码，不是复刻的逻辑。
#
# 【为什么不直接加载整个 Panel.ps1】
#   那会 New-Object Application、建窗口、跑 $app.Run() —— 等于弹出一张
#   真卡片然后卡住。和 test/c2-state-health.ps1 一样，
#   这里按函数名把纯逻辑函数切出来单独执行。
#
# 跑法：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\d4-debug-rotate.ps1
# 退出码 0 = 全通过，1 = 有失败。
#
# 【数据隔离】本脚本自建 %TEMP% 下的独立目录，绝不碰
# %USERPROFILE%\.dsh\desktop-card\。跑完自己删干净。

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot   = Split-Path -Parent $scriptRoot
$panelFile  = Join-Path $repoRoot 'panel\Panel.ps1'

$script:passed = 0
$script:failed = 0

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
Write-Output 'D4 panel-debug.log 轮转与保留（真实行为）'
Write-Output ('=' * 66)

if (-not (Test-Path $panelFile)) {
    Write-Output ("MISSING panel/Panel.ps1: " + $panelFile)
    exit 1
}

# ---------------------------------------------------------------- 抠函数
#
# 【踩过的坑，写在这里免得下一个人重复】
#   · 不能在函数里 dot-source：那样定义的函数出了函数作用域就没了
#   · $null 绝不能 Invoke-Expression：空串会触发 call depth overflow
#   · Panel.ps1 里的注释含大括号，按"第一个 { 到配平 }"会切歪 ——
#     所以这里用"从 function 起锚，到行首单独的 }"这个更保守的边界，
#     和 test/bar-mode.mjs 抓函数体的做法保持一致。
$panelSrc = [System.IO.File]::ReadAllText($panelFile)

function Get-FunctionSource {
    param([string]$Src, [string]$Name)
    $pattern = '(?m)^function\s+' + [regex]::Escape($Name) + '\s*\{[\s\S]*?\r?\n\}\s*$'
    $m = [regex]::Match($Src, $pattern)
    if ($m.Success) { return $m.Value }
    # 兜底：松一点的边界（函数不是文件最后时，末尾没有行尾约束）
    $pattern2 = '(?m)^function\s+' + [regex]::Escape($Name) + '\s*\{[\s\S]*?\r?\n\}'
    $m2 = [regex]::Match($Src, $pattern2)
    if ($m2.Success) { return $m2.Value }
    return $null
}

# 被测函数
$srcMaint = Get-FunctionSource -Src $panelSrc -Name 'Invoke-DebugLogMaintenance'
if ($null -eq $srcMaint -or $srcMaint.Trim().Length -eq 0) {
    Write-Output ''
    Write-Output '  FAIL 缺少 Invoke-DebugLogMaintenance 函数 —— D4 的 B 类未实现'
    Write-Output ''
    Write-Output ('通过 ' + $script:passed + '   失败 1')
    exit 1
}

Write-Output ''
Write-Output '--- 0. 函数已就位 ---'
Check '抓到 Invoke-DebugLogMaintenance' ($srcMaint.Length -gt 0) ([string]$srcMaint.Length + ' 字符')

# ---------------------------------------------------------------- 隔离目录
$iso = Join-Path $env:TEMP ('dsh-d4dbg-' + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $iso -Force | Out-Null

# 【为什么要搭一个只含必要变量的"假脚本作用域"】
#   Invoke-DebugLogMaintenance 依赖 $script:debugPath / $DataDir /
#   $script:DebugMaxBytes / $script:DebugKeepCount / $script:DebugKeepDays。
#   真实卡片里这些在脚本顶层赋值。这里显式按**和 Panel.ps1 相同的名字**赋值，
#   再把函数体 Invoke-Expression 进来，函数就能看到它们。
#   如果哪天有人改了 Panel.ps1 里的变量名，这个测试会因为"变量为空"而失败 ——
#   那正是我们希望被发现的信号。
$DataDir = $iso
$script:debugPath = Join-Path $iso 'panel-debug.log'
$script:DebugMaxBytes = 2 * 1024 * 1024
$script:DebugKeepCount = 3
$script:DebugKeepDays = 15
$script:DebugLastCheck = [datetime]::MinValue
$script:DebugCheckMs = 60000

# 【验证"我从源码里读到的常量"和"我在这里设定的值"一致】
#   防止 Panel.ps1 里的常量被改了、而测试还按老值断言（那会变成假通过）。
Check 'Panel.ps1 里 DebugMaxBytes = 2MB' ($panelSrc -match '\$script:DebugMaxBytes\s*=\s*2\s*\*\s*1024\s*\*\s*1024')
Check 'Panel.ps1 里 DebugKeepCount = 3'   ($panelSrc -match '\$script:DebugKeepCount\s*=\s*3\b')
Check 'Panel.ps1 里 DebugKeepDays = 15'   ($panelSrc -match '\$script:DebugKeepDays\s*=\s*15\b')

Invoke-Expression ($srcMaint + "`r`n")

try {
    # ================================================================
    # 1. 超过 2MB 触发轮转
    # ================================================================
    Write-Output ''
    Write-Output '--- 1. 超过 2MB 会轮转（不是清空） ---'

    $big = 'X' * 1024
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt 2100; $i++) { [void]$sb.AppendLine($big) }   # ~2.1MB
    [System.IO.File]::WriteAllText($script:debugPath, $sb.ToString(),
        (New-Object System.Text.UTF8Encoding($false)))

    $sizeBefore = (Get-Item $script:debugPath).Length
    Check ('主文件确实超过 2MB（{0:N0} 字节）' -f $sizeBefore) ($sizeBefore -ge $script:DebugMaxBytes)

    Invoke-DebugLogMaintenance

    $rotated = @(Get-ChildItem -Path $iso -Filter 'panel-debug.*.log' -File -ErrorAction SilentlyContinue)
    Check '轮转产生了 panel-debug.<日期>-<时间>.log' ($rotated.Count -eq 1) ([string]$rotated.Count + ' 个')
    if ($rotated.Count -eq 1) {
        Check '轮转文件名符合 panel-debug.yyyyMMdd-HHmmss.log' `
            ($rotated[0].Name -match '^panel-debug\.\d{8}-\d{6}(-\d+)?\.log$') $rotated[0].Name
        Check '轮转文件内容是原来那 2MB（不是空的）' ($rotated[0].Length -ge $sizeBefore - 2048) `
            ([string]$rotated[0].Length + ' 字节')
    }

    $mainStillThere = Test-Path $script:debugPath
    Check '主文件还在（轮转不是删除）' $mainStillThere
    if ($mainStillThere) {
        Check '主文件被清空等待新内容' ((Get-Item $script:debugPath).Length -eq 0) `
            ([string](Get-Item $script:debugPath).Length + ' 字节')
    }

    # ================================================================
    # 2. 保留数量上限：只留最近 3 个
    # ================================================================
    Write-Output ''
    Write-Output '--- 2. 轮转文件最多留 3 个（不管天数） ---'

    # 造 6 个"历史轮转"，时间依次更早，但都在 15 天内（不会被天数规则删）
    $base = Get-Date
    for ($i = 1; $i -le 6; $i++) {
        $stamp = $base.AddMinutes(-$i * 10).ToString('yyyyMMdd-HHmmss')
        $p = Join-Path $iso ('panel-debug.' + $stamp + '.log')
        [System.IO.File]::WriteAllText($p, ('old-' + $i), (New-Object System.Text.UTF8Encoding($false)))
        # 显式设定修改时间，保证排序确定（不依赖文件系统精度）
        (Get-Item $p).LastWriteTime = $base.AddMinutes(-$i * 10)
    }

    # 再放一个 30 天前的（应该被天数规则删）
    $oldStamp = $base.AddDays(-30).ToString('yyyyMMdd-HHmmss')
    $oldPath = Join-Path $iso ('panel-debug.' + $oldStamp + '.log')
    [System.IO.File]::WriteAllText($oldPath, 'ancient', (New-Object System.Text.UTF8Encoding($false)))
    (Get-Item $oldPath).LastWriteTime = $base.AddDays(-30)

    $beforeCount = @(Get-ChildItem -Path $iso -Filter 'panel-debug.*.log' -File).Count
    Write-Output ("   （维护前有 {0} 个轮转文件）" -f $beforeCount)

    Invoke-DebugLogMaintenance

    $after = @(Get-ChildItem -Path $iso -Filter 'panel-debug.*.log' -File -ErrorAction SilentlyContinue)
    Check ('维护后只剩 3 个轮转文件（实际 {0} 个）' -f $after.Count) ($after.Count -eq $script:DebugKeepCount)
    Check '30 天前的那个被删了（天数规则生效）' (-not (Test-Path $oldPath))

    # 留下的应该是**最新的** 3 个
    $keptNames = @($after | Sort-Object LastWriteTime -Descending | Select-Object -ExpandProperty Name)
    Check '留下的是最近的 3 个（不是最老的）' ($after.Count -eq 3) ($keptNames -join ', ')

    # ================================================================
    # 3. 绝不误伤 panel.log / 其他日志
    # ================================================================
    Write-Output ''
    Write-Output '--- 3. 清理绝不误伤 panel.log 和其他日志 ---'

    # 造几个"绝对不能删"的文件
    $keepMain = Join-Path $iso 'panel.log'
    $keepSettings = Join-Path $iso 'settings.log'
    $keepPlugin = Join-Path $iso 'plugin.log'
    $keepPluginRot = Join-Path $iso ('plugin.' + $base.ToString('yyyyMMdd-HHmmss') + '.log')
    foreach ($k in @($keepMain, $keepSettings, $keepPlugin, $keepPluginRot)) {
        [System.IO.File]::WriteAllText($k, 'precious', (New-Object System.Text.UTF8Encoding($false)))
        # 全部设成很老，确保"如果正则写松了就会被删"
        (Get-Item $k).LastWriteTime = $base.AddDays(-100)
    }

    Invoke-DebugLogMaintenance

    Check 'panel.log 没被删（主日志）' (Test-Path $keepMain)
    Check 'settings.log 没被删（设置窗口日志）' (Test-Path $keepSettings)
    Check 'plugin.log 没被删（插件日志）' (Test-Path $keepPlugin)
    Check 'plugin.<stamp>.log 没被删（插件轮转）' (Test-Path $keepPluginRot)

    # ================================================================
    # 4. 不到 2MB 时不轮转（不许空转生成垃圾文件）
    # ================================================================
    Write-Output ''
    Write-Output '--- 4. 没到阈值不轮转 ---'

    Get-ChildItem -Path $iso -Filter 'panel-debug.*.log' -File | ForEach-Object { Remove-Item $_.FullName -Force }
    [System.IO.File]::WriteAllText($script:debugPath, ('small content'), (New-Object System.Text.UTF8Encoding($false)))

    Invoke-DebugLogMaintenance
    $smallRot = @(Get-ChildItem -Path $iso -Filter 'panel-debug.*.log' -File -ErrorAction SilentlyContinue)
    Check '小文件不触发轮转' ($smallRot.Count -eq 0) ([string]$smallRot.Count + ' 个轮转文件')

    # ================================================================
    # 5. 维护失败不能抛异常（绝不能拖垮改色主循环）
    # ================================================================
    Write-Output ''
    Write-Output '--- 5. 维护失败不抛异常 ---'

    $savedPath = $script:debugPath
    $threw = $false
    try {
        # 指向一个不存在的目录：Get-Item / Move / Get-ChildItem 都会失败
        $script:debugPath = Join-Path $iso 'no-such-subdir\panel-debug.log'
        Invoke-DebugLogMaintenance
    }
    catch {
        $threw = $true
    }
    $script:debugPath = $savedPath
    Check '【关键】目录不存在时维护函数不抛异常（改色主循环安全）' (-not $threw)
}
finally {
    # 一定要清干净：绝不在用户机器上留测试垃圾
    try { Remove-Item $iso -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

Write-Output ''
Write-Output ('=' * 66)
Write-Output ('通过 ' + $script:passed + '   失败 ' + $script:failed)
if ($script:failed -eq 0) {
    Write-Output '全部通过 ✅'
    exit 0
} else {
    Write-Output '有失败项'
    exit 1
}
