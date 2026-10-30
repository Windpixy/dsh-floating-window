# Settings.ps1 -- 卡片设置界面（v0.7.0 重做版）
#
# 【这个文件在做什么】
#   一个独立的小窗口，用来改卡片的外观和行为。
#   它是**独立进程**：卡片右键「设置…」时新起一个 powershell 进程跑本文件，
#   关掉就退出。所以改完这个文件不用重启 DSH、也不用重启卡片，
#   右键再点一次「设置…」就是新代码。迭代成本极低。
#
# 【相比旧版的改动（用户已拍板的 7 项）】
#   1. 删掉「峰谷时间段」7 行手填框 —— 峰谷已由插件 lib/valley.js 按官方规则
#      自动算好写进 state.json 的 valley 字段。手填那份跟官方规则差得远
#      （官方：工作日 9-12/14-18 是高峰，其余全是低谷），留着只会让人
#      以为要自己维护。改成只读展示。
#   2. 删掉「展开高度」输入框 —— 它是假的。卡片高度由行数决定
#      （Panel.ps1 的 Get-HeightForRows：98 + 54N），填什么都会在 500ms 内被覆盖。
#   3. 删掉「DSH 地址」输入框 —— 插件会自动把真实地址写进 settings.json。
#      改成只读展示（注意：不要显示 2278 那个早就失效的旧值）。
#   4. 新增「点卡片回到 DSH」「贴到屏幕边缘」「贴边留白」三个开关 ——
#      这三个 Panel.ps1 一直在读，但旧界面里根本没露出来。
#   5. 新增「恢复默认」「打开数据文件夹」。
#   6. 界面对齐卡片的设计语言（磨砂 + 圆角 + 无边框 + 同一套配色/字号/圆角）。
#
# 【顺手修掉的 4 个既有 bug（B2~B5）】
#   B2 保存会丢键：旧代码用 [ordered] 字典整份重建 json，字典里没有的键就被抹了
#      （实测丢过 openMode）。现在改成"先带出文件里所有旧键，再覆盖本界面负责的"。
#   B3 写盘非原子：旧代码 WriteAllText 直接截断，卡片每 500ms 读一次，
#      可能读到半截 → ConvertFrom-Json 失败 → 所有设置回默认一帧。
#      现在改成"写 tmp 再改名"（和心跳、和插件的做法一致）。
#   B4 收起高度可填 56 但扁条按 96 排版：New-MiniPanel 的字号/边距是按 96 排的，
#      填 56 会把字切掉。现在范围收到 72-160。
#   B5 本文件原先没有任何异常兜底：任何回调抛异常，用户只看到
#      "PowerShell 已停止工作"，什么都没记下来。现在照卡片的样子加了
#      Add_DispatcherUnhandledException，异常写进数据目录的 settings.log。
#
# 【编码纪律（血泪教训）】
#   本文件必须 UTF-8 **带 BOM**。PowerShell 5.1 在没有 BOM 时按 GBK 解码，
#   中文全乱码，随后整份脚本解析失败，一次能报 30+ 个假语法错误。
#   改完跑：scripts\fix-bom.ps1
#   另外：settings.json 绝不能有 BOM（JSON 规范不允许，JSON.parse 会直接抛错）。
#
# 【XAML 的一个坑】
#   XML 规范禁止注释里出现连续两个短横线。所以下面 XAML 里所有分隔注释
#   一律用 ==== 而不是 ----，否则 XamlReader.Parse 会直接抛
#   "XML 注释中不能包含 --"。这个坑本项目真踩过。

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# 早期问题缓冲。
# 【为什么需要它】下面"建数据目录""复制默认 settings.json"这两处 catch
# 发生在 Write-SettingsLog 定义之前（日志路径本身要靠 $DataDir 才定得下来），
# 但这两处恰恰是**最该记**的失败 —— 数据目录挂了，用户改什么都不会生效。
# 所以先攒在这个列表里，等日志函数定义好立刻补写。
# 不加这个缓冲，就会出现"最严重的故障反而没有任何日志"这种荒唐结果。
$script:EarlyProblems = New-Object System.Collections.ArrayList

# ---------------------------------------------------------------- 目录约定
#
# 必须和 Panel.ps1 完全一致，否则改了设置卡片不认：
#   环境变量 DSH_CARD_DATA_DIR 优先（插件拉起时传的）
#   否则用标准位置 %USERPROFILE%\.dsh\desktop-card\
#   再不行退回脚本目录
if ($env:DSH_CARD_DATA_DIR -and $env:DSH_CARD_DATA_DIR.Trim() -ne '') {
    $DataDir = $env:DSH_CARD_DATA_DIR.Trim()
} elseif ($env:USERPROFILE -and $env:USERPROFILE.Trim() -ne '') {
    $DataDir = Join-Path $env:USERPROFILE '.dsh\desktop-card'
} else {
    $DataDir = $ScriptDir
}
if (-not (Test-Path $DataDir)) {
    $wantedDataDir = $DataDir
    try { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }
    catch {
        # 【A 档：必须记】
        #   数据目录建不出来 → 下面的 settings.json 会写到脚本目录去，
        #   而卡片只认数据目录那一条路径 → 用户看到的是"我改了设置，卡片一点反应都没有"。
        #   这正好是设置窗口最容易被投诉的现象，而旧代码在这里是**彻底静默**的。
        #   判定标准：失败了用户会觉得"设置没生效"吗？会 → A 档。
        $DataDir = $ScriptDir
        [void]$script:EarlyProblems.Add('建立数据目录失败，已退回脚本目录。想要=' + $wantedDataDir + ' 原因=' + $_.Exception.Message)
    }
}

$SettingsPath = Join-Path $DataDir 'settings.json'
# 数据目录里还没有配置就先从程序目录复制一份默认值
if (-not (Test-Path $SettingsPath)) {
    $defaultSettings = Join-Path $ScriptDir 'settings.json'
    if (Test-Path $defaultSettings) {
        try { Copy-Item $defaultSettings $SettingsPath -Force }
        catch {
            # 【A 档：必须记】
            #   默认配置复制不过去 → 本窗口会退回去读写程序目录那份，
            #   而卡片只读数据目录 → 设置"改了不生效"。
            #   这同时也说明数据目录可能根本没写权限，是很重要的环境线索。
            $SettingsPath = $defaultSettings
            [void]$script:EarlyProblems.Add('复制默认 settings.json 失败，已改用程序目录那份。路径=' + $SettingsPath + ' 原因=' + $_.Exception.Message)
        }
    } else {
        $SettingsPath = $defaultSettings
    }
}

# ---------------------------------------------------------------- 日志
#
# 本文件自己的日志。卡片用 panel.log、插件用 plugin.log，这里单独一个，
# 排错时能一眼分清是"设置界面崩了"还是"卡片/插件的问题"。
#
# 【⚠️ 这一段以前是坏的（本次改动的根因）】
#   旧实现只有 [时间] 内容：没有级别、没有毫秒、没有轮转。
#   但更根本的问题在**调用点**：整个文件里 Write-SettingsLog 只被 7 处调用，
#   而且 7 处全在失败分支里（C# 编译失败、磨砂失败、保存失败、自检失败…）。
#   → 正常打开一次窗口、正常保存一次设置，一行都不写。
#   → 所以实测 settings.log 根本不存在：**不是路径写错，是成功路径永远不写日志**。
#   修法因此分两半：① 补齐格式和轮转；② 把启动/保存/恢复默认/关闭这些成功路径也记上。
#   少了 ②，用户说"我改了设置没生效"时日志里依然一片空白。
#
# 【格式：和 panel.log、plugin.log 统一（用户拍板）】
#   [2026-10-29 15:09:24.914] [SETTINGS] [INFO] 设置窗口启动，数据目录=...
#    本地时间 + 空格分隔 + 毫秒   来源标记   级别
#   · 为什么用本地时间：三份日志要能直接对齐时间线。旧版 plugin.log 是 UTC（带 Z），
#     对一次就要手动减 8 小时，每次排查都付一次代价。
#   · 为什么要毫秒：设置窗口的坑多半是"点了没反应""保存慢一拍"，
#     秒级精度看不出先后顺序。
#   · 为什么要 [SETTINGS]：三份日志合并成一个文件后，靠它区分来源。
#   · 为什么要级别：合并后要能一眼挑出 ERR。
#
# 【编码】settings.log 是日志不是 json，所以可以无 BOM（UTF8Encoding($false)），
#   和 panel.log 保持一致。别和 settings.json 搞混 —— 那个绝对不能有 BOM。
$script:SettingsLog          = Join-Path $DataDir 'settings.log'
$script:SettingsLogOld       = Join-Path $DataDir 'settings.old.log'
# 超过 256KB 就轮转（用户拍板）。比卡片的 2MB 小：
# 设置窗口信息密度低，一天顶多几十行（约 3KB），256KB 已经够翻好几个月。
$script:SettingsLogMaxBytes  = 256 * 1024
# 保留天数（用户拍板 15 天）
$script:SettingsLogKeepDays  = 15
# 去重表：同一个 Key 60 秒内只记第一条。
# 【为什么需要】只读区（峰谷/卡片状态）每秒刷新一次，那里失败会 1 秒刷一行，
# 把真正有用的记录冲掉。见下面 B 档的说明。
$script:SettingsLogDedupe    = @{}
# 维护节流：轮转 + 清理要 stat 和扫目录，不必每写一行都做
$script:SettingsLogLastMaint = [datetime]::MinValue

# 把 [有序字典/哈希表] 变成 "键=值, 键=值"，只给日志用。
# 【为什么单独抽出来】启动和保存两处都要记"当前这一组设置值"，
# 手写拼接容易漏键；用同一个函数才能保证两边记的键完全一致。
#
# 【为什么按键名排序，而不是按原顺序】
#   保存时传进来的 $vals 是普通 @{} 哈希表，**枚举顺序是不保证的**
#   （实测同一份值两次运行顺序不同）。不排序的话，两行日志内容一样、
#   顺序不一样，肉眼对比和 diff 都很难看。
#   排序之后同样的设置永远是同一行文字，可以直接拿去比对。
function ConvertTo-SettingsKv {
    param($Table)
    try {
        if ($null -eq $Table) { return '(空)' }
        $keys = @($Table.Keys | Sort-Object)
        $parts = New-Object System.Collections.ArrayList
        foreach ($k in $keys) { [void]$parts.Add(([string]$k + '=' + [string]$Table[$k])) }
        return ($parts -join ', ')
    } catch {
        # 【C 档：故意静默】这只是给日志做格式化，它再失败也不影响任何功能，
        # 而且在这里再往日志里写只会无限套娃。返回一句话就够。
        return '(格式化失败)'
    }
}

# 轮转 + 清理
#
# 【为什么和 Write-SettingsLog 分开】
#   轮转要 stat 文件、清理要扫目录，都比较贵；而写日志是高频动作。
#   分开之后，写日志只多做一次"上次维护是什么时候"的比较（微秒级）。
function Invoke-SettingsLogMaintenance {
    param([switch]$Force)
    try {
        $now = [datetime]::Now
        if (-not $Force) {
            if (($now - $script:SettingsLogLastMaint).TotalSeconds -lt 60) { return }
        }
        $script:SettingsLogLastMaint = $now

        # ---- ① 主文件超 256KB 就轮转，只保留 1 个旧文件
        if (Test-Path -LiteralPath $script:SettingsLog) {
            $size = (Get-Item -LiteralPath $script:SettingsLog -ErrorAction SilentlyContinue).Length
            if ($null -ne $size -and $size -ge $script:SettingsLogMaxBytes) {
                # 【为什么先删再改名】Move-Item -Force 在"目标已存在"时的行为
                # 在不同环境下并不一致（本项目被 File.Move 的重载坑过一次，
                # PS 5.1 没有三参数 Move）。先删掉目标，改名就变成最单纯的一步。
                # 【C 档：故意静默】删旧的 settings.old.log 失败（多半是被占用）无所谓：
                # 下面的 Move-Item 用 -Force 会再试一次，真不行还有清空主文件那道兜底。
                # 日志文件删除失败对用户零影响，不值得记。
                try {
                    if (Test-Path -LiteralPath $script:SettingsLogOld) {
                        Remove-Item -LiteralPath $script:SettingsLogOld -Force -ErrorAction Stop
                    }
                } catch { }
                try {
                    Move-Item -LiteralPath $script:SettingsLog -Destination $script:SettingsLogOld -Force -ErrorAction Stop
                } catch {
                    # 改名失败（多半是被占用）就退一步：清空主文件。
                    # 宁可丢历史，也不能让主文件无限长下去 —— 磁盘写满会让设置窗口
                    # 出现更莫名其妙的问题，而日志本身是最不值钱的东西。
                    # 【C 档：故意静默】这是"已经很坏的处境"里的最后一道兜底，
                    # 清空也失败就只能等下次；在这里写日志属于套娃（还在同一个失败路径上）。
                    try { [System.IO.File]::WriteAllText($script:SettingsLog, '', (New-Object System.Text.UTF8Encoding($false))) } catch { }
                }
            }
        }

        # ---- ② 删掉超过 15 天的轮转文件
        #
        # 【⚠️ 这里删的是文件，必须用最窄的匹配】
        #   绝不能写成"匹配 settings.*.log 就删"。同目录下还有：
        #     settings.diag.log  ← 自检模式（DSH_SETTINGS_DIAG=1）的输出，是排错证据
        #   而且 settings.diag.log **确实会被** settings.*.log 匹配到 —— 这是真实风险，
        #   不是假想（本文件自检那一节专门用 .diag.log 后缀就是为了不被误碰）。
        #   所以只认两种轮转命名：
        #     settings.old.log                 （大小轮转出来的旧文件）
        #     settings.yyyyMMdd-HHmmss.log     （将来若改成按时间归档）
        $logDir = Split-Path -Parent $script:SettingsLog
        $cutoff = (Get-Date).AddDays(-$script:SettingsLogKeepDays)
        $files = @(Get-ChildItem -Path $logDir -Filter 'settings.*.log' -File -ErrorAction SilentlyContinue)
        foreach ($f in $files) {
            if ($f.Name -notmatch '^settings\.(old|[0-9]{8}-[0-9]{6})\.log$') { continue }
            if ($f.LastWriteTime -lt $cutoff) {
                # 【C 档：故意静默】删一个过期旧日志失败（被占用）没有可见后果，
                # 下次启动或 60 秒后的维护还会再试。而且这是循环体，一失败可能连删多个，
                # 记了就是一片噪音。这里唯一重要的是"不能误删" —— 见上面的白名单正则。
                try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop } catch { }
            }
        }
    } catch {
        # 【C 档：故意静默】维护失败最多是"这次没轮转/没清掉"，
        # 60 秒后（或下次启动）还会再试，失败没有可见后果。
        # 而且在这里写日志万一也失败，会再进来一次，容易套娃。
    }
}

