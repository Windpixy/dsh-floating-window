est/c2-state-health.ps1 -- C2：状态健康判定（读不到 / 损坏 / 陈旧 / 真空闲）
#
# ---------------------------------------------------------------------------
# 【这个测试守的是什么】
# ---------------------------------------------------------------------------
# 改造前，Read-PanelState 在下面四种情况下**统一返回 0 任务、0 审批、0 Token**：
#     · state.json 不存在
#     · 读取失败（被锁、权限）
#     · JSON 解析失败（写了一半）
#     · 插件停了，没人更新文件
#
# 结果：「DSH 真的没事做」和「卡片根本拿不到数据」在屏幕上长得一模一样。
# 用户看着卡片写「空闲」，其实插件早就挂了。
#
# 反过来也有另一种坑：插件停了，卡片一直显示最后一次的旧数字，
# 用户以为是新数据。
#
# ---------------------------------------------------------------------------
# 【为什么用 PowerShell 测，不用 Node】
# ---------------------------------------------------------------------------
# 被测函数是 Panel.ps1 里的 PowerShell 代码。用 Node 复刻一遍逻辑
# （像 bar-mode.mjs 那样复刻色板）只能证明"我们以为它怎么写"，
# 证明不了"它真的这么跑"。
# 这里直接用 PowerShell 5.1 加载真实函数并调用，测的是真代码。
#
# 跑法：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\c2-state-health.ps1
#
# 退出码 0 = 全通过，1 = 有失败。

$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$panelRoot  = Join-Path (Split-Path -Parent $scriptRoot) 'panel'
$panelFile  = Join-Path $panelRoot 'Panel.ps1'

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

Write-Output ('=' * 64)
Write-Output 'C2 状态健康：区分「读不到」「损坏」「陈旧」「真空闲」'
Write-Output ('=' * 64)

if (-not (Test-Path $panelFile)) {
    Write-Output ("MISSING panel/Panel.ps1: " + $panelFile)
    exit 1
}

# ---------------------------------------------------------------- 提取被测函数
#
# 【为什么要从源码里抠函数，而不是直接 dot-source Panel.ps1】
#   Panel.ps1 是**整个 WPF 应用**：一加载就会 New-Object Application、
#   建窗口、起定时器、跑 $app.Run()。在测试里加载它 = 真的弹出一张卡片并且卡住。
#
#   所以这里按函数名把**纯逻辑函数**切出来单独执行。
#   只切不依赖 WPF 控件的函数（健康判定必须设计成纯函数，正是为了可测）。
$panelSrc = [System.IO.File]::ReadAllText($panelFile)

function Get-FunctionSource {
    param([string]$Src, [string]$Name)
    # 从 "function Name {" 开始，按大括号配平，切到匹配的 "}"
    $pattern = '(?m)^function\s+' + [regex]::Escape($Name) + '\s*\{'
    $m = [regex]::Match($Src, $pattern)
    if (-not $m.Success) { return $null }
    $start = $m.Index
    $i = $Src.IndexOf('{', $start)
    $depth = 0
    for ($p = $i; $p -lt $Src.Length; $p++) {
        $ch = $Src[$p]
        if ($ch -eq '{') { $depth++ }
        elseif ($ch -eq '}') {
            $depth--
            if ($depth -eq 0) { return $Src.Substring($start, $p - $start + 1) }
        }
    }
    return $null
}

# 被测函数（C2 新增）。
# 【为什么在脚本顶层定义，而不是在函数里 dot-source】
#   在函数内部 dot-source 定义的函数只活在那个函数的局部作用域，
#   函数一返回就没了（踩过这个坑：报 "Get-StateHealth 不是 cmdlet"）。
#   必须在本脚本的顶层作用域定义，后续调用才能看见。
#
# 【判空再定义】$srcHealth 为 $null 时绝不能 Invoke-Expression，
#   空串会触发作用域异常（踩过：call depth overflow）。
$hasHealth = $false
$srcHealth = Get-FunctionSource -Src $panelSrc -Name 'Get-StateHealth'
$srcStale  = Get-FunctionSource -Src $panelSrc -Name 'Get-StaleHealthSeconds'

if ($null -ne $srcHealth -and $srcHealth.Trim().Length -gt 0) {
    Invoke-Expression ($srcHealth + "`r`n")
    $hasHealth = $true
}
if ($null -ne $srcStale -and $srcStale.Trim().Length -gt 0) {
    Invoke-Expression ($srcStale + "`r`n")
}

if (-not $hasHealth) {
    Write-Output ''
    Write-Output '  FAIL 缺少 Get-StateHealth 函数 —— C2 核心逻辑未实现'
    Write-Output ''
    Write-Output ('通过 ' + $script:passed + '   失败 ' + ($script:failed + 1))
    exit 1
}

Write-Output ''
Write-Output '--- 1. 正常空闲：合法 + 新鲜 + 全 0 -> 真的是空闲 ---'

# 构造一个"刚写了 1 秒"的合法状态
$now = [datetime]::Now
$freshSec = [long][DateTimeOffset]::new($now.ToUniversalTime()).ToUnixTimeSeconds()

$r = Get-StateHealth -Raw $null -ErrorKind 'ok' -UpdatedAtSec $freshSec -Now $now -ObjectValid $true
Check '合法新鲜 + 全 0 -> 判为 ok（真空闲）' ($r.Kind -eq 'ok') $r.Kind
Check '  不提示（IsDegraded = false）' ($r.IsDegraded -eq $false) ([string]$r.IsDegraded)
Check '  允许显示空闲' ($r.CanShowIdle -eq $true) ([string]$r.CanShowIdle)