function Write-SettingsLog {
    param(
        [string]$Msg,
        # 级别：INFO / WARN / ERR，默认 INFO
        [string]$Level = 'INFO',
        # 去重键：传了之后同一个键 60 秒内只记第一条。
        # 【什么时候必须传】每秒都在跑的地方（只读区刷新、心跳解析、1 秒定时器）。
        # 那里一旦失败就会 1 秒刷一行，把有用信息全冲掉。
        [string]$Key = ''
    )

    # 【整段包在 try 里，而且这是本文件唯一允许"彻底静默"的地方】
    #   这是设置窗口。日志写不出来最多是"排错时少点线索"；
    #   但它要是把异常抛出去 → 事件回调里没人接 → WPF 直接退出整个应用
    #   → 用户连设置都改不了。宁可丢日志，绝不能崩窗口。
    try {
        # ---- 去重（放在写盘之前，省掉后面全部开销）
        if (-not [string]::IsNullOrEmpty($Key)) {
            $now = [datetime]::Now
            $last = $null
            if ($script:SettingsLogDedupe.ContainsKey($Key)) { $last = $script:SettingsLogDedupe[$Key] }
            if ($null -ne $last -and ($now - $last).TotalSeconds -lt 60) { return }
            $script:SettingsLogDedupe[$Key] = $now
        }

        # ---- 级别规范化：调用处写 ERROR / WARNING 也认
        $lv = 'INFO'
        if ($Level -eq 'ERR' -or $Level -eq 'ERROR') { $lv = 'ERR' }
        elseif ($Level -eq 'WARN' -or $Level -eq 'WARNING') { $lv = 'WARN' }

        # 本地时间 + 毫秒。
        # 【PS 5.1 注意】格式化只用一层 .ToString()，而且先存变量再调 ——
        #   PS 5.1 不认"点号开头的续行"（Panel.ps1 里记过这个坑）。
        $nowWall = Get-Date
        $ts = $nowWall.ToString('yyyy-MM-dd HH:mm:ss.fff')
        $line = ('[{0}] [SETTINGS] [{1}] {2}' -f $ts, $lv, $Msg) + "`r`n"

        [System.IO.File]::AppendAllText($script:SettingsLog, $line, (New-Object System.Text.UTF8Encoding($false)))

        # ---- 写成功之后才考虑轮转（万一轮转出问题，至少这一行已经落盘）
        Invoke-SettingsLogMaintenance
    } catch {
        # 【C 档：故意静默】见函数开头的理由。在这里再写日志会无限套娃。
    }
}

# 做一次启动维护（轮转 + 删 15 天前的旧文件），再把早期攒下的问题补写进来。
# 【顺序】先维护再写：万一 settings.log 上次已经撑得很大，先把旧的挪走，
# 免得这次启动的记录和一大堆旧内容混在一起。
Invoke-SettingsLogMaintenance -Force
if ($script:EarlyProblems.Count -gt 0) {
    foreach ($ep in $script:EarlyProblems) { Write-SettingsLog $ep -Level 'ERR' }
    $script:EarlyProblems.Clear()
}

function Get-Setting {
    param($Object, $Name, $Default)
    if ($null -eq $Object) { return $Default }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p -or $null -eq $p.Value) { return $Default }
    return $p.Value
}

# ---------------------------------------------------------------- 共享读
#
# 【为什么不用 Get-Content】
#   Get-Content 用的是 FileShare.Read，意思是"别人可以读，不许改不许删"。
#   卡片和插件都不停地读写这些文件，撞上就会 EPERM。
#   自己开流、明确声明 FileShare.ReadWrite + Delete，就不会挡住别人。
#   （Panel.ps1 的 Read-SharedText 是同一套理由）
function Read-JsonShared {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    $fs = $null; $sr = $null
    try {
        $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
        $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        $raw = $sr.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json)
    }
    catch {
        # 【B 档：记，但必须去重】
        #   这是所有读文件的统一入口，Update-ReadonlySections 每 1 秒就会调它。
        #   失败 → 返回 $null → 界面上峰谷/卡片状态那一块变成"暂时拿不到"，
        #   用户会觉得不对劲，所以要记；但每秒都可能失败，60 秒去重一次。
        # 【注意】文件不存在不会走到这里（函数开头就 return $null 了），
        #   能走到这里说明是真读不了 / 解析不出来 —— 这种必须留证据。
        Write-SettingsLog ('读取文件失败: ' + $Path + ' 原因=' + $_.Exception.Message) -Level 'WARN' -Key ('read:' + $Path)
        return $null
    }
    finally {
        # 【C 档：故意静默】Dispose 失败无害（.NET 最终会回收句柄），
        # 而且这里每秒执行好几次，记日志只会把日志刷爆。
        # 判定标准：失败了用户会觉得"设置窗口不对劲"吗？不会 → 不记。
        if ($null -ne $sr) {
            # 【C 档：故意静默】同上。Dispose 抛异常只可能是句柄已经没了，无害。
            try { $sr.Dispose() } catch { }
        }
        if ($null -ne $fs) {
            # 【C 档：故意静默】同上。
            try { $fs.Dispose() } catch { }
        }
    }
}

function Format-Duration {
    param([timespan]$Span)
    if ($Span.TotalSeconds -lt 0) { $Span = [timespan]::Zero }
    $totalMin = [int][math]::Floor($Span.TotalMinutes)
    $h = [int][math]::Floor($totalMin / 60)
    $m = $totalMin % 60
    if ($h -ge 24) { return ("{0}天{1}小时" -f [int][math]::Floor($h / 24), ($h % 24)) }
    if ($h -gt 0) { return ("{0}小时{1}分" -f $h, $m) }
    return ("{0}分" -f $m)
}

# ---------------------------------------------------------------- 原生调用（磨砂 + 系统圆角）
#
# 【为什么必须抄这段 C#】
#   WPF 里做圆角窗最省事的写法是 AllowsTransparency=True + 圆角 Border，
#   但那会把窗口变成"分层窗口"，磨砂就彻底失效（实测变成一整块纯白）。
#   卡片踩过这个坑（Panel.ps1 顶部注释有完整记录），所以这里走同一条路：
#     AllowsTransparency=False + 窗口背景透明 + DWM 系统圆角 + Acrylic。
#   Acrylic 必须靠 SetWindowCompositionAttribute 这个原生接口，WPF 没暴露。
#
# 【类名为什么叫 CardWin 而不是 PanelNative】
#   本文件是独立进程，叫什么都行；用不同名字是为了排错时能一眼看出
#   某个错误来自设置窗口还是卡片。
#
# 【为什么要 try/catch】
#   万一 C# 编译失败（PS 版本差异 / 杀软拦截 / 老系统缺 dwmapi），
#   不能让设置界面直接打不开。失败就把 $script:GlassOk 置 false，
#   下面会退回"纯色不透明窗口"——难看但能用。
#   这就是本文件"磨砂失败自动降级"的实现。
$script:GlassOk = $false
if (-not ('CardWin' -as [type])) {
    try {
        Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class CardWin
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MARGINS { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct ACCENTPOLICY { public int AccentState; public int AccentFlags; public int GradientColor; public int AnimationId; }

    [StructLayout(LayoutKind.Sequential)]
    public struct WINCOMPATTRDATA { public int Attrib; public IntPtr Data; public int SizeOfData; }

    [DllImport("user32.dll")]
    static extern int SetWindowCompositionAttribute(IntPtr h, ref WINCOMPATTRDATA d);

    [DllImport("dwmapi.dll")]
    static extern int DwmExtendFrameIntoClientArea(IntPtr h, ref MARGINS m);

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);

    // 磨砂玻璃。accentFlags 必须是 0 —— 填 2 会变成整块纯白底（卡片那边实测过）
    public static int Acrylic(IntPtr h, long tint, int accentFlags)
    {
        ACCENTPOLICY p = new ACCENTPOLICY();
        p.AccentState = 4;                        // ACCENT_ENABLE_ACRYLICBLURBEHIND
        p.AccentFlags = accentFlags;
        p.GradientColor = unchecked((int)tint);   // 0xAABBGGRR
        p.AnimationId = 0;

        int size = Marshal.SizeOf(p);
        IntPtr mem = Marshal.AllocHGlobal(size);
        Marshal.StructureToPtr(p, mem, false);

        WINCOMPATTRDATA d = new WINCOMPATTRDATA();
        d.Attrib = 19;                            // WCA_ACCENT_POLICY
        d.Data = mem;
        d.SizeOfData = size;

        int hr = SetWindowCompositionAttribute(h, ref d);
        Marshal.FreeHGlobal(mem);

        MARGINS m = new MARGINS();
        m.Left = -1; m.Top = -1; m.Right = -1; m.Bottom = -1;
        DwmExtendFrameIntoClientArea(h, ref m);
        return hr;
    }

    public static int Corner(IntPtr h, int pref) { int v = pref; return DwmSetWindowAttribute(h, 33, ref v, 4); }
    public static int DarkMode(IntPtr h, int on) { int v = on;  return DwmSetWindowAttribute(h, 20, ref v, 4); }
}
"@
        $script:GlassOk = $true
    }
    catch {
        $script:GlassOk = $false
        Write-SettingsLog ('内嵌 C# 编译失败，磨砂降级为纯色底: ' + $_.Exception.Message) -Level 'ERR'
    }
}
else {
    $script:GlassOk = $true
}

# 设置窗口的磨砂浓度。卡片是 0x50（要透出壁纸），设置窗口文字多，用更实的 0xD0。
$script:TintAlpha = 0xD0

# ---------------------------------------------------------------- 系统深浅色
# 和 Panel.ps1 完全同一个判据，两边才一致
$isDark = $false
try {
    $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop
    if ($null -ne $reg.AppsUseLightTheme) { $isDark = ($reg.AppsUseLightTheme -eq 0) }
} catch {
    # 【A 档：必须记】读不到系统主题 → 本窗口按"浅色"渲染。
    # 如果卡片其实是深色的，用户看到的就是"设置窗口和卡片颜色不是一套"，
    # 会觉得不对劲但说不出原因。只在启动时跑一次，不会刷屏。
    Write-SettingsLog ('读取系统深浅色失败，按浅色处理: ' + $_.Exception.Message) -Level 'WARN'
}

# 再存一份带 $script: 的副本。
# 【为什么两份都要保留】
#   脚本顶层这两行赋值后，回调里其实读得到 $isDark（脚本作用域）。
#   但本文件有条硬纪律："所有事件回调只碰 $script: 变量和事件参数" ——
#   那条纪律是为了防"读到函数局部变量变成 $null"。
#   为了让纪律没有例外（不用每次想"这个到底读得到吗"），
#   凡是要在回调里用的，一律再存一份 $script: 副本。
$script:isDark = $isDark

# ---------------------------------------------------------------- 峰谷只读数据
#
# 【数据来源：三份本地文件，不联网】
#   state.json      插件算好的 valley 字段（inValley / remainingSec / reason / holidayCount）
#   holidays.json   插件拉下来的节假日缓存（判断"今天是不是法定节假日"必须查它）
#   heartbeat.json  卡片心跳（判断卡片还活着没有，每 2 秒一次）
#
# 【为什么"今天是否节假日"要单独查 holidays.json，不能只看 reason】
#   lib/valley.js 的 judgePeak 先判周末、再判节假日。
#   所以国庆/春节正好落在周六周日时，reason 会是 'weekend'，
#   光看 reason 会漏掉"今天其实是法定节假日"。
#
# 【为什么要按北京时间算日期】
#   节假日是按北京日期给的。本机时区万一不是 +8，
#   直接用 (Get-Date) 会算错一天。
function Get-BeijingDateKey {
    return ([datetime]::UtcNow.AddHours(8)).ToString('yyyyMMdd')
}

function Test-HolidayToday {
    param([string]$Dir)
    $h = Read-JsonShared (Join-Path $Dir 'holidays.json')
    if ($null -eq $h -or $null -eq $h.years) { return $false }
    $key = Get-BeijingDateKey
    $year = $key.Substring(0, 4)
    $list = $h.years.$year
    if ($null -eq $list) { return $false }
    foreach ($d in @($list)) { if ([string]$d -eq $key) { return $true } }
    return $false
}

# 判断"今天是不是调休上班日"。
# 【为什么需要这个】
#   官方口径只把「法定节假日」算低谷。调休上班的周六周日不是法定节假日，
#   所以按规则仍算"周末 → 低谷"（哪怕你要上班）。
#   这个行为是对的，但用户看到"周末却是上班日"会疑惑，所以界面上说明一句。
#   注意：holidays.json 里只有放假日（parseHolidayJson 已经排除了 isOffDay=false
#   的调休上班日），所以这里没法从缓存判断"今天是否调休上班"，
#   只能说明"规则就是这样的"。
function Get-ValleyRuleText {
    return '规则：北京时间周一至周五 09:00-12:00、14:00-18:00 是高峰；其余时间（含周末和法定节假日全天）都是低谷。低谷的价格是高峰的一半。调休上班的周六周日按周末算，也就是全天低谷。'
}

function Get-ValleyReadout {
    param([string]$Dir)

    $out = [ordered]@{
        Ok          = $false
        Headline    = '暂时拿不到峰谷数据'
        Detail      = '可能是 DSH 没开着，或者插件刚启动还没算出结果。卡片本身也在等这份数据。'
        TodayKind   = ''
        Rule        = (Get-ValleyRuleText)
        CardAlive   = $false
        HolidayInfo = ''
    }

    # ---- 卡片活着没有：看心跳（每 2 秒一次，比 state.json 及时）
    $hb = Read-JsonShared (Join-Path $Dir 'heartbeat.json')
    if ($null -ne $hb -and $hb.alive -eq $true) {
        try {
            $nowMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
            $age = $nowMs - [long]$hb.updatedAtMs
            $out.CardAlive = ($age -ge 0 -and $age -lt 8000)
        } catch {
            # 【B 档：记，但要去重】
            #   心跳时间戳坏掉 → 界面一直显示"卡片没在运行"，
            #   可用户明明看着卡片就在屏幕上 → 典型的"不对劲"。
            #   但这段在 1 秒定时器里，必须去重，否则一个坏文件就能刷满日志。
            Write-SettingsLog ('心跳时间戳解析失败，按"卡片未运行"处理: ' + $_.Exception.Message) -Level 'WARN' -Key 'heartbeat-age'
        }
    }

    # ---- 节假日数据加载情况（只报个数，不报技术细节）
    $hj = Read-JsonShared (Join-Path $Dir 'holidays.json')
    if ($null -ne $hj -and $null -ne $hj.years) {
        $year = (Get-BeijingDateKey).Substring(0, 4)
        $list = $hj.years.$year
        if ($null -ne $list) {
            $out.HolidayInfo = ("节假日数据：{0} 年共 {1} 天" -f $year, @($list).Count)
        }
    }

    # ---- 峰谷本体
    $st = Read-JsonShared (Join-Path $Dir 'state.json')
    $v = $null
    if ($null -ne $st) { $v = $st.valley }
    if ($null -eq $v) { return [pscustomobject]$out }

    $inValley = ($v.inValley -eq $true)
    $sec = 0.0
    # 【B 档：记，但要去重】remainingSec 坏掉 → 倒计时显示 0 分，
    # 用户会觉得"这数字不对"。同样在 1 秒定时器里，60 秒去重。
    try { $sec = [double]$v.remainingSec }
    catch {
        $sec = 0
        Write-SettingsLog ('谷时剩余秒数解析失败，按 0 处理: ' + $_.Exception.Message) -Level 'WARN' -Key 'valley-sec'
    }
    if ($sec -lt 0) { $sec = 0 }
    $dur = Format-Duration ([timespan]::FromSeconds($sec))

    if ($inValley) {
        $out.Headline = '现在是低谷（便宜）'
        $out.Detail   = "还有 ${dur}进入高峰"
    }
    else {
        $out.Headline = '现在是高峰（贵）'
        $out.Detail   = "还有 ${dur}进入低谷"
    }

    # reason 只说明"为什么"，注意它先判周末
    switch ([string]$v.reason) {
        'weekend'    { $out.TodayKind = '今天：周末' }
        'holiday'    { $out.TodayKind = '今天：法定节假日' }
        'window'     { $out.TodayKind = '今天：工作日（正处在高峰时段）' }
        'off-window' { $out.TodayKind = '今天：工作日' }
        default      { $out.TodayKind = '' }
    }

    # 复核：节假日撞上周末时 reason 会说 weekend，这里补一句
    if ([string]$v.reason -eq 'weekend' -and (Test-HolidayToday $Dir)) {
        $out.TodayKind = '今天：法定节假日（也正好是周末）'
    }

    $out.Ok = $true
    return [pscustomobject]$out
}

# ---------------------------------------------------------------- DSH 地址（只读展示）
#
# 【为什么这一项从"输入框"变成"只读"】
#   旧界面让用户自己填 DSH 地址，而且默认值写死 http://127.0.0.1:2278。
#   但 DSH 的端口每次启动都可能不同，那个 2278 早就没在监听了；
#   而且插件本来就会把真实地址自动写进 settings.json 的 dshUrl
#   （index.js 的 syncDshUrl，失败会退避重试）。
#   所以用户根本不需要填，填了反而容易填错。
#
# 【⚠️ 关键：拿不到时绝对不能显示 2278】
#   如果还没拿到（插件刚启动 / 真的失败了），要明确说"正在获取"或"未获取到"。
#   显示一个失效的旧地址比什么都不显示更糟 —— 用户会以为那是对的。
function Get-DshUrlReadout {
    param([string]$Dir)
    $s = Read-JsonShared (Join-Path $Dir 'settings.json')
    $u = ''
    if ($null -ne $s) { $u = [string](Get-Setting $s 'dshUrl' '') }
    $u = $u.Trim()

    if ($u -eq '') {
        return [pscustomobject]@{
            Got      = $false
            Text     = '正在获取…（插件会在 DSH 启动后自动填入）'
            HasStale = $false
        }
    }
    # 2278 是旧版本写死的默认值，那个端口早已不在监听。
    # 如果文件里还是它，说明插件还没成功写入过 —— 如实说明，不要冒充有效地址。
    if ($u -match '127\.0\.0\.1:2278/?$') {
        return [pscustomobject]@{
            Got      = $false
            Text     = '未获取到（文件里还是旧版默认值，插件尚未成功写入）'
            HasStale = $true
        }
    }
    return [pscustomobject]@{
        Got      = $true
        Text     = ('自动获取：' + $u)
        HasStale = $false
    }
}

# ---------------------------------------------------------------- 保存（B2 + B3 的修法）
#
# 【B2：为什么不能整份重建 json】
#   旧代码这样写：
#       $payload = [ordered]@{ valley=...; alternateSeconds=...; ... }
#       $payload | ConvertTo-Json | WriteAllText(...)
#   字典里没有的键就被静默抹掉了。实测已经丢过一次 openMode
#   （插件 index.js 会写这个键，设置界面一保存就没了）。
#   现在改成：先把文件里现有的**所有**键原样带出来，再覆盖本界面负责的那几个。
#   这样以后不管谁往 settings.json 里加新键，都不会被这个界面吃掉。
#
# 【B3：为什么要写 tmp 再改名】
#   卡片每 500ms 读一次 settings.json。直接 WriteAllText 是"截断 + 重写"，
#   正好撞上读取的瞬间，卡片会读到半截 json →
#   ConvertFrom-Json 失败 → $settings = $null → 一帧内所有设置回默认。
#   改成"写 tmp 再改名"之后，改名是原子操作：
#   别人要么看到完整的旧内容，要么看到完整的新内容，不存在中间态。
#   （插件 writer.js、卡片心跳都是这个做法）
#
# 【PS 5.1 注意】
#   PS 5.1 没有 [IO.File]::Move(a, b, $true) 三参数重载，会抛"找不到 Move 的重载"。
#   用 Move-Item -Force（卡片心跳也是这么写的，已在真机跑很久）。
function Save-Settings {
    param(
        [string]$Path,
        $Current,
        [hashtable]$Values
    )

    # ---- 1. 先把文件里已有的键原样带出来（不认识的也带着，别丢）
    $payload = [ordered]@{}
    if ($null -ne $Current) {
        foreach ($pp in $Current.PSObject.Properties) { $payload[$pp.Name] = $pp.Value }
    }

    # ---- 2. 明确删掉已废弃的键
    #   valley：峰谷改由 lib/valley.js 自动算，settings.json 里那份手填配置不再使用。
    #           留着会让人以为还有用（而且卡片 Panel.ps1 的回落逻辑会读到一份错的旧表）。
    #   cardHeight：展开高度是假的（高度由行数决定），不再写入。
    #   openMode：**不删也不改** —— 插件会写它，虽然目前卡片没真正用到，
    #             但那是别人的键，本界面不碰。
    $payload.Remove('valley')
    $payload.Remove('cardHeight')

    # ---- 3. 写入本界面负责的键
    $payload['alternateSeconds'] = [int]$Values.alternateSeconds
    $payload['cardWidth']        = [int]$Values.cardWidth
    $payload['miniHeight']       = [int]$Values.miniHeight
    $payload['glassOpacity']     = [int]$Values.glassOpacity
    $payload['snapToEdge']       = [bool]$Values.snapToEdge
    $payload['edgeMargin']       = [int]$Values.edgeMargin
    $payload['clickOpensDsh']    = [bool]$Values.clickOpensDsh

    # ---- 悬浮窗审批（v0.9.0）
    #   这两个键是插件侧的"真源"。写进去之后，插件的 approvalInlineEnabled()
    #   会在下一次调用时（按 mtime 判断）读到新值，不用重启 DSH。
    #
    #   ⚠️ 只在 $Values 里真的带了这两个键时才写 —— 这样以后如果别的地方
    #   调用 Save-Settings 但不想碰审批开关（比如只改外观），也不会被误清成默认值。
    if ($Values.ContainsKey('approvalInline')) {
        $payload['approvalInline'] = [bool]$Values.approvalInline
    }
    if ($Values.ContainsKey('approvalConfirm')) {
        $payload['approvalConfirm'] = [bool]$Values.approvalConfirm
    }

    # ---- 4. 原子写：写 tmp 再改名
    $json = $payload | ConvertTo-Json -Depth 8
    $tmp = "$Path.tmp"
    # 关键：UTF8Encoding($false) —— 绝不能带 BOM。
    # settings.json 带 BOM 会让 node 的 JSON.parse 直接抛错（第四轮事故）。
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))

    try {
        Move-Item -LiteralPath $tmp -Destination $Path -Force -ErrorAction Stop
    }
    catch {
        # 极少数情况下改名会被占用挡一下，退化为"复制 + 删"，仍然不会写到半个文件
        Copy-Item -LiteralPath $tmp -Destination $Path -Force
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        # 【A 档：必须记，但用 WARN 不用 ERR】
        #   走到这里说明已经降级：结果仍然是对的，但"复制"不是原子操作 ——
        #   卡片每 500ms 读一次 settings.json，极小概率读到半截（B3 那个坑正是这个）。
        #   而且它出现本身就说明有别的进程正占着 settings.json，
        #   这往往就是"我保存了但卡片没反应"的现场证据。
        Write-SettingsLog ('改名保存失败，已退化为复制+删除（非原子，可能被读到半截）: ' + $_.Exception.Message) -Level 'WARN'
    }
}