Write-Output ''
Write-Output '--- 2. 文件不存在 -> 缺失，不能显示空闲 ---'

$r = Get-StateHealth -Raw $null -ErrorKind 'missing' -UpdatedAtSec 0 -Now $now -ObjectValid $false
Check 'Kind = missing' ($r.Kind -eq 'missing') $r.Kind
Check '  IsDegraded = true（要提示）' ($r.IsDegraded -eq $true) ([string]$r.IsDegraded)
Check '  【关键】CanShowIdle = false（不许假装空闲）' ($r.CanShowIdle -eq $false) ([string]$r.CanShowIdle)

Write-Output ''
Write-Output '--- 3. JSON 坏了 -> invalidJson ---'

$r = Get-StateHealth -Raw '{broken' -ErrorKind 'invalidJson' -UpdatedAtSec 0 -Now $now -ObjectValid $false
Check 'Kind = invalidJson' ($r.Kind -eq 'invalidJson') $r.Kind
Check '  【关键】CanShowIdle = false' ($r.CanShowIdle -eq $false) ([string]$r.CanShowIdle)

Write-Output ''
Write-Output '--- 4. 读取失败（被锁/权限）-> readError ---'

$r = Get-StateHealth -Raw $null -ErrorKind 'readError' -UpdatedAtSec 0 -Now $now -ObjectValid $false
Check 'Kind = readError' ($r.Kind -eq 'readError') $r.Kind
Check '  【关键】CanShowIdle = false' ($r.CanShowIdle -eq $false) ([string]$r.CanShowIdle)

Write-Output ''
Write-Output '--- 5. 数据陈旧：合法但太久没更新 ---'

$staleSec = 60
$oldSec = $freshSec - $staleSec - 5
$r = Get-StateHealth -Raw '{}' -ErrorKind 'ok' -UpdatedAtSec $oldSec -Now $now -ObjectValid $true
Check 'Kind = stale' ($r.Kind -eq 'stale') $r.Kind
Check '  IsDegraded = true' ($r.IsDegraded -eq $true) ([string]$r.IsDegraded)
Check '  年龄算对了（约 65 秒）' ([math]::Abs($r.AgeSec - 65) -le 3) ([string]$r.AgeSec)

Write-Output ''
Write-Output '--- 6. 阈值边界：刚好在阈值内 / 刚超过 ---'

$thr = 15
$inSec   = $freshSec - ($thr - 1)
$overSec = $freshSec - ($thr + 1)

$r1 = Get-StateHealth -Raw '{}' -ErrorKind 'ok' -UpdatedAtSec $inSec -Now $now -ObjectValid $true
$r2 = Get-StateHealth -Raw '{}' -ErrorKind 'ok' -UpdatedAtSec $overSec -Now $now -ObjectValid $true
Check ('刚好 ' + ($thr - 1) + ' 秒 -> 不判陈旧') ($r1.Kind -eq 'ok') $r1.Kind
Check ('刚超 ' + ($thr + 1) + ' 秒 -> 判陈旧')  ($r2.Kind -eq 'stale') $r2.Kind

Write-Output ''
Write-Output '--- 7. 时间戳异常：0 / 未来 / 非数字 ---'

$r = Get-StateHealth -Raw '{}' -ErrorKind 'ok' -UpdatedAtSec 0 -Now $now -ObjectValid $true
Check '0 时间戳 -> 不当成陈旧（无法判断年龄就不猜）' ($r.Kind -eq 'ok') $r.Kind

$futureSec = $freshSec + 3600
$r = Get-StateHealth -Raw '{}' -ErrorKind 'ok' -UpdatedAtSec $futureSec -Now $now -ObjectValid $true
Check '未来时间 -> 不当成陈旧，也不当成新鲜' ($r.Kind -eq 'timeAnomaly') $r.Kind
Check '  IsDegraded = false（不是数据问题，是时钟问题）' ($r.IsDegraded -eq $false) ([string]$r.IsDegraded)

Write-Output ''
Write-Output '--- 8. 常量检查：阈值 = 15 秒（用户拍板） ---'

$tsrc = Get-FunctionSource -Src $panelSrc -Name 'Get-StaleHealthSeconds'
if ($null -ne $tsrc) {
    Check '源码里有阈值函数' $true
    Check '  阈值是 15 秒' ($tsrc -match '15') $tsrc
} else {
    Check '源码里有 Get-StaleHealthSeconds 阈值函数' $false '未找到'
}

Write-Output ''
Write-Output '--- 9. Panel.ps1 关键改造点存在性 ---'

Check 'Read-PanelState 返回对象里有 Health 字段' ($panelSrc -match 'Health\s*=\s*\$health') '未找到'
Check 'Read-PanelState 区分了 missing（不再直接返回 empty）' ($panelSrc -match "ErrorKind\s*'missing'|ErrorKind\s*=\s*'missing'") '未找到'
Check 'Update-UI 使用 $State.Health 判断（不只看 running）' ($panelSrc -match '\$State\.Health') '未找到'

Write-Output ''
Write-Output ('=' * 64)
Write-Output ('通过 ' + $script:passed + '   失败 ' + $script:failed)
if ($script:failed -eq 0) {
    Write-Output '全部通过 ✅'
    exit 0
} else {
    Write-Output '有失败项'
    exit 1
}