# ---------------------------------------------------------------- 读当前配置
# 读不到就用默认值 —— 不能因为一个坏文件就让设置界面打不开
$settings = Read-JsonShared $SettingsPath
if ($null -eq $settings) {
    # 【A 档：必须记】
    #   读不到配置 → 下面每一项都回默认值，用户看到的是"我的设置全变回默认了"
    #   —— 这是设置窗口最容易被投诉的现象之一，必须留下证据。
    # 【为什么要把两种情况分开记】
    #   文件不存在 = 首次使用，正常（WARN 就够）；
    #   文件存在却解析不出来 = 真故障（ERR）。而且用户点一下保存就会把坏文件
    #   覆盖掉，事后再也查不出来 —— 所以这一刻必须记下来。
    if (Test-Path -LiteralPath $SettingsPath) {
        Write-SettingsLog ('读取设置失败（文件存在但解析不出来），本次全部使用默认值: ' + $SettingsPath) -Level 'ERR'
    } else {
        Write-SettingsLog ('设置文件不存在，本次全部使用默认值: ' + $SettingsPath) -Level 'WARN'
    }
    $defaultSettings = Join-Path $ScriptDir 'settings.json'
    if (Test-Path $defaultSettings) {
        try { Copy-Item $defaultSettings $SettingsPath -Force }
        catch {
            # 【A 档：必须记】连默认文件都复制不过来 → 数据目录很可能写不了，
            # 下面用户一保存就会失败。
            Write-SettingsLog ('读取设置失败后，复制默认设置也失败: ' + $_.Exception.Message) -Level 'ERR'
        }
        $settings = Read-JsonShared $SettingsPath
    }
}

$curAlt   = [int](Get-Setting $settings 'alternateSeconds' 20)
$curWidth = [int](Get-Setting $settings 'cardWidth' 260)
$curMini  = [int](Get-Setting $settings 'miniHeight' 96)
$curGlass = [int](Get-Setting $settings 'glassOpacity' 80)
$curEdge  = [int](Get-Setting $settings 'edgeMargin' 8)
$curSnap  = [bool](Get-Setting $settings 'snapToEdge' $true)
$curClick = [bool](Get-Setting $settings 'clickOpensDsh' $true)

# ---- 悬浮窗审批（v0.9.0 新增）
#
# 【为什么这两个键必须能在设置界面里改】
#   默认值在 lib/paths.js 的 DEFAULTS 里是 approvalInline=false（安全侧默认关）。
#   但 paths.js 第 102-107 行写得很清楚：**开关的真源是数据目录里的 settings.json**，
#   DEFAULTS 只是"settings.json 里缺这个键时的兜底"。
#   插件侧 index.js 的 approvalInlineEnabled() 会读 settings.json 并按 mtime 缓存，
#   所以在这里写进去 → 插件那边不用重启 DSH 就能生效。
#
#   之前这个界面没有这两个开关，导致 settings.json 里永远不出现这个键，
#   插件就一直用 false → 永远走 next() 让路 → 卡片永远只显示"去处理"。
#   整条链路是通的，只差这一个开关。这就是这次要补的。
$curApprovalInline  = [bool](Get-Setting $settings 'approvalInline' $false)
$curApprovalConfirm = [bool](Get-Setting $settings 'approvalConfirm' $true)

# 夹到界面支持的范围内（防止配置文件里是手改的怪值导致滑块超出范围报错）
if ($curAlt   -lt 5)    { $curAlt = 5 }
if ($curAlt   -gt 120)  { $curAlt = 120 }
if ($curWidth -lt 200)  { $curWidth = 200 }
if ($curWidth -gt 360)  { $curWidth = 360 }
if ($curMini  -lt 72)   { $curMini = 72 }
if ($curMini  -gt 160)  { $curMini = 160 }
if ($curGlass -lt 24)   { $curGlass = 24 }
if ($curGlass -gt 144)  { $curGlass = 144 }
if ($curEdge  -lt 0)    { $curEdge = 0 }
if ($curEdge  -gt 60)   { $curEdge = 60 }

# ---------------------------------------------------------------- 启动记录
#
# 【为什么必须有这一行】
#   旧版本 settings.log 从来不存在，根因就是"成功路径一行都不写"。
#   有了这一行，用户报"设置窗口打不开 / 我改了没生效"时，
#   第一件能确认的事就是：他到底成功打开过没有、读到的是哪一份配置。
#   （卡片那边加"启动横幅"是同一个道理 —— 那次事故是"改了代码让用户重启，
#   日志里看不出到底重启没重启"。）
$script:StartValues = [ordered]@{
    alternateSeconds = $curAlt
    cardWidth        = $curWidth
    miniHeight       = $curMini
    glassOpacity     = $curGlass
    snapToEdge       = $curSnap
    edgeMargin       = $curEdge
    clickOpensDsh    = $curClick
    approvalInline   = $curApprovalInline
    approvalConfirm  = $curApprovalConfirm
}
Write-SettingsLog ('用户: 打开设置窗口。数据目录=' + $DataDir + '，配置文件=' + $SettingsPath + '，读到的设置: ' + (ConvertTo-SettingsKv $script:StartValues))

# ---------------------------------------------------------------- 应用与兜底网
#
# 【B5：本文件原先完全没有异常兜底】
#   卡片 Panel.ps1 有 Add_DispatcherUnhandledException 这张网，Settings.ps1 没有。
#   任何一个回调抛异常（写盘被占用、ConvertTo-Json 遇到循环引用……），
#   用户看到的就是 "PowerShell 已停止工作"，而且什么都没记下来，无从排查。
#   这里照卡片的做法装一张网，异常写进 settings.log。
#
#   顺序很重要：Application 必须在任何 Window 之前创建，
#   兜底网也要在窗口之前装好，否则窗口初始化阶段抛的异常没人接。
$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnLastWindowClose'

$app.Add_DispatcherUnhandledException({
    param($sender, $e)
    try {
        $ex = $e.Exception
        Write-SettingsLog ('未捕获异常（设置窗口继续运行）: ' + $ex.GetType().Name + ' / ' + $ex.Message) -Level 'ERR'
    } catch {
        # 【C 档：故意静默】这里已经是"异常处理器内部"了。
        # 再抛出去 WPF 必退；而且这里能失败通常是因为日志系统本身坏了，
        # 在坏掉的日志系统里再写日志没有意义，只会套娃。
    }
    # 吞掉，让消息循环继续跑。不吞的话 WPF 会直接退出整个应用。
    $e.Handled = $true
})

# ---------------------------------------------------------------- XAML 界面
#
# 【为什么用 XAML 而不是像旧版那样一个个 New-Object】
#   开关、滑块、滚动条这类控件用 ControlTemplate 写比一条条 New-Object 短得多，
#   而且能直接拿到 hover / pressed 状态。旧版所有按钮都没有 hover 态，点起来"没手感"。
#
# 【注意：这里是单引号 here-string】
#   双引号 here-string 会让 PowerShell 去插值 $ 和 {}，{TemplateBinding ...}
#   之类会被搞坏。必须单引号。
#
# 【注意：注释里不能用连续短横线】
#   XML 规范禁止注释内出现连续两个短横线，否则 XamlReader.Parse 直接抛
#   "XML 注释中不能包含 --"。所以下面分隔注释一律用 ====。
$xamlUI = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="DSH 卡片设置"
        WindowStyle="None" ResizeMode="NoResize"
        AllowsTransparency="False" ShowInTaskbar="True"
        WindowStartupLocation="CenterScreen"
        Width="560" Height="660"
        FontFamily="Microsoft YaHei UI, Segoe UI"
        FontSize="12"
        Background="Transparent">

  <Window.Resources>

    <!-- ==== 分组卡片：对齐 PanelVisual.ps1 的 圆角8 + 1px 边框 ==== -->
    <Style x:Key="Card" TargetType="Border">
      <Setter Property="CornerRadius" Value="8"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Padding" Value="14"/>
      <Setter Property="Margin" Value="0,0,0,10"/>
    </Style>

    <!-- ==== 文字 ==== -->
    <Style x:Key="GroupTitle" TargetType="TextBlock">
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Margin" Value="0,0,0,2"/>
    </Style>

    <Style x:Key="RowLabel" TargetType="TextBlock">
      <Setter Property="FontSize" Value="12.5"/>
      <Setter Property="VerticalAlignment" Value="Center"/>
    </Style>

    <Style x:Key="Hint" TargetType="TextBlock">
      <Setter Property="FontSize" Value="11"/>
      <Setter Property="TextWrapping" Value="Wrap"/>
      <Setter Property="Margin" Value="0,6,0,0"/>
      <Setter Property="LineHeight" Value="17"/>
    </Style>

    <Style x:Key="ValueText" TargetType="TextBlock">
      <Setter Property="FontSize" Value="11"/>
      <Setter Property="MinWidth" Value="46"/>
      <Setter Property="TextAlignment" Value="Right"/>
      <Setter Property="VerticalAlignment" Value="Center"/>
    </Style>

    <!-- ==== 主按钮（蓝色实心）==== -->
    <Style x:Key="BtnPrimary" TargetType="Button">
      <Setter Property="Height" Value="32"/>
      <Setter Property="MinWidth" Value="88"/>
      <Setter Property="Foreground" Value="#FFFFFF"/>
      <Setter Property="FontSize" Value="12.5"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bg" CornerRadius="6" Background="#2F6FE4">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bg" Property="Background" Value="#2A63CE"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="bg" Property="Background" Value="#2456B4"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter TargetName="bg" Property="Opacity" Value="0.45"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- ==== 次按钮（描边，颜色运行时可调）==== -->
    <Style x:Key="BtnGhost" TargetType="Button">
      <Setter Property="Height" Value="32"/>
      <Setter Property="MinWidth" Value="86"/>
      <Setter Property="FontSize" Value="12.5"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="BorderBrush" Value="#338A93A0"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bg" CornerRadius="6" Background="Transparent"
                    BorderThickness="1" BorderBrush="{TemplateBinding BorderBrush}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bg" Property="Background" Value="#148A93A0"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="bg" Property="Background" Value="#228A93A0"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- ==== 标题栏关闭按钮 ==== -->
    <Style x:Key="BtnTitleClose" TargetType="Button">
      <Setter Property="Width" Value="28"/>
      <Setter Property="Height" Value="28"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bg" CornerRadius="6" Background="Transparent">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bg" Property="Background" Value="#E04040"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- ==== 开关（自绘 ToggleButton，38x22）==== -->
    <Style x:Key="Switch" TargetType="ToggleButton">
      <Setter Property="Width" Value="38"/>
      <Setter Property="Height" Value="22"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ToggleButton">
            <Grid>
              <Border x:Name="track" CornerRadius="11" Background="#338A93A0"/>
              <Ellipse x:Name="knob" Width="16" Height="16" Fill="#FFFFFF"
                       HorizontalAlignment="Left" Margin="3,0,0,0"/>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsChecked" Value="True">
                <Setter TargetName="track" Property="Background" Value="#2F6FE4"/>
                <Setter TargetName="knob" Property="HorizontalAlignment" Value="Right"/>
                <Setter TargetName="knob" Property="Margin" Value="0,0,3,0"/>
              </Trigger>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="track" Property="Opacity" Value="0.85"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter Property="Opacity" Value="0.4"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- ==== 细滑块 ==== -->
    <!-- Track 里三个部件必须写全：只放 Thumb、省掉两个 RepeatButton，
         Thumb 定位和"点轨道跳过去"都会失效（拖得动、点不动）。 -->
    <Style x:Key="SliderThin" TargetType="Slider">
      <Setter Property="Height" Value="22"/>
      <Setter Property="MinWidth" Value="150"/>
      <Setter Property="IsMoveToPointEnabled" Value="True"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Slider">
            <Grid VerticalAlignment="Center" Background="Transparent">
              <Border Height="4" CornerRadius="2" Background="#268A93A0"/>
              <Track x:Name="PART_Track" Orientation="Horizontal">
                <Track.DecreaseRepeatButton>
                  <RepeatButton Command="{x:Static Slider.DecreaseLarge}" Opacity="0" Focusable="False" IsTabStop="False"/>
                </Track.DecreaseRepeatButton>
                <Track.Thumb>
                  <Thumb Width="14" Height="14" Cursor="Hand">
                    <Thumb.Template>
                      <ControlTemplate TargetType="Thumb">
                        <Ellipse Fill="#FFFFFF" Stroke="#552F6FE4" StrokeThickness="1"/>
                      </ControlTemplate>
                    </Thumb.Template>
                  </Thumb>
                </Track.Thumb>
                <Track.IncreaseRepeatButton>
                  <RepeatButton Command="{x:Static Slider.IncreaseLarge}" Opacity="0" Focusable="False" IsTabStop="False"/>
                </Track.IncreaseRepeatButton>
              </Track>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- ==== 细滚动条 ==== -->
    <Style x:Key="ScrollThin" TargetType="ScrollBar">
      <Setter Property="Width" Value="6"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ScrollBar">
            <Grid Background="Transparent">
              <Track x:Name="PART_Track" IsDirectionReversed="True">
                <Track.DecreaseRepeatButton>
                  <RepeatButton Command="{x:Static ScrollBar.PageUpCommand}" Opacity="0" Focusable="False" IsTabStop="False"/>
                </Track.DecreaseRepeatButton>
                <Track.Thumb>
                  <Thumb>
                    <Thumb.Template>
                      <ControlTemplate TargetType="Thumb">
                        <Border CornerRadius="3" Background="#338A93A0"/>
                      </ControlTemplate>
                    </Thumb.Template>
                  </Thumb>
                </Track.Thumb>
                <Track.IncreaseRepeatButton>
                  <RepeatButton Command="{x:Static ScrollBar.PageDownCommand}" Opacity="0" Focusable="False" IsTabStop="False"/>
                </Track.IncreaseRepeatButton>
              </Track>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style TargetType="ScrollBar" BasedOn="{StaticResource ScrollThin}"/>
  </Window.Resources>

  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="44"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="60"/>
    </Grid.RowDefinitions>

    <!-- ==== 自绘标题栏（可拖动）==== -->
    <Border x:Name="TitleBar" Grid.Row="0" Background="Transparent">
      <Grid Margin="14,0,8,0">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <TextBlock x:Name="TitleText" Text="卡片设置" FontSize="13"
                   FontWeight="SemiBold" VerticalAlignment="Center"/>
        <Button x:Name="BtnClose" Grid.Column="1" Content="&#x2715;"
                Style="{DynamicResource BtnTitleClose}" ToolTip="关闭（Esc）"/>
      </Grid>
    </Border>

    <!-- ==== 内容区（可滚动）==== -->
    <ScrollViewer x:Name="ScrollHost" Grid.Row="1"
                  VerticalScrollBarVisibility="Auto"
                  HorizontalScrollBarVisibility="Disabled"
                  Padding="14,4,14,0">
      <StackPanel x:Name="Groups"/>
    </ScrollViewer>

    <!-- ==== 底栏 ==== -->
    <Border Grid.Row="2" Padding="14,0,14,0">
      <Grid>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <TextBlock x:Name="StatusText" VerticalAlignment="Center" FontSize="11"
                   TextTrimming="CharacterEllipsis"/>
        <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Center">
          <Button x:Name="BtnReset" Content="恢复默认" Style="{DynamicResource BtnGhost}" Margin="0,0,8,0"/>
          <Button x:Name="BtnSave"  Content="保存"     Style="{DynamicResource BtnPrimary}" IsDefault="True"/>
        </StackPanel>
      </Grid>
    </Border>
  </Grid>
</Window>
'@

$win = [System.Windows.Markup.XamlReader]::Parse($xamlUI)
$winRes = $win.Resources

# 把要反复用的控件引用存成 $script:。
# 为什么一定要 $script:：事件回调里读不到函数的局部变量
# （第三轮"点一下卡片就消失"事故的根因，交接文档 2.8 有完整记录）。
$script:winRef      = $win
$script:GroupsHost  = $win.FindName('Groups')
$script:TitleBarEl  = $win.FindName('TitleBar')
$script:BtnCloseEl  = $win.FindName('BtnClose')
$script:BtnResetEl  = $win.FindName('BtnReset')
$script:BtnSaveEl   = $win.FindName('BtnSave')
$script:StatusText  = $win.FindName('StatusText')
$script:DataDirPath = $DataDir
$script:SettingsPathRef = $SettingsPath

if ($null -eq $script:GroupsHost) { throw 'XAML 里没找到名为 Groups 的容器' }

$script:themed     = New-Object System.Collections.ArrayList
$script:sliderRows = New-Object System.Collections.ArrayList

# 窗口高度自适应：200% 缩放下 660 逻辑像素够用，但小屏笔记本要收一下
$wa = [System.Windows.SystemParameters]::WorkArea
$win.Height = [math]::Min(660, [int]($wa.Height * 0.85))
if ($win.Height -lt 480) { $win.Height = 480 }

# ---------------------------------------------------------------- 建界面的小工具
#
# 说明：XAML 只给"壳 + 样式"，具体每行用 PowerShell 建。
# 原因是行数随配置变化，而且要把控件的引用留给保存/刷新逻辑，
# 用 XAML 全写死反而更绕。

# 建一个分组卡片，返回它的内容容器（往里加行）
function New-Group {
    param([string]$Title)

    $card = New-Object System.Windows.Controls.Border
    $card.Style = $winRes['Card']

    $stack = New-Object System.Windows.Controls.StackPanel

    $t = New-Object System.Windows.Controls.TextBlock
    $t.Text = $Title
    $t.Style = $winRes['GroupTitle']
    [void]$stack.Children.Add($t)

    $card.Child = $stack
    [void]$script:GroupsHost.Children.Add($card)

    # 登记到主题表，Apply-Theme 时统一染色
    [void]$script:themed.Add([pscustomobject]@{ El = $card; Role = 'card' })
    [void]$script:themed.Add([pscustomobject]@{ El = $t;    Role = 'primary' })

    return $stack
}

# 加一行：左标签 + 右控件
function Add-Row {
    param($Group, [string]$Label, $Control)

    $row = New-Object System.Windows.Controls.Grid
    $row.Margin = New-Object System.Windows.Thickness(0, 9, 0, 1)
    [void]$row.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))

    $c2 = New-Object System.Windows.Controls.ColumnDefinition
    $c2.Width = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
    [void]$row.ColumnDefinitions.Add($c2)

    $lbl = New-Object System.Windows.Controls.TextBlock
    $lbl.Text = $Label
    $lbl.Style = $winRes['RowLabel']
    [System.Windows.Controls.Grid]::SetColumn($lbl, 0)
    [void]$row.Children.Add($lbl)

    $wrap = New-Object System.Windows.Controls.StackPanel
    $wrap.Orientation = 'Horizontal'
    $wrap.HorizontalAlignment = 'Right'
    $wrap.VerticalAlignment = 'Center'
    if ($null -ne $Control) { [void]$wrap.Children.Add($Control) }
    [System.Windows.Controls.Grid]::SetColumn($wrap, 1)
    [void]$row.Children.Add($wrap)

    [void]$Group.Children.Add($row)
    [void]$script:themed.Add([pscustomobject]@{ El = $lbl; Role = 'label' })

    return $row
}

# 一行：标签 + 滑块 + 右侧数值
#
# 【返回值里的 Slider / ValueText 一定要留着】
#   保存时靠 $script:slXxx.Slider.Value 读取，
#   所以调用方必须把返回值存进 $script: 变量（见下面装配部分）。
function Add-SliderRow {
    param(
        $Group, [string]$Label,
        [double]$Min, [double]$Max, [double]$Step, [double]$Value,
        [string]$Unit = '', [string]$Fmt = '{0}'
    )

    $sl = New-Object System.Windows.Controls.Slider
    $sl.Style = $winRes['SliderThin']
    $sl.Minimum = $Min
    $sl.Maximum = $Max
    $sl.SmallChange = $Step
    $sl.LargeChange = $Step
    $sl.TickFrequency = $Step
    $sl.IsSnapToTickEnabled = $true
    $sl.Value = $Value

    $vt = New-Object System.Windows.Controls.TextBlock
    $vt.Style = $winRes['ValueText']
    $vt.Text = ($Fmt -f $Value) + $Unit
    $vt.Margin = New-Object System.Windows.Thickness(10, 0, 0, 0)

    $box = New-Object System.Windows.Controls.StackPanel
    $box.Orientation = 'Horizontal'
    [void]$box.Children.Add($sl)
    [void]$box.Children.Add($vt)

    $row = Add-Row -Group $Group -Label $Label -Control $box

    $binding = [pscustomobject]@{ Slider = $sl; ValueText = $vt; Row = $row; Fmt = $Fmt; Unit = $Unit }
    [void]$script:sliderRows.Add($binding)

    # 拖滑块时实时更新右边数字。
    #
    # 【这个回调为什么这样写】
    #   1) 绝不能读 $binding / $vt / $Fmt 这些**函数局部变量**：
    #      回调执行时函数早返回了，读到 $null，接着 $null.xxx 就抛异常；
    #      而这个回调不在任何函数上下文里，异常没人接 → WPF 退出整个应用。
    #      （第三轮"点一下卡片就消失"就是这个机制）
    #   2) 所以只能拿事件参数 $s（滑块本身）去 $script:sliderRows 里反查。
    #   3) $script:sliderRows 必须存在 $script: 里，否则回调也看不到。
    #
    # 【注意后缀】
    #   「贴边留白」被禁用时，数值后面带着「 · 已禁用」。
    #   如果这里无脑重写，一拖滑块后缀就没了（而且禁用时还能拖动 = 矛盾）。
    #   所以这里判断一下：禁用的那行交给 Update-EdgeRowDisabledHint 统一管。
    $sl.add_ValueChanged({
        param($s, $e)
        try {
            foreach ($b in $script:sliderRows) {
                if ([object]::ReferenceEquals($b.Slider, $s)) {
                    if ($s.IsEnabled) {
                        $b.ValueText.Text = ($b.Fmt -f $s.Value) + $b.Unit
                    }
                    else {
                        # 禁用态的文案由 Update-EdgeRowDisabledHint 负责，这里只更新数值部分
                        # 【C 档：故意静默，不要改成记日志】
                        #   拖动一个滑块会触发上百次 ValueChanged。这里失败最多是
                        #   右侧那个数字没跟着变，下一次拖动就恢复了，用户基本看不出来。
                        #   真记了日志，拉一次滑块就能刷几十行，把有用的记录全冲掉。
                        #   （真正的安全网在下面外层那个 catch —— 而它也是故意静默的）
                        try { Update-EdgeRowDisabledHint } catch { }
                    }
                    break
                }
            }
        } catch {
            # 【C 档：故意静默，不要改成记日志】
            #   同上：这是 ValueChanged 的外层，同样一次拖动上百次触发。
            #   真出问题时先改 Update-EdgeRowDisabledHint 里那层，别在这里加。
        }
    })

    [void]$script:themed.Add([pscustomobject]@{ El = $vt; Role = 'tertiary' })
    return $binding
}

# 一行：标签 + 开关
function Add-SwitchRow {
    param($Group, [string]$Label, [bool]$Value)

    $sw = New-Object System.Windows.Controls.Primitives.ToggleButton
    $sw.Style = $winRes['Switch']
    $sw.IsChecked = $Value
    Add-Row -Group $Group -Label $Label -Control $sw | Out-Null
    return $sw
}

# 一行：纯文字（可换行，用于说明）
function Add-TextRow {
    param($Group, [string]$Text, [string]$Key = 'tertiary', [double]$Size = 11)

    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.Text = $Text
    $tb.Style = $winRes['Hint']
    $tb.FontSize = $Size
    [void]$Group.Children.Add($tb)
    [void]$script:themed.Add([pscustomobject]@{ El = $tb; Role = $Key })
    return $tb
}

# ---------------------------------------------------------------- 装配界面
#
# 顺序：先建所有控件 → 再 Apply-Theme → 再绑事件。
# 为什么主题放在中间：Apply-Theme 要遍历 $script:themed，
# 控件没建完就调，后建的不会被染色。

# ==== 分组一：外观 ====
$gLook = New-Group '外观'

$script:slGlass = Add-SliderRow $gLook '磨砂浓度' 24 144 4 $curGlass
Add-TextRow $gLook '往左更透（能看到背后的壁纸），往右更奶白（字更清楚）。' 'tertiary' 11 | Out-Null

$script:slAlt = Add-SliderRow $gLook '轮播间隔' 5 120 5 $curAlt -Unit ' 秒'
Add-TextRow $gLook '空闲时那条小扁条，每隔多久在「今日 Token」和「谷时倒计时」之间换一次。' 'tertiary' 11 | Out-Null

# ==== 分组二：尺寸 ====
$gSize = New-Group '尺寸'

# 宽度范围取 200-360（用户拍板"保留可改、给窄范围"）。
# 不能给太宽：卡片里字的位置、行高、留白都是照 260 排的，
# 改太多会挤；而且 1:1.414 的 A4 比例只有 260 时才成立。
$script:slWidth = Add-SliderRow $gSize '卡片宽度' 200 360 10 $curWidth
$script:slMini  = Add-SliderRow $gSize '收起高度' 72 160 4 $curMini
Add-TextRow $gSize '宽度的 1:1.414 比例只在 260 时成立，改大改小会让比例变化，这是正常的。' 'tertiary' 11 | Out-Null
Add-TextRow $gSize '卡片高度会按「里面有几行任务」自动算（98 + 54 × 行数），不需要你填。' 'tertiary' 11 | Out-Null

# ==== 分组三：行为 ====
$gAct = New-Group '行为'

$script:swClick = Add-SwitchRow $gAct '点卡片回到 DSH' $curClick
$script:swSnap  = Add-SwitchRow $gAct '贴到屏幕边缘' $curSnap
$script:slEdge  = Add-SliderRow $gAct '贴边留白' 0 60 2 $curEdge -Unit ' 像素'


# ---------------------------------------------------------------- 禁用态的视觉表达
#
# 【为什么要单独处理这个】
#   「贴边留白」在"贴到屏幕边缘"关掉时会被禁用。原先只把滑块本身设
#   IsEnabled=$false（XAML 里 opacity 0.4），标签和数值文字**保持原色**。
#
#   这带来两个问题：
#     1. 用户看不出这一项为什么不能拖（只有滑块变淡，容易以为是坏了）
#     2. 如果为了"看起来禁用"而把文字也调淡，会跌破可读性门槛 ——
#        实测：把 tertiary #484C53 按 opacity 0.6 叠在背景 #C0BDBB 上，
#        对比度从 4.62 掉到 2.33，远低于 4.5。
#
#   所以采取："文字颜色不动（保可读），用文案标注状态"。
#   这样既看得出来是被禁用，又不会牺牲可读性。
function Update-EdgeRowDisabledHint {
    try {
        if ($null -eq $script:slEdge) { return }
        $enabled = ($script:slEdge.Slider.IsEnabled -eq $true)
        if ($enabled) {
            $script:slEdge.ValueText.Text = ('{0} 像素' -f [int]$script:slEdge.Slider.Value)
        }
        else {
            $script:slEdge.ValueText.Text = ('{0} 像素 · 已禁用' -f [int]$script:slEdge.Slider.Value)
        }
    } catch {
        # 【C 档：故意静默，不要改成记日志】
        #   本函数由滑块 ValueChanged 调用，拖动时一次上百次。
        #   失败最多是"· 已禁用"这个小后缀没更新，用户几乎看不出，而且下次就修正了。
    }
}
# 初始同步一次：开关关着的时候，边距滑块应该是灰的。
# 只在点击时同步是不够的 —— 打开窗口时若开关是关的、滑块却能拖，会让人以为坏了。
$script:slEdge.Slider.IsEnabled = ($curSnap -eq $true)
# 同时把"已禁用"后缀写上（函数定义见下面"禁用态的视觉表达"一节，
# 已挪到本行之前 —— PowerShell 没有 JS 那样的函数提升，必须先定义后调用）
Update-EdgeRowDisabledHint

Add-TextRow $gAct '「贴边留白」只在开着「贴到屏幕边缘」时才生效。' 'tertiary' 11 | Out-Null

# ==== 分组三：审批（v0.9.0 新增）====
#
# 【为什么单独一个分组，不塞进「行为」】
#   这是唯一一个**涉及安全**的开关：打开之后，悬浮窗上的「允许」
#   会直接放行 DSH 里要执行的操作。单独成组 + 一段风险说明，
#   让用户知道自己在开什么，而不是混在一堆外观设置里被随手拨开。
#
# 【为什么默认关】
#   审批是安全闸门。插件侧 DEFAULTS 也是 false。
#   这里保持一致：settings.json 里没这个键时，界面显示为关。

# 联动：approvalConfirm 只在 approvalInline 打开时可用。
#
# 【为什么必须"先定义后调用"】
#   上一轮踩过：PowerShell 是顺序执行的，没有 JS 那样的函数提升。
#   函数定义必须出现在第一次调用之前，否则报"不是 cmdlet"，
#   而且会导致整个脚本在建窗口之前就死掉。
function Update-ApprovalConfirmState {
    try {
        if ($null -eq $script:swApprovalConfirm) { return }
        $on = ($script:swApprovalInline.IsChecked -eq $true)
        $script:swApprovalConfirm.IsEnabled = $on
        # 数值/状态文字补一句（和「贴边留白」那套做法一致）：
        # 文字颜色不动（保对比度），用文案说明为什么点不了。
        if ($null -ne $script:stApprovalConfirmHint) {
            if ($on) {
                $script:stApprovalConfirmHint.Text = '打开时，点「允许」前会再问你一次，防止误点。'
            }
            else {
                $script:stApprovalConfirmHint.Text = '上面那个关着的时候，这一项用不上（已禁用）。'
            }
        }
    } catch {
        # 【A 档：必须记】这里管的是**审批安全开关**的联动状态。
        # 失败 → "点允许前再确认一次"可能在该禁用时还能点、或反之，
        # 界面显示和真实生效状态对不上。涉及审批安全，必须留痕。
        # 只在点开关时触发，不会刷屏。
        Write-SettingsLog ('刷新审批开关联动状态失败: ' + $_.Exception.Message) -Level 'ERR'
    }
}

$gApproval = New-Group '审批'

$script:swApprovalInline = Add-SwitchRow $gApproval '在悬浮窗上直接审批' $curApprovalInline

# 风险说明：文案是定稿的，不改写。
# 颜色用专门的"警告色"而不是普通 tertiary —— 这段是安全相关内容，
# 用户是小白，颜色强调比纯文字更有效。
# 对比度实测：#753606 在浅色背景 4.91:1 / #FCD34D 在深色背景 5.20:1，都过 4.5。
$script:txtApprovalRisk = Add-TextRow $gApproval ('打开后，悬浮窗上的「允许」会直接放行 DSH 里要执行的操作，不用再回 DSH 确认。' + "`r`n" + '只在你信任这台电脑上运行的所有程序时打开。关掉后，悬浮窗只提供"去处理"跳转。') 'warn' 11
$script:txtApprovalRisk.Margin = New-Object System.Windows.Thickness(0, 6, 0, 4)

$script:swApprovalConfirm = Add-SwitchRow $gApproval '点「允许」前再确认一次' $curApprovalConfirm
$script:stApprovalConfirmHint = Add-TextRow $gApproval '打开时，点「允许」前会再问你一次，防止误点。' 'tertiary' 11

# 初始联动：approvalInline 关着时，confirm 那个置灰
$script:swApprovalConfirm.IsEnabled = ($curApprovalInline -eq $true)
Update-ApprovalConfirmState

# ==== 分组四：峰谷（只读，不用你填）====
$script:gValley = New-Group '峰谷（自动计算，不用填）'

$script:vbHead = Add-TextRow $script:gValley '正在读取…' 'primary' 13
$script:vbHead.FontWeight = [System.Windows.FontWeights]::SemiBold
$script:vbHead.Margin = New-Object System.Windows.Thickness(0, 6, 0, 0)

$script:vbDetail = Add-TextRow $script:gValley '' 'secondary' 11.5
$script:vbRule   = Add-TextRow $script:gValley (Get-ValleyRuleText) 'tertiary' 11
$script:vbRule.Margin = New-Object System.Windows.Thickness(0, 8, 0, 0)

# ==== 分组五：状态与连接 ====
$script:gStatus = New-Group '状态'

$script:stCard = Add-TextRow $script:gStatus '正在检查…' 'secondary' 11.5
$script:stCard.Margin = New-Object System.Windows.Thickness(0, 6, 0, 0)

# DSH 地址：只读展示（用户拍板：删输入框，改只读）
# 这一行是"插件有没有把真实地址写进来"的检查点。
$script:stUrl = Add-TextRow $script:gStatus '正在获取…' 'secondary' 11.5
$script:stUrl.Margin = New-Object System.Windows.Thickness(0, 4, 0, 0)

$script:stHoliday = Add-TextRow $script:gStatus '' 'tertiary' 11
$script:stHoliday.Margin = New-Object System.Windows.Thickness(0, 4, 0, 0)

# 「打开数据文件夹」按钮。做成左对齐的一行文字按钮，和上面几行视觉一致。
$btnDataDir = New-Object System.Windows.Controls.Button
$btnDataDir.Content = '打开数据文件夹'
$btnDataDir.Style = $winRes['BtnGhost']
$btnDataDir.HorizontalAlignment = 'Left'
$btnDataDir.Margin = New-Object System.Windows.Thickness(0, 10, 0, 2)
$btnDataDir.Height = 28
$btnDataDir.MinWidth = 120
$btnDataDir.FontSize = 11.5
[void]$script:gStatus.Children.Add($btnDataDir)
[void]$script:themed.Add([pscustomobject]@{ El = $btnDataDir; Role = 'primary' })

$btnDataDir.Add_Click({
    # 用 explorer 打开数据目录，方便用户自己取日志发给我们
    try {
        Start-Process 'explorer.exe' -ArgumentList $script:DataDirPath
    } catch {
        Write-SettingsLog ('打开数据文件夹失败: ' + $_.Exception.Message) -Level 'ERR'
    }
})

# ---------------------------------------------------------------- 深浅色
#
# 【为什么两张色板都写死，不用 SystemColors】
#   卡片是自己在代码里写死颜色的（Panel.ps1 的 $isDark 分支），
#   设置窗口也写死同一套值，两边才长得像一家人。
#   用 SystemColors 会跟着系统主题走，和卡片对不上。
#
# 色值来源：PanelVisual.ps1:4-9（ColTextPrimary 等）+ Panel.ps1 的 $isDark 分支。
#
# ----------------------------------------------------------------
# 【v0.7.1：小字对比度修复（用户实测反馈）】
#
# 用户原话："设置界面的小字在淡色背景下可读性不够。"
# 用 WCAG 2.1 相对亮度公式实测，确认他说得对，而且比想象的严重：
#
#   元素                 改前(浅色)  改前(深色)   门槛
#   ------------         ---------   ---------    ----
#   说明文字 tertiary      1.66 ❌      2.48 ❌     4.5
#   次要文字 secondary     3.16 ❌      3.97 ❌     4.5
#   正文 primary           9.50 ✅      6.82 ✅     4.5
#
# 【怎么算出这些数的】
#   设置窗口是磨砂的，背景不是纯色，而是
#       Acrylic tints (alpha=0xD0/255=0.8157)  叠  壁纸模糊色  叠  分组卡片底色
#   所以按"最坏情况"算：
#     浅色模式 → 壁纸取最暗（纯黑）→ 背景 #C0BDBB (L=0.5119)
#     深色模式 → 壁纸取最亮（纯白）→ 背景 #535555 (L=0.0899)
#   这两个背景是深色字/浅色字各自对比度最低的情形，拿它们算才安全。
#
# 【为什么三层都改了，而不是只压暗说明文字】
#   只压暗 tertiary 会把它压到和 secondary 一样重，界面就糊成一片、
#   层次全没了。而且 secondary 本身也不达标（3.16），一起排布更合理。
#
# 【改后（实测）】
#   元素                 浅色         深色
#   ------------         ---------    ---------
#   正文 primary         9.50 ✅      6.82 ✅   （没动）
#   次要 secondary       5.50 ✅      5.09 ✅
#   说明 tertiary        4.62 ✅      4.56 ✅
#
#   层次间距（相邻两层对比度差）：浅色 4.00 / 0.88，深色 1.73 / 0.53
#   → 都 > 0，逐层递减，层次仍然清楚（正文明显重于说明）。
#
# 【色相怎么保住的】
#   浅色那套是把原色 #8A93A0 整体按 0.52 缩放（R<G<B 的冷调关系不变），
#   深色那套是往白里按 0.5 插值。所以颜色"还是那个冷灰蓝"，只是明度合适了。
function New-ThemePalette {
    param([bool]$Dark)
    if ($Dark) {
        return @{
            primary  = '#F2F4F8'   # 对比度 6.82 (bg #535555)
            secondary= '#D1D5DA'   # 对比度 5.09  原 #B6BDC8 只有 3.97
            tertiary = '#C6CAD0'   # 对比度 4.56  原 #8C95A2 只有 2.48
            # warn：审批风险说明专用（v0.9.0）。琥珀色，一眼能看出"这是安全相关"。
            # 对比度 5.20（bg #535555），门槛 4.5，达标。
            warn     = '#FCD34D'
            cardBg   = '#14FFFFFF'
            cardEdge = '#28FFFFFF'
            tint     = 0x001A1A1E
        }
    }
    return @{
        primary  = '#16181D'       # 对比度 9.50 (bg #C0BDBB)
        secondary= '#3D4146'       # 对比度 5.50  原 #5B6573 只有 3.16
        tertiary = '#484C53'       # 对比度 4.62  原 #8A93A0 只有 1.66（最严重）
        # warn：审批风险说明专用（v0.9.0）。深琥珀。
        # 对比度 4.91（bg #C0BDBB），门槛 4.5，达标。
        # 为什么不直接用原色 #B45309 —— 它只有 2.69，远不够。必须压暗到 #753606。
        warn     = '#753606'
        cardBg   = '#0F000000'
        cardEdge = '#34FFFFFF'
        tint     = 0x00FAF6F4
    }
}

function ConvertTo-Brush {
    param([string]$Hex)
    # 接受 '#RRGGBB' 或 '#AARRGGBB'
    $h = $Hex.TrimStart('#')
    if ($h.Length -eq 6) { $h = 'FF' + $h }
    $a = [Convert]::ToByte($h.Substring(0, 2), 16)
    $r = [Convert]::ToByte($h.Substring(2, 2), 16)
    $g = [Convert]::ToByte($h.Substring(4, 2), 16)
    $b = [Convert]::ToByte($h.Substring(6, 2), 16)
    return [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb($a, $r, $g, $b))
}

function Apply-Theme {
    param([bool]$Dark)

    $pal = New-ThemePalette $Dark

    # 状态文字用的绿/红。绿在深色底上要更亮，否则读不清。
    # 状态文字用的绿/红。这两组也是 11-11.5pt 小字（"卡片运行中"/"已保存"/"未获取到"），
    # 门槛同样是 4.5:1，所以一起按 WCAG 实测调过：
    #
    #   元素            改前(浅)        改后(浅)         改前(深)        改后(深)
    #   ------------    ---------       ---------        ---------       ---------
    #   绿 BrushOk      2.24 ❌  #1E8E4A  4.76 ✅ #12552C  3.95 ❌ #6FCF97  4.65 ✅ #93DBB1
    #   红 BrushErr     3.23 ❌  #C0202A  4.81 ✅ #901820  3.38 ❌ #FF8D8D  4.67 ✅ #FFBBBB
    #
    # 【为什么不直接把原色加粗/加大字号回避】
    #   这两处文字本来就该是"次要信息"，加大字号会喧宾夺主；
    #   而状态色本来就是靠色相传达含义，压暗/提亮不改变它"是绿是红"。
    $script:BrushOk  = ConvertTo-Brush $(if ($Dark) { '#93DBB1' } else { '#12552C' })
    $script:BrushErr = ConvertTo-Brush $(if ($Dark) { '#FFBBBB' } else { '#901820' })

    foreach ($item in $script:themed) {
        try {
            switch ($item.Role) {
                'primary'   { $item.El.Foreground = ConvertTo-Brush $pal.primary }
                'label'     { $item.El.Foreground = ConvertTo-Brush $pal.primary }
                'secondary' { $item.El.Foreground = ConvertTo-Brush $pal.secondary }
                'tertiary'  { $item.El.Foreground = ConvertTo-Brush $pal.tertiary }
                'warn'      { $item.El.Foreground = ConvertTo-Brush $pal.warn }
                'card'      {
                    $item.El.Background  = ConvertTo-Brush $pal.cardBg
                    $item.El.BorderBrush = ConvertTo-Brush $pal.cardEdge
                }
            }
        } catch {
            # 【B 档：记，但要去重】
            #   染不上色 → 某几处文字保持默认黑/灰，和深色底撞在一起会很难看，
            #   用户会觉得"界面配色坏了"。
            # 但这个 catch 在 foreach 里：一旦失败往往是几十个元素一起失败，
            # 不设去重会一口气写几十行。60 秒只记一次就够定位了。
            Write-SettingsLog ('主题染色失败（某个元素）: ' + $_.Exception.Message) -Level 'WARN' -Key 'theme-element'
        }
    }

    # 标题栏几个元素不在 themed 表里，单独设
    try {
        $win.FindName('TitleText').Foreground  = ConvertTo-Brush $pal.primary
        $win.FindName('BtnClose').Foreground   = ConvertTo-Brush $pal.secondary
        $script:BtnResetEl.Foreground = ConvertTo-Brush $pal.primary
        $script:BtnSaveEl.Foreground  = ConvertTo-Brush '#FFFFFF'
        if ([string]::IsNullOrEmpty($script:StatusText.Text)) {
            $script:StatusText.Foreground = ConvertTo-Brush $pal.tertiary
        }
    } catch {
        # 【A 档：必须记】这里失败 → 标题文字、关闭按钮、底部两个按钮会是默认色。
        # "保存"按钮是蓝底白字，万一变成蓝底黑字就直接看不清了 ——
        # 用户会觉得"界面花了"。只在启动/切主题时跑一次，不会刷屏。
        Write-SettingsLog ('标题栏 / 底部按钮染色失败: ' + $_.Exception.Message) -Level 'ERR'
    }

    # 磨砂 tint 也要跟着换（深色底偏冷黑，浅色底偏暖白）
    if ($script:GlassOk -and $null -ne $script:hwnd -and $script:hwnd -ne [IntPtr]::Zero) {
        $tint = (([long]$script:TintAlpha) -shl 24) -bor $pal.tint
        # 【B 档：记，但要去重】失败 → 磨砂还是上一次的色调，深色模式下会偏色。
        # 一般只跑一次，但为了将来"运行时切主题"也不至于刷屏，加去重。
        try { [void][CardWin]::Acrylic($script:hwnd, $tint, 0) }
        catch {
            Write-SettingsLog ('更新磨砂色调失败: ' + $_.Exception.Message) -Level 'WARN' -Key 'theme-tint'
        }
    }
}

# ---------------------------------------------------------------- 刷新只读区
#
# 每 1 秒刷一次。峰谷倒计时和"卡片还活着吗"都需要跟着走。
function Update-ReadonlySections {
    try {
        $r = Get-ValleyReadout $script:DataDirPath

        if ($r.Ok) {
            $script:vbHead.Text   = $r.Headline
            $script:vbDetail.Text = "$($r.Detail)　·　$($r.TodayKind)"
        }
        else {
            $script:vbHead.Text   = $r.Headline
            $script:vbDetail.Text = $r.Detail
        }
        $script:vbRule.Text = $r.Rule

        # 状态区：卡片活没活 + 节假日数据情况
        $aliveText = if ($r.CardAlive) { '卡片运行中' } else { '卡片没在运行（下面这些数字可能不更新）' }
        $script:stCard.Text = $aliveText
        $script:stHoliday.Text = $r.HolidayInfo

        # DSH 地址：只读
        # 注意：拿不到时显示"正在获取"，绝不显示 2278 那个失效值。
        # 颜色分三档，让用户一眼看出是"已就绪"还是"还在等"：
        #   拿到了     -> 绿（BrushOk）
        #   还没拿到   -> 三级灰（正常的等待状态，不是错误）
        #   是失效旧值 -> 红（需要提示用户插件没写成功）
        $u = Get-DshUrlReadout $script:DataDirPath
        $script:stUrl.Text = $u.Text
        if ($u.Got) {
            $script:stUrl.Foreground = $script:BrushOk
        }
        elseif ($u.HasStale) {
            $script:stUrl.Foreground = $script:BrushErr
        }
        else {
            $script:stUrl.Foreground = ConvertTo-Brush (New-ThemePalette $script:isDark).tertiary
        }
    }
    catch {
        # 只读区刷新失败不该影响窗口可用性，记一条就走。
        # 【B 档：必须去重】本函数由 1 秒定时器调用。原来这里每次失败都写一行，
        # 一个坏文件就能 1 秒刷一行、几分钟把日志刷满 —— 正是"没去重"的典型坑。
        Write-SettingsLog ('刷新只读区失败: ' + $_.Exception.Message) -Level 'ERR' -Key 'readonly-refresh'
    }
}

# 保存成功后 3 秒把状态文字清掉。
# 为什么：一直挂着"已保存"会让人以为后面的操作没生效。
$script:saveOkAt = $null
function Update-StatusFade {
    if ($null -eq $script:saveOkAt) { return }
    if (((Get-Date) - $script:saveOkAt).TotalSeconds -lt 3) { return }
    $script:saveOkAt = $null
    # 【C 档：故意静默】这只是把"已保存"三个字清掉，失败最多是多挂一会儿，
    # 而且它在 1 秒定时器里，失败会 1 秒刷一行。绝对不要在这里加日志。
    try { $script:StatusText.Text = '' } catch { }
}

# ---------------------------------------------------------------- 绑事件
#
# 【纪律：所有回调里只能读 $script: 变量和事件参数】
#   读函数局部变量会拿到 $null，接着 $null.xxx 抛异常，而回调里没人接
#   → WPF 认为应用该退出。这是第三轮事故的机制（交接文档 2.8）。

# 拖动窗口（无边框窗没有系统标题栏，不自己做就动不了）
$script:TitleBarEl.Add_MouseLeftButtonDown({
    try { $script:winRef.DragMove() }
    catch {
        # 【A 档：必须记】无边框窗口只能靠拖标题栏移动。这里失败 = 窗口拖不动，
        # 用户会觉得"这窗口坏了"。一次拖动只触发一次，不会刷屏。
        # 【为什么用 WARN】还有别的办法（关掉重新打开），不算致命。
        Write-SettingsLog ('拖动设置窗口失败: ' + $_.Exception.Message) -Level 'WARN'
    }
})

# 关闭：标题栏 ✕
$script:BtnCloseEl.Add_Click({
    try { $script:winRef.Close() }
    catch {
        # 【A 档：必须记】关不掉窗口是很明显的故障 —— 用户只能去任务管理器杀进程，
        # 而且他大概率说不清发生了什么。这种必须留证据。
        Write-SettingsLog ('点标题栏关闭按钮后关窗失败: ' + $_.Exception.Message) -Level 'ERR'
    }
})

# 关闭：Esc
# （无边框窗没有系统 ✕，只靠 Alt+F4 对小白太不友好，所以三种关法都留）
$win.Add_KeyDown({
    param($s, $e)
    if ($e.Key -eq 'Escape') {
        try { $script:winRef.Close() }
        catch {
            # 【A 档：必须记】Esc 关不掉 → 用户会以为"快捷键坏了"，
            # 但实际上可能是整个窗口在异常状态里。
            Write-SettingsLog ('按 Esc 关窗失败: ' + $_.Exception.Message) -Level 'ERR'
        }
    }
})

# 吸附开关联动边距滑块
$script:swSnap.Add_Click({
    try {
        $script:slEdge.Slider.IsEnabled = ($script:swSnap.IsChecked -eq $true)
        Update-EdgeRowDisabledHint
    } catch {
        # 【A 档：必须记】这里失败 → 关掉"贴到屏幕边缘"后留白滑块还能拖（或反之），
        # 界面状态和开关对不上，用户会以为"开关坏了"。
        # 只在点开关时触发一次，不会刷屏。
        Write-SettingsLog ('切换「贴到屏幕边缘」后联动留白滑块失败: ' + $_.Exception.Message) -Level 'ERR'
    }
})

# 审批开关联动："点「允许」前再确认一次"只在"在悬浮窗上直接审批"打开时可用
#
# 【为什么用 Add_Click 而不是 Add_Checked 之类】
#   本文件的开关都是 ToggleButton，Add_Click 在切换后触发，
#   这时 IsChecked 已经是新值，读出来就是"切换后的状态"，逻辑最直白。
$script:swApprovalInline.Add_Click({
    try {
        if ($null -ne $script:swApprovalConfirm) {
            $script:swApprovalConfirm.IsEnabled = ($script:swApprovalInline.IsChecked -eq $true)
        }
        Update-ApprovalConfirmState
    } catch {
        # 【A 档：必须记】这是**安全相关**开关的联动。
        # 联动失败 → "点允许前再确认一次"可能在不该能点的时候能点，
        # 也可能在不该禁用时被禁用。涉及审批安全，必须留痕。
        Write-SettingsLog ('切换「在悬浮窗上直接审批」后联动确认开关失败: ' + $_.Exception.Message) -Level 'ERR'
    }
})

# 恢复默认：只拨界面，不写盘。
# 用户还要再点一次「保存」才生效 —— 手滑点错了还有救。
$script:BtnResetEl.Add_Click({
    # 【记 INFO】恢复默认属于"会覆盖一整套设置"的高影响操作，
    # 而它只回填界面、不写盘 —— 用户很容易以为已经生效，
    # 然后在日志里找不到任何痕迹。所以入口处先记一条。
    Write-SettingsLog '用户: 点「恢复默认」（只回填界面，尚未写盘）'
    try {
        $script:slAlt.Slider.Value   = 20
        $script:slWidth.Slider.Value = 260
        $script:slMini.Slider.Value  = 96
        $script:slGlass.Slider.Value = 80
        $script:slEdge.Slider.Value  = 8
        $script:swSnap.IsChecked     = $true
        $script:swClick.IsChecked    = $true
        $script:slEdge.Slider.IsEnabled = $true
        Update-EdgeRowDisabledHint
        # 审批开关也回默认：approvalInline 默认关（安全侧），approvalConfirm 默认开。
        # 【为什么"恢复默认"要把审批关掉】
        #   这是安全闸门，默认值就该是关。用户点"恢复默认"通常是
        #   "我想回到最开始的状态"，那时审批本来就没开。
        #   而且没人会在"恢复默认"的时候期待一个安全开关被打开。
        $script:swApprovalInline.IsChecked  = $false
        $script:swApprovalConfirm.IsChecked = $true
        $script:swApprovalConfirm.IsEnabled = $false
        Update-ApprovalConfirmState
        $script:StatusText.Text = '已恢复成默认值（还没保存，点「保存」才生效）'
        $script:StatusText.Foreground = $script:BrushErr
        $script:saveOkAt = $null
    } catch {
        # 【A 档：必须记】恢复默认失败 → 界面停在一半状态（有的项变了、有的没变），
        # 用户看到的是"点了没反应"，还可能以为自己点错了。这种必须留证据。
        Write-SettingsLog ('恢复默认值失败: ' + $_.Exception.Message) -Level 'ERR'
    }
})

# 保存
$script:BtnSaveEl.Add_Click({
    try {
        # 先按当前文件重读一遍：避免把插件刚写进去的 dshUrl 等键盖成旧值
        $cur = Read-JsonShared $script:SettingsPathRef

        $vals = @{
            alternateSeconds = [int][math]::Round($script:slAlt.Slider.Value)
            cardWidth        = [int][math]::Round($script:slWidth.Slider.Value)
            miniHeight       = [int][math]::Round($script:slMini.Slider.Value)
            glassOpacity     = [int][math]::Round($script:slGlass.Slider.Value)
            snapToEdge       = [bool]$script:swSnap.IsChecked
            edgeMargin       = [int][math]::Round($script:slEdge.Slider.Value)
            clickOpensDsh    = [bool]$script:swClick.IsChecked
            # 悬浮窗审批（v0.9.0）。这两个键是插件侧的"真源"，
            # 写进 settings.json 后插件按 mtime 自己会读到，不用重启 DSH。
            approvalInline   = [bool]$script:swApprovalInline.IsChecked
            approvalConfirm  = [bool]$script:swApprovalConfirm.IsChecked
        }

        Save-Settings -Path $script:SettingsPathRef -Current $cur -Values $vals

        # 【成功记 INFO，而且只记"键名=最终值"】
        #   拖一次滑块会触发上百次 ValueChanged —— 那些一次都不能记，记了就是一堆垃圾。
        #   用户真正"定下来"的时刻只有保存这一次，所以设置值只在这一行落盘。
        Write-SettingsLog ('用户: 保存设置成功。写入: ' + (ConvertTo-SettingsKv $vals))

        # 这条文案必须准确：卡片有热更新（Panel.ps1 的 500ms Tick 会瞄 mtime），
        # 所以真的是保存完就生效，不需要重启、也不需要右键"重新读取设置"。
        $script:StatusText.Text = '已保存，卡片会在 1 秒内自动更新'
        $script:StatusText.Foreground = $script:BrushOk
        $script:saveOkAt = Get-Date
    }
    catch {
        $script:StatusText.Text = '保存失败：' + $_.Exception.Message
        $script:StatusText.Foreground = $script:BrushErr
        $script:saveOkAt = $null
        # 【A 档：必须记，而且这是用户最常投诉的地方】
        #   界面上只会显示"保存失败：xxx"一行小字，用户转述给你的时候往往只剩
        #   "保存不了"三个字。日志里必须有完整异常类型 + 消息 + 目标路径才查得动。
        Write-SettingsLog ('保存设置失败: ' + $_.Exception.GetType().Name + ' / ' + $_.Exception.Message + '；目标=' + $script:SettingsPathRef) -Level 'ERR'
    }
})

# ---------------------------------------------------------------- 上主题 + 首次填充
# 必须在所有控件建完之后调，否则后建的控件不会被染色
Apply-Theme $isDark
Update-ReadonlySections

# ---------------------------------------------------------------- 显示窗口 + 磨砂
#
# 【为什么是 Show() + $app.Run()，不是 ShowDialog()】
#   磨砂必须在窗口已经显示出来、句柄存在之后才能上。
#   ShowDialog() 会阻塞，后面的磨砂代码根本执行不到 ——
#   结果是"窗口出来了，但没磨砂、没圆角"，而且不报任何错。
#   这是本次改造里最容易"看起来对、其实没生效"的一处。
$win.Show() | Out-Null

$script:hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle

if ($script:GlassOk) {
    try {
        # 这一句是磨砂能透出来的前提：把 WPF 合成层底色设成透明
        $hs = [System.Windows.Interop.HwndSource]::FromHwnd($script:hwnd)
        $hs.CompositionTarget.BackgroundColor = [System.Windows.Media.Colors]::Transparent

        [void][CardWin]::Corner($script:hwnd, 2)    # 2 = 系统圆角
        [void][CardWin]::DarkMode($script:hwnd, $(if ($isDark) { 1 } else { 0 }))

        $pal  = New-ThemePalette $isDark
        $tint = (([long]$script:TintAlpha) -shl 24) -bor $pal.tint
        # AccentFlags 传 0，绝对不能是 2（填 2 会变成整块纯白底）
        [void][CardWin]::Acrylic($script:hwnd, $tint, 0)
    }
    catch {
        Write-SettingsLog ('上磨砂失败，降级为纯色底: ' + $_.Exception.Message) -Level 'ERR'
        $script:GlassOk = $false
    }
}

if (-not $script:GlassOk) {
    # 降级：纯色不透明底。难看但能用 —— 总比打不开好。
    $win.Background = if ($isDark) {
        [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromRgb(0x22, 0x24, 0x2A))
    } else {
        [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromRgb(0xF7, 0xF8, 0xFA))
    }
    # 没有磨砂也要系统圆角，否则是直角，和卡片不像一套
    # 【C 档：故意静默】这里已经处在"磨砂整体降级"的兜底分支里了。
    # 圆角再失败最多是窗口四个角变成直角 —— 纯观感问题，
    # 用户不会因此"用不了设置"，而且这条路径本来就很少走到。记了没有排查价值。
    try { [void][CardWin]::Corner($script:hwnd, 2) } catch { }
}

# ---------------------------------------------------------------- 定时器
#
# 【必须存在 $script: 里】
#   函数体内新建的定时器，Tick 里读不到 —— 那是第三轮事故同款。
$script:uiTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:uiTimer.Interval = [TimeSpan]::FromMilliseconds(1000)
$script:uiTimer.Add_Tick({
    # 【B 档：记，但必须去重】
    #   这是 1 秒一次的定时器。里面两个函数自己都会兜异常，
    #   能漏到这里说明是"连它们的兜底都没拦住"的意外 —— 这种值得记。
    #   但绝不能不设去重：1 秒一行，几分钟就把日志刷满。
    try { Update-ReadonlySections }
    catch {
        Write-SettingsLog ('定时刷新只读区出现未预期异常: ' + $_.Exception.Message) -Level 'ERR' -Key 'tick-readonly'
    }
    try { Update-StatusFade }
    catch {
        Write-SettingsLog ('定时清理状态文字出现未预期异常: ' + $_.Exception.Message) -Level 'ERR' -Key 'tick-fade'
    }
})
$script:uiTimer.Start()

# 关窗要把定时器停掉，否则进程退不出去
$win.Add_Closed({
    # 【记一条"窗口关闭"】
    #   设置窗口是"用完就退"的独立进程。日志里没有这一行的话，
    #   就看不出这段记录到底是"用户看了一会儿自己关的"还是"启动完就崩了"。
    Write-SettingsLog '用户: 关闭设置窗口，进程退出'
    try { $script:uiTimer.Stop() }
    catch {
        # 【A 档：必须记】定时器没停 → 进程可能退不出去
        # （用户看到窗口没了，任务管理器里却还在）；下次点「设置…」可能开出两个窗口。
        Write-SettingsLog ('关闭窗口时停定时器失败: ' + $_.Exception.Message) -Level 'ERR'
    }
})

# ---------------------------------------------------------------- 自检开关
#
# 【为什么需要这个】
#   本文件有内嵌 C#（磨砂）。而 check-panel-syntax.ps1 只用 PowerShell 解析器
#   看语法，**完全抓不到 C# 编译错误** —— C# 挂了的话窗口会在 Add-Type 那一步
#   静默失败或者干脆起不来，语法检查却报"全绿"。
#   所以改完内嵌 C# 必须真的把窗口启起来。
#
#   但"人工开一次看一眼"有两个问题：没法自动化，而且看不出内部状态
#   （磨砂到底上没上、只读区读到什么）。
#
#   所以加这个钩子：设了环境变量 DSH_SETTINGS_DIAG=1 时，
#   窗口显示后把关键内部状态写进 settings.diag.log，然后自动关闭。
#   这样冒烟测试只要设环境变量跑一次就能断言结果，不用去改本文件。
#
#   和卡片已有的 DSH_PANEL_DEBUG 是同一套路（Panel.ps1:986）。
#   ⚠️ 注意：这里用 .diag.log 后缀而不是 settings.log，
#      是为了让 check-package.ps1 的 json 扫描和数据目录清理都不会误碰。
$script:diagOn = ($env:DSH_SETTINGS_DIAG -eq '1') -or ($env:DSH_SETTINGS_DIAG -eq 'true')
if ($script:diagOn) {
    try {
        # 诊断文件路径允许被环境变量 DSH_SETTINGS_DIAG_FILE 覆盖。
        # 为什么需要这个：自动化测试可能跑在写不了数据目录的环境里，
        # 那时把结果指到一个能写的地方就行。不指定时仍写数据目录（正常使用即此）。
        $diagPath = $env:DSH_SETTINGS_DIAG_FILE
        if ([string]::IsNullOrWhiteSpace($diagPath)) {
            $diagPath = Join-Path $script:DataDirPath 'settings.diag.log'
        }
        $lines = New-Object System.Collections.ArrayList
        [void]$lines.Add('DIAG_BEGIN')
        [void]$lines.Add('GlassOk=' + $script:GlassOk)
        [void]$lines.Add('Hwnd=' + $script:hwnd)
        [void]$lines.Add('IsDark=' + $script:isDark)
        # 当前生效的配色（v0.7.1 对比度修复的验证点：这几个值应该和注释里写的一致）
        $palNow = New-ThemePalette $script:isDark
        [void]$lines.Add('PalPrimary=' + $palNow.primary)
        [void]$lines.Add('PalSecondary=' + $palNow.secondary)
        [void]$lines.Add('PalTertiary=' + $palNow.tertiary)
        [void]$lines.Add('BrushOk=' + $script:BrushOk.Color.ToString())
        [void]$lines.Add('BrushErr=' + $script:BrushErr.Color.ToString())
        [void]$lines.Add('EdgeValueText=' + $script:slEdge.ValueText.Text)
        [void]$lines.Add('Width=' + $script:winRef.Width)
        [void]$lines.Add('Height=' + $script:winRef.Height)
        [void]$lines.Add('Groups=' + $script:GroupsHost.Children.Count)
        [void]$lines.Add('VbHead=' + $script:vbHead.Text)
        [void]$lines.Add('VbDetail=' + $script:vbDetail.Text)
        [void]$lines.Add('VbRule=' + $script:vbRule.Text)
        [void]$lines.Add('Card=' + $script:stCard.Text)
        [void]$lines.Add('Url=' + $script:stUrl.Text)
        [void]$lines.Add('Holiday=' + $script:stHoliday.Text)
        [void]$lines.Add('SlAlt=' + $script:slAlt.Slider.Value)
        [void]$lines.Add('SlWidth=' + $script:slWidth.Slider.Value)
        [void]$lines.Add('SlMini=' + $script:slMini.Slider.Value)
        [void]$lines.Add('SlGlass=' + $script:slGlass.Slider.Value)
        [void]$lines.Add('SlEdge=' + $script:slEdge.Slider.Value)
        [void]$lines.Add('EdgeEnabled=' + $script:slEdge.Slider.IsEnabled)
        [void]$lines.Add('SwSnap=' + $script:swSnap.IsChecked)
        [void]$lines.Add('SwClick=' + $script:swClick.IsChecked)
        # 审批开关（v0.9.0 验证点）
        [void]$lines.Add('SwApprovalInline=' + $script:swApprovalInline.IsChecked)
        [void]$lines.Add('SwApprovalInlineEnabled=' + $script:swApprovalInline.IsEnabled)
        [void]$lines.Add('SwApprovalConfirm=' + $script:swApprovalConfirm.IsChecked)
        [void]$lines.Add('SwApprovalConfirmEnabled=' + $script:swApprovalConfirm.IsEnabled)
        [void]$lines.Add('ApprovalConfirmHint=' + $script:stApprovalConfirmHint.Text)
        [void]$lines.Add('PalWarn=' + $palNow.warn)
        [void]$lines.Add('RiskText=' + ($script:txtApprovalRisk.Text -replace "`r`n", ' / '))
        [void]$lines.Add('DIAG_END')
        [System.IO.File]::WriteAllLines($diagPath, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))

        # 1.5 秒后自动关闭，方便脚本化连续验证
        $script:diagTimer = New-Object System.Windows.Threading.DispatcherTimer
        $script:diagTimer.Interval = [TimeSpan]::FromMilliseconds(1500)
        $script:diagTimer.Add_Tick({
            # 【C 档：故意静默】这是自检模式（DSH_SETTINGS_DIAG=1）专用的一次性定时器，
            # 1.5 秒后自动关窗，然后就没了。它失败最多是"关不掉"，而这时 diag 文件
            # 早就写完了（自检的全部价值在那里）。记日志只会污染正常日志文件。
            try { $script:diagTimer.Stop() } catch { }
            try { $script:winRef.Close() } catch { }
        })
        $script:diagTimer.Start()
    }
    catch {
        Write-SettingsLog ('自检模式失败: ' + $_.Exception.Message) -Level 'ERR'
    }
}

# ---------------------------------------------------------------- 起消息循环
# 上面已经用 $win.Show() 显示过窗口（磨砂需要句柄），所以这里只能 Run()
$app.Run() | Out-Null
