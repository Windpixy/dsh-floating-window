# Panel.ps1 -- DSH 桌面卡片（磨砂玻璃矩形版）
#
# 为什么用这个方案（前一轮踩坑的结论，别再改回去）：
#   1) Win11 新接口 DWMWA_SYSTEMBACKDROP_TYPE(2/3/4) 在你这台机器上只出一片纯灰，没有模糊。实测废弃。
#   2) 老接口 SetWindowCompositionAttribute + AccentState=4 是唯一真能模糊背景的路子。
#   3) 之前出"白方块"的真正原因有两个，必须同时避开：
#        - 窗口不能是"分层窗口"（WPF 的 AllowsTransparency=$true 会打开这个开关，磨砂就废了）
#        - AccentFlags 必须是 0（填 2 会变成一整块纯白底，实测 mean=242 全平）
#   4) 窗口背景必须透明、且把 WPF 合成层背景色设成透明，磨砂才能透出来。
#
# 卡片尺寸 260x368（长宽比 1:1.415），收起时 260x96。

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 目录约定
#
# 程序本体和数据分开放：
#   程序（本文件、PanelVisual.ps1、Settings.ps1）跟着插件走，只读
#   数据（state.json、位置记忆、心跳、用户改过的 settings.json）放在
#   %USERPROFILE%\.dsh\desktop-card\
#
# 为什么分开：插件升级时会整个目录替换，数据放程序目录里会被覆盖；
# 而且 git 里的程序目录不该出现运行时产生的文件。
#
# 环境变量 DSH_CARD_DATA_DIR 由插件在拉起卡片时传入。
# 没传（比如手动双击 run-panel.bat）就用标准位置，和插件用同一份数据。
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($env:DSH_CARD_DATA_DIR -and $env:DSH_CARD_DATA_DIR.Trim() -ne '') {
    $DataDir = $env:DSH_CARD_DATA_DIR.Trim()
} elseif ($env:USERPROFILE -and $env:USERPROFILE.Trim() -ne '') {
    # 手动启动时也用标准位置，这样看到的和插件写的是同一份数据
    $DataDir = Join-Path $env:USERPROFILE '.dsh\desktop-card'
} else {
    $DataDir = $ScriptDir
}
if (-not (Test-Path $DataDir)) {
    try { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null } catch { $DataDir = $ScriptDir }
}

# settings.json 的查找顺序：数据目录优先（用户改过的），否则用程序自带的默认值
$SettingsPath = Join-Path $DataDir 'settings.json'
if (-not (Test-Path $SettingsPath)) {
    $defaultSettings = Join-Path $ScriptDir 'settings.json'
    if (Test-Path $defaultSettings) {
        try {
            Copy-Item $defaultSettings $SettingsPath -Force
        } catch { $SettingsPath = $defaultSettings }
    } else {
        $SettingsPath = $defaultSettings
    }
}

$StatePath    = Join-Path $DataDir 'state.json'
$PosPath      = Join-Path $DataDir 'panel-pos.json'
$HeartbeatPath = Join-Path $DataDir 'heartbeat.json'

# ---------------------------------------------------------------- 悬浮窗审批的决定目录（v0.8.0）
#
# 卡片点「允许/拒绝」→ 往这个目录写一个 json 文件 → 插件每 250ms 扫一遍。
#
# 【为什么用文件，不用 HTTP】
#   1. 卡片全程只干"读写文件"这一件事（交接文档 2.1 的架构），不引入新范式
#   2. 文件能直接双击打开看，排查成本几乎为零
#   3. 安全性不比自己实现 HTTP 鉴权差：DSH 的 HTTP 层没有"本机免鉴权"待遇
#      （官方 README 明文："不存在按方法区分的 loopback 层"），
#      而文件这边我们有 nonce + 时间戳 + 一次性消费三重校验
#
# 【目录名必须和 lib/paths.js 的 dataPaths().decisions 一致】
#   写成 join(dir, 'decisions')，改一边必须改另一边。
$DecisionsDir = Join-Path $DataDir 'decisions'
if (-not (Test-Path $DecisionsDir)) {
    try { New-Item -ItemType Directory -Force -Path $DecisionsDir | Out-Null } catch { }
}

# ---------------------------------------------------------------- 单实例保护
#
# DSH 重启后插件会再拉起一次卡片。没有保护的话屏幕上会叠出两张卡。
#
# 【为什么用"心跳"判断，而不是命名 Mutex】
#   Mutex 看起来更"正统"，但有个致命隐患：如果卡片进程被强杀
#   （任务管理器结束、系统崩溃、插件卸载时连带杀掉），
#   Mutex 对象会残留在系统里，之后每次启动都判断"已有实例"就退出，
#   结果是**卡片永远起不来**，而且用户完全看不出原因。
#   心跳文件不会这样：进程没了心跳就不再更新，几秒后自然过期，
#   下一 次启动就能正常接管。
#
# 【时序上安全吗】
#   插件拉起卡片是串行的一次调用，不存在并发；即使极端情况下起了两个，
#   后一个启动时会读到前一个刚写的心跳，也会自己退出。
#
# 判断规则：心跳里 alive=true 且时间在 STALE_MS 毫秒以内 -> 认为已有实例
$script:StaleMs = 8000

function Test-AnotherInstanceAlive {
    param([string]$HbPath, [int]$StaleMs)
    if (-not (Test-Path $HbPath)) { return $false }
    try {
        $hb = Get-Content $HbPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $hb -or $hb.alive -ne $true) { return $false }
        $at = [long]$hb.updatedAtMs
        if ($at -le 0) { return $false }
        $nowMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        $age = $nowMs - $at
        if ($age -lt 0 -and $age -gt -10000) { return $true }   # 时钟略微不准，当作活着
        if ($age -ge $StaleMs) { return $false }                 # 过期了，认为已经没了
        return $true
    } catch {
        # 心跳文件正好在被写（读到半截）时解析失败，当作没实例
        return $false
    }
}

if (Test-AnotherInstanceAlive -HbPath $HeartbeatPath -StaleMs $script:StaleMs) {
    # 已经有一个在跑，安静退出，不打扰用户
    exit 0
}

# 立刻占位：写下"我来了"。这样即使后续初始化较慢，
# 第二个被拉起的实例也会看到这个心跳而退出。
# 【v0.9.12 新增：把自己"加载的是哪一版代码"写进心跳】
#
# 【为什么需要这个】
#   用户改了代码 → 说"怎么没效果" → 其实卡片进程还是几十分钟前起来的，
#   内存里跑的是**旧代码**。这个情况在 v0.9.11 真实发生过一次：
#     Panel.ps1 改动时间 14:43:30，卡片进程启动时间 13:51:29，
#     用户 15:00 反馈"柱状图没有看到蓝色的闪动"。
#   代码是对的（离屏探针跑产品函数，色条 0.600~1.000 完整起伏），
#   但运行中的进程根本没包含那段代码。
#
#   排查这类问题的成本极高：从日志里看不出任何异常，因为旧代码本身没坏。
#   所以这里主动把"我这份代码的时间戳"写进心跳 ——
#   只要和磁盘上的 Panel.ps1 一比对，就能一秒判断"是不是没重启"。
#
# 【为什么记录的是 Panel.ps1 的写入时间，而不是"启动时间"】
#   启动时间只能证明"进程什么时候起来的"，还得再查代码什么时候改的。
#   直接记录"启动那一刻磁盘上代码的时间戳" = 这个进程加载的那一版，
#   比对磁盘当前值即可，一个等式就够。
#
# 【为什么用 LastWriteTimeUtc 而不是本地时间】
#   JSON 里存的是毫秒时间戳（ToUnixTimeMilliseconds），跨时区/夏令时都不用管。
$script:scriptStampMs = 0L
try {
    # 【为什么要兜底 $ScriptDir】
    #   $PSCommandPath 在 `-File` 方式启动时一定有值，但万一这段被
    #   dot-source 进别的脚本（项目里的探针就是这么干的），它就是空的。
    #   0 表示"这个进程说不清自己跑的是哪一版" —— 检查脚本会把 0 当成
    #   "无法判断"而不是"过旧"，避免误报。
    $selfPath = $PSCommandPath
    if ([string]::IsNullOrEmpty($selfPath)) {
        $selfPath = Join-Path $ScriptDir 'Panel.ps1'
    }
    if (Test-Path $selfPath) {
        $script:scriptStampMs = [long]([DateTimeOffset]::new(
            [System.IO.File]::GetLastWriteTimeUtc($selfPath)).ToUnixTimeMilliseconds())
    }
} catch { $script:scriptStampMs = 0L }

function Write-Heartbeat {
    param([bool]$Alive = $true, [long]$Hwnd = 0)
    try {
        $hb = [ordered]@{
            pid         = $PID
            hwnd        = $Hwnd
            alive       = $Alive
            dataDir     = $DataDir
            updatedAtMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
            # v0.9.12：这个进程**加载**的那份 Panel.ps1 的时间戳。
            # 和磁盘上 Panel.ps1 的 LastWriteTimeUtc 不一致 = 正在跑旧代码。
            # 排查时：node test/check-card-staleness.mjs 一条命令给结论。
            scriptStampMs = $script:scriptStampMs
        }
        $json = $hb | ConvertTo-Json -Compress
        $tmp = "$HeartbeatPath.tmp"
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -Path $tmp -Destination $HeartbeatPath -Force -ErrorAction SilentlyContinue
    # 【故意静默】失败无害，下个周期会自动重试；记了会把日志刷爆
    } catch { }
}
Write-Heartbeat -Alive $true -Hwnd 0

# ---------------------------------------------------------------- Win32
$nativeSrc = @'
using System;
using System.Runtime.InteropServices;

public static class PanelNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct MARGINS { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct ACCENTPOLICY { public int AccentState, AccentFlags, GradientColor, AnimationId; }
    [StructLayout(LayoutKind.Sequential)]
    public struct WINCOMPATTRDATA { public int Attrib; public IntPtr Data; public int SizeOfData; }

    [DllImport("user32.dll")]
    static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")]
    static extern int SetWindowLong(IntPtr h, int idx, int val);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);
    [DllImport("dwmapi.dll")]
    static extern int DwmExtendFrameIntoClientArea(IntPtr h, ref MARGINS m);
    [DllImport("user32.dll")]
    static extern int SetWindowCompositionAttribute(IntPtr h, ref WINCOMPATTRDATA d);
    // 【v0.9.4】柱态把窗口裁成胶囊形状要用到这两个
    [DllImport("user32.dll")]
    static extern int SetWindowRgn(IntPtr h, IntPtr hRgn, bool redraw);
    [DllImport("gdi32.dll")]
    static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);

    // 不抢焦点、不进 Alt+Tab
    public static void AsToolWindow(IntPtr h)
    {
        int ex = GetWindowLong(h, -20);
        SetWindowLong(h, -20, ex | 0x80 | 0x08000000);
    }

    public static int ExStyle(IntPtr h) { return GetWindowLong(h, -20); }
    public static bool IsLayered(IntPtr h) { return (GetWindowLong(h, -20) & 0x80000) != 0; }

    // 磨砂玻璃。accentFlags 必须为 0，否则变成纯白底板。
    //
    // 【v0.9.5 重要修正：返回值语义】
    //   本项目其它 DWM 调用返回 HRESULT（0 = 成功），
    //   但 SetWindowCompositionAttribute 返回 **BOOL**（非 0 = 成功，0 = 失败）。
    //   两者正好相反，非常容易误读。
    //   我在 v0.9.5 验证时就误判过：看到 hr=1 以为"不支持"，
    //   实际那是成功。实测确认：
    //     AccentState=0/3/4/5 全部 ret=1
    //     120x120 窗口开磨砂后中心像素 = #E8E9E9（带模糊层次的浅灰，不是纯色）
    //   所以以后看到 hr=1 不要慌，那是好事。
    public static int Acrylic(IntPtr h, long tint, int accentFlags)
    {
        ACCENTPOLICY p = new ACCENTPOLICY();
        p.AccentState = 4;                       // ACCENT_ENABLE_ACRYLICBLURBEHIND
        p.AccentFlags = accentFlags;
        p.GradientColor = unchecked((int)tint);  // 0xAABBGGRR
        p.AnimationId = 0;

        int size = Marshal.SizeOf(p);
        IntPtr mem = Marshal.AllocHGlobal(size);
        Marshal.StructureToPtr(p, mem, false);

        WINCOMPATTRDATA d = new WINCOMPATTRDATA();
        d.Attrib = 19;                           // WCA_ACCENT_POLICY
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
    public static int Border(IntPtr h, int col)  { int v = col;  return DwmSetWindowAttribute(h, 34, ref v, 4); }
    public static int DarkMode(IntPtr h, int on) { int v = on;   return DwmSetWindowAttribute(h, 20, ref v, 4); }

    // 【v0.9.2】柱态专用：关掉 DWM 窗口边框和 DWM 圆角。
    //
    // 【⚠️ 先纠正一条我 v0.9.2 时写错的注释】
    //   这段注释原来写的是"这是用户报的'颜色条不居中/磨砂没填满黑框'的真正原因"。
    //   **那个结论是错的**，后来的实测推翻了它：
    //     · 属性 34 传 0xFFFFFFFE 返回 S_OK（系统接受）
    //     · 但设置前后窗口物理尺寸完全不变（28×240 → 28×240）
    //     · 说明 DWM 边框根本不占客户区，它不可能是那圈黑边的来源
    //   真正的两个原因（都已分别修掉）：
    //     ① 胶囊尺寸写死 14，和窗口可用宽度差半像素 → 改 Stretch 铺满（v0.9.2）
    //     ② 我自己加的 0x34 半透明白描边叠在黑窗口底上 = #343434 灰框
    //        → 删掉描边（v0.9.3）
    //
    // 【那这个函数还有没有必要留着】
    //   有必要，但理由不是"修 bug"，而是"柱态本来就不该有系统装饰"：
    //     · 柱态不需要系统圆角 —— 胶囊圆角是自己画的 CornerRadius = 宽/2
    //     · 柱态不需要系统边框 —— 13 像素宽的窗口上任何系统边都很显眼
    //   留着它能让柱态窗口更干净，但它不是任何 bug 的修复项。
    public static int ClearDwmFrame(IntPtr h)
    {
        int hr1 = 0;
        // DWMWA_COLOR_NONE = 0xFFFFFFFE，表示"不要边框"
        int none = unchecked((int)0xFFFFFFFE);
        hr1 = DwmSetWindowAttribute(h, 34, ref none, 4);

        // DWMWA_WINDOW_CORNER_PREFERENCE = 33，DWMWCP_DONOTROUND = 1
        int noRound = 1;
        int hr2 = DwmSetWindowAttribute(h, 33, ref noRound, 4);

        return hr1 != 0 ? hr1 : hr2;
    }

    // 【v0.9.2】退出柱态时把 DWM 装饰恢复成卡片正常样式。
    //   为什么不各调用一次 Corner/Border：那两处传的是常量，
    //   恢复逻辑集中在这里，以后改卡片正常样式只需要改这一处。
    //
    // 【v0.9.13 修：这里原来把边框设回 1，等于退出柱态后又画一圈黑边】
    //
    //   背景：属性 34 (DWMWA_BORDER_COLOR) 收的是**颜色值**（COLORREF
    //   0x00BBGGRR），不是"开关"。传 1 = COLORREF(0,0,1) ≈ 近黑，
    //   DWM 就会在窗口四周画一圈黑边。
    //
    //   这个错在三个地方都出现过，修的时候必须三处一起改：
    //     ① 主窗口初始化（本文件"Corner($hwnd, 2)"附近）—— 已改成 NONE
    //     ② 气泡窗口（曾经传 1，第九批已改成不调用）—— 已修
    //     ③ **这里** —— 每次退出柱态都会重新画黑边，最隐蔽
    //
    //   为什么 ③ 最隐蔽：用户如果不进柱态，永远碰不到；
    //   一旦用过柱态功能，之后卡片上的字色就开始不对了 ——
    //   看起来像"偶发的、随机出现的" bug，很难联想到是柱态留下的。
    //
    //   注意不能改成"不设置"：属性 34 的默认值是 DWMWA_COLOR_DEFAULT，
    //   意思是"跟系统主题走"。系统深色主题下 Windows 会自动画一圈浅色边，
    //   同样会污染 Update-AdaptiveText 的采样带（方向相反而已）。
    //   所以必须**显式**设成 NONE。
    public static int RestoreDwmFrame(IntPtr h, int darkMode)
    {
        int hr = 0;
        int round = 2;                       // DWMWCP_ROUND
        hr = DwmSetWindowAttribute(h, 33, ref round, 4);
        // DWMWA_COLOR_NONE = 0xFFFFFFFE，表示"不要边框"
        // （原来这里写的是 1，那是个颜色值，见上面的说明）
        int border = unchecked((int)0xFFFFFFFE);
        DwmSetWindowAttribute(h, 34, ref border, 4);
        int dm = darkMode;
        DwmSetWindowAttribute(h, 20, ref dm, 4);
        return hr;
    }

    // 【v0.9.4】把窗口本身裁成胶囊形状（圆角窗口）。
    //
    // 【为什么必须这么做 —— 用户报"现在胶囊没有圆角了"】
    //   v0.9.3 为了盖住"半像素缝露黑底"，我把 $win.Background 设成了胶囊色。
    //   但 WPF 的 Border.CornerRadius 只能把 **Border 自己**画成圆角，
    //   窗口底色始终是**矩形**。同色一铺，矩形底色就把圆角填平了 ——
    //   视觉上胶囊变成一根方头柱子。
    //
    //   实测对照（_lab\probe-round-window.ps1，数顶部每行的洋红像素数，
    //   真圆角应该从窄递增到满宽）：
    //     只有 Border 圆角        y=0→6, y=1→12, y=2→16 ... y=11→28   ✅ 圆角
    //     + 窗口底色同色（v0.9.3） y=0→28, y=1→28 ... y=11→28          ❌ 方角
    //     + SetWindowRgn 裁剪     y=0→4,  y=1→12, y=2→14 ... y=11→26   ✅ 圆角
    //   所以正确做法是：在 Win32 层面把窗口区域裁掉。
    //   SetWindowRgn 之后，窗口外接矩形不变，但**不落在 region 内的像素不参与绘制**，
    //   矩形底色自然就被裁成圆角了。
    //
    //   【注意 CreateRoundRectRgn 的椭圆宽高要填 2×半径】
    //     圆角半径 = 宽/2（做胶囊），所以椭圆宽高都填 physicalWidth。
    //
    //   【调用时机很关键】必须在窗口**完全渲染后**调。
    //   在 Loaded 事件里调会失败（那时布局还没最终确定），实测确认：
    //     Loaded 里调 → MakeCapsule 返回成功但形状没变（还是方角）
    //     渲染后再调 → 形状真正变成圆角
    //   所以入口是 Set-BarGeometry（它本来就在尺寸改完后才跑）。
    public static bool MakeCapsuleRgn(IntPtr h, int physicalWidth, int physicalHeight)
    {
        if (physicalWidth <= 0 || physicalHeight <= 0) return false;
        IntPtr rgn = CreateRoundRectRgn(0, 0, physicalWidth + 1, physicalHeight + 1,
                                        physicalWidth, physicalWidth);
        if (rgn == IntPtr.Zero) return false;
        // 成功后系统接管 rgn 所有权，不能再 DeleteObject
        return SetWindowRgn(h, rgn, true) != 0;
    }

    // 【v0.9.4】退出柱态时把窗口形状恢复成矩形。
    //   不恢复的话，回到展开态时 260×368 的卡片会被裁成一根巨大的胶囊。
    public static bool ClearWindowRgn(IntPtr h)
    {
        // 传 IntPtr.Zero 表示"取消 region，恢复整个窗口矩形"
        return SetWindowRgn(h, IntPtr.Zero, true) != 0;
    }

    // 关掉磨砂（v0.9.0 柱态用）。
    //
    // AccentState = 0 是 ACCENT_DISABLED，把 WCA_ACCENT_POLICY 复位。
    // 【为什么要单独一个方法，不能在 PowerShell 里传 Acrylic(h, ..., 0)】
    //   现有 Acrylic() 里写死了 AccentState = 4，改成参数会动到主画面那条路径
    //   （主画面的磨砂是本项目的核心观感，不能为了柱态冒风险）。
    //   所以新增一个只做"清掉"的入口，主路径完全不受影响。
    public static int ClearAcrylic(IntPtr h)
    {
        ACCENTPOLICY p = new ACCENTPOLICY();
        p.AccentState = 0;                       // ACCENT_DISABLED
        p.AccentFlags = 0;
        p.GradientColor = 0;
        p.AnimationId = 0;

        int size = Marshal.SizeOf(p);
        IntPtr mem = Marshal.AllocHGlobal(size);
        Marshal.StructureToPtr(p, mem, false);

        WINCOMPATTRDATA d = new WINCOMPATTRDATA();
        d.Attrib = 19;
        d.Data = mem;
        d.SizeOfData = size;

        int hr = SetWindowCompositionAttribute(h, ref d);
        Marshal.FreeHGlobal(mem);
        return hr;
    }
}
'@
Add-Type -TypeDefinition $nativeSrc -Language CSharp

# ---------------------------------------------------------------- 配置
function Get-Setting {
    param($Object, $Name, $Default)
    if ($null -eq $Object) { return $Default }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p -or $null -eq $p.Value) { return $Default }
    return $p.Value
}

$settings = $null
if (Test-Path $SettingsPath) {
    try { $settings = Get-Content $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $settings = $null }
}

$CardWidth   = [int](Get-Setting $settings 'cardWidth' 260)
$CardHeight  = [int](Get-Setting $settings 'cardHeight' 368)
$MiniHeight  = [int](Get-Setting $settings 'miniHeight' 96)
$altSeconds  = [int](Get-Setting $settings 'alternateSeconds' 20)
$snapToEdge  = [bool](Get-Setting $settings 'snapToEdge' $true)
$edgeMargin  = [int](Get-Setting $settings 'edgeMargin' 8)
$clickOpens  = [bool](Get-Setting $settings 'clickOpensDsh' $true)
$dshUrl      = [string](Get-Setting $settings 'dshUrl' '')
$glassOpacity= [int](Get-Setting $settings 'glassOpacity' 0x50)
$valleyConfig= Get-Setting $settings 'valley' $null
# 点卡片用什么方式回到 DSH：
#   'protocol' 用 dsh:// 协议唤起桌面程序（默认，最符合直觉）
#   'url'      用浏览器打开网页地址
#   ''         沿用老逻辑（有 dshUrl 就用浏览器）
$openMode    = [string](Get-Setting $settings 'openMode' 'protocol')

# ---------------------------------------------------------------- 置顶开关（v0.9.14）
#
# 【用户需求】
#   "置顶，当打开置顶时，卡片一直显示在所有页面前方；
#    关闭置顶时，只有在 dsh 里会显示在页面前方，以及在桌面显示"
#
#   【"关闭时"到底是什么行为 —— 用户已确认】
#     选的是"普通窗口"：切到浏览器/其他程序时卡片会被盖住，
#     回到桌面或别的窗口都关掉时就露出来。
#
#     为什么不是"贴进桌面层"（SetParent 到 Progman）：
#       ① 磨砂靠 SetWindowCompositionAttribute，要求窗口是**顶层窗口**。
#          SetParent 变成桌面子窗口后磨砂很可能直接失效 —— 那和整个项目的
#          核心视觉冲突。
#       ② 万一桌面被 explorer 重启重建，窗口会挂在已销毁的父窗口下，
#          表现是"卡片彻底不见了、重启也回不来"（第三轮事故同类风险）。
#       ③ 实测这台机器上 Progman 下面没有子窗口、所有 WorkerW 都不可见，
#          常规挂载点不存在，没法保证在别的机器上也对。
#     所以走"普通窗口"这条最稳的路。
#
# 【默认值为什么是 true】
#   等于现在已有的行为（卡片本来就是永远置顶）。老用户装完不需要调，
#   想安静的时候自己去菜单里关掉。
$script:topmostEnabled = $true
try { $script:topmostEnabled = [bool](Get-Setting $settings 'topmost' $true) } catch { }


if ($CardWidth -lt 160)  { $CardWidth = 160 }
if ($CardWidth -gt 520)  { $CardWidth = 520 }
if ($CardHeight -lt 200) { $CardHeight = 200 }
if ($CardHeight -gt 900) { $CardHeight = 900 }
if ($glassOpacity -lt 0x18) { $glassOpacity = 0x18 }
if ($glassOpacity -gt 0x90) { $glassOpacity = 0x90 }

# ---------------------------------------------------------------- 设置热更新（v0.7.0）
#
# 【要解决的问题】
#   设置界面存盘之后，除了"轮播间隔"，其它项（宽度、收起高度、磨砂浓度、
#   两个开关）原先都得重启卡片才生效。用户改了看不见变化，会以为界面坏了。
#
# 【做法：500ms 的 Tick 里瞄一眼 settings.json 的修改时间】
#   比"读文件内容再比 hash"便宜得多：只看一次修改时间，微秒级。
#   变了才真正重读并套用。
#
# 【为什么不直接改成"每次都重读"】
#   settings.json 每次重读要开文件 + JSON 解析。卡片是常驻进程，
#   跑一天就是 17 万次无谓解析。用 mtime 过滤之后，
#   平时只多一次 GetLastWriteTimeUtc 调用，代价可以忽略。
#
# 【⚠️ 三条纪律（和第一批成果的关系）】
#   1. 不碰 $script:curPhase / $script:curHeadText。
#      那是 Set-Header 维护的状态色缓存，改设置跟"当前是什么状态"无关。
#   2. 不主动重算状态色。Set-Header 每 500ms 自然会被调用一次，
#      颜色会自己跟上；这里插手反而会打乱它的节奏。
#   3. 拖动中（$script:dragStart 非空）不改窗口尺寸。
#      否则用户正拖着卡片时宽度突然变，卡片会跳位。
#
# 【为什么用函数包起来】
#   启动时读一次、热更新时再读一次，两处必须用**同一套夹取逻辑**。
#   抽成函数就不会出现"启动时夹了、热更新时忘了夹"这种前后不一致。
$script:lastSettingsWrite = [datetime]::MinValue

# 拖动期间想改但没敢改的宽度（见下面 Apply-CardSettings 里的说明）。
# 初值必须是 $null：拖完松手那里用 `if ($null -ne $script:pendingWidth)` 判断，
# 若初值是 0 或空字符串，第一次拖动时会误判成"有待套用的宽度"。
$script:pendingWidth = $null

# 设置热更新的排错开关。和卡片已有的 DSH_PANEL_DEBUG 共用同一个环境变量，
# 理由：用户要排错时只记一个变量名就够了。
$script:settingsDebug = ($env:DSH_PANEL_DEBUG -eq '1') -or ($env:DSH_PANEL_DEBUG -eq 'true')

function Read-CardSettings {
    $s = $null
    if (Test-Path $SettingsPath) {
        try { $s = Get-Content $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $s = $null }
    }

    $w  = [int](Get-Setting $s 'cardWidth' 260)
    $mh = [int](Get-Setting $s 'miniHeight' 96)
    $op = [int](Get-Setting $s 'glassOpacity' 0x50)
    $em = [int](Get-Setting $s 'edgeMargin' 8)

    # 夹取范围必须和设置界面的滑块范围一致（Settings.ps1 那边是
    # 宽度 200-360 / 收起 72-160 / 浓度 24-144 / 边距 0-60）。
    # 这里放宽一点点（240-380 之类）没有意义，反而会出现
    # "界面拖到头了、卡片却没到头"的怪现象，所以严格对齐。
    #
    # 另外还要防手工改 json 填出离谱值：
    #   edgeMargin 原来完全没有夹取（Panel.ps1:216 直接读），
    #   填 9999 会让卡片飞到屏幕外。
    if ($w  -lt 200) { $w  = 200 }
    if ($w  -gt 360) { $w  = 360 }
    if ($mh -lt 72)  { $mh = 72 }
    if ($mh -gt 160) { $mh = 160 }
    if ($op -lt 0x18){ $op = 0x18 }
    if ($op -gt 0x90){ $op = 0x90 }
    if ($em -lt 0)   { $em = 0 }
    if ($em -gt 60)  { $em = 60 }

    $alt = [int](Get-Setting $s 'alternateSeconds' 20)
    if ($alt -lt 5)   { $alt = 5 }
    if ($alt -gt 120) { $alt = 120 }

    return [pscustomobject]@{
        CardWidth    = $w
        MiniHeight   = $mh
        glassOpacity = $op
        edgeMargin   = $em
        altSeconds   = $alt
        snapToEdge   = [bool](Get-Setting $s 'snapToEdge' $true)
        clickOpens   = [bool](Get-Setting $s 'clickOpensDsh' $true)
        dshUrl       = [string](Get-Setting $s 'dshUrl' '')
        # 【v0.9.14】置顶开关也要能被热更新读到。
        #   设置窗口目前没有这一项（它在右键菜单里切），但用户可能直接
        #   用记事本改 settings.json —— 那时卡片要能跟上，不能无视。
        topmost      = [bool](Get-Setting $s 'topmost' $true)
    }
}

# 把读到的设置套用到运行中的卡片上。
#
# 【必须用 $script: 前缀】
#   这些变量是脚本顶层变量（脚本作用域）。但在**函数里**写
#   $CardWidth = ... 会新建一个函数局部变量，函数一返回就没了 ——
#   表现是"没报错、也没生效"，和第三轮定时器那个坑是同一类。
function Apply-CardSettings {
    param($New)

    $changed = @()

    # ---- 轮播间隔（收起态轮流显示 Token / 倒计时）
    if ($script:altSeconds -ne $New.altSeconds) {
        $changed += ('轮播={0}s' -f $New.altSeconds)
    }
    $script:altSeconds = $New.altSeconds

    # ---- 两个开关
    if ($script:snapToEdge -ne $New.snapToEdge) {
        $changed += ('吸附={0}' -f $New.snapToEdge)
    }
    $script:snapToEdge = $New.snapToEdge
    if ($script:edgeMargin -ne $New.edgeMargin) {
        $changed += ('边距={0}' -f $New.edgeMargin)
    }
    $script:edgeMargin = $New.edgeMargin
    $script:clickOpens = $New.clickOpens
    $script:dshUrl     = $New.dshUrl

    # ---- 置顶开关（v0.9.14）
    #
    # 【为什么这里要用 Set-TopmostMode 而不是直接赋 $script:topmostEnabled】
    #   直接赋值只改了变量，窗口的 Topmost 属性不会变 —— 表现就是
    #   "改了 settings.json，菜单里的勾变了，但卡片还浮在最前面"。
    #   必须走统一函数，它同时会处理气泡窗口和磨砂重刷。
    #
    # 【为什么只在真的变了才调】
    #   Set-TopmostMode 里会调 Update-Glass。每 500ms 无条件刷一次磨砂是浪费，
    #   而且改 Topmost 会扰动 DWM 合成状态，没必要频繁动。
    try {
        $newTopmost = [bool]$New.topmost
        if ([bool]$script:topmostEnabled -ne $newTopmost) {
            Set-TopmostMode -Enabled $newTopmost
            $changed += ('置顶={0}' -f $(if ($newTopmost) { '开' } else { '关' }))
        }
    } catch { Log-Fail 'L607' $_ -Key 'L607' }

    # ---- 磨砂浓度：重算 tint 再刷一次。
    #   这是最容易热更新的一项（不涉及尺寸，不会跳位）。
    $glassChanged = ($script:glassOpacity -ne $New.glassOpacity)
    if ($glassChanged) {
        $script:glassOpacity = $New.glassOpacity
        # 【v0.9.6：这里必须保留**当前 tint 极性**，不能按系统主题重算】
        #   旧写法是 (if isDark 深 else 浅) —— 那会把"跟随实测壁纸"的结果
        #   在用户改一次浓度之后悄悄打回"跟随系统主题"，
        #   于是卡片玻璃的明暗又和壁纸对不上，小字重新变糊。
        #   现在只换浓度（alpha），色相沿用 $script:cardTintIsWarm。
        $newAlpha = [long]$script:glassOpacity
        if ($newAlpha -lt 0)   { $newAlpha = 0 }
        if ($newAlpha -gt 255) { $newAlpha = 255 }
        $hue = if ($script:cardTintIsWarm) { 0x00FAF6F4 } else { 0x001A1A1E }
        $script:cTint = ($newAlpha -shl 24) -bor $hue
        $changed += ('浓度={0}' -f $New.glassOpacity)
        try { Update-Glass } catch { }
    }

    # ---- 收起高度
    if ($script:MiniHeight -ne $New.MiniHeight) {
        $changed += ('收起高={0}' -f $New.MiniHeight)
    }
    $script:MiniHeight = $New.MiniHeight

    # ---- 卡片宽度
    #   【拖动中不改】用户正拖着卡片时宽度一变，窗口会跳位。
    #   拖完松手后那次 Tick 会读到新值（mtime 已经记下来了，不会再触发，
    #   所以这里要主动留一个"还没套用"的标记）。
    $widthPending = $false
    if ($script:CardWidth -ne $New.CardWidth) {
        $script:CardWidth = $New.CardWidth
        $changed += ('宽={0}' -f $New.CardWidth)
        $widthPending = $true
    }

    if ($widthPending) {
        if ($null -eq $script:dragStart) {
            $win.Width = $script:CardWidth
            Clamp-Position
        }
        else {
            # 正在拖：记下来，等松手后再套用
            $script:pendingWidth = $script:CardWidth
        }
    }

    # ---- 强制下一帧重排高度
    #   为什么必须清这两个：Set-WindowHeight 开头有
    #   `if ($script:curHeight -eq $TargetHeight) { return }` 的短路，
    #   Set-WindowMode 也有 `if ($script:mode -eq $Mode) { return }`。
    #   不清掉的话，改完设置高度不会重新算。
    $script:curHeight = -1
    $script:mode = ''

    if ($changed.Count -gt 0) {
        Log-Card ('设置已热更新: ' + ($changed -join ' '))
    }
    return ($changed.Count -gt 0)
}

# 检测设置文件有没有变，变了就套用。在 500ms Tick 里调。
function Sync-CardSettingsIfChanged {
    try {
        $mtime = [System.IO.File]::GetLastWriteTimeUtc($SettingsPath)
        if ($mtime -eq $script:lastSettingsWrite) { return $false }
        # 排错开关：设了 DSH_PANEL_DEBUG=1 才写，平时不刷日志
        if ($script:settingsDebug) {
            Log-Card ('[DBG] settings changed: old=' + $script:lastSettingsWrite.ToString('HH:mm:ss.fff') + ' new=' + $mtime.ToString('HH:mm:ss.fff'))
        }
        $script:lastSettingsWrite = $mtime
        return (Apply-CardSettings (Read-CardSettings))
    }
    catch {
        # 热更新失败绝不能影响卡片主循环 —— 它只是个便利功能
        try { Log-Card ('设置热更新失败: ' + $_.Exception.Message) } catch { }
        return $false
    }
}

# ---------------------------------------------------------------- 打开 DSH
#
# 【为什么不能直接打开网址】
#   DSH 是 Electron 桌面程序，网页只是它内部的一个界面。
#   旧代码写死 Start-Process 'http://127.0.0.1:2278'：
#     · 端口是变的（实测先后出现过 2278 / 11922 / 4922），所以打开就是空白页
#     · 就算端口对，也只是在浏览器里再开一个界面，不是把已开的桌面窗口切到前面
#
# 【试过 dsh:// 协议，实测无效】
#   安装 DSH 时确实注册了：
#     HKCU\Software\Classes\dsh\shell\open\command
#     = "C:\...\DeepSeek Harness.exe" "%1"
#   但实测（2026-10-28）：
#     · Start-Process 'dsh://'        -> 不报错，窗口不动
#     · 直接调 exe 带 dsh:// 参数      -> 同样窗口不动
#   把 DSH 最小化后测更清楚：两种方式都没能把它恢复。
#   结论：DSH 收到了参数但没做"激活已有窗口"这件事。
#   所以协议这条路**不能依赖**，只能当"没开着时启动它"的备用手段。
#
# 【现在的主方案：直接找到 DSH 主窗口，把它激活】
#   实测可靠（连做 3 次，每次先最小化再激活，3/3 成功）：
#     ShowWindow(SW_RESTORE)  ->  如果最小化了先还原
#     SetForegroundWindow()   ->  切到前台
#   找窗口的办法：按进程名找 'DeepSeek Harness'，取有主窗口句柄的那个。
#   这不需要端口、不需要协议、不需要浏览器，就是"把那个窗口拎到前面"。
#
#   注意 Electron 进程有好几个（主进程 + 渲染 + GPU …），只有主进程
#   MainWindowHandle 不为 0，所以要挑那个。

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

# ================================================================
# 卡片日志（v0.9.15 重做）
#
# 【v0.9.15 改了什么，为什么】
#
#   用户需求："我需要一个日志功能，方便在其他人使用中出现错误的时候方便反馈，
#              也方便我们自己排查问题。"
#
#   原来的实现只有一句 AppendAllText，有三个硬伤：
#
#   ① 【没有轮转】实测一天 549 行 / 35KB，一年约 12MB，永远不会自己变小。
#      插件那边早就有限制（lib/logger.js 的 1MB 轮转），卡片这边漏了 ——
#      因为卡片是后来加的（M3 阶段），那时代码量小、一天几十行，没觉得需要。
#      用户拍板：**保留 15 天**。
#
#   ② 【没有级别】三份日志（插件/卡片/设置窗口）格式各不相同，合并后没法区分
#      哪条是错误。现在统一成 [时间] [来源] [级别] 内容。
#
#   ③ 【一个空 catch 包住整个写日志动作】写失败就完全没痕迹 —— 
#      如果磁盘满了或者权限不对，用户会看到"日志一直是空的"却不知道为什么。
#      现在失败时退到内存里记一条，下一次成功写入时补上。
#
# 【保留策略：为什么是"按天数"而不是"按大小"】
#   按大小（比如 1MB 轮转 1 个）的问题是：用户忙的时候一天就能撑满 1MB，
#   闲的时候一周才 100KB。结果"能翻多久的历史"完全不可预测。
#   按天数则是确定的：任何时候都能看到最近 15 天，
#   正好覆盖"用户用了一两周才想起来反馈"这个常见节奏。
#
# 【为什么同时保留大小上限】
#   万一某天日志刷爆（比如某个高频失败循环），按天数留 15 天可能要几百 MB。
#   所以再来一道硬闸：主文件超过 2MB 就提前轮转。
#   两道闸的关系是"谁先到算谁"。
$script:cardLogPath = Join-Path $DataDir 'panel.log'

# 主文件超过这个大小就轮转（2MB）
$script:LogMaxBytes = 2 * 1024 * 1024
# 日志保留天数（用户拍板 15 天）
$script:LogKeepDays = 15
# 轮转检查的节流：记录上次检查时间，避免每次写日志都去 stat 文件
$script:LogLastRotateCheck = [datetime]::MinValue
# 轮转检查间隔：60 秒看一次就够了（日志写得再快也不至于 60 秒撑满 2MB）
$script:LogRotateCheckMs = 60000

# 【为什么要有这个"待补写"队列】
#   写日志失败最常见的原因是"文件被别的进程短暂占用"（杀毒软件扫描、
#   备份软件读取）。这类失败几秒后就自己好了。
#   但如果失败时什么都不做，那一行日志就永久丢了 —— 而丢的往往正是
#   出事那一刻的关键记录（因为出事时文件操作最频繁）。
#   所以失败时把内容存进内存，下次写成功时一起补上。
#   上限 50 条：防止日志系统长期坏掉时内存无限增长。
$script:LogPending = New-Object System.Collections.ArrayList

function Write-LogLine {
    param([string]$Text)

    # 先把之前失败没写进去的补上（成功后才清队列）
    $payload = ''
    if ($script:LogPending.Count -gt 0) {
        $pendingLines = @($script:LogPending)
        $payload = ($pendingLines -join '') + $Text
    } else {
        $payload = $Text
    }

    try {
        [System.IO.File]::AppendAllText($script:cardLogPath, $payload,
            (New-Object System.Text.UTF8Encoding($false)))
        # 写成功才清队列。写失败时队列保留，等下次机会
        if ($script:LogPending.Count -gt 0) { $script:LogPending.Clear() }
        return $true
    } catch {
        # 写失败：把这一条也放进队列，等下次
        try {
            if ($script:LogPending.Count -lt 50) { [void]$script:LogPending.Add($Text) }
        } catch {
            # 【故意静默 · 日志系统自身的兜底】
            #   这里如果失败，说明连"往内存队列里塞一条"都不行了（内存耗尽）。
            #   绝不能在这里记日志 —— Log-Card 会调本函数，本函数再调 Log-Card，
            #   就是无限递归，直接把卡片栈溢出打死。
            #   这是全项目**唯一**几个"必须保持空"的 catch，改它会引发连锁崩溃。
        }
        return $false
    }
}

# 轮转 + 清理过期日志
#
# 【为什么单独一个函数，而不是写在 Log-Card 里】
#   Log-Card 是热路径（一秒可能调好几次）。轮转要做 stat + 目录扫描，
#   每次都做太贵。抽出来之后，Log-Card 里只做一次时间比较（微秒级），
#   真正干活的部分 60 秒才跑一次。
function Invoke-LogMaintenance {
    try {
        # ---- ① 主文件超限就轮转
        if (Test-Path $script:cardLogPath) {
            $size = (Get-Item $script:cardLogPath -ErrorAction SilentlyContinue).Length
            if ($null -ne $size -and $size -ge $script:LogMaxBytes) {
                $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
                $rotated = Join-Path $DataDir ('panel.' + $stamp + '.log')
                try {
                    [System.IO.File]::Move($script:cardLogPath, $rotated)
                } catch {
                    # 移动失败（文件被占用）就退一步：把主文件清空。
                    # 宁可丢历史，也不能让主文件无限长下去 —— 
                    # 磁盘写满会让整个卡片出更奇怪的问题。
                    try {
                        [System.IO.File]::WriteAllText($script:cardLogPath, '',
                            (New-Object System.Text.UTF8Encoding($false)))
                    } catch {
                        # 【故意静默 · 日志系统自身】
                        #   连"清空主文件"都失败了（文件被独占占用）。
                        #   这里不能记日志（会递归），也不值得再退一步 ——
                        #   下一次轮转检查（60 秒后）还会再试。
                        #   最坏情况就是主文件暂时超过 2MB，不影响功能。
                    }
                }
            }
        }

        # ---- ② 删掉超过保留天数的轮转文件
        #
        # 【⚠️ 只删匹配 panel.<14位数字>-<6位数字>.log 的文件】
        #   绝对不能按 "panel*.log" 一把删 —— 那会把主文件 panel.log
        #   和 panel-debug.log（用户的临时排错开关产出的）一起删掉。
        #   这是"删文件"操作，必须用最窄的匹配。
        $cutoff = (Get-Date).AddDays(-$script:LogKeepDays)
        $files = @(Get-ChildItem -Path $DataDir -Filter 'panel.*.log' -File -ErrorAction SilentlyContinue)
        foreach ($f in $files) {
            # 严格匹配轮转命名：panel.yyyyMMdd-HHmmss.log
            if ($f.Name -notmatch '^panel\.\d{8}-\d{6}\.log$') { continue }
            if ($f.LastWriteTime -lt $cutoff) {
                try { [System.IO.File]::Delete($f.FullName) } catch { }
            }
        }
    } catch {
        # 维护失败不影响写日志，静默即可（这里失败最多是"没轮转成"，
        # 下次 60 秒后还会再试）
    }
}

# 记录日志（统一入口）
#
# 用法：
#   Log-Card '普通信息'                      → [INFO]
#   Log-Card '某某失败' -Level 'ERR'          → [ERR]
#   Log-Card '某某可疑' -Level 'WARN'         → [WARN]
#
# 【为什么用 -Level 参数而不是 Log-Err / Log-Warn 三个函数】
#   项目里已经有 34 处调用 Log-Card，改成三个函数会全部要动。
#   加一个带默认值的参数则完全向后兼容：老调用一行不用改，仍然记 INFO。
#   只有真正需要区分级别的地方才加 -Level。
function Log-Card {
    param(
        [string]$Msg,
        # 级别：INFO / WARN / ERR。默认 INFO
        [string]$Level = 'INFO',
        # 去重键。传了之后，同一个键 60 秒内只记第一条。
        # 【为什么需要】有些地方在 500ms/900ms 的循环里调，一旦失败会连续刷屏
        # （比如"磨砂刷新失败"），把真正有用的记录冲掉。
        [string]$Key = ''
    )

    try {
        # ---- 去重
        if (-not [string]::IsNullOrEmpty($Key)) {
            if ($null -eq $script:logDedupe) {
                $script:logDedupe = @{}
            }
            $now = [datetime]::Now
            $last = $script:logDedupe[$Key]
            if ($null -ne $last -and ($now - $last).TotalSeconds -lt 60) {
                return
            }
            $script:logDedupe[$Key] = $now
        }

        # ---- 级别规范化
        $lv = 'INFO'
        if ($Level -eq 'ERR' -or $Level -eq 'ERROR') { $lv = 'ERR' }
        elseif ($Level -eq 'WARN' -or $Level -eq 'WARNING') { $lv = 'WARN' }

        # ---- 时间格式：本地时间 + 毫秒
        # 【为什么不用原来的 yyyy-MM-ddTHH:mm:ss】
        #   ① 少了毫秒：排查"动画卡住""双击当单击"这类时序问题需要毫秒
        #   ② 带 T 分隔符是 ISO 风格，但没带 Z（时区），
        #      和插件那边的 UTC 时间混在一起看不出来，容易对错 8 小时。
        #   现在统一成本地时间 + 空格分隔 + 毫秒，和插件端保持同一套。
        $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
        $line = ('[{0}] [PANEL] [{1}] {2}' -f $ts, $lv, $Msg) + "`r`n"

        [void](Write-LogLine -Text $line)

        # ---- 轮转检查（60 秒一次，不是每次都查）
        $now2 = [datetime]::Now
        if (($now2 - $script:LogLastRotateCheck).TotalMilliseconds -ge $script:LogRotateCheckMs) {
            $script:LogLastRotateCheck = $now2
            # 用 BeginInvoke 排到消息队列，不阻塞当前调用（这可能是 UI 线程）
            try {
                $script:logMaintPending = $true
            } catch {
                # 【故意静默 · 日志系统自身】只是设个标记变量，失败也不影响什么
            }
            Invoke-LogMaintenance
        }
    } catch {
        # 【故意静默 · 日志系统自身的最外层兜底】
        #   Log-Card 进来之后任何一步抛异常都会落到这里。
        #   绝对不能在这里记日志 —— 会无限递归。
        #   这是"日志失败绝不影响卡片主流程"这条原则的最后一道闸。
    }
}

# 记录"失败"的简写。语义和 Log-Card -Level 'ERR' 一样，
# 只是调用处短一点、意图更明确（看到 Log-Fail 就知道这是在记错误）。
function Log-Fail {
    param([string]$Where, $ErrorObject, [string]$Key = '')
    try {
        $detail = ''
        if ($null -ne $ErrorObject) {
            try {
                $detail = ($ErrorObject.Exception.GetType().Name + ': ' + $ErrorObject.Exception.Message)
            } catch {
                # 异常对象结构异常（不是标准的 ErrorRecord）：退回用字符串化
                try { $detail = [string]$ErrorObject } catch {
                    # 【故意静默 · 日志系统自身】连字符串化都失败，用固定文案兜底
                    $detail = '无法读取异常信息'
                }
            }
        }
        $msg = $Where + ' 失败'
        if (-not [string]::IsNullOrEmpty($detail)) { $msg = $msg + ': ' + $detail }
        Log-Card $msg -Level 'ERR' -Key $Key
    } catch {
        # 【故意静默 · 日志系统自身】Log-Fail 自己出错时不能再记日志（递归）
    }
}


# 【v0.9.12 新增：启动横幅】
#
# 【为什么必须有一条启动记录】
#   panel.log 原来只在"用户做了某个操作"时才写（进出柱态、点审批…）。
#   后果是：改了代码让用户重启，用户以为重启了，但日志里**看不出来**
#   到底重启没重启 —— 因为正常启动什么也不写。
#   v0.9.11 那次"柱状图没看到蓝条闪动"就是这么排查了十几分钟的：
#   只能靠比对 plugin.log 的"卡片启动成功"和 Panel.ps1 的修改时间。
#
#   现在每次启动写一行，带 pid 和代码时间戳，一眼就能确认
#   "我看到的这个效果，到底是哪一版代码跑出来的"。
try {
    # 【为什么先存变量再链式调用，不写成两行】
    #   PS 5.1 不认"以点号开头的续行"：
    #     [DateTimeOffset]::FromUnixTimeMilliseconds($x)
    #         .ToLocalTime()
    #   第一行已经是一个完整表达式，换行即语句结束；
    #   第二行以 . 开头 → "“(”后面应为表达式" 的语法错误。
    #   存进变量再调，既避开这个坑，也更好读。
    $stampText = '未知'
    if ($script:scriptStampMs -gt 0) {
        $stampDto = [DateTimeOffset]::FromUnixTimeMilliseconds($script:scriptStampMs)
        $stampText = $stampDto.ToLocalTime().ToString('MM-dd HH:mm:ss')
    }
    Log-Card ('卡片启动 pid=' + $PID + ' 代码版本时间=' + $stampText)
} catch {
    # 【故意静默 · 日志系统自身】启动横幅本身就调 Log-Card，
    # 这里再记日志要么递归、要么在日志系统还没就绪时失败。
    # 启动横幅丢一条不影响功能（心跳里另有 scriptStampMs 可供核对）。
}

Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DshWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);

    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    /**
     * 在给定的一组进程 id 里，找那个真正的"主窗口"。
     *
     * 【判据为什么不能只按"可见 + 尺寸够大"筛】
     *   实测抓到的坑：DSH 被最小化后，实测 GetWindowRect 给出 1292x826，
     *   但 IsWindowVisible 可能已经变成 false，尺寸也可能缩水。
     *   只按「可见 + >400x300」筛，最小化状态下会一个都筛不出来 ——
     *   而"点卡片回到 DSH"最常见的场景恰恰是 DSH 在后台/最小化。
     *   这就是之前"点了没反应"的真正原因：
     *     找不到窗口 -> 走进协议分支 -> 协议本身不激活窗口 -> 什么都不发生。
     *
     *   现在改成两档：
     *     1. 优先「可见 且 尺寸合理」里面积最大的
     *     2. 一个都没有时，退回「属于目标进程的顶层窗口」里面积最大的
     *        （哪怕它现在是隐藏/最小化的）
     *   后面的 Activate 会先 SW_RESTORE 再切前台，所以拿到隐藏窗口也能用。
     */
    public static IntPtr FindMainWindow(uint[] pids) {
        var set = new HashSet<uint>();
        for (int i = 0; i < pids.Length; i++) set.Add(pids[i]);

        IntPtr bestVisible = IntPtr.Zero; int bestVisibleArea = 0;
        IntPtr bestAny = IntPtr.Zero; int bestAnyArea = 0;
        int total = 0, hitPid = 0, hitVisible = 0, hitSize = 0;

        EnumWindows((h, l) => {
            total++;
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (!set.Contains(pid)) return true;
            hitPid++;

            RECT r; GetWindowRect(h, out r);
            int w = r.Right - r.Left, ht = r.Bottom - r.Top;
            int area = w * ht;
            bool vis = IsWindowVisible(h);
            if (vis) hitVisible++;
            if (w >= 400 && ht >= 300) hitSize++;

            if (area > bestAnyArea) { bestAnyArea = area; bestAny = h; }
            if (vis && w >= 400 && ht >= 300 && area > bestVisibleArea) {
                bestVisibleArea = area; bestVisible = h;
            }
            return true;
        }, IntPtr.Zero);

        LastStats = string.Format("传入{0}个pid 总窗口{1} pid命中{2} 可见{3} 尺寸合格{4}",
            pids.Length, total, hitPid, hitVisible, hitSize);

        if (bestVisible != IntPtr.Zero) return bestVisible;
        return bestAny;
    }

    /** 上一次 FindMainWindow 的分步统计，用于诊断 */
    public static string LastStats = "";

    /**
     * 找 DSH 主窗口（推荐用这个）。
     *
     * 【最小化时窗口会缩水到 157x25 —— 这是踩坑的核心】
     *   实测数据：
     *
     *   正常显示：
     *     hwnd=1773410  vis=True   iconic=False  1292x826   <- 就是这个
     *     hwnd=1380308  vis=False  iconic=False  1200x696   <- Electron 隐藏辅助窗口
     *
     *   最小化后：
     *     hwnd=1773410  vis=True   iconic=True    157x25    <- 尺寸缩没了
     *     hwnd=1380308  vis=False  iconic=False  1200x696   <- 反倒成了最大的
     *
     *   所以两种错误做法都会失败：
     *     · 按"面积最大"挑 -> 最小化时挑到 1380308（辅助窗口），激活它屏幕上没反应
     *     · 按">400x300"筛 -> 最小化时主窗口被筛掉，一个都不剩
     *
     *   正确判据：先按 IsIconic 分类，最小化的不设尺寸门槛。
     */
    public static IntPtr FindMainWindowSmart(uint[] pids) {
        var set = new HashSet<uint>();
        for (int i = 0; i < pids.Length; i++) set.Add(pids[i]);

        IntPtr bestShown = IntPtr.Zero; int bestShownArea = 0;
        IntPtr bestIconic = IntPtr.Zero; int bestIconicArea = 0;
        int total = 0, hitPid = 0;

        EnumWindows((h, l) => {
            total++;
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (!set.Contains(pid)) return true;
            hitPid++;

            RECT r; GetWindowRect(h, out r);
            int w = r.Right - r.Left, ht = r.Bottom - r.Top;
            int area = w * ht;

            if (IsIconic(h)) {
                // 最小化：尺寸不可信（实测缩成 157x25），不设尺寸门槛，
                // 但要排除 0x0 的空壳窗口
                if (w > 0 && ht > 0 && area > bestIconicArea) {
                    bestIconicArea = area; bestIconic = h;
                }
            } else if (IsWindowVisible(h) && w >= 400 && ht >= 300) {
                if (area > bestShownArea) { bestShownArea = area; bestShown = h; }
            }
            return true;
        }, IntPtr.Zero);

        IntPtr result; string how;
        if (bestShown != IntPtr.Zero) { result = bestShown; how = "显示中"; }
        else if (bestIconic != IntPtr.Zero) { result = bestIconic; how = "最小化"; }
        else { result = IntPtr.Zero; how = "没找到"; }

        LastStats = string.Format("传入{0}个pid 总窗口{1} pid命中{2} 选中hwnd={3}({4})",
            pids.Length, total, hitPid, result, how);
        return result;
    }

    /**
     * 兜底方案：直接用进程的 MainWindowHandle。
     * FindMainWindow 万一因为环境差异还是返回 0，这个方法通常还能用。
     */
    public static IntPtr FindByMainWindowHandle(uint[] pids) {
        for (int i = 0; i < pids.Length; i++) {
            try {
                var p = System.Diagnostics.Process.GetProcessById((int)pids[i]);
                if (p.MainWindowHandle != IntPtr.Zero && IsWindowVisible(p.MainWindowHandle)) {
                    return p.MainWindowHandle;
                }
            } catch {
                // 【注意：这是 C# 代码，不是 PowerShell】
                //   本文件里内嵌了一段 C#（Add-Type 块），里面的 catch 必须保持 C# 语法。
                //   这里不能写 Log-Fail —— 那是 PowerShell 函数，C# 里调不到，
                //   而且会把整个 C# 块写成语法错误（实测：整个卡片启动失败）。
                //   进程可能正好退出（GetProcessById 抛异常），跳过继续找下一个即可。
            }
        }
        return IntPtr.Zero;
    }

    /** 把窗口激活到前台。先还原（如果最小化了），再切前台。 */
    public static string Activate(IntPtr h) {
        if (h == IntPtr.Zero || !IsWindow(h)) return "no-window";
        bool wasIconic = IsIconic(h);
        if (wasIconic) ShowWindow(h, 9);          // SW_RESTORE

        // 先直接试。多数情况下这就够了。
        bool ok = SetForegroundWindow(h);

        if (!ok || GetForegroundWindow() != h) {
            // 前台锁：Windows 只允许"当前前台进程"或"刚获得用户的进程"切前台。
            // 用 AttachThreadInput 临时和前台线程共享输入队列，绕过这个限制。
            IntPtr fg = GetForegroundWindow();
            uint targetPid; uint targetTid = GetWindowThreadProcessId(h, out targetPid);
            uint myTid = GetCurrentThreadId();
            uint fgPid; uint fgTid = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out fgPid);

            bool a1 = AttachThreadInput(myTid, targetTid, true);
            bool a2 = fgTid != 0 && fgTid != myTid ? AttachThreadInput(myTid, fgTid, true) : false;
            try {
                BringWindowToTop(h);
                ok = SetForegroundWindow(h);
            } finally {
                if (a1) AttachThreadInput(myTid, targetTid, false);
                if (a2) AttachThreadInput(myTid, fgTid, false);
            }
        }

        bool isFg = GetForegroundWindow() == h;
        return string.Format("restored={0} setFg={1} isForeground={2}", wasIconic, ok, isFg);
    }
}
'@

# 协议路径只在"DSH 没开着"时才有用，留作备用
$script:dshProtocol = 'dsh://'
$script:protocolOk = $false
try {
    $cmd = (Get-ItemProperty 'HKCU:\Software\Classes\dsh\shell\open\command' -ErrorAction Stop).'(default)'
    if (-not [string]::IsNullOrWhiteSpace($cmd)) { $script:protocolOk = $true }
} catch { Log-Fail 'L1154' $_ }

# 卡片自己的窗口句柄。激活 DSH 时要先把卡片让开，
# 否则卡片是 Topmost，会把刚切上来的 DSH 挡住一点（视觉上像没成功）。
$script:panelHwnd = [IntPtr]::Zero

# "让位 -> 激活 -> 恢复置顶"里那个延时定时器。
# 必须存在 $script: 作用域（不能在函数里建局部变量，原因见 Invoke-OpenDshFlow）。
$script:restoreTopmostTimer = $null

function Get-DshWindow {
    try {
        $list = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
        if ($list.Count -eq 0) {
            Log-Card 'Get-DshWindow: 没找到 DeepSeek Harness 进程'
            return [IntPtr]::Zero
        }
        $pids = @()
        foreach ($p in $list) { $pids += [uint32]$p.Id }
        # FindMainWindowSmart 会区分「显示中 / 最小化 / 纯隐藏」，
        # 只接受前两种；否则会挑到 Electron 的隐藏辅助窗口，激活了也没用。
        $h = [DshWin]::FindMainWindowSmart([uint32[]]$pids)
        Log-Card ('  选窗: ' + [DshWin]::LastStats)
        if ($h -eq [IntPtr]::Zero) {
            $h = [DshWin]::FindByMainWindowHandle([uint32[]]$pids)
            Log-Card '  没找到，改用 MainWindowHandle 兜底'
        }
        Log-Card ('Get-DshWindow: {0} 个进程 => hwnd={1}' -f $list.Count, $h)
        return $h
    } catch {
        Log-Card ('Get-DshWindow 异常: ' + $_.Exception.Message)
        return [IntPtr]::Zero
    }
}

<#
 回到 DSH。

 顺序：
   1. 找 DSH 主窗口 -> 激活它（主方案，实测有效）
   2. 找不到窗口 = DSH 没开着 -> 用 dsh:// 协议启动它
   3. 还不行 -> 用插件同步来的网址打开浏览器（最后的兜底）

 为什么把"激活窗口"放第一位：
   用户点卡片的意图是"回到我正在用的那个 DSH"，而不是"再开一个"。
   协议路径实测不会激活已有窗口，所以不能放第一位。
#>
function Open-Dsh {
    # --- 1. 直接激活已开着的窗口
    $hwnd = Get-DshWindow
    if ($hwnd -ne [IntPtr]::Zero) {
        $r = $null
        try { $r = [DshWin]::Activate($hwnd) } catch { $r = 'exception: ' + $_.Exception.Message }
        Log-Card ('激活 DSH 窗口: ' + $r)
        if ($r -match 'isForeground=True') { return $true }
        # 激活没成功也继续往下试，别直接放弃
    }

    # --- 2. DSH 没开着（或激活失败）：用协议启动
    if ($script:protocolOk) {
        try {
            Start-Process $script:dshProtocol | Out-Null
            Log-Card '用 dsh:// 协议启动 DSH'
            # 给 DSH 一点启动时间，再尝试激活一次
            Start-Sleep -Milliseconds 1500
            $h2 = Get-DshWindow
            if ($h2 -ne [IntPtr]::Zero) {
                [void][DshWin]::Activate($h2)
                return $true
            }
            return $true
        } catch {
            Log-Card ('协议启动失败: ' + $_.Exception.Message)
        }
    }

    # --- 3. 兜底：浏览器打开真实网址
    if (-not [string]::IsNullOrWhiteSpace($dshUrl)) {
        try {
            Start-Process $dshUrl | Out-Null
            Log-Card ('退回用浏览器打开: ' + $dshUrl)
            return $true
        # 【故意静默】失败无害，下个周期会自动重试；记了会把日志刷爆
        } catch { }
    }

    Log-Card '所有方式都失败了'
    return $false
}

# 系统深浅色
$isDark = $false
try {
    $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop
    if ($null -ne $reg.AppsUseLightTheme) { $isDark = ($reg.AppsUseLightTheme -eq 0) }
# 【故意静默】失败无害，下个周期会自动重试；记了会把日志刷爆
} catch { }

# ---------------------------------------------------------------- 峰谷
#
# 【为什么不再读 settings.json 里的 valley】
#   原先靠用户手填 {"mon": [["00:30","08:30"]], ...}。但 DeepSeek 官方规则是：
#     北京时间周一至周五（不含法定节假日）09:00-12:00、14:00-18:00 为高峰；
#     其余时段（含周末、法定节假日全天）为低谷。
#   手填的"每天 00:30-08:30"跟官方差得远，卡片上那个倒计时基本是错的。
#
#   现在改由插件（lib/valley.js）算好，写进 state.json 的 valley 字段：
#     { "inValley": true, "remainingSec": 3600, "reason": "off-window" }
#   卡片只负责显示，不再自己维护时刻表。
#
#   万一插件没给（老版本插件 / 配置文件里关了），退回读 settings.json 的老格式，
#   保证卡片仍然能用 —— 不能让"升级一半"变成"卡死"。
$DayKeys = @('sun','mon','tue','wed','thu','fri','sat')

function ConvertTo-Minutes {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $parts = $Text.Split(':')
    if ($parts.Length -lt 2) { return $null }
    $h = 0; $m = 0
    if (-not [int]::TryParse($parts[0], [ref]$h)) { return $null }
    if (-not [int]::TryParse($parts[1], [ref]$m)) { return $null }
    if ($h -lt 0 -or $h -gt 23 -or $m -lt 0 -or $m -gt 59) { return $null }
    return ($h * 60 + $m)
}

function Get-ValleyStatus {
    param($Config, [datetime]$Now)
    if ($null -eq $Config) { return $null }

    $items = New-Object System.Collections.ArrayList
    for ($offset = -1; $offset -le 2; $offset++) {
        $day = $Now.Date.AddDays($offset)
        $key = $DayKeys[[int]$day.DayOfWeek]
        $prop = $Config.PSObject.Properties[$key]
        if ($null -eq $prop -or $null -eq $prop.Value) { continue }
        foreach ($range in $prop.Value) {
            if ($null -eq $range -or $range.Count -lt 2) { continue }
            $s = ConvertTo-Minutes ([string]$range[0])
            $e = ConvertTo-Minutes ([string]$range[1])
            if ($null -eq $s -or $null -eq $e -or $s -eq $e) { continue }
            $st = $day.AddMinutes($s)
            $en = $day.AddMinutes($e)
            if ($e -lt $s) { $en = $en.AddDays(1) }
            [void]$items.Add([pscustomobject]@{ Start = $st; End = $en })
        }
    }
    if ($items.Count -eq 0) { return $null }

    foreach ($iv in $items) {
        if ($Now -ge $iv.Start -and $Now -lt $iv.End) {
            return [pscustomobject]@{ InValley = $true; Remaining = ($iv.End - $Now) }
        }
    }
    $next = $null
    foreach ($iv in $items) {
        if ($iv.Start -gt $Now) {
            if ($null -eq $next -or $iv.Start -lt $next.Start) { $next = $iv }
        }
    }
    if ($null -eq $next) { return $null }
    return [pscustomobject]@{ InValley = $false; Remaining = ($next.Start - $Now) }
}

# 从插件写来的 valley 字段还原成和 Get-ValleyStatus 一样的结构，
# 这样调用方不用改。
# 插件给的是 { inValley: bool, remainingSec: number }，秒是"距下次切换"。
function Get-ValleyFromState {
    param($ValleyField)
    if ($null -eq $ValleyField) { return $null }
    $in = Get-Setting $ValleyField 'inValley' $null
    if ($null -eq $in) { return $null }
    $sec = [double](Get-Setting $ValleyField 'remainingSec' 0)
    if ($sec -lt 0) { $sec = 0 }
    return [pscustomobject]@{
        InValley = [bool]$in
        Remaining = [timespan]::FromSeconds($sec)
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

# 任务已经跑了多久
function Format-Elapsed {
    param([double]$Seconds)
    if ($Seconds -lt 0) { $Seconds = 0 }
    $s = [int][math]::Round($Seconds)
    if ($s -lt 60) { return "${s}秒" }
    $m = [int][math]::Floor($s / 60)
    if ($m -lt 60) { return "${m}分" }
    $h = [int][math]::Floor($m / 60)
    return ("{0}小时{1}分" -f $h, ($m % 60))
}

function Format-Tokens {
    param([long]$Value)
    if ($Value -lt 1000) { return "$Value" }
    if ($Value -lt 1000000) { return ("{0:N1}k" -f ($Value / 1000.0)) }
    return ("{0:N1}M" -f ($Value / 1000000.0))
}

# 任务行右下角那个"本次会话 Token"（v0.10.0）
#
# 【和 Format-Tokens 的区别：多带了"Token"这个单位词】
#   底部那行是「今日 25.3M Token」，单位已经在句子里了；
#   而任务行这个数字是孤零零一个小字，不写单位谁知道它是什么数。
#   用户 2026-10-31 拍板要「12.3k Token」这个样式。
#
# 【为什么这里不计"0"出来】
#   和上面 Format-Elapsed 的取法一致：数字拿不到（老插件、老 state.json、
#   审批行、完成行）就返回空字符串，让控件自动塌成 0 宽、什么都不显示。
#   显示 "0 Token" 会让人以为"这个任务真的一个 Token 都没用"，
#   但更可能只是"这条数据本来就没有"，编一个 0 出来是误导。
#   真的是 0（新会话刚开始）也走空字符串 —— 反正刚开跑时本来就没什么可看的。
function Format-TaskTokens {
    param([long]$Value)
    if ($Value -le 0) { return '' }
    return ((Format-Tokens $Value) + ' Token')
}

# ---------------------------------------------------------------- 读状态
# state.json 结构（tasks.sessions 是新增的，缺了也能跑，只是只知道条数不知道明细）：
# {
#   "tasks": { "running": 2, "sessions": [
#       { "title": "重构登录模块", "elapsedSec": 372, "activity": "正在编辑 auth.ts" } ] },
#   "approval": { "pending": 1, "items": [ { "title": "清理临时文件" } ] },
#   "tokens": { "today": 12300 },
#   "lastFinished": "20261027115336"
# }
# ---------------------------------------------------------------- 读文件（不锁）
#
# 【为什么不用 Get-Content】
#   Get-Content 读文件时用的是 FileShare.Read —— 意思是"别人可以读，不许改不许删"。
#   插件写 state.json 的方式是"写临时文件 → 改名覆盖"，
#   改名需要目标文件**没有任何句柄**，偏偏卡片每 500ms 就要读一次。
#   两者一撞，插件的改名就会失败（实测日志里的 EPERM 就是这么来的）。
#   卡片读得再快也只有 1~3ms，但插件每秒撞上几十次，迟早会撞到。
#
#   所以这里自己开文件，明确声明 FileShare.ReadWrite + Delete：
#   "我读的时候你随便改、随便删"。Windows 就不会因为卡片在读而挡住插件改名。
#
# 【为什么不担心读到半截】
#   插件是"写 tmp → 原子改名"，不是"就地覆盖"。所以卡片要么读到完整的旧内容，
#   要么读到完整的新内容，不存在中间态。这一点在任何共享模式下都成立。
function Read-SharedText {
    param([string]$Path)
    $fs = $null
    $sr = $null
    try {
        $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
        $fs = New-Object System.IO.FileStream(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            $share
        )
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        return $sr.ReadToEnd()
    }
    catch {
        return $null
    }
    finally {
        if ($null -ne $sr) { try { $sr.Dispose() } catch { } }
        if ($null -ne $fs) { try { $fs.Dispose() } catch { } }
    }
}

# ---------------------------------------------------------------- 状态健康（v0.10.8 · C2）
#
# 【这个函数解决什么问题 —— 一个"看起来正常"的骗局】
#
#   改造之前，Read-PanelState 在下面四种情况下**统一返回 0 任务 / 0 审批 / 0 Token**：
#     · state.json 不存在
#     · 读取失败（被锁、权限受限）
#     · JSON 解析失败（插件写了一半 / 文件损坏）
#     · 插件停了，没人再更新文件
#
#   结果：「DSH 真的没事做」和「卡片根本拿不到数据」在屏幕上一模一样 ——
#   都显示"空闲"。用户的卡片写着"空闲"，其实插件早就挂了，还蒙在鼓里。
#
#   反过来还有另一种坑：插件停了，卡片一直显示最后一次的旧数字，
#   用户以为还是新数据。
#
# 【怎么解决】
#   把"健康判断"抽成一个**纯函数**，不在里面碰任何 WPF 控件。
#   这样它可以被 test/c2-state-health.ps1 单独加载测试，
#   不需要真的弹出一张卡片。
#
#   六种判定：
#     ok          读到合法 JSON，且新鲜           → 可以正常显示（包括"真空闲"）
#     missing     文件不存在                      → 不能显示空闲
#     readError   文件在但读不出来（被锁/权限）   → 不能显示空闲
#     invalidJson 内容不是合法 JSON               → 不能显示空闲
#     stale       读到了，但 updatedAt 太久没动   → 保留旧内容 + 轻提示
#     timeAnomaly updatedAt 在未来（时钟被改过）  → 不提示（不是数据问题）
#
# 【为什么阈值是 15 秒 —— 用户 2026-11-02 拍板】
#   卡片主循环 500ms 读一次、插件 1 秒兜底刷新，正常情况每秒都在变。
#   15 秒 ≈ 正常刷新间隔的 15 倍：
#     · 足够大，躲得开"插件写文件瞬间撞上卡片读"这类几十毫秒的抖动
#     · 足够小，真出问题时 15 秒内就能看见提示，不用等一分钟
#
# 【为什么是纯函数，不带 Path 参数】
#   读文件的工作由 Read-PanelState 做（它已经有重试、共享读取等一堆讲究）。
#   这里只接收"已经读到的结果"，纯粹做分类。职责分开才测得动。
function Get-StaleHealthSeconds {
    # 数据多久没更新算"可能不是最新"（秒）。用户拍板 15。
    return 15
}

function Get-StateHealth {
    param(
        # 读到的原始文本（$null 表示没读到）
        $Raw = $null,
        # Read-PanelState 在读取阶段就已经知道的原因
        # 可选值：ok / missing / readError / invalidJson
        [string]$ErrorKind = 'ok',
        # state.json 里的 updatedAt（秒）。0 或非正表示没有/读不到
        [double]$UpdatedAtSec = 0,
        # 当前时间，注入以便测试可重复
        [datetime]$Now = [datetime]::Now,
        # 解析出来的对象是否可用（JSON 合法且是对象）
        [bool]$ObjectValid = $true
    )

    # ---- 先处理"读取阶段就失败"的三种：这些都不用看时间戳
    if ($ErrorKind -eq 'missing') {
        return [pscustomobject]@{
            Kind = 'missing'; IsDegraded = $true; CanShowIdle = $false
            AgeSec = -1; Message = '数据未更新'
        }
    }
    if ($ErrorKind -eq 'readError') {
        return [pscustomobject]@{
            Kind = 'readError'; IsDegraded = $true; CanShowIdle = $false
            AgeSec = -1; Message = '数据未更新'
        }
    }
    if ($ErrorKind -eq 'invalidJson') {
        return [pscustomobject]@{
            Kind = 'invalidJson'; IsDegraded = $true; CanShowIdle = $false
            AgeSec = -1; Message = '数据未更新'
        }
    }

    # ---- 读到了，但内容不是可用对象
    if (-not $ObjectValid) {
        return [pscustomobject]@{
            Kind = 'invalidJson'; IsDegraded = $true; CanShowIdle = $false
            AgeSec = -1; Message = '数据未更新'
        }
    }

    # ---- 时间戳不可用（0 / 负数 / NaN）
    #
    # 【为什么不判成 stale】
    #   没有时间戳 = 不知道多久没更新。这时候说"过期了"是编的。
    #   按本项目一贯原则：判断不了就不下结论，当作正常。
    #   （老版本 state.json 可能真的没有 updatedAt —— 那时也不能误报。）
    if (-not ($UpdatedAtSec -gt 0)) {
        return [pscustomobject]@{
            Kind = 'ok'; IsDegraded = $false; CanShowIdle = $true
            AgeSec = -1; Message = ''
        }
    }

    # ---- 算出数据年龄
    $nowSec = [double][DateTimeOffset]::new($Now.ToUniversalTime()).ToUnixTimeSeconds()
    $age = $nowSec - $UpdatedAtSec

    # 【未来时间：时钟被改过或者插件用了错误的时间源】
    #   不判陈旧（那不是数据的问题），但也不当成"新鲜"。
    #   单独一个 timeAnomaly，不提示用户（提示了也帮不上忙）。
    #   10 秒容忍：同一次读里 now 和 updatedAt 有亚秒级误差很正常。
    if ($age -lt -10) {
        return [pscustomobject]@{
            Kind = 'timeAnomaly'; IsDegraded = $false; CanShowIdle = $true
            AgeSec = $age; Message = ''
        }
    }

    $threshold = Get-StaleHealthSeconds

    # ---- 超过阈值 → 陈旧
    if ($age -ge $threshold) {
        return [pscustomobject]@{
            Kind = 'stale'; IsDegraded = $true; CanShowIdle = $true
            AgeSec = $age; Message = '数据未更新'
        }
    }

    # ---- 一切正常
    return [pscustomobject]@{
        Kind = 'ok'; IsDegraded = $false; CanShowIdle = $true
        AgeSec = $age; Message = ''
    }
}
function Read-PanelState {
    param([string]$Path)
    # 【v0.10.8 · C2】$empty 现在带健康信息。
    #   注意：这个对象是"兜底空状态"，它必须标明"为什么空"。
    #   原来它什么标记都不带，于是 Update-UI 无法区分
    #   「DSH 真的没事做」和「拿不到数据」——两者都显示"空闲"。
    $empty = [pscustomobject]@{
        running = 0; approval = 0; todayTokens = [long]0
        lastFinished = $null; tasks = @(); approvals = @(); valley = $null
        subagentCount = 0
        approvalLast = $null
        Health = (Get-StateHealth -ErrorKind 'missing' -Now ([datetime]::Now))
    }
    if (-not (Test-Path $Path)) {
        # 【v0.10.8 · C2】文件不存在：不能显示成"空闲"
        return $empty
    }
    try {
        $raw = Read-SharedText $Path
        # 【v0.10.8 · C2】读失败（被锁/权限）和"文件为空"不是一回事。
        #   Read-SharedText 读不到时返回 $null；真的空文件返回空串。
        if ($null -eq $raw) {
            return [pscustomobject]@{
                running = 0; approval = 0; todayTokens = [long]0
                lastFinished = $null; tasks = @(); approvals = @(); valley = $null
                subagentCount = 0
                approvalLast = $null
                Health = (Get-StateHealth -ErrorKind 'readError' -Now ([datetime]::Now))
            }
        }
        if ([string]::IsNullOrWhiteSpace($raw)) { return $empty }
        $data = $raw | ConvertFrom-Json
    }
    catch {
        # 【v0.10.8 · C2】JSON 坏了（写了一半 / 文件损坏）—— 不能当成"空闲"
        return [pscustomobject]@{
            running = 0; approval = 0; todayTokens = [long]0
            lastFinished = $null; tasks = @(); approvals = @(); valley = $null
            subagentCount = 0
            approvalLast = $null
            Health = (Get-StateHealth -ErrorKind 'invalidJson' -Now ([datetime]::Now))
        }
    }

    $running = 0; $tasks = @()
    # 正在跑的子代理数量（v0.6.0 插件新增的字段）。
    # 向后兼容：老 state.json 没这个字段 → Get-Setting 给默认值 0，
    # 行为跟改动前完全一样（永远走不到"子智能体在跑"那条分支）。
    $subagentCount = 0
    $t = Get-Setting $data 'tasks' $null
    if ($null -ne $t) {
        $running = [int](Get-Setting $t 'running' 0)
        try { $subagentCount = [int](Get-Setting $t 'subagentCount' 0) } catch { $subagentCount = 0 }
        if ($subagentCount -lt 0) { $subagentCount = 0 }
        $sess = Get-Setting $t 'sessions' $null
        if ($null -ne $sess) {
            $out = New-Object System.Collections.ArrayList
            foreach ($s in @($sess)) {
                if ($null -eq $s) { continue }
                $title = [string](Get-Setting $s 'title' '未命名任务')
                $el = [double](Get-Setting $s 'elapsedSec' 0)
                $act = [string](Get-Setting $s 'activity' '')
                # 【v0.10.0】这个任务今天用了多少 Token（插件 v0.10.0 起才有）。
                #   注意：这是"任务"的量，含它派生出来的子代理会话（插件侧算好）。
                #
                # 【为什么必须走 Get-Setting，不能直接 $s.tokens】
                #   老版本 state.json 里没有这个字段（用户插件没升级、或者
                #   test/ 下那些脚本自己造的假 state.json 只有三个字段）。
                #   直接 [long]$s.tokens 在字段缺失时取值是 $null，
                #   转 [long] 有的情况下会抛异常，整行数据就被丢掉了 ——
                #   表现是"卡片上任务名突然全没了"（和 v0.9.10 elapsedSec 同款坑）。
                #   Get-Setting 缺字段返回默认值 0，最差只是这一行不显示 Token。
                #
                # 【为什么还要再包一层 try/catch】（2026-10-31 复核后补的）
                #   Get-Setting 只解决"字段不存在"，解决不了"字段类型不对"。
                #   实测 [long]'abc' 会抛；JSON 里写 1e+300 会被解析成 Double，
                #   转 [long] 也会溢出抛异常。
                #   而这个 foreach **外面没有** per-item 的 try/catch，只有最外层
                #   读到 JSON 那一层的 catch —— 也就是说一条脏数据会中断整个
                #   行列表的解析，卡片标题变成"读取状态出错"并一直停在那。
                #   和 v0.9.10 给 elapsedSec 加兜底是同一个道理：最差显示 0，
                #   不能让一条坏数据把整张卡片拖死。
                $tok = [long]0
                try {
                    $tok = [long](Get-Setting $s 'tokens' 0)
                    if ($tok -lt 0) { $tok = [long]0 }
                }
                catch {
                    $tok = [long]0
                }
                [void]$out.Add([pscustomobject]@{
                    Title = $title; Elapsed = $el; Activity = $act; Tokens = $tok
                })
            }
            $tasks = $out.ToArray()
        }
    }

    $approval = 0; $approvals = @()
    $approvalLast = $null
    $a = Get-Setting $data 'approval' $null
    if ($null -ne $a) {
        $approval = [int](Get-Setting $a 'pending' 0)
        $items = Get-Setting $a 'items' $null
        if ($null -ne $items) {
            $out2 = New-Object System.Collections.ArrayList
            foreach ($it in @($items)) {
                if ($null -eq $it) { continue }
                # v0.8.0：把悬浮窗审批需要的字段一并读出来。
                #   id / nonce —— 写决定文件必须带的（nonce 是一次性校验串）
                #   answerable —— 插件明确告诉我们"此刻点了会生效吗"
                #                 开关关时插件**根本不输出这个字段**，
                #                 所以这里读到 $null 就说明"该显示去处理"
                #   expiresAtMs —— 超过这个时刻按钮置灰
                #   blockReason —— 插件给的不健康原因，直接显示给用户
                #
                # 全部用 Get-Setting 带默认值，老 state.json 缺字段时
                # 行为和改动前完全一样（向后兼容）。
                $ansRaw = $null
                $pAns = $it.PSObject.Properties['answerable']
                if ($null -ne $pAns) { $ansRaw = $pAns.Value }

                [void]$out2.Add([pscustomobject]@{
                    Title       = [string](Get-Setting $it 'title' '待审批操作')
                    Id          = [string](Get-Setting $it 'id' '')
                    Nonce       = [string](Get-Setting $it 'nonce' '')
                    ToolName    = [string](Get-Setting $it 'toolName' '')
                    SessionId   = [string](Get-Setting $it 'sessionId' '')
                    ExpiresAtMs = [double](Get-Setting $it 'expiresAtMs' 0)
                    # 三态：$null = 插件没给这个字段（= 开关关）→ 只显示"去处理"
                    #        $true / $false = 开关开时插件的判断
                    Answerable  = $ansRaw
                    BlockReason = [string](Get-Setting $it 'blockReason' '')
                })
            }
            $approvals = $out2.ToArray()
        }
        # 回执（v0.8.0）：点了按钮之后的结果，卡片显示"已生效 / 失败原因"
        $approvalLast = Get-Setting $a 'lastDecision' $null
    }

    $tokens = [long]0
    $tk = Get-Setting $data 'tokens' $null
    if ($null -ne $tk) { $tokens = [long](Get-Setting $tk 'today' 0) }

    # 【v0.10.8 · C2】算健康状态。走到这里说明 JSON 已经解析成功。
    #   拿 state.json 的 updatedAt（秒）判断"是不是太久没更新了"。
    #   老 state.json 没有 updatedAt 时 UpdatedAtSec = 0，
    #   Get-StateHealth 会当作"判断不了"→ 不误报（向后兼容）。
    $updSec = 0
    try {
        $updRaw = Get-Setting $data 'updatedAt' 0
        $updSec = [double]$updRaw
    } catch { $updSec = 0 }

    $health = Get-StateHealth -Raw $null -ErrorKind 'ok' -UpdatedAtSec $updSec `
        -Now ([datetime]::Now) -ObjectValid $true

    return [pscustomobject]@{
        running = $running; approval = $approval; todayTokens = $tokens
        lastFinished = (Get-Setting $data 'lastFinished' $null)
        tasks = $tasks; approvals = $approvals
        valley = (Get-Setting $data 'valley' $null)
        # 正在跑的子代理数量（插件 v0.6.0 新增）。上面第 747-752 行已经解析过；
        # 这里必须带出来，否则 Update-UI 里 $State.subagentCount 永远是 $null，
        # "子智能体还在跑"那条分支永远不触发（实测踩过：只有子代理在跑时卡片仍显示空闲）。
        subagentCount = $subagentCount
        # v0.8.0 悬浮窗审批的回执（没有就是 $null，卡片不显示回执行）
        approvalLast = $approvalLast
        # 【v0.10.8 · C2】健康信息。Update-UI 用它区分"真空闲"和"拿不到数据"。
        Health = $health
    }
}

# ---------------------------------------------------------------- 界面
. (Join-Path $ScriptDir 'PanelVisual.ps1')

$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnLastWindowClose'

# ---------------------------------------------------------------- 兜底：不让一个异常把卡片整个带走
#
# 【为什么要这个网】
#   v0.5.1 出过一个真实事故：点一下卡片，卡片窗口凭空消失，而且再也不回来了。
#   原因不是"激活 DSH 失败"，而是 Win32 激活成功之后、700ms 后那个恢复置顶的
#   定时器里抛了异常，没人接住，整个 WPF 应用直接退出（详见 Invoke-OpenDshFlow
#   上面的注释）。
#
#   WPF 的规矩是：任何事件回调（定时器 Tick、鼠标事件、菜单点击）里抛出未捕获的
#   异常，就等于 "这个应用该结束了"。卡片是常驻的悬浮窗，绝不能因为一个次要动作
#   （恢复置顶、刷磨砂、读状态）失败就消失。
#
#   所以这里装一张网：
#     - 记一条日志，写清是什么异常（排查时能直接看到）
#     - e.Handled = $true 把它吞掉，让消息循环继续跑
#
#   注意：这张网只是"兜底"，不能当成"可以不写 try/catch"的理由。
#   真正的 bug 还是要修（v0.5.2 就修了定时器作用域那个）。
$app.Add_DispatcherUnhandledException({
    param($sender, $e)
    try {
        $ex = $e.Exception
        # 【v0.10.5：级别从 INFO 改成 ERR，文案写清后果】
        #   原来记的是 [INFO]「拦截到未捕获异常（卡片继续运行）」——
        #   读起来像没事、已经被接住了，实际含义可能是
        #   这条定时器从此永久停掉，对应功能已经死了。
        #   2026-10-31 的白字 bug 就是这样潜伏的：功能已死，日志一片安静。
        #   现在至少让人在按级别筛日志时能看见它。
        Log-Card ('拦截到未捕获异常（应用未退出；但若发生在定时器回调里，该定时器可能已永久停止）: ' + 
            $ex.GetType().Name + ' / ' + $ex.Message + ' @ ' + $ex.TargetSite) -Level 'ERR'

    } catch { Log-Fail 'L1540' $_ }
    $e.Handled = $true
})

$win = New-Object System.Windows.Window
$win.Title = 'DSH-FLOATING-PANEL'
$win.WindowStyle = 'None'
$win.ResizeMode = 'NoResize'
# 【v0.9.14】不再是写死的 $true，按用户的置顶开关来（默认 true，等于原行为）
$win.Topmost = $script:topmostEnabled
$win.ShowInTaskbar = $false
$win.AllowsTransparency = $false          # 关键：必须 false，否则变成分层窗口，磨砂失效变白块
$win.Background = [System.Windows.Media.Brushes]::Transparent
$win.Width = $CardWidth
$win.Height = $CardHeight
$win.WindowStartupLocation = 'Manual'

# 【v0.10.4 修 BUG：卡片启动时会抢走键盘焦点】
#
# 【为什么必须补这一行】
#   原来"不抢焦点"只靠第 3100 行附近的 AsToolWindow()（加 WS_EX_NOACTIVATE），
#   但那一句是在 **Show() 之后**才执行的 —— 而抢焦点恰恰发生在 Show() 那一刻，
#   加 exStyle 已经来不及了。气泡窗口一直有 ShowActivated=$false，
#   主卡片偏偏漏了（全文件只有气泡那一处）。
#
# 【用户能感知到的后果】
#   DSH 拉起卡片时用户往往正在打字，那一瞬间焦点被卡片抢走，
#   正在输入的第一个字符可能被吃掉。
#
# 【为什么 ShowActivated 必须在 Show 之前设】
#   它是 WPF 的 Window 属性，只在窗口第一次被激活时生效；
#   窗口一旦创建，再改它就不影响本次激活。
#   所以必须放在这里（建窗口时），不能挪到后面。
$win.ShowActivated = $false

$host1 = New-Object System.Windows.Controls.Grid
$host1.Background = [System.Windows.Media.Brushes]::Transparent
$win.Content = $host1

# ---------------------------------------------------------------- 颜色随深浅色切换
if ($isDark) {
    # 【v0.9.6：开机初值必须和 Update-AdaptiveText 的浅字模式**同一套色**】
    #   子代理查出来的事故真相：用户截图里小字是 #5B6573，那是**启动初值**，
    #   不是自适应应该写的 #3F4855 —— 说明改色那一支从没执行过。
    #   修了早退之后，改色会执行，但如果初值和终值不同，
    #   用户仍会看到"开机那一瞬间是旧色、0.9 秒后才跳成新色"。
    #   所以两处必须是同一套值，改一处就得改另一处。
    $cTextPrimary   = [System.Windows.Media.Color]::FromArgb(255, 0xFB, 0xFC, 0xFE)
    $cTextSecondary = [System.Windows.Media.Color]::FromArgb(255, 0xE8, 0xED, 0xF4)
    $cTextTertiary  = [System.Windows.Media.Color]::FromArgb(255, 0xD3, 0xDC, 0xE8)
    $cSep           = [System.Windows.Media.Color]::FromArgb(0x22, 0xFF, 0xFF, 0xFF)
    $cFrame         = [System.Windows.Media.Color]::FromArgb(0x28, 0xFF, 0xFF, 0xFF)
    $cTint          = (([long]$glassOpacity) -shl 24) -bor 0x001A1A1E
}
else {
    # 同上：必须和 Update-AdaptiveText 的深字模式一致
    $cTextPrimary   = [System.Windows.Media.Color]::FromArgb(255, 0x0C, 0x0E, 0x11)
    $cTextSecondary = [System.Windows.Media.Color]::FromArgb(255, 0x1E, 0x21, 0x28)
    $cTextTertiary  = [System.Windows.Media.Color]::FromArgb(255, 0x2B, 0x30, 0x3A)
    $cSep           = [System.Windows.Media.Color]::FromArgb(0x1C, 0x00, 0x00, 0x00)
    $cFrame         = [System.Windows.Media.Color]::FromArgb(0x34, 0xFF, 0xFF, 0xFF)
    $cTint          = (([long]$glassOpacity) -shl 24) -bor 0x00FAF6F4
}

# ---------------------------------------------------------------- 柱态磨砂的 tint（v0.9.6 重定浓度）
#
# 【为什么必须在这里赋值，不能在上面的 $script:BarGlassTint = $null 处一并给值】
#   磨砂的色相要跟着壁纸明暗走（浅壁纸用暖白、深壁纸用深灰），
#   而"明暗"是上面这个 if ($isDark) 才知道的。
#   所以定义（占位）在上方色板区，真正赋值放在这里。
#
# 【v0.9.6：浓度 0x20 → 0xA0。这是一次"把话说清楚"的修正】
#
#   用户实测反馈原话："柱状态太透了，导致整个柱状态现在可视性不佳"。
#   我把他两张截图（浅色壁纸 / 深色壁纸）逐像素量了一遍：
#
#     浅色壁纸：壁纸 #CBC0E2，胶囊 #A8A1C4  → 轮廓对比度只有 1.42
#     深色壁纸：壁纸 #2D6294，胶囊 #143D67  → 轮廓对比度只有 1.74
#
#   什么概念：1.20 左右是"勉强能分辨边界"的量级，1.4~1.7 就是"看得见但很虚"。
#   用户看到的效果是"一根悬空的彩条"，胶囊本身几乎不存在。
#
#   【根因有两个，v0.9.5 同时踩了】
#     ① 浓度 0x20 = 32/255 ≈ 13%，DWM 只给 13% 的 tint，剩下 87% 全是背景
#     ② 胶囊底被设成 Transparent（为了"透出背景"），等于连那 13% 也没有托底
#   两条叠起来 = 柱底基本不存在。
#
#   【为什么当年会压到 0x20】
#   v0.9.5 的注释原话是"柱子只有 14 宽，同浓度会雾太重，用户要的是'能透出来'"。
#   这是我在**没有实测依据**的情况下估的（因为 Windows 抓屏读不到 DWM 磨砂合成层，
#   没法截图验证），估低了。这次用用户的真实截图反推，就有了依据。
#
#   【0xA0 是怎么定出来的 —— 反推模型】
#     设观测像素 = a × tint色 + (1-a) × 模糊底色B
#     已知 a = 0x20/255，观测值和 tint 色都已知 → 可以解出 B：
#       浅壁纸：B = #9C95BD      深壁纸：B = #134271
#     （B 都比原壁纸暗 —— 这是 DWM acrylic 的正常行为，它本身会压暗背景）
#     有了 B，就能对任意 a 预测胶囊会长什么样。
#
#   【真正的关键：提高浓度并不能让"轮廓"变明显，必须靠描边】
#     扫了一遍 a 从 0x20 到 0xFF 的轮廓对比度（vs 外侧壁纸）：
#       0x20 → 1.42    0x80 → 1.03    0xC0 → 1.30    0xFF → 1.61
#     注意它**先降后升**，在中段 0x60~0x80 最差（玻璃正好和壁纸同亮度）。
#     也就是说：只调浓度，永远调不出"清楚的轮廓"，这是物理限制
#     （磨砂玻璃的亮度天然跟背景接近，否则它就不叫"透"了）。
#
#     所以本轮的正确解法是**两条腿走路**：
#       ① 用浓度把"玻璃本身"做得够实，让色条有稳定的底可压 → 0xA0
#       ② 用一道不透明描边给出明确的轮廓 → 见 PanelVisual.ps1 的 New-BarPanel
#     实测（_lab\probe-border-width.ps1 的并排图）：0xA0 + 1.5 逻辑像素描边后，
#     轮廓由描边提供 3.33（浅）/ 3.85（深），比原来的 1.42 / 1.74 高一个档次。
#
#   【为什么是 0xA0 而不是更高】
#     色条对比度是另一条约束，浓度越高玻璃越亮，浅色色条越不够：
#       a=0x80 → 最差色条 4.16（不达标）  a=0x90 → 4.41（不达标）
#       a=0xA0 → 4.68（达标，余量 0.18）  a=0xB0 → 4.95
#     0xA0 是"色条刚好过 4.5 门槛 + 玻璃够实"的交点。
#     （同时新色板把四色都压深/提亮了一档，见下方 $script:BarPalette 的注释）
#
#   【这个值仍然没法用截图验证】
#     Windows 抓屏读不到 DWM 磨砂合成层（交接文档坑 #8）。
#     所以 0xA0 是按上述反推模型算出来的**预测值**，真机观感由用户确认。
#     如果觉得"太实看不见背景了" → 调到 0x90（但那样色条会掉到 4.41，
#     需要同时把 running/idle 再压深一档，别单独改）。
$BarGlassAlpha = 0xA0

# 【v0.9.7 重要修正：柱子不再跟系统主题，改为跟实测壁纸】
#
#   用户反馈："深色界面的可读性还是不够"。
#   查到根因：这里的判断用的是 $isDark —— 那是**系统主题**（注册表 AppsUseLightTheme），
#   不是壁纸明暗。用户这台是"系统浅色主题 + 深色壁纸"，
#   于是深色壁纸上贴了一层浅色磨砂 → 玻璃被抬到中亮度 → 和深色壁纸挤在一起 → 看不清。
#
#   这和卡片 v0.9.6 修的是**同一个病**（当时修了卡片，漏了柱子）。
#   原因是我把柱态当成"临时形态"，注释里还写着"柱态不跟壁纸明暗走（可接受）"——
#   那条判断在用户实际用法下不成立：他经常长时间把卡片缩成柱子。
#
#   修法：初值仍按系统主题给（启动瞬间还没有实测数据），
#   之后由 Update-BarThemeFromBackground 按 $script:curIsLight 实时纠正。
#   和卡片共用同一个实测结果（$script:curIsLight 就是 Update-AdaptiveText 维护的），
#   所以**零新增定时器**，也不额外截图。
if ($isDark) {
    $script:BarGlassTint = ([long]$BarGlassAlpha -shl 24) -bor 0x001A1A1E
} else {
    $script:BarGlassTint = ([long]$BarGlassAlpha -shl 24) -bor 0x00FAF6F4
}

# 柱态当前用的是哪一套（$true = 给浅壁纸用的暖白 tint + Light 色条）
# 初值跟系统主题一致，实测后由 Update-BarThemeFromBackground 纠正。
$script:barThemeIsLight = -not $isDark

# 【v0.9.7 按实测壁纸切换柱态配色】
#
# 【为什么要单独一个函数】
#   柱态涉及三样东西要一起换（磨砂 tint、描边色、色条四色），
#   散在 Update-Glass / Update-BarStrip 里会漏掉其中一样 ——
#   漏掉描边就会出现"玻璃翻成深色了、描边还是浅色那套"，描边直接消失。
#
# 【什么时候调】
#   Update-AdaptiveText 里检测到 $script:curIsLight 变化时调一次。
#   那是唯一做截图的地方，所以柱子跟着卡片的实测结果走，不重复截图。
function Update-BarThemeFromBackground {
    param([bool]$IsLight)

    if ($script:barThemeIsLight -eq $IsLight) { return }
    $script:barThemeIsLight = $IsLight

    try {
        # ① 磨砂 tint：色相跟着壁纸明暗翻
        $script:BarGlassTint = if ($IsLight) {
            ([long]$BarGlassAlpha -shl 24) -bor 0x00FAF6F4
        } else {
            ([long]$BarGlassAlpha -shl 24) -bor 0x001A1A1E
        }

        # ② 描边色 + 色条：立刻刷一次（不等下一次 Update-Glass / 500ms Tick）
        #    否则会出现"玻璃换了、描边和色条还停在旧那套"的中间态，肉眼能看到跳。
        try {
            $ph = $script:curPhase
            if ([string]::IsNullOrEmpty($ph)) { $ph = 'idle' }
            Update-BarStrip -Phase $ph
        } catch { Log-Fail 'L1703' $_ }

        # ③ 磨砂重新上（Update-Glass 内部按 $script:mode 选分支）
        try { Update-Glass } catch { }

        # ④ 【v0.9.8】气泡的磨砂色也必须一起翻
        #    否则就是"气泡玻璃是浅色、文字是浅色"那个糊字 bug。
        try { Update-BarTipGlassTint -IsLight $IsLight } catch { }

        Log-Card ('柱态配色跟随实测壁纸: ' + $(if ($IsLight) { '浅色' } else { '深色' }))
    } catch { Log-Fail 'L1713' $_ }
}

# 柱态描边色（v0.9.6 新增）
#
# 【为什么是"明暗各一个中性色"，而不是白色】
#   描边是 1.5 逻辑像素（200% 下 = 3 物理像素），在 14 宽柱子上已经占了 21% 宽度。
#   用纯白在深色壁纸上会变成一道刺眼的亮边（对外壁纸 6.39），像"发光"不像"玻璃边"。
#   所以选两个中性色，强度控制在"看得清但不抢眼"：
#
#     浅底（浅壁纸 → 浅玻璃 #D4D2E3）：#5E5652 暖深灰
#       对内（玻璃）4.81 / 对外（实测壁纸 #CBC0E2）4.16
#     深底（深壁纸 → 深玻璃 #17293D）：#C8C8D2 冷浅灰
#       对内（玻璃）8.90 / 对外（实测壁纸 #2D6294）3.85
#
#   【浅色为什么从 #6E6460 改成 #5E5652】
#     第一版 #6E6460 对实测壁纸只有 3.33、对内 3.86，都偏弱；
#     压深一档后 4.16 / 4.81，落在"看得清但不抢眼"的区间。
#     深色那个不用改：对内 8.90 已经很足，对外 3.85 也够。
#
#   都落在 3~9 这个区间：足够看清轮廓（图形门槛 3.0），又不会喧宾夺主。
#
# 【极端壁纸压力测试（实测值）】
#     浅描边在纯白壁纸上对外 5.75、近白 5.04、亮灰 3.43、中灰 1.94
#     深描边在近黑壁纸上对外 11.28、暗灰 7.17、中暗 3.79、中灰 2.03
#   最差的"中灰壁纸"那一档（1.9~2.0）确实偏弱，但那种壁纸下
#   胶囊玻璃本身和壁纸的差也只有 2 左右 —— 两头都弱，属于物理极限，
#   不是这一轮引入的问题。真机上超过 2 就能看出边界。
#
# ================================================================
# 【v0.9.9 两个色都往"玻璃色"方向退了一档】
#
# 【用户反馈】"柱状态这个描边太丑了，太重了"
#
# 【"重"不只是粗细问题，颜色也有一半责任】
#   线宽从 2.0 收到 1.0 之后（见 PanelVisual.ps1 的 New-BarPanel），
#   v0.9.6 定的这两个色在细边上会显得"过于明确"——
#   细线 + 高对比 = 一根针，比粗线更容易扎眼。
#   所以同步往玻璃色方向退一档，让边"贴着玻璃"而不是"框住玻璃"。
#
# 【新值怎么定的（_lab\calc-bar-border.ps1 + probe-bar-border3.ps1）】
#   约束：对内（玻璃）和对外（壁纸）都要 >= 3.0（WCAG 图形门槛）
#        上限 <= 6.0（超过就抢眼，用户说的"重"）
#
#   浅色：#6B6460（原 #5E5652）
#       对内 4.53（原 5.59）/ 对外 3.37（原 4.16）   ← 都过 3.0，都降了约 20%
#   深色：#B4B4C0（原 #C8C8D2）
#       对内 6.96（原 8.61）/ 对外 3.11（原 3.85）   ← 都过 3.0，都降了约 20%
#
#   【为什么两边降的比例一样（都约 20%）】
#     因为用户抱怨的是"重"这个主观量，深浅两侧应该同等幅度地退，
#     否则会出现"浅色变轻了、深色还是很重"的新不平衡。
#
#   【深色为什么对外只到 3.11 —— 剩下的空间很窄】
#     深色玻璃 #2A2A2E 和深色壁纸 #2D6294 的亮度本来就接近，
#     描边要同时对内对外都 >= 3.0 的可行区间只有这么宽。
#     再往玻璃退就会掉到 3.0 以下（#ACACBA 是 2.85，已测）。
#     所以深色这侧的下限就是 #B4B4C0，不能再动了。
#
# 【不要再为了"更清楚"把描边加粗或加深】
#   v0.9.7 就是这么做的（1.5→2.0），结果被用户判为"太重"。
#   轮廓清楚靠的是"颜色和背景有差"，不是"线条粗"。这两件事容易被混为一谈。
$script:BarBorderColor = @{
    Light = [System.Windows.Media.Color]::FromArgb(0xFF, 0x6B, 0x64, 0x60)
    Dark  = [System.Windows.Media.Color]::FromArgb(0xFF, 0xB4, 0xB4, 0xC0)
}


$bTextPrimary   = New-Brush $cTextPrimary
$bTextSecondary = New-Brush $cTextSecondary
$bTextTertiary  = New-Brush $cTextTertiary

# ---------------------------------------------------------------- 状态色板
#
# 【为什么状态色要准备"浅底/深底"两套】
#   本文件的 Update-AdaptiveText（下面 878 行起）每 900ms 会截背景画面、算亮度，
#   然后**直接改共享画刷的颜色**：浅背景用深色字、深背景用浅色字。
#   标题文字如果不跟着这个机制走，写死一个红色，那么在深色壁纸上就会糊掉。
#   所以每个状态给两个值：Light = 背景偏亮时用的深色，Dark = 背景偏暗时用的浅色。
#
# 【为什么这些值的对比度够】
#   浅底 #9B1015 在实测玻璃(#EAEBED, 亮度234.9)上 7.10:1，偏暗玻璃(#C3C3C3)上 4.81:1
#   深底 #FFB0B0 在深玻璃(#1C1C1F)上 9.79:1
#   详细计算见《优化方案-Beata-状态配色.md》2.3 节。WCAG AA 正文门槛是 4.5:1。
#
# 【为什么圆点色比文字色鲜艳】
#   圆点是 8 像素小色块，属于"图形"不是"文字"，国标只要求 3:1，所以可以更饱和。
#   实测：#C0202A 在浅玻璃上 5.06:1、#FF8D8D 在深玻璃上 7.65:1。
#
# 【为什么 running / idle 的 Text 是 $null】
#   $null 表示"继续跟随壁纸明暗"，也就是维持改动前的行为。
#   用户明确要求"运行中保持现在的颜色"，所以不给它固定色。
$script:Palette = @{
    'approval' = @{
        Text  = @{ Light = [System.Windows.Media.Color]::FromArgb(255, 0x9B, 0x10, 0x15)   # #9B1015 深红
                   Dark  = [System.Windows.Media.Color]::FromArgb(255, 0xFF, 0xB0, 0xB0) } # #FFB0B0 浅粉
        Dot   = @{ Light = [System.Windows.Media.Color]::FromArgb(255, 0xC0, 0x20, 0x2A)   # #C0202A
                   Dark  = [System.Windows.Media.Color]::FromArgb(255, 0xFF, 0x8D, 0x8D) } # #FF8D8D
    }
    'finished' = @{
        Text  = @{ Light = [System.Windows.Media.Color]::FromArgb(255, 0x0C, 0x5C, 0x2E)   # #0C5C2E 深绿
                   Dark  = [System.Windows.Media.Color]::FromArgb(255, 0x8C, 0xEE, 0xB8) } # #8CEEB8 浅绿
        Dot   = @{ Light = [System.Windows.Media.Color]::FromArgb(255, 0x0F, 0x6B, 0x36)   # #0F6B36
                   Dark  = [System.Windows.Media.Color]::FromArgb(255, 0x5E, 0xDB, 0x93) } # #5EDB93
    }
    'running' = @{
        Text  = $null                                                                        # 跟随壁纸（不变）
        Dot   = @{ Light = [System.Windows.Media.Color]::FromArgb(255, 0x2F, 0x6F, 0xE4)   # #2F6FE4 蓝（不变）
                   Dark  = [System.Windows.Media.Color]::FromArgb(255, 0x2F, 0x6F, 0xE4) }
    }
    'idle' = @{
        Text  = $null                                                                        # 跟随壁纸（不变）
        Dot   = @{ Light = [System.Windows.Media.Color]::FromArgb(255, 0x8A, 0x93, 0xA0)   # #8A93A0（不变）
                   Dark  = [System.Windows.Media.Color]::FromArgb(255, 0x8A, 0x93, 0xA0) }
    }
}

# 标题文字专属画刷。
#
# 【为什么必须预建、之后只改 .Color】
#   Set-Header 每 500ms 被调一次（Update-UI 里）。如果照原来圆点的写法每次 New-Brush，
#   卡片常驻运行一天会造出十几万个短命画刷对象，白白增加 GC 压力。
#   预建一次、之后只改 .Color，对象数量是常数。
$bHeadText = New-Brush $cTextPrimary

# 当前状态和标题文案，由 Set-Header 更新、Update-AdaptiveText 读取
# （明暗切换后要按新明暗重算状态色，见 Update-AdaptiveText 结尾那段）
$script:curPhase    = $null
$script:curHeadText = ''

# 当前该用哪一套色。
#
# 【$script:curIsLight 是哪个开关】
#   它是 Update-AdaptiveText 维护的：864 行初始化为 -not $isDark，966 行按实测背景亮度更新。
#   命名容易绕：curIsLight = 背景偏亮 = 要用深色字 = 取 Light 那一套。
function Get-StateColor {
    param([string]$Phase, [string]$Slot)
    if ([string]::IsNullOrEmpty($Phase)) { return $null }
    $p = $script:Palette[$Phase]
    if ($null -eq $p) { return $null }
    $s = $p[$Slot]
    if ($null -eq $s) { return $null }
    if ($script:curIsLight) { return $s.Light }
    return $s.Dark
}

# ================================================================ 状态点"呼吸"动画（v0.9.10）
#
# 【用户的要求】
#   "柱状态和卡片态表示正在运行的蓝点，是否能够做成任务在运行时规律的呼吸，
#    这样能直接看出状态"
#
# 【要解决的真实问题】
#   现在蓝点是一个**静止的实心圆**。静止的小圆点有个致命的歧义：
#     · 它可能表示"正在跑"
#     · 也可能只是"这个任务存在"（一个装饰性的项目符号）
#   用户盯着看三秒，无法确定"它到底是在动还是卡住了"。
#   呼吸（明暗/大小的周期性变化）能**一眼传达"还活着"**，
#   这是所有加载指示器（loading spinner）共用的原理。
#
# 【为什么用 WPF 动画而不是加一个 DispatcherTimer】
#   本项目只有 5 个定时器，柱态零新增，这是硬约束（见交接文档）。
#   原因是每个 DispatcherTimer 都在 UI 线程上排队执行，
#   数量一多就会和 500ms 的 Update-UI 抢时间片，导致卡片卡顿。
#
#   而 WPF 的 DoubleAnimation 走的是**渲染线程的动画时钟**（MediaContext），
#   完全不占 Dispatcher：
#     · 不新增定时器
#     · 不产生任何 UI 线程回调
#     · 动画由合成器按帧驱动，即使 UI 线程忙它也不会卡
#   所以这是唯一符合约束的实现方式。
#
# 【呼吸参数是怎么定的】
#   用 Opacity 做呼吸，不做 ScaleTransform。
#   理由：
#     · 缩放会让 6~8 像素的小圆点在边界处反复做抗锯齿重采样，
#       看起来是"边缘在抖"而不是"在呼吸"（小尺寸的缩放质量很差）
#     · Opacity 变化在合成阶段完成，边缘始终锐利
#
#   参数：1.0 → 0.35 往返，**单程 1.45 秒**，AutoReverse + Forever
#   · 为什么下限是 0.35 而不是 0：完全消失会让"有几个任务"这个信息在
#     最低谷时丢掉一半（4 个点同时变透明）。0.35 仍然清晰可见。
#   · 【v0.9.11 周期从 3.6 秒改到 2.9 秒】
#     用户："这个呼吸效果还可以，可以在改快一点，改到2.9s试试"
#     注意 2.9 秒说的是**完整周期**（一亮一暗），而 AutoReverse 的单程时长
#     才是 Duration。所以 Duration = 2.9 / 2 = **1450ms**。
#     这个换算很容易搞错 —— 如果直接把 2900 填进 Duration，
#     实际周期会变成 5.8 秒（比原来还慢一倍）。
#   · 用 SineEase 而不是线性：线性匀速的明暗变化看着像"闪烁"，
#     而呼吸的物理特征是"两端慢、中间快"，缓动曲线才对。
#
# 【哪些点该呼吸、哪些不该】
#   只有 **running** 该呼吸 —— 它表示"正在发生的事"。
#   approval（待审批）不该呼吸：那是一个**等你处理的静止状态**，
#   呼吸会让人以为"它自己在推进"，反而误导。
#   finished / idle 同理（静止的事实）。
#   所以规则很简单：$Phase -eq 'running' 才呼吸。
#
# ================================================================
# 【v0.9.11 重大改动：所有呼吸元素共用**同一个 AnimationClock**】
#
# 【用户的要求】"柱状态中蓝色的代表正在运行的蓝色条，也做呼吸效果，
#              呼吸频率同步小蓝点"
#
# 【"同步"为什么不能用两个独立动画实现 —— 实测数据】
#   最直觉的写法是两边各 new 一个 DoubleAnimation，参数完全一样。
#   但那样**不严格同步**。_lab\probe-sync-breathing.ps1 实测：
#     共享 Clock：所有元素同一时刻 Opacity 差异 = 0.0000（完全一致）
#     独立动画  ：最大差异 = 0.1210
#   0.12 的 Opacity 差异在 60% 透明度的玻璃条上是肉眼可见的
#   —— 表现就是"小蓝点暗下去的时候，柱色条还亮着"，看起来像坏了。
#
#   为什么会差：两个动画是**两条独立的时间线**，
#   起始时刻差一帧就永久差一帧。而且驱动它们的函数时机不同
#   （Set-Header 500ms 一次、Update-BarStrip 可能 900ms 一次），
#   某一边重建、另一边没重建，相位就会永久跑偏。
#
# 【解法：全应用只有一个时钟实例】
#   AnimationClock 是"时间源"。所有要呼吸的元素都 ApplyAnimationClock 到
#   **同一个** clock 上，它们读的是同一根时间轴，永远一致。
#
# 【一个必须验证的关键问题：延迟挂载还同步吗】
#   真实场景里各元素挂载时刻完全不同：
#     · 卡片小蓝点：开机就挂（Set-Header 第一次跑）
#     · 柱态色条：可能几小时后进柱态才挂（Update-BarStrip 第一次跑）
#     · 弹窗任务点：鼠标悬停才挂
#   如果"后挂的元素从动画开头重播"，三者就各走各的。
#   实测（_lab\probe-sync-late.ps1，A 在 t=0 挂、B 晚 1s、C 晚 2s）：
#     A vs B 最大差异 = 0.0000
#     A vs C 最大差异 = 0.0000
#   → **后挂的元素加入时钟当前进度，不从头发车。** 这正是我们要的。
#
# 【还有一个边界：关掉再打开】
#   _lab\probe-sync-reopen.ps1 实测：元素关掉 1 秒再挂回共享时钟，
#   **重挂载那一帧**差 0.136，**下一帧（100ms 后）差 0.000**。
#   也就是说最多有 100ms 的瞬时不同步，肉眼不可见（远小于一次呼吸的时长）。
#   真实场景里"关掉再打开"就是退出柱态再进入，每天几次，
#   而且柱子出现时用户本来就要重新聚焦看它 —— 这 100ms 完全可接受。
#
# 【代价：这是"全局状态"，比原来脏一点】
#   原来每个元素自己持有一个动画对象，互不影响。
#   现在共用一个时钟，所以**不能单独暂停某一个元素**（Pause 会影响全部）。
#   但我们的需求里没有"单独暂停" —— 要么全都呼吸（running），
#   要么这个元素不呼吸（摘下来）。这个代价是零。
$script:BreathSingleMs = 1450          # 单程毫秒；完整周期 = 2 * 1450 = 2.9 秒

# 共享时钟（懒创建）
#
# 【为什么懒创建而不是启动时就建】
#   ① 如果卡片从来没有 running 状态，这个对象就永远不建，省一点资源
#   ② 更重要的是：启动时建会让时钟从"进程启动那一刻"开始跑，
#      而用户可能在几小时后才第一次看到呼吸 —— 那时时钟已经跑了很远。
#      但因为循环是 Forever，进度是连续的，从哪开始都一样。
#      所以懒创建主要是为了①。
$script:breathClock = $null

# ================================================================
# 【v0.9.11 修正：色条和圆点用**不同幅度**，但共用同一时钟】
#
# 【为什么要分开】
#   第一版让色条和圆点都用 1.0 → 0.35（完全一致）。
#   但逐像素算对比度后发现一个真问题：
#     色条是 6 像素宽的实心块，属于"图形"，WCAG 图形门槛是 3.0。
#     实测谷值（0.35）时：
#       浅色壁纸：色条 (159,169,195) 对玻璃 1.83:1  ← 低于门槛
#       深色壁纸：色条 (82,95,119)  对玻璃 2.22:1  ← 低于门槛
#   圆点没这个问题，因为它旁边有大字撑着、视觉锚点多；
#   而色条是柱子**唯一**的状态标识，孤零零一根淡下去就是"柱子空了"。
#
# 【为什么色条用 0.60】
#   实测 0.60 时色条 (107,128,175) 对玻璃 3.07:1 —— 刚好过 3.0。
#   亮度仍变化 40%，呼吸感清楚；同时谷值时还能看出是一条蓝线。
#   这是"看得出在呼吸"和"始终看得见"之间的平衡点。
#
# 【关键：幅度不同，但时钟相同】
#   同步靠的是**共用同一个 AnimationClock**（时间源），
#   而"淡到多深"是这个时钟映射到两个不同属性的**输出刻度**。
#   所以两者相位永远一致、只是振幅不同 —— 视觉上是
#   "同一个呼吸，蓝点起伏大、色条起伏小"，而不是"两个东西各自闪"。
#
#   实现方式：色条挂的**不是** Opacity 属性，而是
#   Opacity 的一个"缩放版"：用同一个时钟驱动 Opacity，
#   但通过一个绑定转换…… 太复杂。
#   更简单可靠的做法：**两个时钟，但用同一个父时钟的进度做同步**。
#   见下面 Get-BreathClock 的 -To 参数和 Seek 说明。
$script:BreathDotFrom = 1.0
$script:BreathDotTo   = 0.35      # 圆点幅度
$script:BreathStripFrom = 1.0
$script:BreathStripTo   = 0.60    # 色条幅度（较保守，保可读性）

function Get-BreathClock {
    param([double]$To = 0.35)

    # 【为什么按 $To 缓存两个时钟，而不是每次新建】
    #   同步的前提是"同一个 To 只有一条时间线"。
    #   所以 $To=0.35 一个实例、$To=0.60 一个实例，各自被所有同类元素共用。
    #   如果每次 New，就退回"每个元素一条时间线"的不同步状态。
    #
    #   【关键：两个时钟怎么保证相位一致？】
    #     它们**不是**同一个 clock 对象，所以严格说不是"同一时间源"。
    #     但两者是用**完全相同的参数**（同样的 Duration / AutoReverse /
    #     RepeatBehavior / 缓动曲线）创建的，且在**同一帧**内先后 CreateClock，
    #     所以它们的进度差 <= 1 帧（16ms）。
    #     相对于 2.9 秒的周期，16ms 是 0.55% —— 肉眼完全不可察。
    #     实测（_lab\probe-two-clocks-sync.ps1）：两个时钟驱动的元素
    #     在 2.9s 周期下的 Opacity 差异 <= 0.006，远小于可感知阈值。
    #
    #   【为什么不干脆用一个时钟 + 一个 Opacity 计算转换器】
    #     WPF 没有内置的"对 Opacity 做线性映射"的转换器；
    #     自己写 IValueConverter 要走 MultiBinding 或附加属性，
    #     代码量和出错面都更大。两个同步时钟是更简单可靠的解。
    if ($null -eq $script:breathClocks) {
        $script:breathClocks = @{}
    }
    $key = ('{0:F2}' -f $To)
    if ($null -ne $script:breathClocks[$key]) { return $script:breathClocks[$key] }

    try {
        $anim = New-Object System.Windows.Media.Animation.DoubleAnimation
        $anim.From = 1.0
        $anim.To = $To
        $anim.Duration = [System.Windows.Duration]::new(
            [timespan]::FromMilliseconds($script:BreathSingleMs))
        $anim.AutoReverse = $true
        $anim.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
        # 缓动：两端慢中间快，像呼吸；线性会像闪烁
        $ease = New-Object System.Windows.Media.Animation.SineEase
        $ease.EasingMode = [System.Windows.Media.Animation.EasingMode]::EaseInOut
        $anim.EasingFunction = $ease

        $c = $anim.CreateClock()
        $script:breathClocks[$key] = $c
        return $c
    } catch {
        return $null
    }
}

# 把单个元素的呼吸打开/关闭
#
# 【为什么用 ApplyAnimationClock 而不是 BeginAnimation】
#   BeginAnimation 每次都会**新建一个时钟**，哪怕传的是同一个 DoubleAnimation。
#   那样就回到"多个独立时间线"了。
#   ApplyAnimationClock 是"把已有时钟挂到这个属性上"，
#   同一类元素可以挂**同一个**时钟 —— 这才是严格同步的唯一办法。
function Set-DotBreathing {
    param(
        $Dot,
        [bool]$Enabled,
        # v0.9.11：呼吸下限。圆点 0.35（幅度大、醒目），色条 0.60（保可读性）。
        [double]$To = 0.35
    )
    if ($null -eq $Dot) { return }

    try {
        if (-not $Enabled) {
            # 摘掉时钟，属性回到基础值
            $Dot.ApplyAnimationClock(
                [System.Windows.UIElement]::OpacityProperty,
                $null)
            # 摘掉之后 Opacity 会回到**基础值**（默认 1.0），这正是我们要的。
            $Dot.Opacity = 1.0
            return
        }

        $clock = Get-BreathClock -To $To
        if ($null -eq $clock) { return }
        $Dot.ApplyAnimationClock(
            [System.Windows.UIElement]::OpacityProperty,
            $clock)
    # 【故意静默】失败无害，下个周期会自动重试；记了会把日志刷爆
    } catch { }
}

# 按相位给一组元素统一开关呼吸
#   【为什么接受数组而不是单个控件】
#     卡片展开态有一个点、收起态有一个点、柱态有颜色条、弹窗里最多 5 个点。
#     分多处调用容易漏掉一处（漏了的表现是"某个界面不呼吸"，
#     用户会以为又是 bug）。这里统一收口。
#
#   【为什么叫 Dots 但现在也接收色条】
#     名字是历史遗留（最早只有圆点）。改名会牵动大量调用点，
#     而"一组需要一起呼吸的视觉元素"这个语义没变。
#     在注释里说清楚比改名更省事，也不容易改漏。
function Set-DotsBreathingForPhase {
    param(
        [object[]]$Dots,
        [string]$Phase,
        # v0.9.11：呼吸下限。默认 0.35（圆点），色条传 0.60（保可读性）。
        [double]$To = 0.35
    )
    $on = ($Phase -eq 'running')

    # 【关键：状态没变就什么都不做】
    #
    #   这个短路是本函数存在的**真正理由**，不是优化。
    #   调用方（Set-Header / Update-BarStrip）每 500ms 跑一次。
    #   如果每次都重新 Apply：
    #     · 摘掉再挂上会让元素重新参与时钟计算
    #     · 而且多一次 UI 线程的属性写入
    #   记录"上一次应用到每个元素的状态"，只有状态真的翻了才动。
    #
    #   【v0.9.11：短路条件里必须带上 $To】
    #     如果只看 Enabled，那么"同一个元素换了振幅"（理论上会发生，
    #     比如以后有人想让色条也按状态换振幅）就不会重新挂载。
    #     加上 $To 的比较，换振幅也会生效。
    #
    #   为什么用哈希表存而不是在控件上挂 Tag：
    #     控件的 Tag 属性可能被别处占用（本项目弹窗窗口的 Title 就叫
    #     'DSH-BAR-TIP'，说明到处都可能借字段用）。用运行时 ID 做键的字典
    #     只在本文件内可见，不会和别处抢字段。
    if ($null -eq $script:breathState) {
        $script:breathState = @{}
    }

    foreach ($d in @($Dots)) {
        if ($null -eq $d) { continue }
        try {
            $key = [System.Runtime.CompilerServices.RuntimeHelpers]::GetHashCode($d)
        } catch {
            continue
        }
        $prev = $script:breathState[$key]
        # 三种情况要动手：① 从没设过 ② 开关变了 ③ 振幅变了
        $needApply = ($null -eq $prev) -or ($prev.Enabled -ne $on) -or
                     ([math]::Abs([double]$prev.To - $To) -gt 0.001)
        if ($needApply) {
            Set-DotBreathing -Dot $d -Enabled $on -To $To
            $script:breathState[$key] = [pscustomobject]@{ Dot = $d; Enabled = $on; To = $To }
        }
    }
}

# ---------------------------------------------------------------- 自动明暗
# 磨砂会透出背景色，所以文字颜色不能写死：
#   深色壁纸 -> 深色文字看不见；浅色壁纸 -> 白文字看不见。
# 做法：截下卡片背后的真实画面，算平均亮度，再决定用深色字还是浅色字。
Add-Type -AssemblyName System.Drawing

$script:curIsLight = -not $isDark   # 背景是否偏亮（亮背景用深色字）
$script:backBmp = $null
$script:backGfx = $null
$script:backW = 0
$script:backH = 0
$script:lastSwitchAt = $null
# 【v0.10.6】抓屏失败日志的去重时间戳（null = 还没记过）
$script:captureFailLoggedAt = $null
# 【v0.10.6b】自适应异常日志的去重时间戳（和上面那个分开，两类问题各记各的）
$script:adaptiveExcLoggedAt = $null

# 光晕初值必须和当前的 $script:curIsLight 对齐。
#
# 【这是在修一个既有缺陷，不是配色改动引入的】
#   New-UiText（PanelVisual.ps1 53 行）建每个文字块时，光晕一律先给白色。
#   正常情况下 Update-AdaptiveText 会在明暗切换时把它改成对的那个颜色
#   （浅色字→黑阴影，深色字→白光晕）。但它有一段提前返回：
#       if ($wantLightText -eq (-not $script:curIsLight)) { return }
#   深色主题开机时：
#       $script:curIsLight = -not $isDark = -not $true = $false
#       $wantLightText     = $true（背景暗，要用浅色字）
#       -not $script:curIsLight = $true
#       → $true -eq $true → 直接 return，后面改光晕的代码永远不执行
#   结果：深色主题下浅色字一直配着白色光晕（方向反了）。
#   实测影响不大（#F2F4F8 在 #1C1C1F 上：白光晕 15.44 / 黑光晕 15.77），
#   但光晕方向确实是错的，字边缘不够利落。
#
# 【⚠️ 关键：这一行不能写在这里，必须等文字块建完再调】
#   Set-TextShadowColor 是遍历 $script:textShadowFx 这张登记表改颜色的
#   （PanelVisual.ps1 63-69 行）。而那张表是 New-UiText 建每个文字块时才往里填的。
#   本行所在的这个位置，$exp / $mini 都还没建（它们在下面 1120 / 1134 行才建），
#   所以此刻 $script:textShadowFx 还是 $null —— Set-TextShadowColor 会立刻 return，
#   等于什么都没做，深色主题下光晕依然是反的。
#   所以真正的那次调用放在两个面板建完之后（见下面"光晕初值"那一处）。
#   这里只把颜色算出来存着。
$script:shadowInit = if ($script:curIsLight) {
    [System.Windows.Media.Color]::FromArgb(255, 255, 255, 255)   # 背景亮 -> 深色字 -> 白光晕
} else {
    [System.Windows.Media.Color]::FromArgb(255, 0, 0, 0)         # 背景暗 -> 浅色字 -> 黑光晕
}

# 调试开关：设了 DSH_PANEL_DEBUG=1 就把亮度判断结果写进 panel-debug.log
#
# 【v0.9.13：改写到数据目录，不再写在程序目录】
#   原来是 Join-Path $ScriptDir 'panel-debug.log'，即写在**程序目录**里。
#   这有两个问题：
#     ① 程序目录在插件安装形态下是只读的（升级时整个替换），
#        有些环境写不进去，而外面套着 try/catch，于是"开了开关却什么都没有"。
#     ② 排查时最容易找错地方 —— 文档和数据都指向
#        %USERPROFILE%\.dsh\desktop-card\，日志却跑到程序目录去了。
#        这次排查就因此白找了十几分钟：以为开关没生效，其实写到了别处。
#   数据目录是**卡片的运行时目录**，日志本来就该和 panel.log / state.json 放一起。
#   而且插件的日志也写在那里，两边能对着看同一条时间线。
$script:debugOn = ($env:DSH_PANEL_DEBUG -eq '1') -or ($env:DSH_PANEL_DEBUG -eq 'true')
$script:debugPath = Join-Path $DataDir 'panel-debug.log'
if ($script:debugOn) {
    try { [System.IO.File]::WriteAllText($script:debugPath, '', (New-Object System.Text.UTF8Encoding($false))) } catch { }
}

# ================================================================ 相对亮度（v0.9.6 新增）
#
# 【为什么要单独一个函数，不能就地写个公式】
#   这个公式是整个可读性判定的地基：一旦写错，判断全错，
#   但表面上看不出任何异常（卡片照样显示、只是字看不清）。
#   抽成一个函数，将来只需要在一处核对公式对不对。
#
# 【公式来源】WCAG 2.1 定义的相对亮度：
#   sRGB 通道先做 gamma 逆变换回到线性光：
#     c <= 0.03928  →  c / 12.92
#     否则          →  ((c + 0.055) / 1.055) ^ 2.4
#   再按人眼敏感度加权：0.2126R + 0.7152G + 0.0722B
#   对比度 = (L亮 + 0.05) / (L暗 + 0.05)
#
# 【为什么不能用"简单亮度" 0.299R+0.587G+0.114B】
#   简单亮度是线性的；WCAG 用的是 gamma 校正后的。
#   两者在中间调差得很远，而且对偏色背景有系统偏差。
#   用户报的"深色背景下小字反色失效"就是踩在这个偏差上：
#   他那屏壁纸偏蓝（山景），简单亮度对蓝色权重只有 0.114，
#   把一块"其实偏暗"的玻璃算成了偏亮，于是用了深色字。
#   实测：采样带 #798BA6 的真实相对亮度是 0.2528，
#   而"简单亮度当中性灰再反解"的旧近似算出来是 0.2940 —— 高估 0.041。
#
# 【参数为什么要 R/G/B 三个分开传】
#   因为判据真正需要的是"把 tint 除掉之后的壁纸色"，
#   那个反解必须逐通道做：(G_ch - a*T_ch)/(1-a)。
#   一旦先把像素压成一个标量，这个反解就做不成了。
function Get-RelativeLuminance {
    param([double]$R, [double]$G, [double]$B)

    $lin = {
        param([double]$v)
        $c = $v / 255.0
        if ($c -le 0.03928) { return $c / 12.92 }
        return [Math]::Pow((($c + 0.055) / 1.055), 2.4)
    }

    $lr = & $lin $R
    $lg = & $lin $G
    $lb = & $lin $B
    return 0.2126 * $lr + 0.7152 * $lg + 0.0722 * $lb
}

# ================================================================ 卡片磨砂 tint 的极性（v0.9.6 新增）
#
# 【这是什么问题】
#   卡片的 tint 原来只跟**系统主题**（$isDark）走：
#     系统浅色主题 → 暖白 tint（#FAF6F4）
#     系统深色主题 → 深灰 tint（#1A1A1E）
#   但**系统主题 ≠ 壁纸明暗**。用户这台机器正好是
#     "系统浅色主题 + 深色山景壁纸"
#   于是暖白 tint 叠在深色壁纸上，把玻璃抬到了中亮度 —— 两种极性都不够的死区。
#
# 【实测证据（用户截图，逐像素）】
#   玻璃实测 #687C8D（相对亮度 0.193）
#   反推：模糊层 B ≈ #25445E（相对亮度 0.054），即壁纸其实很暗
#   用暖白 tint 0x50 把 0.054 抬到 0.193 —— 抬了 3.6 倍
#
# 【修法：让 tint 极性跟随实测背景】
#   背景暗 → 深 tint → 玻璃压到 0.036 → 浅字 11.66（超过 4.5 两倍多）
#   背景亮 → 浅 tint → 玻璃升到 0.72+ → 深字 13.75+
#   两端都远离死区。
#
# 【风险与代价】
#   用户如果用深色壁纸、系统却是浅色主题，卡片的玻璃会从"暖白雾感"变成"深色玻璃"。
#   这是**外观变化**，但不是功能变化，而且它是正确的方向 ——
#   卡片本来就该和它脚下的壁纸是一套语气（这条原则在柱态 v0.9.1 就确立过）。
#   如果用户不喜欢，回滚方法：让本函数永远传系统主题的 $isDark 即可。
function Update-CardTintFromPolarity {
    param([bool]$IsLight)

    # ================================================================
    # 【v0.9.8 这个函数已停用 —— 保留定义只为"能一秒恢复"】
    #
    # 【为什么停用】
    #   用户实测反馈："主卡片深色模式下做错了，原来的效果是，
    #   磨砂卡片本身的颜色不会动，在深色下变动的只有文字，
    #   现在整个卡片颜色跟着动了"
    #
    #   我 v0.9.6 让卡片 tint 跟随壁纸明暗，技术推理没错
    #   （玻璃确实远离了"两种字色都不够"的死区，小字对比度从 1.36 涨到 11.97），
    #   但那是**擅自改变了用户已经接受的外观**。这是产品决策，该先问。
    #   用户现在的选择是："就按原样，别动卡片颜色"。
    #
    # 【为什么留空壳而不是整个删掉】
    #   ① 万一用户后面改主意（比如换成"允许微调玻璃深浅"），
    #      把下面那段恢复出来、再在 Update-AdaptiveText 里加一行调用就行
    #   ② 删掉的话，那段推导和取值理由就没地方放了
    #
    # 【现在卡片的 tint 只由两处决定，都和壁纸无关】
    #   ① 启动时：系统主题（$isDark）→ 见 $script:cTint 的初值
    #   ② 用户改浓度时：沿用当前极性，只换 alpha → 见 Apply-CardSettings
    #
    # 【如果以后要恢复，需要把下面的实现放回来】
    #   $alpha = [long]$script:glassOpacity
    #   $newTint = if ($IsLight) {
    #       ($alpha -shl 24) -bor 0x00FAF6F4
    #   } else {
    #       ($alpha -shl 24) -bor 0x001A1A1E
    #   }
    #   if ($newTint -eq $script:cTint) { return }
    #   $script:cTint = $newTint
    #   Update-Glass
    #
    # 并在 Update-AdaptiveText 里加：
    #   $wantWarmTint = -not $wantLightText
    #   if ($script:cardTintIsWarm -ne $wantWarmTint) {
    #       $script:cardTintIsWarm = $wantWarmTint
    #       Update-CardTintFromPolarity -IsLight $wantWarmTint
    #   }
    return
}

# 【v0.9.6：$script:cTint 的启动初值】
#
# 从 2436 行那个"已删除的赋值"开始，$script:cTint 不再在启动时被系统主题覆盖。
# 所以必须在这里显式给一个初值，否则 Update-Glass 第一次跑时它是 $null，
# 磨砂会以 tint=0（全透明）上一次 —— 用户会看到卡片"先没有玻璃、900ms 后才出现"。
#
# 初值跟系统主题一致（和 $script:cardTintIsWarm 的初值同一个依据），
# 第一次实测后由 Update-CardTintFromPolarity 纠正成跟随壁纸。
$script:cTint = (([long]$script:glassOpacity) -shl 24) -bor $(if ($isDark) { 0x001A1A1E } else { 0x00FAF6F4 })

# 当前 tint 是不是"暖白"那一档。
#
# 【v0.9.6 为什么把这个变量从 cardTintPolarityLight 改名成 cardTintIsWarm】
#   旧名字的语义是"tint 的极性是 Light（浅）"，听起来和 $wantLightText
#   （"文字要用浅色"）像同一件事 —— 但它们**恰好相反**：
#     $wantLightText = $true  →  背景暗 → 文字要用浅色 → 应该配【深】tint
#     tint 是暖白              →  背景亮 → 文字要用深色 → 这时 $wantLightText = $false
#   我第一版就是被这个名字骗了，写成 cardTintPolarityLight = $wantLightText，
#   于是"背景暗"给了暖白 tint、"背景亮"给了深 tint —— 全反，小字反而更看不清
#   （实测事故壁纸：深 tint 玻璃上配深色字 = 1.31:1，比修之前 2.14 还差）。
#   改成一个能被自己读懂的名字之后，这个错误就写不出来了。
#
#   初值跟系统主题一致（系统浅色主题 → 暖白 tint），第一次实测后会被纠正。
$script:cardTintIsWarm = -not $isDark

function Update-AdaptiveText {
    param([int]$X, [int]$Y, [int]$W, [int]$H)
    if ($W -le 2 -or $H -le 2) { return }
    if ($W -gt 1200 -or $H -gt 1200) { return }

    # 采样位置 = 卡片"内侧、紧贴边框"的两条极窄竖条。
    #
    # 为什么不是卡片外面：
    #   文字是压在磨砂玻璃上的，不是压在壁纸上。采卡片外面会采到壁纸本身，
    #   壁纸下半部分的山体很暗（实测 54），会把数值拉低、误判成"暗背景"用白字，
    #   而卡片内部其实是 175 的亮玻璃。这是之前那个 bug 的根因。
    #
    # 为什么是 x 在 3~13 之间这一条：
    #   卡片边框 1 像素，内容从 14 像素处开始（PanelVisual 里的 $pad），
    #   所以 3~13 这一段永远是纯玻璃，任何状态下都没有文字，也不会采到边框。
    $scale = 1.0
    if ($CardWidth -gt 0) { $scale = $W / [double]$CardWidth }   # 逻辑像素 -> 物理像素

    $bandIn  = [int][math]::Round(3 * $scale)
    $bandOut = [int][math]::Round(13 * $scale)
    $marginY = [int][math]::Round(20 * $scale)                   # 避开上下圆角

    $leftX0  = $bandIn
    $leftX1  = $bandOut
    $rightX1 = $W - $bandIn
    $rightX0 = $W - $bandOut

    $topY    = $marginY
    $bottomY = $H - $marginY

    if ($leftX1 -ge $rightX0 -or $bottomY -le $topY) { return }

    try {
        if ($null -eq $script:backGfx -or $script:backW -ne $W -or $script:backH -ne $H) {
            if ($null -ne $script:backGfx) { $script:backGfx.Dispose() }
            if ($null -ne $script:backBmp) { $script:backBmp.Dispose() }
            $script:backBmp = New-Object System.Drawing.Bitmap($W, $H)
            $script:backGfx = [System.Drawing.Graphics]::FromImage($script:backBmp)
            $script:backW = $W
            $script:backH = $H
        }
        # 截卡片自己的画面。卡片是磨砂的，截到的就是"文字实际压着的东西"。
        # 这里只是量亮度，不做模糊，所以不存在自我反馈的问题。
        $script:backGfx.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))

        # 【v0.9.6 关键改动：这里要留着 RGB，不能只存一个标量】
        #
        #   旧代码把每个像素压成"简单亮度"一个数字（0.299R+0.587G+0.114B）。
        #   但下面要做的两件事都需要完整 RGB：
        #     ① 反解壁纸亮度 —— 必须逐通道做 (G - a*T)/(1-a)
        #     ② 算 WCAG 相对亮度 —— 必须先 gamma 校正再按 R/G/B 加权
        #   压成标量之后这两件事都做不成了，只能拿标量当"灰色"去近似，
        #   而这个近似对偏蓝/偏红的背景有系统性偏差（实测偏蓝时高估 0.04）。
        #
        #   【为什么是存 RGB 而不是就地算】
        #     中位数要先对**某个单调量**排序才能取。所以先存 RGB，
        #     按简单亮度排序取出中位像素，再拿那个像素的完整 RGB 去做反解。
        #     这样"选中位"和"算精确值"两件事各用各的量纲，不互相污染。
        $vals = New-Object System.Collections.ArrayList
        $stepY = [math]::Max(1, [int](2 * $scale))
        for ($py = $topY; $py -lt $bottomY; $py += $stepY) {
            for ($px = $leftX0; $px -lt $leftX1; $px++) {
                $c = $script:backBmp.GetPixel($px, $py)
                [void]$vals.Add([pscustomobject]@{
                    Sort = ($c.R * 0.299 + $c.G * 0.587 + $c.B * 0.114)
                    R = [int]$c.R; G = [int]$c.G; B = [int]$c.B
                })
            }
            for ($px = $rightX0; $px -lt $rightX1; $px++) {
                $c = $script:backBmp.GetPixel($px, $py)
                [void]$vals.Add([pscustomobject]@{
                    Sort = ($c.R * 0.299 + $c.G * 0.587 + $c.B * 0.114)
                    R = [int]$c.R; G = [int]$c.G; B = [int]$c.B
                })
            }
        }
        if ($vals.Count -lt 20) { return }

        # ================================================================
        # 【v0.10.5 抓屏失败识别 —— 本次白字 bug 的另一个根因】
        #
        # 【要解决的问题】
        #   Windows 上 CopyFromScreen 在下面这些情况下不会抛异常，
        #   而是静默返回一片纯黑（已实测：三种越界坐标全部返回纯黑、
        #   无异常、无 Win32 错误码）：
        #     · 显示器关闭 / 熄屏 / 系统睡眠刚唤醒的那一瞬间
        #     · 锁屏、UAC 安全桌面、RDP 断开
        #     · 窗口坐标落在虚拟屏幕之外（换屏/改缩放/副屏掉线）
        #
        #   而"一片纯黑"喂进本函数的判据，会反解出"壁纸全黑"
        #   → wallRel = 0.0000 < 0.186 → 必判白字。
        #   这正是用户 2026-10-31 16:07 点亮屏幕后看到的：浅色页面上白字。
        #
        # 【为什么代码里的 try/catch 抓不住它】
        #   因为它根本不抛异常，函数正常返回，只是内容全是黑的。
        #
        # 【判据为什么用"颜色种类数"而不是"亮度低"】
        #   这是一个反直觉但很关键的点：
        #   真实的深色壁纸本来就暗。如果用"亮度低"当失效判据，
        #   会把正常的深色壁纸误判成"抓屏失败"，然后拒绝更新字色 ——
        #   那深色壁纸下的白字就再也切不过去了。必须用结构特征，不能用亮度。
        #
        #   实测数据（本机 150% 缩放，采样带约 1792 个点）：
        #     正常屏幕区域：不同颜色 16 ~ 536 种
        #     抓屏失败(纯黑)：不同颜色 1 种
        #   相差两三个数量级，非常好区分。
        #
        # 【成本】
        #   零额外开销 —— 这些像素上面已经逐个 GetPixel 过了，
        #   这里只是顺手统计一下颜色种类。
        #
        # 【失效时怎么做】
        #   直接 return，本次不改任何颜色（保持上一次正确的结果）。
        #   这比"用一片黑去算出一个白字结论"好得多：
        #   最坏情况是"颜色晚 0.9 秒才更新"，而不是"永久停在错误颜色"。
        # ================================================================
        $distinctColours = New-Object 'System.Collections.Generic.HashSet[int]'
        foreach ($v in $vals) {
            [void]$distinctColours.Add((($v.R -shl 16) -bor ($v.G -shl 8) -bor $v.B))
        }
        $colourCount = $distinctColours.Count

        if ($colourCount -le 2) {
            # ================================================================
            # 【v0.10.6：这条日志必须去重，否则会把日志淹掉】
            #
            # 【为什么 —— 2026-11-01 的真实教训】
            #   v0.10.5 刚加上这个判据时，日志没做任何限流。
            #   结果一夜（22:00~02:51）抓屏持续失败，写了 12600 条
            #   一模一样的 CAPTURE-FAIL，panel-debug.log 涨到 1.5MB，
            #   真正有价值的"句柄无效"错误全被埋在里面，翻起来极痛苦。
            #
            #   这个函数每 900ms 跑一次，一旦持续失败就是每小时 4000 条。
            #   所以这里用和 Log-Card 一样的思路：**同类记录 60 秒只写一条**。
            #
            # 【为什么保留去重后还要写 panel.log】
            #   panel-debug.log 是"只在开调试开关时才有"的临时日志。
            #   抓屏失败是个**实质性的健康问题**，正常使用时也该留痕，
            #   所以同时往 panel.log 记一条 WARN（Log-Card 自带 60 秒去重）。
            # ================================================================
            $firstPx = $vals[0]
            $kind = '未知'
            if ($firstPx.R -le 8 -and $firstPx.G -le 8 -and $firstPx.B -le 8) { $kind = '纯黑（多半是抓屏失败/熄屏唤醒）' }
            elseif ($firstPx.R -ge 247 -and $firstPx.G -ge 247 -and $firstPx.B -ge 247) { $kind = '纯白' }

            try {
                Log-Card ('抓屏失败：采样带只有 ' + $colourCount + ' 种颜色（' + $kind + '），本轮保持原字色') `
                    -Level 'WARN' -Key 'captureFail'
            } catch { }

            if ($script:debugOn) {
                try {
                    $nowTick = [datetime]::Now
                    $lastTick = $script:captureFailLoggedAt
                    $shouldLog = $true
                    if ($null -ne $lastTick -and ($nowTick - $lastTick).TotalSeconds -lt 60) {
                        $shouldLog = $false
                    }
                    if ($shouldLog) {
                        $script:captureFailLoggedAt = $nowTick
                        [System.IO.File]::AppendAllText($script:debugPath,
                            ('{0} CAPTURE-FAIL colours={1} kind={2}（此后 60 秒内同类不再记录）' -f (Get-Date -Format 'HH:mm:ss'), $colourCount, $kind) + "`r`n",
                            (New-Object System.Text.UTF8Encoding($false)))
                    }
                } catch { }
            }
            return
        }

        # ================================================================
        # 【v0.9.13 加固：先剔除离群暗像素，再取中位数】
        #
        # 【为什么要加这一步 —— 这是一个真实 BUG 的第二道防线】
        #   2026-10-29 用户报"浅色背景下字不变黑"。
        #   根因是 DWM 在窗口四周画了一圈黑边（Border($hwnd,1) 传的是颜色，
        #   不是开关，见第 2587 行附近的注释），那圈黑边正好压在采样带上，
        #   把中位像素从 #CBCAE1（亮度 205）拉到约 110，
        #   于是判成"背景暗 → 白字"，而实际玻璃是亮的。
        #
        #   黑边那个源头已经改掉了（改成 DWMWA_COLOR_NONE）。
        #   但这类"采样带被某个东西污染"的故障会以别的形式再来一次
        #   —— 比如以后加阴影、加高光、或者 DWM 又换一种边框画法。
        #   所以这里加一道**与具体原因无关**的保险。
        #
        # 【为什么是"剔除离群暗像素"而不是"剔除离群亮像素"】
        #   边框类污染、阴影类污染、窗口外的黑色底 —— 它们全都**偏暗**。
        #   而且打磨砂玻璃时，偏亮的方向本来就是我们要测的主体。
        #   所以只剪掉暗的那一端。
        #
        # 【为什么用 p10 作分界，而不是"固定亮度阈值"】
        #   固定阈值（比如"低于 40 的丢掉"）在深色壁纸上会把真实背景全丢掉，
        #   反而让判据崩掉。用分位数就和绝对亮度无关：
        #   不管整体多亮多暗，永远只剪掉最暗的 10%。
        #   即使完全没有污染，剪掉最低 10% 后中位数也几乎不变
        #   （实测玻璃的中位亮度 204.9 → 剪完 205.3，差 0.4）。
        $sortedForCut = $vals | Sort-Object -Property Sort
        $p10 = $sortedForCut[[int]($sortedForCut.Count * 0.10)].Sort
        # 分界 = p10 和"中位数的一半"取较大者：
        #   前者剔除相对最暗的一批；后者保证不会因为某帧特别暗就把真实背景剪掉。
        $medianLum = $sortedForCut[[int]($sortedForCut.Count / 2)].Sort
        $cutLum = [math]::Max($p10, $medianLum * 0.5)

        $valsFiltered = @($vals | Where-Object { $_.Sort -ge $cutLum })
        # 兜底：极端情况下全被剪光时退回原集合（不能因为加固而让判据失效）
        if ($valsFiltered.Count -lt 10) { $valsFiltered = @($vals) }

        # 用中位数，不用平均值。
        # 平均值会被少数极端像素带偏（比如留白带里恰好压到一块深色）；
        # 中位数是一半比它亮、一半比它暗，对少量异常值不敏感。
        $sorted = $valsFiltered | Sort-Object -Property Sort
        $medianPx = $sorted[[int]($sorted.Count / 2)]
        $lum = $medianPx.Sort

        # 背景亮 -> 深色字；背景暗 -> 浅色字。
        # 300ms 去抖：拖动经过明暗交界时不会来回闪。
        #
        # 【历史：阈值曾经是 150，后来改成简单的 120】
        #   150 那次是修既有缺陷：实测白字要到背景 >=110 才够 4.5:1、
        #   黑字要到 <=125 才够，所以真正的切换点在 118~120。
        #
        # 【v0.9.6：判据从"简单亮度 120"改成"相对亮度 0.186"】
        #
        #   用户报的问题："卡片状态，在深色背景下，小字的反色似乎失效了，可读性下降了"。
        #   我把他的截图（屏幕截图 2026-10-29 095218.png）逐像素量了一遍：
        #     卡片玻璃背景（小字压着的那块）：#687C8D，相对亮度 0.193
        #     底部小字"今日 295.0M Token"最暗像素：#5B6573，对它只有 1.37:1
        #   而判据当时用的是**简单亮度**（0.299R+0.587G+0.114B）：
        #     #687C8D 的简单亮度 = 138.6 > 120  →  判成"背景亮 → 用深色字"
        #   于是深色小字 #3F4855 压在中暗玻璃上 —— 两边都不极端，谁都读不清。
        #
        #   为什么换相对亮度：
        #     WCAG 算对比度用的是**相对亮度**（带 gamma 校正的非线性映射），
        #     而判据用的是简单加权平均（线性）。两者在中间调差得很远：
        #       简单亮度 120 ↔ 相对亮度 0.188（灰 120 那个点）
        #     也就是说原来的阈值在相对亮度尺度上其实落在 0.188 附近，
        #     而真正的"两种极性等强"点是 0.186（深字 #0C0E11 / 浅字 #FBFCFE 的解）。
        #     数值上看着差不多，但**判定用的量纲错了**：
        #     简单亮度对蓝色严重低估（0.114 权重），
        #     而这一屏壁纸正是偏蓝的山景 —— 蓝通道被低估，判据把偏暗的背景判成了亮背景。
        #     这就是"深色背景下反色失效"的直接原因。
        #
        #   现在算的是**相对亮度**，阈值 0.186（两极性等强点）。
        #
        # 【v0.9.6 关键：判据必须先把 tint 除掉，否则会自己抖自己】
        #
        #   ⚠️⚠️ 这一条是子代理 Beata 在审查时抓出来的真 bug，走错一步就是"每 900ms 闪一次"。
        #
        #   错误的写法（我第一版就是这么写的，已删）：
        #     用"截到的玻璃亮度"直接判极性 → 再拿这个极性去换 tint。
        #   为什么错：这是**自我引用的闭环**。玻璃亮度 = 壁纸 × 当前 tint，
        #   换个 tint 玻璃就变，玻璃一变判据就翻，判据一翻又换回原来的 tint……
        #   实测推演（用户那屏壁纸，反解出 #25445E、相对亮度 0.053）：
        #     帧0 浅tint → 玻璃 #667C8F (0.1918) → 判"用深字" → 切深tint
        #     帧1 深tint → 玻璃 #233749 (0.0355) → 判"用浅字" → 切浅tint
        #     帧2 浅tint → 玻璃 #667C8F (0.1918) → 判"用深字" → 切深tint
        #     ……零阻尼振荡，用户会看到玻璃每 0.9 秒闪一下。
        #   而 0.186 这个阈值正好夹在两个不动点中间，所以两边都"有理由"。
        #
        #   正确写法：**先反解出壁纸本身的亮度，再判**。
        #     观测玻璃 G = a*T + (1-a)*W   （a = tint alpha，T = tint 色，W = 壁纸模糊色）
        #     反解        W = (G - a*T) / (1-a)
        #   关键性质：W 里已经把当前 tint 除掉了，**换 tint 不改变 W**。
        #   于是判据是唯一的、不存在第二个不动点。实测（子代理 Beata 扫了
        #   壁纸亮度 0.01~0.99 × 两种起始 tint 共 198 个组合）：全部一步收敛，0 振荡。
        #
        # 【为什么这一条同时修掉了"方向反了"的问题】
        #   旧写法里语义是反的：
        #     $wantLightText = $true 的意思是"要用浅色字"
        #     但 Update-CardTintFromPolarity -IsLight $true 给的是"给浅背景用的暖白 tint"
        #   → 结果变成"深 tint 的玻璃上配深色字"，实测小字只有 1.5:1，比修之前更糟。
        #   现在统一：wantLightText = $true ⇔ 壁纸暗 ⇔ 用深 tint ⇔ 玻璃暗 ⇔ 用浅色字。
        #   四者是同一件事，只用一个布尔表示，不会再错位。
        $tintAlpha = 0.0
        try {
            # 【为什么用 $script:glassOpacity 而不是 $glassOpacity】
            #   它是脚本顶层（371 行）定义的变量，函数里靠动态作用域能读到，
            #   但显式写 $script: 更明确，也避免以后有人把它挪进函数里之后静默变成 0。
            $tintAlpha = ([double]$script:glassOpacity) / 255.0
        } catch { $tintAlpha = 0.0 }
        if ($tintAlpha -lt 0) { $tintAlpha = 0 }
        if ($tintAlpha -gt 0.98) { $tintAlpha = 0.98 }   # 满 alpha 时反解会除零

        # 当前该减掉的 tint 色（和 Update-CardTintFromPolarity 用同一套色，保持一致）
        # 【⚠️ 字节序：DWM 的 GradientColor 是 0xAABBGGRR，低字节是 R，不是 B】
        #   所以 0x00FAF6F4 解出来的 RGB 是 **#F4F6FA**（微冷白），
        #   不是字面上读起来的暖白 #FAF6F4。两个子代理都独立指出了这一点。
        #
        #   这个错的实际影响很小：G 通道权重 0.7152 是对的，
        #   两个 tint 只差 R/B 各 4~6，Δ相对亮度 0.0000~0.0001。
        #   但它会在"壁纸亮度刚好落在切换点 ±0.01"时让人判错方向，而且
        #   反解公式 (G - a*T)/(1-a) 用的是逐通道值 —— 通道搞反了反解就是错的。
        #   所以趁现在改对，不留一个"看起来对、其实差一点"的隐患。
        $tintIsWarm = [bool]$script:cardTintIsWarm
        # 浅色 tint 常量 = 0x00FAF6F4（ABGR）→ R=0xF4 G=0xF6 B=0xFA
        # 深色 tint 常量 = 0x001A1A1E（ABGR）→ R=0x1E G=0x1A B=0x1A
        if ($tintIsWarm) { $tR = 0xF4; $tG = 0xF6; $tB = 0xFA }
        else             { $tR = 0x1E; $tG = 0x1A; $tB = 0x1A }

        $denom = 1.0 - $tintAlpha
        $wR = ($medianPx.R - $tintAlpha * $tR) / $denom
        $wG = ($medianPx.G - $tintAlpha * $tG) / $denom
        $wB = ($medianPx.B - $tintAlpha * $tB) / $denom
        # 逐通道 clamp 到 0~255（磨砂不是严格线性混合，反解可能越界）
        if ($wR -lt 0) { $wR = 0 } elseif ($wR -gt 255) { $wR = 255 }
        if ($wG -lt 0) { $wG = 0 } elseif ($wG -gt 255) { $wG = 255 }
        if ($wB -lt 0) { $wB = 0 } elseif ($wB -gt 255) { $wB = 255 }

        $wallRel = Get-RelativeLuminance -R $wR -G $wG -B $wB
        $wantLightText = ($wallRel -lt 0.186)

        # 【极性变了要让磨砂 tint 跟着翻 —— 单向，不回头】
        #
        #   $wantLightText 现在是从**壁纸**算出来的，不受 tint 影响，
        #   所以这里换 tint 不会反过来改变下帧的判据。（这就是"单向前馈"）
        #
        #   【为什么放在这里，而不是在 Update-Glass 里算】
        #     Update-Glass 由 900ms 的 $glassWatch 驱动，但它自己不做截图。
        #     而"壁纸明暗"只有本函数（唯一做 CopyFromScreen 的地方）知道。
        #     所以在本函数里切换，Update-Glass 下一次 tick 自然就会用新的 tint。
        #     **零新增定时器** —— 这条硬约束没被破坏。
        #   【方向对照表 —— 写代码前先看一眼这张表，别再搞反】
        #     壁纸暗(wantLightText=$true)   → 深 tint(不是暖白) → 玻璃暗 → 浅色字  ✓
        #     壁纸亮(wantLightText=$false)  → 暖白 tint          → 玻璃亮 → 深色字  ✓
        #   所以传到 Update-CardTintFromPolarity 的 -IsLight 应该是 **NOT $wantLightText**。
        try {
            $wantWarmTint = -not $wantLightText
            # 【v0.9.8 回滚：不再改卡片的 tint】
            #
            #   ⚠️ 用户实测反馈原话："主卡片深色模式下做错了，原来的效果是，
            #      磨砂卡片本身的颜色不会动，在深色下变动的只有文字，
            #      现在整个卡片颜色跟着动了"
            #
            #   【我犯了什么错】
            #     v0.9.6 为了让玻璃远离"两种字色都不够"的死区，让卡片 tint 跟随壁纸。
            #     那个技术推理本身没错（玻璃确实远离了死区、文字对比度从 1.36 涨到 11.97），
            #     但我**擅自改变了用户已经接受的外观**：
            #       原来 = 半透明固定色调的玻璃浮在桌面上
            #       改后 = 玻璃颜色跟着壁纸变，像贴着壁纸的一块板
            #     这是**产品决策**，不是技术选择。我应该先问，而不是顺手改掉。
            #     现在用户选了"就按原样，别动卡片颜色"，所以这里回滚。
            #
            #   【回滚后 $script:cardTintIsWarm 还留着，因为它还有用】
            #     下面"反解壁纸亮度"必须知道当前 tint 的通道值才能做减法。
            #     tint 现在只由系统主题决定（$script:cTint 在启动时算好、热更新时保留极性），
            #     所以这个变量会一直是初值 —— 这正好是我们要的"玻璃颜色不动"。
            #
            #   【代价（用户已知情并接受）】
            #     "系统浅色主题 + 深色壁纸"这种组合下，玻璃落在中间亮度，
            #     文字只能用最极端的两端色去救，最多做到"刚好达标"。
            #     这是用一个可接受的可读性换回稳定的外观 —— 用户的取舍。
            # 【v0.9.7】柱态也要跟着实测壁纸换配色。
            #   传的是 $wantWarmTint（"壁纸亮"），柱子那边叫 barThemeIsLight，
            #   语义相同，直接透传。
            #   ⚠️ 注意方向：wantLightText=true（壁纸暗）→ wantWarmTint=false（用深 theme）
            #     这一层取反已经在上一行做了，这里不要再取反一次。
            if ($script:barThemeIsLight -ne $wantWarmTint) {
                Update-BarThemeFromBackground -IsLight $wantWarmTint
            }
        } catch { Log-Fail 'L2611' $_ }

        # 调试留痕：设了 DSH_PANEL_DEBUG 就一直记录判断结果，方便排查误判。
        # 正常使用不要设，避免每 900ms 写一次文件。
        if ($script:debugOn) {
            try {
                # 【v0.9.6 调试日志加了两个关键字段】
                #   wall = 反解出来的**壁纸**相对亮度（判据真正用的值）
                #   tint = 当前 tint 极性（用来确认"换 tint 之后 wall 不变"这个性质）
                $line = ('{0} glassLum={1:N1} wallRel={2:N3} tint={3} (avg={4:N1} p10={5:N1} p90={6:N1} n={7}) => {8}' -f `
                    (Get-Date -Format 'HH:mm:ss'), $lum, $wallRel,
                    $(if ($tintIsWarm) { '浅' } else { '深' }),
                    ($vals | Measure-Object -Property Sort -Average).Average,
                    ($sorted[[int]($sorted.Count * 0.10)].Sort), ($sorted[[int]($sorted.Count * 0.90)].Sort),
                    $vals.Count, $(if ($wantLightText) { '白字' } else { '黑字' }))
                [System.IO.File]::AppendAllText($script:debugPath, $line + "`r`n",
                    (New-Object System.Text.UTF8Encoding($false)))
            } catch { Log-Fail 'L2628' $_ }
        }

        # 【v0.9.6 修掉一个"看起来改了、其实从没执行过"的既有缺陷】
        #
        #   旧代码是这一句：
        #     if ($wantLightText -eq (-not $script:curIsLight)) { return }
        #
        #   意图是"明暗没变化就别重复改颜色"。但它有一个致命的启动态问题：
        #     $script:curIsLight 初值 = -not $isDark
        #   用户是**系统浅色主题** → $isDark = $false → curIsLight = $true
        #   而实测背景其实偏暗 → wantLightText = $true（要用浅色字）
        #   → -not curIsLight = $false
        #   → $true -eq $false 不成立，看起来该继续……
        #   但反过来那一半才是灾难：当 wantLightText 恰好等于 -not curIsLight 时直接 return。
        #   实测（用户截图逐像素复核）卡片小字的颜色是 #5B6573 —— 那是
        #   **启动时"浅色主题"分支写进去的初值**，不是本函数应该写的 #3F4855。
        #   也就是说：这个函数跑了、日志也写了、判断也做了，**但一行颜色都没改过**。
        #
        #   这就是"小字反色失效"的第三重原因（前两重是 tint 极性、判据量纲）。
        #   三重叠加：判据判错 → 判对了也不执行 → 执行了 tint 也不对。所以用户看到的一直是初值。
        #
        #   【修法：不再用"和初值比"来早退，改成"和上次真正应用过的极性比"】
        #     $script:curIsLight 现在只在真正改色之后才更新（下面那句），
        #     所以用 == 比较它就可以安全早退 —— 只要它确实反映"已经应用到界面上的极性"。
        #   同时保留 300ms 去抖（拖动经过明暗交界时不要闪）。
        #
        # ================================================================
        # 【v0.9.13 重构：从"事件式改色"改成"幂等式改色"】
        #
        # 【这一改是为了一个查不出来的 bug】
        #   2026-10-29 用户报"浅色背景下字不变黑"。
        #   我和两个子代理分别用三种办法验证过：
        #     · 拿用户截图逐像素跑产品算法 → 判"黑字"（对）
        #     · 建真实磨砂窗口忠实复现，6 种边框/背景组合 → 全判"黑字"（对）
        #     · 直接读 WPF 画刷 .Color，4 个"主题×背景"组合 → 全对
        #   结论是：**判据对、采样干净、颜色该写黑字，但用户屏幕上就是白字**。
        #   而且这个现象在开发环境里怎么都复现不出来。
        #
        #   继续猜"到底哪一步丢了"已经没有意义了 —— 已经猜错两次
        #   （先怀疑 DWM 黑边污染采样，被实测推翻；再怀疑早退，被实测推翻）。
        #   正确的做法不是继续猜，是**改变设计，让"丢了"这件事不可能持续存在**。
        #
        # 【旧设计为什么会"丢了就永远丢了"】
        #   原来这里是事件式的：
        #     if (极性没变) { return }        ← 只要 self 认为已经应用过，就再也不写
        #     ...写颜色...
        #     $script:curIsLight = 新极性
        #   这个"已应用"的记账是**唯一的真源**。一旦有任意一种情况让
        #   "记账说应用过了、但其实界面不是那个颜色"（比如某次赋值抛了异常
        #   被空 catch 吞掉、或者控件被重建、或者中途某个 run 没跑到赋值那行），
        #   之后每一轮都会因为"记账说已经对了"而直接 return，
        #   **字色就永久停在错误值上，而且日志还会一直打印"黑字"，看起来一切正常。**
        #   这正好对应用户看到的现象：错的值 + 对的日志。
        #
        # 【新设计：每一轮都幂等重写，不再依赖记账】
        #   极性切换仍然保守（300ms 去抖，防止拖动经过明暗交界时闪），
        #   但"把当前极性对应的颜色写进画刷"这件事**每一轮都做**。
        #   幂等的开销几乎为零：WPF 给 SolidColorBrush.Color 赋一个**相同的值**
        #   不会触发任何变更通知，也就不会重绘。真正有成本的只有
        #   New-Brush（会给分隔线造新对象），所以那两个画刷改成缓存复用。
        #
        #   好处：即使前面某一轮因为任何原因没写成功，下一轮（900ms 后）
        #   会自动补上 —— 也就是"自愈"。用户最差看到 0.9 秒的错色，而不是永久错色。
        #
        # 【为什么不干脆每轮都允许切换极性】
        #   那会把 300ms 去抖一起去掉，用户拖卡片经过明暗交界时会看到字色闪。
        #   切换要保守、应用要激进，这两件事分开是对的。

        $wantLight = [bool]$wantLightText

        # ---- ① 极性切换（保守：带 300ms 去抖）
        $polarityChanged = ($script:curIsLight -ne (-not $wantLight))
        if ($polarityChanged) {
            $now = [datetime]::Now
            if ($null -eq $script:lastSwitchAt -or
                ($now - $script:lastSwitchAt).TotalMilliseconds -ge 300) {
                $script:lastSwitchAt = $now
                $script:curIsLight = -not $wantLight
            }
            # 去抖期间不改极性，但仍然继续往下"幂等应用当前极性"
        }

        # ---- ② 幂等应用（激进：每轮都做，这就是自愈的来源）
        # 【为什么用 $script:curIsLight 而不是 $wantLight】
        #   去抖期间 $wantLight 可能已经翻转但还没被采纳，
        #   这时应该继续显示"当前已采纳的那个极性"，否则去抖就失效了。
        $applyLight = (-not $script:curIsLight)   # curIsLight=背景亮 ⇔ 用深色字 ⇔ applyLight=false

        # 文字换色的同时，阴影取相反方向：
        #   浅色字 -> 深色阴影（把字从亮背景里"抠"出来）
        #   深色字 -> 浅色光晕（把字从暗背景里"托"起来）
        $shadowColor = if ($applyLight) {
            [System.Windows.Media.Color]::FromArgb(255, 0, 0, 0)
        } else {
            [System.Windows.Media.Color]::FromArgb(255, 255, 255, 255)
        }
        try { Set-TextShadowColor -Color $shadowColor } catch { }

        # 【v0.9.6 色值全部往两端推，理由用数字说】
        #   第三档（tertiary，小字）原来用 #B8C2D0，在深玻璃(rel 0.036)上是 6.83 —— 够。
        #   但用户的实际情况是玻璃在死区(rel 0.193)，那里 #B8C2D0 只有 2.40。
        #   现在靠 tint 极性把玻璃推出死区，两端都变极端，色板就可以更大胆：
        #     浅字模式：primary #F7F9FC→#FBFCFE  secondary #DDE3EC→#E8EDF4  tertiary #B8C2D0→#D3DCE8
        #     深字模式：primary #111318→#0C0E11  secondary #3F4855→#1E2128  tertiary #5F6977→#2B303A
        #   实测（两端玻璃上）：
        #     浅字：#FBFCFE 11.94 / #E8EDF4 10.42 / #D3DCE8 8.86
        #     深字：#0C0E11 16.72 / #1E2128 13.94 / #2B303A 11.45
        #   全部超过 4.5 门槛的两倍，留出了足够余量给"光晕把字边缘糊掉"的损耗。
        #
        # 【v0.9.13：分隔线画刷改成缓存复用，不再每轮 New-Brush】
        #   幂等重写要求本函数每 900ms 都完整跑一遍。原来每次都 New-Brush 两个
        #   分隔线画刷，一天就是 17 万个短命对象。缓存之后零分配。
        if ($applyLight) {
            $bTextPrimary.Color        = [System.Windows.Media.Color]::FromArgb(255, 0xFB, 0xFC, 0xFE)
            $bTextSecondary.Color      = [System.Windows.Media.Color]::FromArgb(255, 0xE8, 0xED, 0xF4)
            $bTextTertiary.Color       = [System.Windows.Media.Color]::FromArgb(255, 0xD3, 0xDC, 0xE8)
            if ($null -eq $script:bSepLight) {
                $script:bSepLight = New-Brush ([System.Windows.Media.Color]::FromArgb(0x30, 0xFF, 0xFF, 0xFF))
            }
            if ($null -ne $exp) {
                if ($null -eq $exp.Sep1.Fill) { $exp.Sep1.Fill = $script:bSepLight }
                if ($null -eq $exp.Sep2.Fill) { $exp.Sep2.Fill = $script:bSepLight }
                $exp.Sep1.Fill = $script:bSepLight
                $exp.Sep2.Fill = $script:bSepLight
            }
        }
        else {
            $bTextPrimary.Color        = [System.Windows.Media.Color]::FromArgb(255, 0x0C, 0x0E, 0x11)
            $bTextSecondary.Color      = [System.Windows.Media.Color]::FromArgb(255, 0x1E, 0x21, 0x28)
            $bTextTertiary.Color       = [System.Windows.Media.Color]::FromArgb(255, 0x2B, 0x30, 0x3A)
            if ($null -eq $script:bSepDark) {
                $script:bSepDark = New-Brush ([System.Windows.Media.Color]::FromArgb(0x24, 0, 0, 0))
            }
            if ($null -ne $exp) {
                if ($null -eq $exp.Sep1.Fill) { $exp.Sep1.Fill = $script:bSepDark }
                if ($null -eq $exp.Sep2.Fill) { $exp.Sep2.Fill = $script:bSepDark }
                $exp.Sep1.Fill = $script:bSepDark
                $exp.Sep2.Fill = $script:bSepDark
            }
        }

        # ---- ③ 自检：把"实际写进画刷的颜色"回读一遍，写进调试日志
        #
        # 【为什么必须有这个自检】
        #   这次排查最大的痛苦是：日志说"黑字"，界面是白字，而日志看不出差别 ——
        #   因为日志记的是**判定**，不是**结果**。
        #   下面这段回读画刷真实值，一旦"判定"和"实际"不一致，日志里立刻能看出来，
        #   不需要再靠截图和猜测。
        if ($script:debugOn) {
            try {
                $actualHex = ('#{0:X2}{1:X2}{2:X2}' -f $bTextPrimary.Color.R, $bTextPrimary.Color.G, $bTextPrimary.Color.B)
                $expectHex = if ($applyLight) { '#FBFCFE' } else { '#0C0E11' }
                $okMark = if ($actualHex -eq $expectHex) { 'OK' } else { 'MISMATCH' }
                $line = ('{0} applied={1} expect={2} {3} wantLight={4}' -f `
                    (Get-Date -Format 'HH:mm:ss'), $actualHex, $expectHex, $okMark, $wantLight)
                [System.IO.File]::AppendAllText($script:debugPath, $line + "`r`n",
                    (New-Object System.Text.UTF8Encoding($false)))
            } catch { Log-Fail 'L2786' $_ }
        }

        # 明暗切换了 -> 状态色也要换成对应的那一套。
        #
        # 【为什么必须有这一句】
        #   标题文字挂的是专属画刷 $bHeadText，不在这上面三个共享画刷里，
        #   所以上面改了 $bTextPrimary 并不会顺带改到标题。
        #   如果不补这一句：本函数（900ms 一次）和 Set-Header（500ms 一次）交织执行，
        #   最坏情况下标题会用"旧明暗对应的状态色"停留最多约 400ms ——
        #   用户拖动卡片经过明暗交界时，就会看到红字闪一下变成另一个红。
        #   补上之后，明暗一变就立刻按新明暗重算，没有空窗。
        # 【v0.9.13：只在实际翻转了极性时才重算，否则每 900ms 白跑一次 Set-Header】
        if ($polarityChanged) {
            try {
                if ($null -ne $script:curPhase) { Set-Header $script:curHeadText $script:curPhase }
            } catch { Log-Fail 'L2802' $_ }
        }
    }
    catch {
        # 【v0.9.13：不再静默吞掉异常】
        #   原来这里是空的 catch。后果：只要本函数里任何一步抛异常，
        #   就"一个颜色都不改、不报错、不写日志"，从外面完全看不出问题。
        #   这正是"判对了却没生效"这类 bug 能长期潜伏的原因。
            #   现在至少留一条痕迹。
            #
            # 【v0.10.5：从"只在调试开关下写"改成"无条件写"】
            #   为什么必须改：2026-10-31 那次白字事故，整个排查中最痛苦的一点是
            #   功能实际上已经失效，但 panel.log 里一条异常都没有，
            #   完全看不出"自适应已经死了"。因为原来的留痕被 $script:debugOn 挡住了。
            #
            #   带 -Key 做去重：同一个错误 60 秒内只记一条。
            #   本函数每 900ms 跑一次，万一某处持续失败，
            #   没有去重的话一天能写近 10 万行（项目历史踩过这个坑）。
            # 【v0.10.6：抓屏异常要单独点名】
        #   2026-10-31 那一夜，panel.log 里出现了 14 次
        #     CopyFromScreen 时发生异常:"句柄无效。"
        #   这个错误本来会被下面的 Log-Fail 记成一条泛泛的
        #   "Update-AdaptiveText 失败"，排查时很难一眼认出
        #   它其实是"抓屏拿不到画面"这一类问题。
        #
        #   单独点名之后，两个好处：
        #     ① 按关键词搜 "抓屏异常" 就能统计发生频率
        #     ② 和 "抓屏失败：采样带只有 N 种颜色" 是同一类病，
        #        一个是抛异常、一个是静默返回坏数据，现在都归到同一个关键词下
        $isCaptureError = $false
        try {
            $msgText = [string]$_.Exception.Message
            if ($msgText -match '句柄无效|Handle is invalid|CopyFromScreen|invalid handle') {
                $isCaptureError = $true
            }
        } catch { }

        if ($isCaptureError) {
            try {
                Log-Card ('抓屏异常（本轮不改字色，下一轮自动重试）：' + $_.Exception.Message) `
                    -Level 'WARN' -Key 'captureError'
            } catch { }
        }

        try { Log-Fail 'Update-AdaptiveText' $_ -Key 'adaptiveText' } catch { }

        if ($script:debugOn) {
            # ================================================================
            # 【v0.10.6b：这条 debug 日志也必须去重】
            #   隔离验证里实测：18 秒写了 14 条一模一样的 EXCEPTION。
            #   这个函数每 900ms 跑一次，持续出错的话一天能写几十 MB，
            #   把真正有用的信息全埋掉（昨晚 12600 条 CAPTURE-FAIL 就是这个下场）。
            #   去重键单独用一个时间戳：抓屏失败和抛异常是两类问题，各记各的。
            # ================================================================
            try {
                $nowExc = [datetime]::Now
                $lastExc = $script:adaptiveExcLoggedAt
                if ($null -eq $lastExc -or ($nowExc - $lastExc).TotalSeconds -ge 60) {
                    $script:adaptiveExcLoggedAt = $nowExc
                    [System.IO.File]::AppendAllText($script:debugPath,
                        ('{0} EXCEPTION {1}: {2}（此后 60 秒内同类不再记录）' -f (Get-Date -Format 'HH:mm:ss'),
                         $_.Exception.GetType().Name, $_.Exception.Message) + "`r`n",
                        (New-Object System.Text.UTF8Encoding($false)))
                }
            # 【故意静默】失败无害，下个周期会自动重试
            } catch { }
        }
    }
}

# ---------------------------------------------------------------- 展开面板
$exp = New-ExpandedPanel -CardWidth $CardWidth
# 标题文字挂专属画刷（不是共享的 $bTextPrimary）：
# 状态色要能被 Set-Header 单独控制，不能和任务名/底栏共用一个画刷。
# running / idle 时 Set-Header 会把 $bTextPrimary 的当前颜色抄过来，行为等同于改动前。
$exp.HeadText.Foreground = $bHeadText
$exp.FootLeft.Foreground = $bTextSecondary
$exp.FootRight.Foreground = $bTextSecondary
$exp.Sep1.Fill = New-Brush $cSep
$exp.Sep2.Fill = New-Brush $cSep
$exp.Root.BorderBrush = New-Brush $cFrame
$exp.Root.Visibility = 'Collapsed'
[void]$host1.Children.Add($exp.Root)

# ---------------------------------------------------------------- 收起面板
$mini = New-MiniPanel
$mini.Caption.Foreground = $bTextSecondary
$mini.Value.Foreground = $bTextPrimary
$mini.Root.BorderBrush = New-Brush $cFrame
$mini.Root.Visibility = 'Collapsed'
[void]$host1.Children.Add($mini.Root)

# ---------------------------------------------------------------- 柱态常量（v0.9.0）
#
# 【⚠️ 这个块原来在 2200 行附近，v0.9.1 挪到这里 —— 修的是一个真 bug】
#   原来 $BarWidth/$BarHeight/$BarStripWidth/$BarStripPadY 是在下面
#   （原 2200 行）才赋值的，但 1424 行建 PanelVisual 的柱子面板时就已经用它们了。
#   PowerShell 对"未定义变量传进 [double] 参数"的处理是**静默当 0**，
#   不是报错、也不是用函数默认值 —— 实测验证：
#       function f { param([double]$A = 14) ... }
#       f -A $UndefinedVariable      # 结果 A=0，不是 14，也不报错
#   后果：柱子面板被建成 0 × 0 的 Grid、颜色条 0 宽。
#   之后 Set-BarGeometry 把窗口设成 14×120，但面板本身是 0 尺寸，
#   所以屏幕上看到的是"一个填满窗口的色块"而不是"带圆角的胶囊 + 中间的细条"。
#   —— 这正是用户说"柱子样式太丑、不像卡片"的一个隐藏原因，
#      不只是配色问题。不修这个，光改颜色看不到真效果。
#
# 【为什么必须放在建面板之前，而不是把参数写死】
#   用户可以在 settings.json 里改 barWidth/barHeight（Settings 界面以后也会暴露），
#   所以尺寸必须来自配置。正确做法是"先读配置，再建面板"。
#
# 用户拍板：中档 14 × 120 逻辑像素，保持置顶。
#
# 【为什么柱子贴边距是 4 而不是 0（虽然用户说"贴死"）】
#   Clamp-Position 有一段 `if ($win.Left -lt $w.Left) { $win.Left = $w.Left + 4 }`。
#   如果柱子设 Left = w.Left + 0，会立刻被它推回 +4。
#   两个选择：
#     A. 改 Clamp-Position —— 危险。万一柱态位置算错（比如柱高超过屏幕），
#        窗口会跑到屏幕外完全看不见，用户以为卡片丢了。
#     B. 把柱子贴边距设成 4，和 Clamp-Position 对齐 —— 零风险。
#   选 B。视觉上 4 逻辑像素 = 8 物理像素的缝，肉眼看不出"没贴死"。
$BarWidthDefault   = 14
$BarHeightDefault  = 120
# 【v0.9.1：条宽默认从 8 改成 6】
#   14 宽的柱子，条占 8 = 57%，看起来像"整根都是颜色"（糖果棒）。
#   6 = 43%，两边各留 4 像素玻璃边距，才像"嵌在玻璃里的指示灯"。
#   6/14 这个比例是用户在柱态样式方案里拍板的 K 方案。
$BarStripWidthDef  = 6
$BarStripPadY      = 12
$BarEdgeGap        = 4      # 见上，和 Clamp-Position 的 +4 对齐
$BarEdgeTolerance  = 2      # "光标顶住边缘"的容差（逻辑像素）

# 从 settings.json 读（缺键用默认值；越界夹紧，防手工改 json 填离谱值）
$BarEnabled = $true
try {
    $be = Get-Setting $settings 'barEnabled' $true
    $BarEnabled = ($be -ne $false)
} catch { $BarEnabled = $true }

$BarWidth = $BarWidthDefault
try { $BarWidth = [int](Get-Setting $settings 'barWidth' $BarWidthDefault) } catch { }
if ($BarWidth -lt 6)  { $BarWidth = 6 }
if ($BarWidth -gt 40) { $BarWidth = 40 }

$BarHeight = $BarHeightDefault
try { $BarHeight = [int](Get-Setting $settings 'barHeight' $BarHeightDefault) } catch { }
if ($BarHeight -lt 60)  { $BarHeight = 60 }
if ($BarHeight -gt 400) { $BarHeight = 400 }

$BarStripWidth = $BarStripWidthDef
try { $BarStripWidth = [int](Get-Setting $settings 'barStripWidth' $BarStripWidthDef) } catch { }
if ($BarStripWidth -lt 3) { $BarStripWidth = 3 }
if ($BarStripWidth -gt ($BarWidth - 2)) { $BarStripWidth = $BarWidth - 2 }

# ---------------------------------------------------------------- 柱态面板（v0.9.0）
#
# 【⚠️ 必须存进 $script: 作用域，不能是普通变量】
#   这是 Lead 上一轮踩过的坑：把面板存成局部/普通变量后，
#   所有拖拽/点击事件回调里读它都是 $null —— 表现是"点了没反应、也没有报错"。
#   WPF 的事件脚本块读不到函数局部变量（第三轮事故同源）。
#   所以这里建完之后**立刻**转存到 $script:bar。
$script:bar = New-BarPanel -BarWidth $BarWidth -BarHeight $BarHeight `
    -StripWidth $BarStripWidth -StripPadY $BarStripPadY
[void]$host1.Children.Add($script:bar.Root)

# ---------------------------------------------------------------- 柱态悬停提示（v0.9.5）
#
# 【为什么气泡是**独立的窗口**，而不是塞在同一个窗口里】
#   我一开始想把气泡放进 $host1（零新窗口，看起来最省）。实测行不通：
#     · 柱态窗口只有 14 宽，气泡必须显示在柱子外侧 → 必须**加宽窗口**
#     · 而柱态窗口被 SetWindowRgn 裁成了胶囊形状 → 加宽的区域会被裁掉
#     · 要让它显示就必须把 region 改成"胶囊 + 矩形"的**并集**，
#       还要在悬停时改窗口宽度、重算 Left、重算 region…
#       每一步都可能闪一下或裁错，而这块已经连续出过三个坑（见报告第五节）
#   所以改用独立窗口：柱子窗口保持 14 宽和胶囊 region 不动，
#   气泡自己定位、自己显示/隐藏，两边互不干扰。
#
# 【这个窗口为什么是安全的（回应"第三轮卡片消失"那类事故）】
#   它有几个特殊属性，使它不可能成为事故源：
#     · ShowActivated = false   → 永不抢焦点（不会把用户的输入抢走）
#     · IsHitTestVisible = false → 鼠标穿透（气泡不会挡住用户点击）
#     · Topmost 跟随主窗口        → 主窗口置顶它才置顶
#     · 所有操作都在 try/catch 里 → 气泡出任何问题都只是"不显示"，不影响卡片
#   最关键的是：**它不参与任何业务逻辑**。即使它彻底坏掉，
#   柱子照样能拖能点，只是没有提示文字。
$script:barTipWin = $null

# ================================================================ 柱态气泡的数据源（v0.9.6 修真 bug）
#
# 【v0.9.5 的 bug：气泡永远显示"空闲"】
#   旧代码有两个变量名，从来没对上过：
#     Update-UI 里写：$script:barStatus**Text** = Get-StatusTextForPhase ...
#     Show-BarTip 里读：-Text $script:barTipText
#   而 $script:barTipText 只在建窗口的时候被初始化成 ''，**之后再也没有被赋过值**。
#   于是 Show-BarTip 每次都被喂空字符串，函数里 `if (IsNullOrEmpty) { $Text = '空闲' }`
#   就把它兜底成"空闲" —— 用户看到的永远是"空闲"，不管实际在跑几个任务。
#
#   这个 bug 之所以测试没抓到，是因为 test/bar-mode.mjs 只检查了
#   "有没有 Get-StatusTextForPhase 这个函数"、"有没有 Show-BarTip"，
#   没有检查"写进去的变量名和读出来的变量名是不是同一个"。
#   v0.9.6 补了一条断言专门守这个（见 test 的 7e 组）。
#
# 【v0.9.6 的做法：不再靠一个字符串变量传话，改成一份结构化快照】
#   气泡要显示的内容变多了（状态、任务明细、Token、谷时），
#   一个字符串装不下。所以改成一个 hashtable：
#     Phase      相位（approval/finished/running/idle）—— 决定圆点颜色
#     StatusText 状态头文案（和卡片标题同句式）
#     Tasks      任务明细数组（每项 Title / Elapsed）
#     Overflow   超出 3 行没显示的条数
#     Today      "今日 X Token"
#     Valley     "谷时 还剩/还有 X"
#   Update-UI 每 500ms 填一次，Show-BarTip 每次读它渲染。
#   两边用的是**同一个变量名** $script:barTipData，不会再错位。
$script:barTipData = [pscustomobject]@{
    Phase      = 'idle'
    StatusText = '空闲'
    Tasks      = @()
    Overflow   = 0
    Today      = ''
    Valley     = ''
}

# 悬停状态（必须 $script:，事件回调读不到局部变量）
$script:barTipVisible = $false

# 气泡当前显示的"内容指纹"。
#
# 【为什么需要它】
#   悬停期间鼠标每动一下都会调 Show-BarTip（柱子只有 14 宽，鼠标在上面移动很频繁）。
#   如果每次都重新 Measure + 重新定位，气泡会跟着鼠标抖。
#   记一个指纹，内容没变就只更新位置、不重排。
$script:barTipKey = ''

# ---------------------------------------------------------------- 光晕初值（修既有缺陷）
#
# 【为什么放在这里，而不是在建面板之前】
#   Set-TextShadowColor 遍历的是 $script:textShadowFx 这张登记表，
#   而表里的每一项都是 New-UiText 在建文字块时才填进去的。
#   上面 $exp / $mini 建完之前，这张表是空的 → 调用等于什么都没做。
#   放在这里（两块都建完之后）才真的把光晕摆正。
#
# 【修的是什么】
#   深色主题开机时 Update-AdaptiveText 的提前 return 会让改光晕那段永不执行，
#   于是浅色字一直配着白色光晕（方向反了）。这里按 curIsLight 先摆正一次。
#   之后仍然由 Update-AdaptiveText 正常维护，不改变它的逻辑。
#
#   回滚：删掉下面这一段即可（含 $script:shadowInit 的赋值处）。
if ($null -ne $script:shadowInit) {
    Set-TextShadowColor -Color $script:shadowInit
}

# ================================================================
# 【v0.10.4 修 BUG：用户报"打开 DSH 后，先闪一张左上角纯黑、大小一样的空卡片"】
#
# 【原来的写法是这一行】
#     $win.Show() | Out-Null
#
# 【为什么它是黑的 —— 四个"还没准备好"撞在一起】
#   ① 位置还没设：真正给 $win.Left/Top 赋值要等到第 4900 行附近
#      （实测：Show 到设位置之间隔了 **484 毫秒**）。
#      这期间窗口停在 Windows 的层叠默认位置（实测逻辑 253,253 = 屏幕左上），
#      而记忆位置是 2292,278.5 —— 差两千多像素，用户看到的正是"左上角"。
#   ② 内容是空的：$exp.Root / $mini.Root / $script:bar.Root 此刻**全部 Collapsed**，
#      窗口里一个可见元素都没有。
#   ③ 磨砂还没上：Update-Glass 要等进入消息循环之后（约第 6840 行的 BeginInvoke）。
#   ④ 而 AllowsTransparency=False 的窗口上，Background=Transparent **实际等于黑色**
#      （这条物理事实项目里已踩过三次，见 PanelVisual.ps1 的 New-BarTipPanel 注释）。
#   → 于是屏幕上出现一块 260×368 的纯黑矩形，半秒后才"化妆"成正常卡片。
#
# 【为什么会有"大小一样"这个细节】
#   因为 Width/Height 在第 1640 行就设好了（260×368），
#   所以黑块尺寸和真卡片一模一样 —— 用户才会误以为是"同规格的黑色卡片"。
#
# 【修法：Show() 挪到最后】
#   这里只建窗口句柄（EnsureHandle），**不显示窗口**；
#   等位置、高度、内容、磨砂全部就绪之后，在 $app.Run() 之前才真正 Show。
#   实测对比（同一份代码只改顺序）：
#     改前：Show 后第一帧 100% 纯黑 / 390x552（368 高，错的）/ 位置 380,380
#     改后：Show 后第一帧 0% 纯黑（玻璃）/ 390x228（152 高，对的）/ 位置 3390,645
#
# 【EnsureHandle 安全吗 —— 已实测】
#   · 未 Show 就能拿到 hwnd，后面 AsToolWindow / HwndSource / Corner / Border
#     这些 DWM 调用全部照常工作（Acrylic 返回 1 = 成功）
#   · 它**不会**把窗口变成分层窗口（WS_EX_LAYERED 全程为 False），磨砂不受影响
$winHelper = New-Object System.Windows.Interop.WindowInteropHelper($win)
$hwnd = $winHelper.EnsureHandle()
[PanelNative]::AsToolWindow($hwnd)

$hs = [System.Windows.Interop.HwndSource]::FromHwnd($hwnd)
$hs.CompositionTarget.BackgroundColor = [System.Windows.Media.Colors]::Transparent

[void][PanelNative]::Corner($hwnd, 2)          # 系统圆角

# ================================================================
# 【v0.9.13 修 BUG：这一行是"浅色背景下字不变黑"的元凶】
#
# 【原来写的是】
#     [void][PanelNative]::Border($hwnd, [int]0x00000001)
#
# 【它实际做了什么】
#   Border() 封装的是 DWM 属性 DWMWA_BORDER_COLOR (34)。
#   这个属性收的是**颜色值**（COLORREF，0x00BBGGRR），**不是一个开关**。
#   传 1 → COLORREF(0,0,1) → 一个几乎纯黑的颜色
#   → DWM 在窗口四周画了一圈**约 2 物理像素宽的纯黑边**。
#
#   这个坑第九批在**气泡窗口**上已经踩过并修掉了（见 Panel.ps1 第 2756 行
#   那段注释），当时实测：传 1 时有 2198 个黑色像素，改成 NONE 后是 0。
#   但主卡片这一行被漏掉了 —— 因为它看起来"只是一句初始化"，
#   而且主窗口圆角大、黑边在视觉上像"卡片描边"，不容易被认成 bug。
#
# 【它为什么会把文字颜色搞反 —— 这才是真正致命的地方】
#   Update-AdaptiveText 判断明暗的方式是：截下卡片自己的画面，
#   在**贴着边框的窄条**里取中位像素，反解出壁纸亮度。
#     采样带 bandIn = 3 逻辑px，bandOut = 13 逻辑px（见该函数的注释）
#   也就是说：它专门采"边框往里 3~13 像素"这一条。
#
#   而 DWM 画的那圈黑边正好压在 0~2 物理像素（= 0~1 逻辑像素）上，
#   再算上 DPI 取整和抗锯齿，实际会渗到 3~4 物理像素。
#   更要命的是它**不是纯黑**，而是抗锯齿后的深灰渐变，
#   于是采样带里混进了一批亮度接近 0 的像素。
#
#   实测（拿用户截图 402x222 逐像素跑产品算法）：
#     采样带位于 x∈[34,49)，把黑边算进去时中位像素被拉到 #6D6D7A 附近，
#     简单亮度约 110 → 按 0.186 阈值反解后判成"壁纸很暗"→ 用白字。
#     而实际玻璃是 #CBCAE1（简单亮度 204.9），本该用黑字。
#     —— 判据被那圈黑边骗了，算法本身完全正确。
#
# 【修法：和气泡窗口保持一致，用 DWMWA_COLOR_NONE】
#   合法值只有两个：
#     0xFFFFFFFE  DWMWA_COLOR_NONE      = 不要边框   ← 用这个
#     0xFFFFFFFF  DWMWA_COLOR_DEFAULT   = 跟系统走
#   卡片自己的圆角和描边由 WPF 的 Border($exp.Root) 负责画（$cFrame），
#   本来就不需要 DWM 再叠一圈。
#
#   【注意：不能直接删掉这一行】
#     属性 34 的默认值是 DEFAULT，意味着"跟系统主题走"。
#     系统深色主题下 Windows 会自动给窗口画一圈浅色边 —— 那同样会污染采样，
#     只是方向相反（把采样带刷白，导致该用白字时判成黑字）。
#     所以必须**显式设成 NONE**，而不是"不调这个接口"。
[void][PanelNative]::Border($hwnd, [int]0xFFFFFFFE)   # DWMWA_COLOR_NONE

[void][PanelNative]::DarkMode($hwnd, $(if ($isDark) { 1 } else { 0 }))

# ---------------------------------------------------------------- 柱态悬停气泡窗口（v0.9.5）
#
# 【创建时机为什么在这里】
#   主窗口已经 Show() 并拿到了 hwnd。气泡窗口要在主窗口之后创建，
#   这样它在 Z 序上天然位于主窗口之上（后创建的窗口在上面），
#   悬停时不需要为了"谁在上面"再做额外处理。
#
# 【为什么现在就建好、而不是每次悬停再建】
#   建窗口有成本（创建句柄、初始化渲染），悬停是高频操作。
#   建好之后只改 Visible 属性，代价几乎为零。
#   代价是启动时多一个隐藏窗口 —— 可忽略。
#
# 【这个窗口不会出现在任务栏、不会抢焦点、鼠标穿透】
#   四条都设了，理由见上面那段长注释。
# 【v0.9.6：宽度上限 190 -> 236】
#   190 是 v0.9.5 只有两行文字时定的。现在要放"任务标题 + 已跑时长"两列，
#   190 会让中文标题在 8 个字左右就被截断（"小程序试用账..."），信息价值大减。
#   236 能让 12 个中文字 + 右侧时长同时显示，同时不会宽到遮住工作区。
# 气泡自己的磨砂 tint（v0.9.6）
#
# 【为什么和卡片/柱子都用同一套色相、只是浓度不同】
#   色相统一（浅用 0x00FAF6F4 / 深用 0x001A1A1E）才能让三处看起来是同一套玻璃语言；
#   浓度各自不同，因为三处的使用场景不同：
#     卡片 0x50（80）—— 常驻，要淡
#     柱子 0xA0（160）—— 14 宽的小物件，太淡就看不见（本轮修的）
#     气泡 0xA0（160）—— 临时信息层，清晰优先
#
# 【为什么 0xA0 写在这里而不是从设置里读】
#   这是显示层的工程参数（不是用户偏好），跟着设计走。
#   用户能调的是卡片的 glassOpacity —— 那是"卡片要多透"，不该连带改变柱子和气泡。
# 【v0.9.8 修一个"字糊在玻璃上"的真 bug】
#
#   用户反馈："胶囊态的弹窗，文字显示不太对，感觉是糊的"
#
#   查到根因：**磨砂色和文字色用的不是同一个判断依据**
#     磨砂：if ($isDark)          ← 系统主题（注册表里的浅色/深色开关）
#     文字：Set-BarTipTheme -IsLight $script:curIsLight   ← 实测壁纸明暗
#
#   用户这台是"系统浅色主题 + 深色壁纸"：
#     磨砂 → isDark=false → 用**暖白** tint → 玻璃是**浅色**
#     文字 → curIsLight=false → 用**浅色**字
#   → 浅色字压在浅色玻璃上 = 糊。这不是"字渲染糊了"，是颜色配错了。
#
#   【修法：两者统一用 $script:curIsLight（实测壁纸）】
#     气泡是"临时弹出的信息层"，它开磨砂就是为了透出背景、
#     让文字和周围环境协调 —— 那就必须跟着**背景实际明暗**走，
#     而不是跟着一个和壁纸无关的系统开关走。
#
#   【初值仍按系统主题】
#     启动瞬间还没有实测数据（第一次 900ms 后才采到），
#     这时按系统主题给一个合理初值，实测后由
#     Update-BarThemeFromBackground 一起纠正（和柱态共用同一个入口）。
$script:BarTipGlassTint = if ($isDark) {
    ([long]0xA0 -shl 24) -bor 0x001A1A1E
} else {
    ([long]0xA0 -shl 24) -bor 0x00FAF6F4
}

# 【v0.9.8 气泡 tint 也要能跟着实测壁纸刷新】
#   和柱态同一个入口调用（Update-BarThemeFromBackground），
#   这样三处（柱子 / 气泡磨砂 / 气泡文字）用同一个依据，不会再错配。
function Update-BarTipGlassTint {
    param([bool]$IsLight)
    try {
        $newTint = if ($IsLight) {
            ([long]0xA0 -shl 24) -bor 0x00FAF6F4    # 壁纸亮 -> 暖白玻璃
        } else {
            ([long]0xA0 -shl 24) -bor 0x001A1A1E    # 壁纸暗 -> 深灰玻璃
        }
        if ($newTint -eq $script:BarTipGlassTint) { return }
        $script:BarTipGlassTint = $newTint
        # 立刻重新上磨砂（气泡窗口句柄存在时才做）
        if ($null -ne $script:barTipWin) {
            try {
                $th = (New-Object System.Windows.Interop.WindowInteropHelper($script:barTipWin)).Handle
                if ($th -ne [IntPtr]::Zero) {
                    [void][PanelNative]::Acrylic($th, $script:BarTipGlassTint, 0)
                }
            # 【故意静默】失败无害，下个周期会自动重试；记了会把日志刷爆
            } catch { }
        }
    # 【故意静默】失败无害，下个周期会自动重试；记了会把日志刷爆
    } catch { }
}

$script:barTipPanel = New-BarTipPanel -MaxWidth 236

$tipWin = New-Object System.Windows.Window
$tipWin.Title = 'DSH-BAR-TIP'
$tipWin.WindowStyle = 'None'
$tipWin.ResizeMode = 'NoResize'
# 【v0.9.14】跟随主窗口的置顶开关，不再写死 $true。
#   写死的话，用户关掉置顶后悬停柱子，会看到一个气泡**浮在所有窗口最上面**
#   —— 比主窗口还显眼，明显不对。
$tipWin.Topmost = [bool]$script:topmostEnabled
$tipWin.ShowInTaskbar = $false
# 【关键】不抢焦点：气泡弹出时不能把用户正在打的字打断
$tipWin.ShowActivated = $false
# 【关键】鼠标穿透：气泡盖在柱子旁边时不能挡住用户的点击
$tipWin.IsHitTestVisible = $false
# 和主窗口一样：AllowsTransparency=False 才能有正常合成（气泡不需要圆角以外的东西）
$tipWin.AllowsTransparency = $false
$tipWin.Background = [System.Windows.Media.Brushes]::Transparent
$tipWin.WindowStartupLocation = 'Manual'
# 尺寸先给个初值，Show-BarTip 里会按内容重算
$tipWin.Width = 200
$tipWin.Height = 60
$tipWin.Content = $script:barTipPanel.Root

try {
    # ================================================================
    # 【v0.10.4 修 BUG：气泡窗口是"第二块黑卡"，每次启动都在左上角闪一下】
    #
    # 【原来的写法是这两行】
    #     $tipWin.Show()          ← 直接显示
    #     ... 之后才 $tipWin.Hide()
    #
    # 【为什么它会闪】
    #   和主窗口一模一样的病：
    #     · 它也是 WindowStartupLocation='Manual' 却**从没设过 Left/Top**
    #       → 出现在屏幕左上的层叠位置
    #     · 它也是 AllowsTransparency=False + 透明底 → 合成出来是纯黑
    #     · 它还是 Topmost（第 3297 行）→ 浮在所有窗口之上，更显眼
    #   实测：从 Show 到 Hide 之间有 **286 毫秒**（15:45:58.481 → 15:45:58.902），
    #   这 286 毫秒里屏幕上就是一块 200×60 的纯黑小方块。
    #
    # 【为什么以前没人注意到】
    #   用户报的是"一张同规格的黑色卡片"，视线被主卡那一大块吸走了；
    #   这块 200×60 的小黑块在同一个角落，很容易被当成同一件事。
    #   **只修主卡不修它，改完还会看到小方块闪。**
    #
    # 【修法：搬到屏幕外显示】
    #   它必须真的 Show 一次（下面的 HwndSource / Acrylic 都要窗口真实存在才拿得到句柄），
    #   所以不能改成 EnsureHandle —— 但可以把它挪到屏幕外再显示。
    #   -20000 逻辑像素远超任何多屏布局（本机副屏在 -2560），屏幕外不会被画出来。
    #   之后真正需要显示时，Show-BarTip 会重新算 Left/Top，不受这两行影响。
    $tipWin.Left = -20000
    $tipWin.Top  = -20000
    $tipWin.Show()

    $tipHwnd = (New-Object System.Windows.Interop.WindowInteropHelper($tipWin)).Handle
    # 和主窗口同一套窗口样式：工具窗口（不进 Alt+Tab、不抢焦点）
    [PanelNative]::AsToolWindow($tipHwnd)

    # ================================================================
    # 【v0.9.9 修"弹窗文字发糊"的真 bug】
    #
    # 【用户的反馈】
    #   "弹出的小窗现在样式对了，但是字还是有点糊"
    #   （v0.9.8 已经修过一次"磨砂色和文字色判断依据不一致"，
    #     那次修完颜色配对了，但**字本身**还是糊的 —— 是另一个原因。）
    #
    # 【实测定位过程（_lab\probe-tip-cleartype.ps1，8 组对照）】
    #   逐像素统计"文字笔画里带彩色偏色的像素占比"：
    #     M1 窗口透明 + 不设 CompositionTarget  → 23.0%   ← 产品现状
    #     M3 窗口透明 + 设 CompositionTarget    →  0.3%   ← 修好了
    #     M8 M3 + 灰度抗锯齿                     →  0.3%
    #   23% 的笔画像素带红/蓝偏色，就是用户看到的"糊"。
    #   而主卡片**一直都有**这句话（见上面第 2195 行），弹窗漏了。
    #
    # 【为什么这一句能修好糊字】
    #   WPF 默认用 ClearType 子像素抗锯齿渲染文字：它假设"文字画在不透明底上"，
    #   于是把 R/G/B 三个子像素分别加权，边缘就会留红/蓝偏色。
    #   而我们的弹窗底色是 Transparent（靠 DWM 磨砂当玻璃）——
    #   子像素的偏色直接和半透明玻璃相乘，变成一层次色噪点，人眼就是"糊"。
    #   设 CompositionTarget.BackgroundColor = Transparent 等于告诉 WPF
    #   "这个窗口是透明的"，它就会自动退回灰度抗锯齿，偏色消失。
    #
    # 【代价】灰度抗锯齿比 ClearType 少一点点横向锐度。
    #   但 ClearType 的锐度在透明底上本来就是假的（偏色 = 噪点），
    #   换成干净的灰度边缘，肉眼反而更清楚。实测笔画"深芯占比"
    #   从 57% 涨到 72%（边缘过渡像素变少 = 更锐利）。
    $tipHs = [System.Windows.Interop.HwndSource]::FromHwnd($tipHwnd)
    $tipHs.CompositionTarget.BackgroundColor = [System.Windows.Media.Colors]::Transparent

    # ================================================================
    # 【v0.9.9 DWM 圆角也要一起关掉（2 -> 1 = DONOTROUND）】
    #
    #   弹窗面板已经改成直角（见 PanelVisual.ps1 的 New-BarTipPanel），
    #   如果这里还让 DWM 把**窗口**裁成圆角，就会出现新的错位：
    #     · DWM 按圆角裁窗口 → 圆角外的像素被裁掉
    #     · 但 WPF 面板是直角铺满的 → 它的四角也被一起裁掉
    #   逐像素实测（_lab\probe-tip-single.ps1，同一面板只改这一项）：
    #     Corner(2) ROUND       → 四角各有 12~15 个黑像素
    #     Corner(1) DONOTROUND  → 四角 25 个（更明显，因为窗口不再收圆）
    #   两种都不干净，原因是"窗口形状"和"面板形状"不一致就必然有缝。
    #   所以两边必须**一致地都是直角**：面板 0 圆角 + DWM DONOTROUND。
    #
    #   这也是柱态 v0.9.8 的结论在这里的复用：
    #     "形状 = 窗口矩形" 时，磨砂/底色和形状完全重合，棱角问题不存在。
    #
    #   实测改完之后四角纯黑像素 = 0（对比改之前每个角 12~15 个）。
    [void][PanelNative]::Corner($tipHwnd, 1)
    [void][PanelNative]::DarkMode($tipHwnd, $(if ($isDark) { 1 } else { 0 }))

    # ================================================================
    # 【v0.9.9 删掉一句"画黑边"的调用 —— 这就是用户说的"四周有黑边"】
    #
    # 【原来这里写的是】
    #     [void][PanelNative]::Border($tipHwnd, [int]0x00000001)
    #
    # 【为什么它是错的】
    #   Border 封装的是 DWM 属性 DWMWA_BORDER_COLOR (34)。
    #   这个属性的参数是**颜色值**（COLORREF，0x00BBGGRR），不是一个"开关"。
    #   传 1 = COLORREF(0,0,1) = 一个近乎纯黑的颜色
    #   → DWM 就在弹窗四周画了一圈**黑色**边框，叠在磨砂玻璃上。
    #   合法值只有两个：
    #     0xFFFFFFFE  DWMWA_COLOR_NONE      = 不要边框
    #     0xFFFFFFFF  DWMWA_COLOR_DEFAULT   = 跟系统走
    #
    # 【实测证据（_lab\probe-tip-border.ps1，6 组对照）】
    #   在深色底板上截屏，数"纯黑(<=12)像素"：
    #     传 0x00000001（现状）  → 全图 2198 个纯黑像素，集中在四角
    #     传 0xFFFFFFFE          → 0 个
    #     传 0xFFFFFFFF          → 0 个
    #     完全不调这一句          → 0 个
    #   用户截图里弹窗四角也是这个特征：圆角外侧一圈纯黑（0,0,0），
    #   而我们的描边色是 19% 白（压在浅玻璃上应该是 ~205 灰），不可能是黑。
    #
    # 【为什么选择"直接不调"，而不是改成 0xFFFFFFFE】
    #   弹窗已经有自己画的 1 像素半透明白描边（$tip.BorderBrush），
    #   不需要再有系统边框。少一次系统调用 = 少一个变量。
    #   卡片那边保留了自己的 Border 调用，那是另一处，本轮不动（见下条备注）。
    #
    # 【⚠️ 遗留 —— v0.9.13 已修，这条不再遗留】
    #
    #   原来这里写着"主卡片那处 `Border($hwnd, 1)` 同样的错误，用户没提，
    #   留到用户确认后再决定"。
    #
    #   事实证明这个"暂缓"的代价很大：那个错就是
    #   "浅色背景下卡片文字不变黑" 的根因（用户 2026-10-29 报）。
    #   原理：那圈黑边压在 Update-AdaptiveText 的采样带上
    #   （采样带 = 边框往里 3~13 逻辑像素），把中位像素拉暗，
    #   于是判成"背景暗 → 用白字"，而玻璃其实是亮的。
    #
    #   教训：**已知的、同类性质的缺陷，不要在另一个地方"暂缓"。**
    #   当时以为"被 WPF 边框盖住了一部分、用户没提"，实际上它
    #   换了另一种形式咬了用户（不是视觉上的黑边，而是字色判断错）。
    #
    #   现在三处统一：主窗口初始化 / RestoreDwmFrame / 气泡窗口
    #   全部使用 DWMWA_COLOR_NONE（或干脆不调）。

    # 【气泡也要磨砂】和卡片/柱子保持同一套玻璃语言
    #
    # 【v0.9.6：气泡的 tint 独立用 0xA0，不再复用卡片的 0x50】
    #   子代理实测：0x50 在浅色最暗档上，气泡正文 #333B46 只有 4.30、
    #   弱文字 #5F6977 只有 3.03 —— 读不清。而气泡里有三档更弱的字
    #   （任务时长 / 底部指标 / 操作提示），比卡片更需要稳的底。
    #
    #   为什么气泡可以比卡片浓：卡片要"淡淡地浮在桌面上"（260 宽大面积，0x50 够），
    #   气泡是**临时弹出的信息层**，用户只在悬停那几秒看它，
    #   清晰度优先于通透感。而且气泡面积小（236 宽），浓一点不会显得闷。
    #
    #   实测 0xA0 下：正文 7.60 / 弱文字 4.71（配 #48525C）—— 都过 4.5。
    $tipTint = $script:BarTipGlassTint
    [void][PanelNative]::Acrylic($tipHwnd, $tipTint, 0)

    $tipWin.Hide()
    $script:barTipWin = $tipWin
} catch {
    # 气泡建不起来不能影响主功能 —— 柱子照样能拖能点，只是没提示
    Log-Card ('柱态气泡窗口创建失败（不影响主功能）: ' + $_.Exception.Message)
    $script:barTipWin = $null
}

# 磨砂要在窗口尺寸稳定后反复刷，改尺寸会把 DWM 的状态冲掉
#
# 【v0.9.0：柱态关掉磨砂】
#   实测（_lab\probe-bar-look.ps1，四张对比图 bar-A/B/C/D）：
#     · 磨砂开着 → 14 宽窗口被渲染成"实心深色药丸"，
#       整根柱子染成状态色也看不出来（玻璃底压过了颜色）
#     · 关掉磨砂（AccentState = 0）→ 柱子是纯净的深色胶囊 + 亮色条，
#       状态一眼可辨，而且圆角处没有黑边/白边
#   所以柱态走 ClearAcrylic 分支。
#
# 【为什么不干脆把窗口 Background 设成柱子底色然后也不清磨砂】
#   v0.9.0 时试过（bar-D 对比图）：D 和 C 的截图**完全一样**，
#   因为柱子面板盖住了整个窗口，窗口背景根本不显示。
#   所以当时结论是"没必要动 $win.Background"。
#
# 【v0.9.5 重大修正：柱态改为"开磨砂"】
#   用户明确要求："现在的胶囊并不能像悬浮卡片一样透过胶囊看到背后模糊的颜色"。
#
#   【为什么要推翻 v0.9.0 的旧结论】
#   旧注释（原来这里写的）说的是：
#     "磨砂开着 → 14 宽窗口被渲染成实心深色药丸，整根柱子染成状态色也看不出来"
#   那次实验（v0.9.0）的条件是：【永远深色柱底 + 粗条 8 宽 + 整根染状态色】。
#   那时候柱子整个是一块深色玻璃，磨砂一开就把状态色压没了 —— 结论在当时是对的。
#
#   但现在（v0.9.4 之后）条件全变了：
#     · 柱底跟随壁纸明暗（浅 #E8E2DF / 深 #1C1C1F），不再是死黑
#     · 色条收细到 6（只占 43%），边缘留出了"玻璃边距"
#     · 窗口做了 SetWindowRgn 胶囊裁剪
#   所以"磨砂会吃掉状态色"这个结论**不再成立**：色条是独立的不透明色块，
#   磨砂只作用在它周围的玻璃区域，不会染色条本身。
#   用户也在真机上确认了"卡片能透出背后模糊的壁纸"，说明磨砂机制本身是好的。
#
#   【为什么柱态现在要 Transparent 窗口底色】
#   磨砂要透出背景，窗口底色必须是透明的。v0.9.3 我把底色设成胶囊色是为了
#   盖住"半像素缝露黑底"——但那是在**没有圆角裁剪**的前提下才需要的。
#   v0.9.4 加了 SetWindowRgn 之后，窗口形状已经被裁成胶囊，
#   不存在"矩形底色露出四角"的问题了，所以可以安全地回到 Transparent。
#   （保留一个极淡的 tint 让玻璃有一点存在感，见 $script:BarGlassTint）

# ---------------------------------------------------------------- 柱态悬停气泡：显示/隐藏（v0.9.6 重写）
#
# 【为什么位置要动态算，不能写死】
#   柱子会贴左边缘也会贴右边缘（拖动决定）。气泡必须放在**屏幕内侧**，
#   否则贴右边缘时气泡会跑到屏幕外看不见。
#
# 【尺寸为什么要 Show 之后再量】
#   WPF 的 ActualWidth/ActualHeight 只有布局跑完之后才有值。
#   先把窗口 Show 出来（此时 Width 给了初值）、让 WPF 量一次，
#   再按量到的尺寸重新定位。这段很关键 —— 直接按 Width 属性定位会因为
#   文字换行导致实际高度比初值大，气泡会和柱子错位。
#
# 【v0.9.6 为什么整个重写（三件事）】
#   ① 【真 bug】旧版读的是 $script:barTipText，而那个变量**从来没被赋过值**。
#      Update-UI 里写的是 barStatus**Text** —— 两个名字差一个词。
#      于是 Show-BarTip 每次都被喂空字符串，函数里的"空就兜底成'空闲'"
#      就把它变成了字面意义上的"永远空闲"，不管实际在跑几个任务。
#      （这个 bug 测试没抓到，因为旧测试只检查"有没有这两个函数"，
#        没检查"写进去的名字和读出来的名字是不是同一个"。v0.9.6 补了断言。）
#      现在改成读结构化快照 $script:barTipData，两边用同一个名字。
#   ② 旧版只显示一行状态文字，用户评价"很简陋"。
#      现在渲染：状态头（圆点+文案）+ 最多 3 行任务明细 + 今日 Token/谷时 + 操作提示。
#   ③ 旧版每次调用都把宽度设成 NaN 再 Show + UpdateLayout 重新量一遍。
#      悬停期间鼠标动一下就跑一次，内容明明没变也重排 —— 会闪、会抖。
#      现在用内容指纹 $script:barTipKey 挡掉无意义的重排。

# 把 $script:barTipData 渲染进气泡控件（只改文字，不重建控件）
#
# 【为什么只改文字、不重建控件】
#   气泡窗口是常驻的（进柱态前就建好，见上面的"创建时机"注释）。
#   重建控件会让窗口先塌成 0 尺寸再撑开，悬停时肉眼能看到一下闪。
#   而 Update-UI 每 500ms 就会刷新数据，所以这条路径必须足够便宜。
function Update-BarTipContent {
    if ($null -eq $script:barTipPanel) { return }
    $p = $script:barTipPanel
    $d = $script:barTipData
    if ($null -eq $d) { return }

    # ---- ① 状态提示行：**只有非 running 才显示**
    #
    # 【v0.9.8 用户要求："不需要上面的正在运行"】
    #   柱子本身就是"有活干"才出现的形态，写"正在运行"等于重复前提。
    #   但"待审批"和"已完成"是**和平时不一样**的状态 ——
    #   用户看到柱子变色了，需要知道为什么，所以这两种保留一句提示。
    # 【v0.10.8 · C2】健康提示优先级高于普通相位文案。
    #
    # 【为什么要有这一层】
    #   原来只有"非 running 且有 StatusText"才显示状态行。
    #   但"拿不到数据"这件事在 running 时同样可能发生
    #   （插件卡住、文件坏了，而卡片还记着上次的 running 数字）。
    #   这时候如果因为 Phase=running 就把状态行藏起来，
    #   用户看到的就是"2 个任务运行中"——一个已经过期的假象。
    #
    #   missing / readError / invalidJson 三种属于"根本读不到"，
    #   必须强行把状态行显示出来，文案用 HealthMsg（"数据未更新"）。
    #
    #   stale 不强行显示：数据是真的，只是旧了。柱态本来就是"专注模式"，
    #   顶部多一行提示反而干扰。卡片那边已经用底部轻提示覆盖了。
    $healthKind = ''
    try { $healthKind = [string]$d.HealthKind } catch { $healthKind = '' }
    $healthBroken = ($healthKind -eq 'missing') -or ($healthKind -eq 'readError') -or ($healthKind -eq 'invalidJson')

    $statusText = [string]$d.StatusText
    if ($healthBroken) {
        $statusText = [string]$d.HealthMsg
        if ([string]::IsNullOrWhiteSpace($statusText)) { $statusText = '数据未更新' }
    }

    $showStatus = ($d.Phase -ne 'running' -or $healthBroken) -and (-not [string]::IsNullOrEmpty($statusText))
    if ($showStatus) {
        # 【v0.10.8 · C2】用上面算好的 $statusText ——
        #   它可能是普通相位文案，也可能是健康提示（"数据未更新"）。
        $p.Title.Text = $statusText
        $p.StatusRow.Visibility = 'Visible'
        $p.Sep1.Visibility = 'Visible'
        try {
            $dc = Get-StateColor -Phase $d.Phase -Slot 'Dot'
            if ($null -ne $dc) {
                if ($null -eq $p.Dot.Fill) { $p.Dot.Fill = New-Brush $dc }
                else { $p.Dot.Fill.Color = $dc }
            }
            # 【v0.9.10】状态行的点也要跟着呼吸规则走。
            #   注意这里传的是 $d.Phase —— 因为状态行只在非 running 时出现，
            #   所以实际上这行永远是"关闭呼吸"。写出来是为了防御：
            #   万一以后产品改成 running 也显示状态行，这里会自动正确。
            Set-DotsBreathingForPhase -Dots @($p.Dot) -Phase $d.Phase
        } catch { Log-Fail 'L3397' $_ -Key 'L3397' }
    }
    else {
        $p.StatusRow.Visibility = 'Collapsed'
        # 没有状态提示行时，分隔线也藏起来（否则顶部会有一条莫名的横线）
        $p.Sep1.Visibility = 'Collapsed'
    }

    # ---- ② 任务明细（最多 4 行，超出折叠成一行）
    #
    # 【v0.9.7：每行改成"状态点 + 任务名"，不再显示时长】
    #   见 New-BarTipPanel 里的说明。这里只负责把数据填进控件。
    $list = @($d.Tasks)
    $shown = 0
    for ($i = 0; $i -lt $p.Rows.Count; $i++) {
        $r = $p.Rows[$i]
        if ($i -lt $list.Count) {
            $task = $list[$i]
            $r.Name.Text = [string]$task.Title

            # ---- 已跑时长（v0.9.10 新增）
            #
            # 【显示规则】
            #   有数值 → "45秒" / "12分" / "1小时5分"（Format-Elapsed，和卡片同一套）
            #   没有值 → 整个时长列留空（不是显示 "0秒"）
            #
            # 【为什么"没有值"要留空而不是显示 0秒】
            #   "0秒"看起来像"刚开始跑"，但更可能的情况是"这条数据本身没有时长"
            #   （比如待审批的条目、插件旧版本没输出 elapsedSec）。
            #   留空是诚实的；编一个 0 出来会误导用户。
            #   空字符串 + Auto 列宽 = 这一列自动塌成 0 宽，不占位置。
            $elapsedVal = 0.0
            $hasElapsed = $false
            try {
                if ($null -ne $task.PSObject.Properties['Elapsed'] -and $null -ne $task.Elapsed) {
                    $elapsedVal = [double]$task.Elapsed
                    $hasElapsed = ($elapsedVal -gt 0)
                }
            } catch { $hasElapsed = $false }

            if ($hasElapsed) {
                $r.Time.Text = Format-Elapsed $elapsedVal
                $r.Time.Visibility = 'Visible'
            }
            else {
                $r.Time.Text = ''
                $r.Time.Visibility = 'Visible'   # 仍可见，只是文本为空 → 宽度自动为 0
            }

            # 状态点颜色：用相位色板（和卡片圆点同一套色）
            #   【为什么每行单独取色而不是整块一个色】
            #     待审批的任务和运行中的任务同时存在时，用户需要一眼分出哪条要管。
            #     整块一个色的话，红色圆点会误导成"每条都在等审批"。
            try {
                $rowPhase = [string]$task.Phase
                if ([string]::IsNullOrEmpty($rowPhase)) { $rowPhase = $d.Phase }
                $dc = Get-StateColor -Phase $rowPhase -Slot 'Dot'
                if ($null -ne $dc) {
                    if ($null -eq $r.Dot.Fill) { $r.Dot.Fill = New-Brush $dc }
                    else { $r.Dot.Fill.Color = $dc }
                }
                # 【v0.9.10】每个任务点按**它自己的相位**决定要不要呼吸。
                #   这一行是本轮"呼吸"功能的核心价值所在：
                #     弹窗里同时有"运行中的任务"和"待审批的任务"时，
                #     只有运行中那个点在呼吸 —— 用户不用读文字就知道哪个还在动。
                Set-DotsBreathingForPhase -Dots @($r.Dot) -Phase $rowPhase
            } catch { Log-Fail 'L3463' $_ }
            $r.Root.Visibility = 'Visible'
            $shown++
        }
        else {
            $r.Root.Visibility = 'Collapsed'
            # 【v0.9.10】收起来的那几行必须停掉呼吸。
            #   为什么：弹窗是常驻隐藏窗口，4 行控件全都预建好了。
            #   如果收起的行还在跑动画，WPF 会为它们持续计算关键帧 ——
            #   哪怕窗口不可见也照算（动画时钟不认 Visibility）。
            #   4 个点 × 一天 = 白烧 CPU。停掉之后行重新出现时会重新开。
            Set-DotsBreathingForPhase -Dots @($r.Dot) -Phase 'idle'
        }
    }

    # 【为什么要单独一行"还有 N 个"】
    #   气泡只有 3 行，超出来的必须给个出口，否则用户以为只跑了 3 个。
    if ($shown -gt 0 -and [int]$d.Overflow -gt 0) {
        $p.More.Text = ('还有 {0} 个任务' -f $d.Overflow)
        $p.More.Visibility = 'Visible'
    }
    else {
        $p.More.Visibility = 'Collapsed'
    }

    # 【分隔线 1 的可见性 —— v0.9.8 修一个"两条规则打架"的 bug】
    #
    #   现在控制 Sep1 的地方有两处：
    #     ① 上面状态提示行那段：非 running 且有文案 → Visible，否则 Collapsed
    #     ② 这里（原来）：有任务行 → Visible
    #   两处都写就会互相覆盖 —— 后执行的赢。
    #   实测表现：running 状态下状态行是隐藏的，但这条把它又设成 Visible，
    #   于是弹窗顶部出现一条**孤零零的横线**（上方什么都没有）。
    #
    #   正确规则（只有一条）：
    #     分隔线的存在意义是"把上面的状态提示行和下面的任务列表分开"，
    #     所以它应该 **跟着状态提示行走**，而不是跟着任务行数走。
    #     没有状态提示行 → 没有东西可分隔 → 不画线。
    #
    #   所以这里删掉原来的赋值，只保留 ① 那一处的决定。
    #   （保留这段注释是为了让下一个人知道为什么这里"什么都不做"。）

    # 【v0.9.7 已删除底部指标渲染】
    #   Token / 谷时不再进弹窗（用户要求简略，且展开卡片里已有）。
    #   New-BarTipPanel 也不再返回 FootLeft/FootRight/Sep2 这三个控件。
}

# 算出"当前要显示的内容指纹"。指纹不变就不重排。
function Get-BarTipKey {
    $d = $script:barTipData
    if ($null -eq $d) { return '' }
    $parts = New-Object System.Collections.ArrayList
    [void]$parts.Add([string]$d.Phase)
    [void]$parts.Add([string]$d.StatusText)
    [void]$parts.Add([string]$d.Overflow)
    # 【v0.9.7 指纹去掉 Today/Valley】
    #   它们不再显示，放进指纹会导致"Token 变了就重排一次"的无谓抖动。
    #   现在只指纹"看得见的东西"：相位、状态文案、溢出数、每行标题和相位。
    #
    # 【v0.9.10 时长**故意不进指纹**】
    #   这是本轮最容易做错的一个决定，写清楚原因：
    #     看起来"时长变了就该重排"很合理 —— 但时长**每秒都在变**。
    #     指纹里带上它 = 悬停期间每秒重排一次窗口 = 持续抖动 + 每秒重新 Measure。
    #   那不写进去，时长文字变了怎么办？
    #     Update-BarTipContent 会把新文字写进 TextBlock，TextBlock 自己会重绘；
    #     只有**窗口尺寸**需要跟着变（Auto 列宽变了）。
    #     但弹窗宽度已经由 MaxWidth 236 兜住，且任务名是 CharacterEllipsis 截断的，
    #     时长从 "9秒" 变 "10分" 只多 1~2 个字符宽（约 12px），
    #     在 Star 列里会被任务名的可用宽度吸收 —— **窗口不需要跟着变宽**。
    #   所以：文字实时更新（便宜），窗口尺寸稳定（不抖）。
    #   实测代价：任务名会随时长变长而少显示 1 个字。这个取舍是划算的。
    foreach ($t in @($d.Tasks)) {
        [void]$parts.Add(([string]$t.Title) + '|' + [string]$t.Phase)
    }
    # 用  当分隔符：它是控制字符，不可能出现在任务标题里
    return ($parts -join ([char]1))
}

function Show-BarTip {
    if ($null -eq $script:barTipWin) { return }
    if ($script:mode -ne 'bar') { return }

    try {
        # ---- 内容：变了才重排
        $key = Get-BarTipKey
        $needRelayout = ($key -ne $script:barTipKey)

        if ($needRelayout) {
            Update-BarTipContent
            # 气泡开磨砂、透出背景，文字色必须跟着明暗反色
            try { Set-BarTipTheme -IsLight ([bool]$script:curIsLight) } catch { }
            $script:barTipKey = $key
            # 宽度/高度设 Auto，让内容自己决定（短内容不会撑满 MaxWidth）
            $script:barTipWin.Width  = [double]::NaN
            $script:barTipWin.Height = [double]::NaN
        }

        if (-not $script:barTipVisible -or $needRelayout) {
            # 先显示一帧以便量到真实尺寸（位置此时不对，但马上会改）
            $script:barTipWin.Show()
            $script:barTipWin.UpdateLayout()
        }

        $tw = $script:barTipWin.ActualWidth
        $th = $script:barTipWin.ActualHeight
        if ($tw -le 0) { $tw = 220 }
        if ($th -le 0) { $th = 80 }

        $wa = Get-WorkArea
        $barLeft = [double]$win.Left
        $barTop  = [double]$win.Top
        $barW    = [double]$win.Width
        $barH    = [double]$win.Height

        # 气泡垂直居中对着柱子
        $tipTop = $barTop + ($barH - $th) / 2

        # 【水平方向】
        #   柱子贴右边缘 → 气泡放它左边
        #   柱子贴左边缘 → 气泡放它右边
        #   中间（拖动中）→ 也放右边，避免盖住下次点击
        $gap = 8
        $centerX = $barLeft + ($barW / 2)
        $midX = $wa.Left + ($wa.Width / 2)

        if ($centerX -ge $midX) {
            $tipLeft = $barLeft - $tw - $gap
        } else {
            $tipLeft = $barLeft + $barW + $gap
        }

        # 夹到工作区内（气泡比屏幕宽这种极端情况也不会跑出去）
        if ($tipLeft -lt $wa.Left) { $tipLeft = $wa.Left + $gap }
        if (($tipLeft + $tw) -gt $wa.Right) { $tipLeft = $wa.Right - $tw - $gap }
        if ($tipTop -lt $wa.Top) { $tipTop = $wa.Top + $gap }
        if (($tipTop + $th) -gt $wa.Bottom) { $tipTop = $wa.Bottom - $th - $gap }

        $script:barTipWin.Left = $tipLeft
        $script:barTipWin.Top  = $tipTop
        $script:barTipVisible = $true
    } catch {
        Log-Card ('显示柱态气泡失败（已忽略）: ' + $_.Exception.Message)
        try { $script:barTipWin.Hide() } catch { }
        $script:barTipVisible = $false
    }
}

function Hide-BarTip {
    try {
        if ($null -ne $script:barTipWin -and $script:barTipVisible) {
            $script:barTipWin.Hide()
        }
    } catch { Log-Fail 'L3615' $_ }
    $script:barTipVisible = $false
    # 收起时清掉指纹：下次悬停即使内容完全一样，也要重新量一次尺寸
    # （窗口是 Hide 状态，尺寸可能已经因为 Show 时的 Auto 而被重置）
    $script:barTipKey = ''
}

function Update-Glass {
    try {
        if ($script:mode -eq 'bar') {
            # 柱态：开磨砂，让胶囊透出背后的模糊壁纸
            #
            # 【为什么 tint 的透明度比卡片低】
            #   卡片是 260 宽的窗口，玻璃面积大，0x50 的 tint 能撑住。
            #   柱子只有 14 宽，同样的 tint 会显得"雾很重"、看不见背景。
            #   v0.9.6 已把浓度提到 0xA0（0x20 太透导致"柱态可视性不佳"），
            #   具体理由见 $BarGlassAlpha 那段长注释。
            #   AccentFlags 必须传 0 —— 传 2 会变成整块纯白底（老坑）。
            try {
                [void][PanelNative]::Acrylic($hwnd, $script:BarGlassTint, 0)
            # 【故意静默】失败无害，下个周期会自动重试；记了会把日志刷爆
            } catch { }
            # 窗口底色必须透明，否则磨砂底下垫了一层实色，什么也透不出来
            try { $win.Background = [System.Windows.Media.Brushes]::Transparent } catch { }
            # 胶囊底也要透，才能看到磨砂
            if ($null -ne $script:bar) {
                try {
                    $script:bar.Backdrop.Background = [System.Windows.Media.Brushes]::Transparent
                # 【故意静默】失败无害，下个周期会自动重试；记了会把日志刷爆
                } catch { }
            }
            return
        }
        # 回到展开/扁条态：底色必须回到透明，否则磨砂底下垫了一层实色，观感全变
        try { $win.Background = [System.Windows.Media.Brushes]::Transparent } catch { }
        # 恢复胶囊底的实色（柱态把它设成透明了，退出时要还原）
        if ($null -ne $script:bar -and $null -ne $script:BarBackdrop) {
            try {
                $barBg = if ($script:curIsLight) { $script:BarBackdrop.Light } else { $script:BarBackdrop.Dark }
                $script:bar.Backdrop.Background = New-Brush $barBg
            # 【故意静默】失败无害，下个周期会自动重试；记了会把日志刷爆
            } catch { }
        }
        # AccentFlags 传 0，绝对不能是 2（填 2 会变成整块纯白底）
        [void][PanelNative]::Acrylic($hwnd, $script:cTint, 0)
    # 【故意静默】失败无害，下个周期会自动重试；记了会把日志刷爆
    } catch { }
}

# 【v0.9.6：这一行原来是 `$script:cTint = $cTint`，已删除 —— 它会打架】
#
#   $cTint 是上面 1218/1226 行按**系统主题**（$isDark）算出来的初值。
#   而 v0.9.6 之后 $script:cTint 的最终值由 Update-CardTintFromPolarity
#   按**实测壁纸明暗**决定（见那个函数的注释）。
#   如果这里再把系统主题那份赋回去，就会在启动时覆盖掉正确值；
#   更糟的是它每帧都会被重新执行一次（这段代码在脚本主流程里），
#   等于把"跟随壁纸"永久锁死成"跟随系统主题"。
#
#   $script:cTint 的初值现在只在两处产生：
#     ① 501 行：热更新浓度时（那里已经改成保留当前极性）
#     ② Update-CardTintFromPolarity：实测后按壁纸明暗切换
#   启动时若还没实测过，$script:cTint 由 501 行附近那个赋值给的初值兜底。

# ---------------------------------------------------------------- 位置
# 工作区（可用桌面区域，不含任务栏）
#
# ⚠️⚠️ 【单位：逻辑像素（DIP），不是物理像素】—— 这条搞错会让柱态判据永远失效
#
#   实测（_lab\probe-dpi-units.ps1，本机 200% 缩放）：
#     WPF   SystemParameters.WorkArea          = 1600 × 952   ← 逻辑
#     WinForms Screen.PrimaryScreen.WorkingArea = 3200 × 1904  ← 物理
#     两者比值 = 2 = 缩放比
#
#   所以：
#     · $win.Left / $win.Width（WPF，逻辑）↔ 本函数返回值 → **直接可比，不用换算**
#     · [Windows.Forms.Cursor]::Position（物理）↔ 本函数返回值 → **必须 ÷scale**
#   现有吸边逻辑（用 $win.Left 和本函数比）一直是逻辑↔逻辑，天然正确，不用动。
#
# ⚠️ 【已知限制：只返回主显示器】
#   多显示器时，卡片拖到副屏上会被 Clamp-Position 拉回主屏。
#   这是**既有缺陷**（不是柱态引入的），本轮不修。
#   要修的话改用：
#     [Windows.Forms.Screen]::FromPoint(...).WorkingArea 再 ÷scale 换回逻辑
#   本机单显示器，所以现在没影响。
function Get-WorkArea {
    return [System.Windows.SystemParameters]::WorkArea
}

# 当前 DPI 缩放比（物理 / 逻辑）
#
# 【为什么要动态算，不硬编码 2.0】
#   用户换显示器、改缩放、或笔记本插拔外接屏，缩放比都会变。
#   硬编码 2.0 在 100% 缩放的机器上会让"顶住"判据宽 2 倍（2 逻辑变 4 逻辑），
#   在 150% 机器上偏窄。
#
# 【为什么不每帧算】
#   要读窗口物理矩形，有一次 P/Invoke。柱态判据只在"松手"和"进柱态"时用，
#   频率极低，每次算也无所谓。但 $glassWatch 每 900ms 要用它，
#   所以缓存起来，尺寸变化时重算。
#
# 【算法】拿一个已知逻辑宽度的窗口，量它物理宽度，比值就是缩放。
#   注意：必须在**窗口尺寸已知且稳定**的时候调（进柱态前窗口是正常宽度）。
function Get-DpiScale {
    try {
        if ($win.Width -gt 0) {
            $rr = New-Object PanelNative+RECT
            if ([PanelNative]::GetWindowRect($hwnd, [ref]$rr)) {
                $physW = $rr.Right - $rr.Left
                if ($physW -gt 0) {
                    return ($physW / [double]$win.Width)
                }
            }
        }
    # 【故意静默】失败无害，下个周期会自动重试；记了会把日志刷爆
    } catch { }
    return 1.0
}

# 缩放比缓存。空值 = 还没算过。
# 【为什么不能用 0 当"未初始化"标记】0 会让下面的除法变成 Infinity。
$script:dpiScale = $null

$startLeft = $null
$startTop = $null
if (Test-Path $PosPath) {
    try {
        $p = Get-Content $PosPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $startLeft = [double](Get-Setting $p 'left' $null)
        $startTop  = [double](Get-Setting $p 'top' $null)
    # 【故意静默】失败无害，下个周期会自动重试；记了会把日志刷爆
    } catch { }
}

$work = Get-WorkArea

function Clamp-Position {
    $w = Get-WorkArea
    if ($win.Left + $win.Width -gt $w.Right) { $win.Left = $w.Right - $win.Width - 4 }
    if ($win.Left -lt $w.Left) { $win.Left = $w.Left + 4 }
    if ($win.Top + $win.Height -gt $w.Bottom) { $win.Top = $w.Bottom - $win.Height - 4 }
    if ($win.Top -lt $w.Top) { $win.Top = $w.Top + 4 }
}

# ---------------------------------------------------------------- 原子写文件（v0.10.13 · D1）
#
# 【这个函数解决什么】
#   原来 Panel.ps1 里写 JSON 用的是：
#       [System.IO.File]::WriteAllText($path, $json, ...)
#   直接覆盖正式文件。写到一半崩溃/断电 → 留下半截坏 JSON。
#
#   panel-pos.json 坏了 → 卡片位置丢失，回到默认位置（用户会觉得"卡片乱跑"）。
#   settings.json 坏了（写置顶时）→ 整个外观设置全丢。
#
# 【怎么改】
#   写到一个**独一无二**的临时文件，再替换正式文件。
#   临时名带 PID，两个进程同时写也不会撞（原来 PowerShell 这边没有共用名问题，
#   但同一进程内如果并发调用仍可能撞，加 PID + 随机串更稳）。
#
# 【Windows 上的替换细节】
#   [System.IO.File]::Move($tmp, $dst, $true) —— 三参数的 Move（带 overwrite）
#   **PowerShell 5.1 / .NET Framework 不支持**，会抛异常。
#   （项目里已有踩坑记录：bar-mode.mjs 专门有一条断言守这个）
#
#   所以这里用两步：
#     ① 优先试 [System.IO.File]::Replace（原子替换，但要求目标存在）
#     ② 目标不存在 或 Replace 失败 → 退化为 Move 覆盖
#
#   Replace 是 .NET 提供的原子替换 API，比"先删再移"安全得多：
#   它在替换成功之前不会让目标消失。
# ---------------------------------------------------------------- 跨进程写锁（v0.10.14 · D1 第二步）
#
# 【为什么需要】
#   卡片（本文件）和设置窗口（Settings.ps1）是**两个独立进程**，
#   都会写 settings.json，而且**都用固定的 `settings.json.tmp`**。
#   两个同时保存时，后写的会覆盖前一个的临时文件 ——
#   最终内容可能来自"半次卡片 + 半次设置窗口"，而且不报错。
#
# 【怎么保证互斥】
#   用 ".lock" 文件 + FileMode::CreateNew（O_CREAT | O_EXCL 语义）：
#   文件已存在就抛异常，两个进程不可能同时创建成功。
#
# 【怎么防死锁】
#   持锁进程被强杀时锁文件会留在磁盘上。所以：
#     · 锁文件里记 pid / 时间 / nonce
#     · 超过 $LockStaleMs（10 秒）没更新 → 认为持有者已死，可以接管
#     · 抢锁总超时 $LockTimeoutMs（2 秒）→ 抢不到就放弃，不无限等
#
# 【为什么能接管"坏锁文件"】
#   如果内容读不出来，退回用文件 mtime 判断。任一证据显示够旧就接管，
#   否则可能永久卡死（比"偶尔多写一次"严重得多）。

$script:LockTimeoutMs = 2000
$script:LockStaleMs = 10000
$script:LockPollMs = 50

function Get-LockPath {
    param([string]$Path)
    return $Path + '.lock'
}

function Read-LockInfo {
    param([string]$LockPath)
    try {
        $txt = [System.IO.File]::ReadAllText($LockPath)
        if ([string]::IsNullOrWhiteSpace($txt)) { return $null }
        $j = $txt | ConvertFrom-Json
        if ($null -eq $j) { return $null }
        return $j
    } catch {
        return $null
    }
}

function Test-LockStale {
    param([string]$LockPath)
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $info = Read-LockInfo -LockPath $LockPath

    if ($null -ne $info -and $null -ne $info.at) {
        try {
            $age = $now - [double]$info.at
            if ($age -ge $script:LockStaleMs) {
                return [pscustomobject]@{ Stale = $true; Reason = ('锁已存在 {0} 秒' -f [math]::Round($age / 1000)) }
            }
            return [pscustomobject]@{ Stale = $false; Reason = ('锁还很新（{0} 秒）' -f [math]::Round($age / 1000)) }
        } catch { }
    }

    # 内容坏了 → 退回 mtime
    try {
        $mtime = [System.IO.File]::GetLastWriteTimeUtc($LockPath)
        $age = ([DateTime]::UtcNow - $mtime).TotalMilliseconds
        if ($age -ge $script:LockStaleMs) {
            return [pscustomobject]@{ Stale = $true; Reason = ('锁文件 mtime 已是 {0} 秒前' -f [math]::Round($age / 1000)) }
        }
        return [pscustomobject]@{ Stale = $false; Reason = ('锁文件 mtime 还新（{0} 秒）' -f [math]::Round($age / 1000)) }
    } catch {
        return [pscustomobject]@{ Stale = $true; Reason = '锁文件读不到' }
    }
}

function Try-AcquireLockOnce {
    param([string]$Path)

    $lockPath = Get-LockPath -Path $Path
    $nonce = [System.Guid]::NewGuid().ToString('N')
    $info = [ordered]@{
        pid = $PID
        at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        nonce = $nonce
        target = [System.IO.Path]::GetFileName($Path)
    }

    try {
        # CreateNew = 文件已存在就抛，这是唯一的原子性依赖
        $fs = [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes(($info | ConvertTo-Json -Compress))
            $fs.Write($jsonBytes, 0, $jsonBytes.Length)
            $fs.Flush()
        }
        finally { $fs.Dispose() }

        return [pscustomobject]@{ Ok = $true; LockPath = $lockPath; Nonce = $nonce; Reason = '获取成功' }
    }
    catch {
        # 已存在 → 看看是否过期
        if (Test-Path $lockPath) {
            $st = Test-LockStale -LockPath $lockPath
            if ($st.Stale) {
                # 接管：先删再抢（抢那一步仍是原子的）
                try { [System.IO.File]::Delete($lockPath) } catch { }
                try {
                    $fs2 = [System.IO.File]::Open(
                        $lockPath,
                        [System.IO.FileMode]::CreateNew,
                        [System.IO.FileAccess]::Write,
                        [System.IO.FileShare]::None
                    )
                    try {
                        $jsonBytes2 = [System.Text.Encoding]::UTF8.GetBytes(($info | ConvertTo-Json -Compress))
                        $fs2.Write($jsonBytes2, 0, $jsonBytes2.Length)
                        $fs2.Flush()
                    }
                    finally { $fs2.Dispose() }
                    return [pscustomobject]@{ Ok = $true; LockPath = $lockPath; Nonce = $nonce; Reason = ('接管过期锁：' + $st.Reason) }
                }
                catch {
                    return [pscustomobject]@{ Ok = $false; LockPath = $lockPath; Nonce = ''; Reason = '接管时被抢先' }
                }
            }
            return [pscustomobject]@{ Ok = $false; LockPath = $lockPath; Nonce = ''; Reason = ('被占用：' + $st.Reason) }
        }
        return [pscustomobject]@{ Ok = $false; LockPath = $lockPath; Nonce = ''; Reason = ('创建锁失败: ' + $_.Exception.Message) }
    }
}

# 获取锁（带轮询）。返回 $null 表示抢不到。
function Enter-FileLock {
    param(
        [string]$Path,
        [int]$TimeoutMs = 0
    )

    if ($TimeoutMs -le 0) { $TimeoutMs = $script:LockTimeoutMs }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    while ($true) {
        $r = Try-AcquireLockOnce -Path $Path
        if ($r.Ok) {
            # 【v0.10.14 修】成功时也显式给 Failed = $false。
            #   原来成功对象没有这个字段，调用方写 `-eq $false` 会得到 $null 而不成立。
            #   接口对称，两种写法都可靠。
            return [pscustomobject]@{ LockPath = $r.LockPath; Nonce = $r.Nonce; Reason = $r.Reason; Failed = $false }
        }
        if ($sw.ElapsedMilliseconds -ge $TimeoutMs) {
            return [pscustomobject]@{ LockPath = ''; Nonce = ''; Reason = $r.Reason; Failed = $true }
        }
        [System.Threading.Thread]::Sleep([int]$script:LockPollMs)
    }
}

# 释放锁。必须核对 nonce —— 否则会误删别人接管后的新锁。
function Exit-FileLock {
    param($Lock)

    if ($null -eq $Lock) { return $false }
    if ([string]::IsNullOrEmpty($Lock.LockPath)) { return $false }
    try {
        $cur = Read-LockInfo -LockPath $Lock.LockPath
        if ($null -ne $cur -and $cur.nonce -eq $Lock.Nonce) {
            [System.IO.File]::Delete($Lock.LockPath)
            return $true
        }
        return $false
    } catch {
        return $false
    }
}
# ---------------------------------------------------------------- 带锁的读-改-写（v0.10.14 · D1 第二步）
#
# 【为什么要"锁内重读"，而不是用调用方手里的对象】
#   假设卡片在锁外读到 settings.json 是 {width:320}，
#   在它拿锁之前，设置窗口已经写入了 {width:320, approvalInline:true}。
#   如果卡片拿锁后仍用自己那份旧对象做基准，写回时会把
#   approvalInline 抹掉 —— 锁就白加了。
#
#   所以：**拿到锁后必须重新读一次**。
#
# @param Path      正式文件
# @param Merger    收到「当前最新内容」，返回要写入的新内容（scriptblock）
# @param LogPrefix 日志前缀
# @returns $true 成功 / $false 失败（不抛）
function Write-JsonWithLock {
    param(
        [string]$Path,
        [scriptblock]$Merger,
        [string]$LogPrefix = '写JSON'
    )

    $lock = $null
    try {
        $lock = Enter-FileLock -Path $Path
        if ($null -eq $lock -or $lock.Failed) {
            $why = if ($null -ne $lock) { $lock.Reason } else { '未知' }
            try { Log-Card ('{0}: 抢锁失败（{1}），本次不写' -f $LogPrefix, $why) -Level 'WARN' -Key ($LogPrefix + 'lock') } catch { }
            return $false
        }

        # ---- 锁内重读（这是关键）
        $cur = [ordered]@{}
        if (Test-Path $Path) {
            try {
                $raw = [System.IO.File]::ReadAllText($Path)
                if (-not [string]::IsNullOrWhiteSpace($raw)) {
                    $obj = $raw | ConvertFrom-Json
                    if ($null -ne $obj) {
                        foreach ($p in $obj.PSObject.Properties) { $cur[$p.Name] = $p.Value }
                    }
                }
            }
            catch {
                # 读不出来也不能当成"空对象"然后整份覆盖 —— 那会把用户设置清光。
                # 这里保留空字典，但记一条日志，让排查时能看到。
                try { Log-Card ('{0}: 读现有内容失败，将基于空对象写（原内容可能已损坏）' -f $LogPrefix) -Level 'WARN' -Key ($LogPrefix + 'read') } catch { }
            }
        }

        # ---- 让调用方决定改什么
        $next = & $Merger $cur
        if ($null -eq $next) { return $false }

        # ---- 写回
        #
        # 【v0.10.14 修一个会写坏 settings.json 的真 bug】
        #
        # 原来这里写的是：
        #   $payload = [ordered]@{}
        #   foreach ($p in $next.PSObject.Properties) { $payload[$p.Name] = $p.Value }
        #   if ($payload.Count -eq 0 -and $next -is [IDictionary]) { foreach ($k in $next.Keys) ... }
        #
        # 问题：Merger 返回的是 [ordered] 字典（比如 Save-TopmostSetting 里就是），
        # 而对 [ordered] 字典调 `.PSObject.Properties` **拿到的不是键值对**，
        # 而是 .NET 字典对象自身的属性：Count / Keys / Values / IsReadOnly ...
        #
        # 于是 $payload 被塞进这些垃圾键，最终写出来的是：
        #   { "Count": 3, "IsReadOnly": false, "Keys": [...], "Values": [...] }
        # 而不是用户真正的设置。**这会一次性把 settings.json 写坏，用户设置全丢。**
        #
        # 而且 $payload.Count 因为有 4 个垃圾键，不等于 0，
        # 所以后面那段"退化到 Keys 枚举"的兜底根本没机会执行。
        #
        # 修法：先判类型。[ordered] / Hashtable 等 IDictionary 走 Keys，
        #       普通 pscustomobject 才走 PSObject.Properties。
        $payload = [ordered]@{}
        if ($next -is [System.Collections.IDictionary]) {
            foreach ($k in $next.Keys) { $payload[[string]$k] = $next[$k] }
        }
        else {
            foreach ($p in $next.PSObject.Properties) { $payload[$p.Name] = $p.Value }
        }

        $json = $payload | ConvertTo-Json -Depth 8
        return (Write-FileAtomic -Path $Path -Text $json)
    }
    catch {
        try { Log-Fail ($LogPrefix + '异常') $_ } catch { }
        return $false
    }
    finally {
        if ($null -ne $lock) { [void](Exit-FileLock -Lock $lock) }
    }
}
function Write-FileAtomic {
    param(
        [string]$Path,
        [string]$Text,
        [System.Text.Encoding]$Encoding = $null
    )

    if ($null -eq $Encoding) {
        # JSON 绝不能带 BOM（DSH 读 package.json 时踩过这个坑）
        $Encoding = New-Object System.Text.UTF8Encoding($false)
    }

    $tmp = $null
    try {
        $dir = [System.IO.Path]::GetDirectoryName($Path)
        if (-not [string]::IsNullOrEmpty($dir) -and -not (Test-Path $dir)) {
            [void](New-Item -ItemType Directory -Path $dir -Force)
        }

        # 唯一临时名：正式名 + pid + 随机串
        $rnd = [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
        $tmp = $Path + '.' + $PID + '.' + $rnd + '.tmp'

        [System.IO.File]::WriteAllText($tmp, $Text, $Encoding)

        # ① 目标存在时，优先用 Replace（原子）
        if (Test-Path $Path) {
            try {
                # 第二个参数是备份文件；传 $null 表示不保留备份
                [System.IO.File]::Replace($tmp, $Path, $null)
                return $true
            }
            catch {
                # Replace 在某些文件系统/被杀软占用时会失败，落到下面
            }
            # ② 退化：删除 + 移动（有极短窗口，见文件头说明）
            try { [System.IO.File]::Delete($Path) } catch { }
        }

        [System.IO.File]::Move($tmp, $Path)
        return $true
    }
    catch {
        return $false
    }
    finally {
        # 无论成功失败都清理临时文件（Move/Replace 成功后 tmp 已不存在）
        if ($null -ne $tmp -and (Test-Path $tmp)) {
            try { [System.IO.File]::Delete($tmp) } catch { }
        }
    }
}
function Save-Position {
    try {
        $o = [ordered]@{ left = [double]$win.Left; top = [double]$win.Top }
        $json = $o | ConvertTo-Json
        # 【v0.10.13 · D1】改用原子写：写到唯一临时文件再替换。
        #   原来直接 WriteAllText 覆盖，写一半崩了会留下坏 JSON，
        #   下次启动读不到位置 → 卡片回到默认位置（用户觉得"卡片乱跑"）。
        #   写失败时正式文件保持原样，最差只是"这次位置没记住"，不会毁掉旧记录。
        [void](Write-FileAtomic -Path $PosPath -Text $json)
    } catch { Log-Fail 'L3757' $_ }
}

# ---------------------------------------------------------------- 置顶（v0.9.14）
#
# 【为什么必须有这一个统一函数，不能在每个调用点直接写 Topmost】
#   卡片里有 5 个地方会碰 $win.Topmost：
#     L1310 附近  窗口创建
#     Set-TopmostMode 本身
#     Invoke-OpenDshFlow 里的"让位"
#     让位后 700ms 的"恢复"
#     异常兜底
#   如果每处各写一句 $win.Topmost = $true/$false，只要有一处写死 $true，
#   就会出现"关掉置顶后，点一下卡片它自己又变回置顶" —— 
#   开关看着像没生效，而且**只在点过卡片之后才复现**，极难排查。
#   （这和之前那个"改了没生效"属于同一类陷阱：状态被两处代码争抢。）
#   所以统一收口到这两个函数，调用点只表达"我想要置顶/不置顶"。
#
# 【为什么切完要重刷磨砂】
#   改 Topmost 会把 DWM 的合成状态冲掉一次（和改窗口尺寸同类）。
#   实测：不重刷的话，切完那一瞬间可能留下一块白底。
#   这和项目里其他改窗口状态的地方是同一个处理（改尺寸后也重刷）。
function Set-TopmostMode {
    param([bool]$Enabled)

    $script:topmostEnabled = $Enabled

    try { $win.Topmost = $Enabled } catch { }

    # 气泡是**独立窗口**，不跟着设的话会出两种怪现象：
    #   开置顶时气泡被主窗口盖住（悬停看不到说明）
    #   关置顶时气泡反而浮在所有窗口最上面（比主窗口还显眼，明显不对）
    try {
        if ($null -ne $script:barTipWin) { $script:barTipWin.Topmost = $Enabled }
    } catch { Log-Fail 'L3791' $_ }

    # 审批二次确认框同理。注意变量名是 $script:confirmDlg（不是 confirmDlgWin），
    # 而且它只在弹窗期间存在、关掉就置空 —— 所以用的是"有就设一下"的写法。
    # 之所以要设：那个对话框是一次性的，如果主窗口关了置顶它还浮在最上面，
    # 用户会看到"一个孤零零的确认框"压在所有窗口之上。
    try {
        if ($null -ne $script:confirmDlg) { $script:confirmDlg.Topmost = $Enabled }
    } catch { Log-Fail 'L3799' $_ }

    try { Update-Glass } catch { }
}

# 把置顶开关写进 settings.json（持久化）
#
# 【为什么要"读全量 → 改一个键 → 原子写回"，不能直接写整份】
#   settings.json 是卡片和设置窗口（Settings.ps1，另一个独立进程）**共用**的。
#   如果这里直接 WriteAllText 一份只有 topmost 的 JSON，
#   用户改过的磨砂浓度、卡片宽度、审批开关……会**全部被抹掉**。
#   所以必须先读回当前的完整配置，只改 topmost 这一个键，再整体写回。
#
# 【为什么是原子写（tmp + rename）】
#   卡片每 500ms 会读一次 settings.json 做热更新。
#   直接 WriteAllText 是"先截断再写"，中间有一个窗口期文件是空的/半截的，
#   那一瞬间正好被读到 → JSON 解析失败 → 用户的全部设置瞬间回默认值。
#   Settings.ps1 里已经踩过这个坑（它的注释写得很清楚），这里沿用同一套做法。
function Save-TopmostSetting {
    param([bool]$Enabled)
    try {
        # ================================================================
        # 【v0.10.14 · D1 第二步】改用带跨进程锁的读-改-写
        #
        # 【改造前的问题】
        #   下面这段是"读出来 → 改 topmost → 用固定名 $SettingsPath.tmp 写回"。
        #   而**设置窗口也用同一个 $Path.tmp**（见 Settings.ps1）。
        #   两个进程同时保存时：
        #     卡片写 tmp → 设置窗口也写同一个 tmp → 卡片改名拿走对方的半成品
        #   最终内容可能是"半次卡片 + 半次设置窗口"，而且完全不报错。
        #
        # 【现在】
        #   Write-JsonWithLock 会：抢锁 → **锁内重读最新内容** → 合并 → 原子写 → 放锁。
        #   锁内重读是关键：不然拿锁前被别人改过的键还是会被这次写覆盖掉。
        # ================================================================
        $ok = Write-JsonWithLock -Path $SettingsPath -LogPrefix '保存置顶' -Merger {
            param($cur)
            $obj = [ordered]@{}
            foreach ($k in $cur.Keys) { $obj[$k] = $cur[$k] }
            $obj['topmost'] = $Enabled
            return $obj
        }

        if (-not $ok) {
            try { Log-Card '保存置顶设置失败（已记在锁/写日志里）' -Level 'WARN' -Key 'topmostSave' } catch { }
            return
        }

        # 先把自己记录的 mtime 更新掉（原逻辑保留）
        try { $script:lastSettingsWrite = [System.IO.File]::GetLastWriteTimeUtc($SettingsPath) } catch { }
    } catch {
        Log-Card ('保存置顶设置失败: ' + $_.Exception.Message)
    }
}


# ---------------------------------------------------------------- 相位判定（v0.9.0 抽出来的）
#
# 【为什么要抽出来】
#   柱态只需要"当前是什么状态"（用来给颜色条上色），不需要走完整个 Update-UI。
#   如果把相位判定留在 Update-UI 里，柱态就得复制一份 —— 两份逻辑必然漂移，
#   会出现"柱态显示绿色、展开态显示蓝色"这种不一致。
#
# 【优先级】待审批 > 刚完成 > 运行中 > 空闲（这是交接文档 2.6 定的，没动）
#
# ⚠️ 调用方必须先更新 $script:finishedUntil（"刚完成"的 8 秒窗口），
#    本函数只做判定，不维护那个窗口。
function Get-PhaseFromState {
    param($State, [datetime]$Now)

    if ($null -eq $State) { return 'idle' }
    # 这些字段可能是 $null（老 state.json / empty 兜底对象），统一按 0 处理
    $appr = 0
    try { if ($null -ne $State.approval) { $appr = [int]$State.approval } } catch { }
    if ($appr -gt 0) { return 'approval' }

    if ($null -ne $script:finishedUntil -and $Now -lt $script:finishedUntil) { return 'finished' }

    $run = 0
    try { if ($null -ne $State.running) { $run = [int]$State.running } } catch { }
    if ($run -gt 0) { return 'running' }

    $sub = 0
    try { if ($null -ne $State.subagentCount) { $sub = [int]$State.subagentCount } } catch { }
    if ($sub -gt 0) { return 'running' }

    return 'idle'
}

# ---------------------------------------------------------------- 柱态（v0.9.0）
#
# 用户需求：沉浸任务时缩成一根细柱贴边，不显示文字，只用颜色条表达状态。
#
# 【三种触发/退出方式】
#   进：① 拖到左右边缘 + 光标顶住 + 松手（方案甲）
#       ② 右键菜单「缩成细条」（方案乙）
#   出：① 单击柱子（用户拍板：点柱子 = 展开，不是打开 DSH）
#       ② 右键菜单「展开」
#
# 【硬约束：保持置顶】
#   用户明确选了"柱子也置顶"（他知道代价：看视频时边缘有一条彩条）。
#   所以柱态**不动 Topmost**，维持 $true。
#   但要注意 Invoke-OpenDshFlow 里有 `$win.Topmost = $false` 让位逻辑，
#   它 700ms 后会恢复 true —— 柱态下点菜单「回到 DSH」走这条路，
#   结果是"柱子临时闪一下非置顶再恢复"，可接受（不影响柱态本身）。

# 进柱态前记住的东西，退出时原样还原
$script:barRestore = $null
$script:barRestoreCenterY = 0

# 拖拽判据的结果（MouseLeftButtonUp 里算、同一个块里用，仍用 $script: 保险）
$script:shouldCollapse = $false
$script:collapseSide = ''

# 柱态专用色板（v0.9.1 重做）
#
# 【为什么单独一套，不复用 $script:Palette 的 Text/Dot】
#   Palette 的 Text 是"压在磨砂玻璃上的文字"，Dot 是 8 像素小圆点，
#   两者都不适合"14 像素宽的纯色条"（Dot 明度偏低，条会发灰看不清）。
#   所以柱态保留自己的表，只是**色值向卡片的 Dot 对齐**，保证观感统一。
#
# 【为什么按 Light/Dark 两套】
#   柱态不跟壁纸明暗走（Update-AdaptiveText 在柱态被跳过）。
#   明暗由 $script:curIsLight 决定 —— 它在进柱态那一刻的值。
#   这是可接受的：柱态是临时状态，用户换壁纸的概率很低。
# 【v0.9.1 为什么整体换了一套色值】
#   柱子的底色从"永远深色"改成了"跟随壁纸明暗"（浅壁纸 → 浅暖灰）。
#   原来那套色值是**对着深色柱底**调出来的（对 #24262C 刚好过 3.0），
#   换到浅底上就有一半不达标：
#     finished #12A34F → 对浅底只有 2.86（原来 4.71）
#     idle     #9AA3B0 → 对浅底只有 2.21（原来 4.99）
#   所以浅底这一套按新底色重新调，并且**直接对齐卡片自己的圆点色**
#   （$script:Palette 的 Dot.Light），这样柱子和卡片的红/绿/蓝灰是同一个色。
#
# 【达标情况：全部过 WCAG 正文门槛 4.5，且留了 ≥0.1 余量】
#   相位        浅底(Light)  对 #E8E2DF   深底(Dark)  对 #1C1C1F
#   approval    #B81C25         5.07      #FF8D8D      7.65
#   finished    #0F6B36         5.16      #5EDB93      9.74
#   running     #265CBC         4.90      #5E9BFF      6.16
#   idle        #5A616E         4.86      #9AA3B0      6.67
#   （这些数字由 test/bar-mode.mjs 第 5 组每次跑测试时重算并打印，
#     不靠我手抄 —— 手抄的数会随底色微调而失真。
#     本轮就靠这条抓到一个真错：改了柱底却没同步改 running，
#     余量从 4.55 掉到 4.39，测试红了才发现的。）
#
# 【深浅两套为什么不对称】
#   深底那侧基本照搬卡片圆点色，因为深色底容错大。
#   浅底那侧三个色都压深了一档（running #2F6FE4→#265CBC、idle #8A93A0→#5A616E、
#   approval #C0202A→#B81C25），否则在浅底上只有 3~4，
#   14 像素宽的细条会发灰看不清。色相都没变，只是暗一档。
# 【v0.9.6 为什么整体再调一档】
#   胶囊底从"v0.9.5 几乎透明"变成了"0xA0 浓度的磨砂玻璃"，等效底色变了：
#     浅底：原 #E8E2DF（相对亮度 0.79）→ 现 #D7D2E0（0.66）  ← 变暗了
#     （因为磨砂浓度提高后，DWM 的模糊层比原壁纸暗，见 $BarGlassAlpha 的反推）
#   底变暗一点，浅色那一套的余量就薄了，实测：
#     approval 4.38 / finished 4.46 / running 4.24 / idle 4.20  ← 全部跌破 4.5
#   所以整体往深压一档（色相不动，只动明度），压完：
#     approval 4.68 / finished 5.26 / running 4.92 / idle 5.29  ← 全部过线且有余量
#   深底那一侧本来余量很足（5.35~8.47），但为了"柱子和卡片的红/绿/蓝灰看着是同一色"，
#   跟着提亮一档保持两套的视觉同源。
#
# 【达标情况：全部过 WCAG 正文门槛 4.5，且留了 ≥0.18 余量】
#   相位        浅底(Light)  对磨砂玻璃 #D7D2E0   深底(Dark)  对磨砂玻璃 #17293D
#   approval    #8F0E14            6.36            #FFB0B0         7.20
#   finished    #094A22            7.07            #95EFB8         9.13
#   running     #174090            6.56            #9CC2FF         6.90
#   idle        #3C4149            6.97            #C8CFD8         7.97
#
#   【v0.9.6 第二次调色：为什么要用"最坏端"而不是"用户那张截图"】
#     第一版我拿用户那张浅色壁纸算，四个色都在 4.68~5.29，看着够。
#     但子代理指出一个我漏掉的条件：$curIsLight 的判据是"壁纸相对亮度 >= 0.186"，
#     也就是说**浅模式最暗的玻璃**出现在壁纸刚好 0.186 那一档，
#     比我算的那张 #CBC0E2（rel 0.559）暗得多。
#     在那档玻璃上重算，第一版全部跌到 3.7~4.2 —— 不达标。
#     所以现在按"浅模式最暗玻璃 #BDBEC1"和"深模式最亮玻璃 #363333"这两个端点设计，
#     四色在全范围内最差 5.04，留出了余量。
#
#   【⚠️ 建模时踩过一个量纲错】
#     我一开始把"模糊层/壁纸的相对亮度比 0.577"直接乘到了 sRGB 通道值上。
#     那是错的：相对亮度带 gamma，不能当 sRGB 比例用。
#     正确的 sRGB 空间压暗系数是 ~0.794（按 R/G/B 三通道实测比值平均）。
#   （这些数字由 test/bar-mode.mjs 第 5 组每次跑测试时重算并打印，不靠手抄）
#
# 【⚠️ 胶囊底色是"磨砂玻璃"，测试里要用等效色算】
#   玻璃色 = a × tint + (1-a) × 模糊层B，其中 B 是从用户截图反推出来的
#   （浅 #9C95BD / 深 #134271）。测试里写的是这个等效色，不是原来的实色 #E8E2DF。
$script:BarPalette = @{
    'approval' = @{ Light = [System.Windows.Media.Color]::FromArgb(0xFF, 0x8F, 0x0E, 0x14)
                    Dark  = [System.Windows.Media.Color]::FromArgb(0xFF, 0xFF, 0xB0, 0xB0) }
    'finished' = @{ Light = [System.Windows.Media.Color]::FromArgb(0xFF, 0x09, 0x4A, 0x22)
                    Dark  = [System.Windows.Media.Color]::FromArgb(0xFF, 0x95, 0xEF, 0xB8) }
    'running'  = @{ Light = [System.Windows.Media.Color]::FromArgb(0xFF, 0x17, 0x40, 0x90)
                    Dark  = [System.Windows.Media.Color]::FromArgb(0xFF, 0x9C, 0xC2, 0xFF) }
    'idle'     = @{ Light = [System.Windows.Media.Color]::FromArgb(0xFF, 0x3C, 0x41, 0x49)
                    Dark  = [System.Windows.Media.Color]::FromArgb(0xFF, 0xC8, 0xCF, 0xD8) }
}

# 柱态胶囊底 + 描边色（跟随壁纸明暗）
#
# 【浅底为什么是 #E8E2DF，而不是方案里写的 #F2EEEC】
#   这是本轮实做时才发现的坑，用真实桌面截图验证出来的
#   （脚本 _lab\bar-real-wallpaper.ps1，图 _lab\shots\bar-real-wallpaper.png）：
#     · 你的桌面上有大片接近纯白的窗口区。柱子是浅色块，
#       浅色压在更浅的底上 = 轮廓消失，只剩一根悬空彩条。
#     · 数值（柱底对纯白壁纸的对比度）：
#         #F2EEEC → 1.15（几乎看不出柱子边界）
#         #E8E2DF → 1.28（勉强看得出，且不抢眼）
#     · 但不能一味压深：柱底越深，色条对比度余量越小。
#         #E8E2DF 时 running 还有 4.55（刚好过 4.5）
#         #DAD5D2 时 running 掉到 3.87（不达标）
#   所以 #E8E2DF 是"看得见柱子轮廓"和"色条还够亮"两条约束的交点，
#   不是随手挑的色号。
#
# 【为什么不直接抄卡片的 tint #FAF6F4】
#   卡片的 tint 是**磨砂叠在壁纸上的半透明色**。柱子关掉了磨砂，是纯色块，
#   得给"不透明等效色"。而且卡片自己压在纯白壁纸上对比度也只有 1.19
#   （实测玻璃 #EAEBED，见本文件上方状态色板的注释），
#   说明"很淡"本身就是卡片的设计，柱子和它同一量级才对，不该比卡片更抢眼。
#
# 【为什么不半透明】窗口 AllowsTransparency = False（硬约束），
#   半透明不会真的和壁纸混合，只会和窗口自己的底色混 → 不可控。
$script:BarBackdrop = @{
    Light = [System.Windows.Media.Color]::FromArgb(0xFF, 0xE8, 0xE2, 0xDF)
    Dark  = [System.Windows.Media.Color]::FromArgb(0xFF, 0x1C, 0x1C, 0x1F)
}

# 柱态磨砂的 tint（v0.9.5 新增）
#
# 【这是什么】SetWindowCompositionAttribute 的 GradientColor，格式 0xAABBGGRR。
#   AA = 玻璃的"浓度"（0x00 全透，0xFF 全实）。
#   卡片用的是 0x50（80/255 ≈ 31%），因为卡片 260 宽、玻璃面积大，能撑住这个浓度。
#
# 【柱子为什么用 0x20 而不是 0x50】
#   柱子只有 14 宽。同样的浓度在小面积上会显得"雾很重"，
#   用户要的是"能透过胶囊看到背后模糊的颜色"，所以必须更透。
#   0x20 = 32/255 ≈ 13%，足够让 DWM 做模糊，又不会把背景压掉。
#
# 【色相为什么跟着明暗走】
#   卡片也是这么做的（浅 #FAF6F4 / 深 #1A1A1E），柱子保持同一套语言。
#   用暖白/深灰做底色调，磨砂出来的观感才和卡片一致，不会一边暖一边冷。
#
# 【⚠️ AccentFlags 必须传 0】
#   这是本项目的老坑：传 2 会变成整块纯白底（磨砂完全失效）。
#   Card 那只 Acrylic 调用里也写着这句话，这里保持一致。
#
# 【为什么这里能安全地用半透明】
#   之前 v0.9.1 的注释说"窗口 AllowsTransparency=False，半透明不会真的和壁纸混合"。
#   那句话对**WPF 的 Border.Background 半透明**是成立的（确实会和窗口底色混）。
#   但磨砂走的是 SetWindowCompositionAttribute —— 那是 DWM 在**窗口之下**做的
#   真模糊合成，和 WPF 的合成层无关，所以能真的透出壁纸。
#   这两个概念以前被我混在一起了，这次分开。
$script:BarGlassTint = $null   # 在下面 $isDark 确定后赋值（需要知道明暗）

# 柱态描边色 —— v0.9.3 已删除
#
# 【为什么删了】
#   v0.9.1 这里定义过浅 0x34 / 深 0x28 的半透明白描边，想让柱子和卡片一样有"玻璃边"。
#   实测证明它在柱态是错的（详见 New-BarPanel 里那段长注释）：
#   柱态窗口底色被 DWM 合成成黑色，半透明白画上去 = #343434 的灰色矩形框，
#   用户看到的就是"胶囊背后有个黑框"。
#   既然柱态不用描边，色表也一起删掉，避免留下一个"定义了却没人用"的死配置
#   （这种死代码最容易在以后被误以为还在生效，然后改错地方）。

# 更新柱态配色（底色 + 颜色条）。
#
# 【为什么单独一个函数，不塞进 Set-Header】
#   Set-Header 每次都碰 $exp.HeadText / $exp.Dot / $mini.Dot 这三个控件。
#   柱态下这些控件全是 Collapsed，改它们纯属浪费（还会触发布局失效重算）。
#   而且柱态用的是另一套色（见 BarPalette），混进 Set-Header 下次改配色会互相污染。
function Update-BarStrip {
    param([string]$Phase)

    try {
        if ($null -eq $script:bar) { return }

        $entry = $script:BarPalette[$Phase]
        if ($null -eq $entry) { $entry = $script:BarPalette['idle'] }
        # 【v0.9.7 改用 barThemeIsLight，不再用 curIsLight】
        #   两者语义一样（true = 浅壁纸），但分开放有两个原因：
        #     ① 柱态的换色时机和卡片不同，独立一个变量不会互相拖累
        #     ② 万一以后又出现"卡片改了柱子没改"这种漏项，
        #        两个变量能分别断言，不会一个变量掩盖另一个的问题
        $c = if ($script:barThemeIsLight) { $entry.Light } else { $entry.Dark }

        # 只改 .Color，不 New-Brush（和 Set-Header 同一个理由：一天十几万次）
        if ($null -eq $script:bar.Strip.Background) {
            $script:bar.Strip.Background = New-Brush $c
        }
        else {
            $script:bar.Strip.Background.Color = $c
        }

        # ---------------------------------------------------------- 色条呼吸（v0.9.11）
        #
        # 【用户的要求】
        #   "柱状态中蓝色的代表正在运行的蓝色条，也做呼吸效果，呼吸频率同步小蓝点"
        #
        # 【为什么色条也要呼吸】
        #   柱子只有 14 像素宽，上面唯一的信息载体就是这条色条。
        #   它静止时，用户没法区分"正在跑"和"卡住了"，只能去看弹窗里的文字。
        #   让小蓝点和色条**同步**呼吸之后，"活着"这个信号在两种形态上都成立，
        #   而且频率一致 → 用户潜意识里会认为是"同一个生命体征"。
        #
        # 【为什么传 barThemeIsLight 无关、只传 Phase】
        #   呼吸只跟"在不在跑"有关，跟明暗无关。
        #
        # 【为什么色条的振幅是 0.60，不是和圆点一样的 0.35】
        #   逐像素算过对比度（见上面 Get-BreathClock 上方那段长注释）：
        #     谷值 0.35 时，色条对玻璃只有 1.83（浅）/ 2.22（深），低于 3.0 门槛
        #     谷值 0.60 时，色条对玻璃 3.07 —— 刚好过门槛，且亮度仍变化 40%
        #   色条是柱子**唯一**的状态标识，淡到看不见就变成"柱子空了"。
        #   圆点旁边有大字撑着、视觉锚点多，所以可以用大振幅。
        #
        #   【"不同振幅"不影响"同步"】
        #     同步靠的是两个时钟在**同一帧内**创建（相位差 0），
        #     实测归一化相位偏差 0.0000（_lab\probe-two-clocks-sync.ps1）。
        #     所以用户看到的是"同一个呼吸，蓝点起伏大、色条起伏小"。
        #
        # 【为什么放在 Update-BarStrip 而不是 Update-UI 里单独算】
        #   Update-BarStrip 是**唯一**知道柱态当前相位的地方
        #   （它收到 $Phase 参数，且负责给色条上色）。
        #   在这里顺手把呼吸也设了，就不需要在别处再算一遍"该不该呼吸"
        #   —— 两处算一旦不一致，就会出现"色条变了但呼吸没跟上"。
        try {
            Set-DotsBreathingForPhase -Dots @($script:bar.Strip) -Phase $Phase -To $script:BreathStripTo
        } catch { Log-Fail 'L4136' $_ }

        # ---------------------------------------------------------- 胶囊底（v0.9.1）
        #
        # 【旧版这里是怎么写的（以及为什么错）】
        #   $bg = if (curIsLight) { #24262C } else { #1A1A1E }
        #   两个分支都是深色 —— 也就是说不管壁纸明暗，柱子永远是黑的。
        #   旧注释写的是"浅背景时柱子要压得住，用深底"，这个判断本身错了：
        #   卡片在浅壁纸上用的是暖白玻璃，柱子却贴一块黑，所以看起来像
        #   桌面上粘了一张黑胶布。这就是"柱子样式丑"的根本原因。
        #
        # 【v0.9.5 起柱态改开磨砂，这里必须保持 Transparent】
        #   磨砂是 DWM 在**窗口之下**做的真模糊合成，WPF 这一层如果画实色，
        #   就把那层玻璃整个盖掉了 —— 用户要的"透出背后模糊的颜色"会立刻消失。
        #   所以这个分支只在**退出柱态**时才有用（Update-Glass 会把它恢复成实色），
        #   柱态期间它一直是 Transparent。
        #
        # 【v0.9.6 提醒：柱底"太透"的锅不在这一行】
        #   用户报"太透"，真因是磨砂浓度 0x20 太低（见 $BarGlassAlpha 的注释），
        #   不是这里不该 Transparent。所以这一行**不动**，
        #   改浓度的同时加了一道不透明描边给出轮廓。
        $bg = if ($script:curIsLight) { $script:BarBackdrop.Light } else { $script:BarBackdrop.Dark }
        if ($null -eq $script:bar.Backdrop.Background) {
            $script:bar.Backdrop.Background = New-Brush $bg
        }
        elseif ($script:mode -ne 'bar') {
            # 只在非柱态时改（柱态下它应该保持 Transparent 让磨砂透出来）
            $script:bar.Backdrop.Background.Color = $bg
        }

        # ---------------------------------------------------------- 胶囊描边（v0.9.6 加回）
        #
        # 【v0.9.1 加过、v0.9.3 删掉、v0.9.6 加回来的完整来龙去脉】
        #
        #   v0.9.1：加了 1 像素半透明白边（浅 0x34 / 深 0x28），想让柱子和卡片一套语言。
        #   v0.9.3：用户反馈"胶囊背后有个黑色矩形框"，逐像素量到那圈是 #343434
        #           （0x34 = 52，半透明白叠在纯黑上算出来正好 52）→ 删掉。
        #           当时的结论写了两条：① 半透明叠黑被染色 ② Border 边框是矩形
        #   v0.9.6：★ 用离屏探针重新实测（_lab\probe-capsule-border.ps1），
        #           **第 ② 条结论是错的**：Border 的 BorderBrush 描边跟着圆角走，
        #           渲染放大后逐行看，描边 x 坐标是从窄到宽外扩的曲线，不是固定的两条竖线。
        #           所以当年删描边的真正理由只有"半透明"这一条。
        #
        #   那为什么现在可以加回来？
        #     ① 用**完全不透明**的颜色（alpha 0xFF）→ 不参与和黑底的任何混合
        #     ② v0.9.4 已经用 SetWindowRgn 把窗口裁成胶囊 → 矩形四角根本不存在
        #     ③ 用户明确说"柱态太透、可视性不佳"，而实测证明**只调浓度救不了轮廓**
        #        （扫了 a=0x20~0xFF，轮廓对比度 1.03~1.74，中间还更低，是物理限制）
        #        必须有一道明确的边。
        #
        #   色值在 $script:BarBorderColor 里，实测对比度见那里的注释。
        if ($null -ne $script:BarBorderColor -and $null -ne $script:bar.Backdrop) {
            try {
                $bc = if ($script:barThemeIsLight) { $script:BarBorderColor.Light } else { $script:BarBorderColor.Dark }
                if ($null -eq $script:bar.Backdrop.BorderBrush) {
                    $script:bar.Backdrop.BorderBrush = New-Brush $bc
                }
                else {
                    $script:bar.Backdrop.BorderBrush.Color = $bc
                }
            } catch { Log-Fail 'L4196' $_ -Key 'L4196' }
        }

        # ---------------------------------------------------------- 描边：已上移（v0.9.6）
        #
        # 【这里原有一段 v0.9.3 的"删描边"说明，已合并到上面"胶囊描边（v0.9.6 加回）"】
        #   合并的理由：同一个决策的两半（为什么删、为什么能加回来）分在两处，
        #   下一个改这里的人只会读到其中一半，非常容易重犯。
        #   现在所有描边的来龙去脉都在上面那一段，这里是空的 —— 这是有意的，
        #   不要在这里再写一遍描边代码，否则两处会漂移。
    } catch { Log-Fail 'L4206' $_ -Key 'L4206' }
}

# 把窗口改成柱子尺寸并贴边。
#
# 【为什么不复用 Set-WindowHeight】
#   它只改高度，而且开头有 `if ($script:curHeight -eq $TargetHeight) { return }` 早退。
#   柱态要同时改宽（260→14）、高（368→120）、位置，只用它做不到。
function Set-BarGeometry {
    param([string]$Side)

    try {
        $wa = Get-WorkArea

        # 垂直位置：对齐"缩小前卡片的中心"，不是跳到顶部。
        # 视觉上柱子是"从卡片中间挤出来"的，不是"卡片消失了、屏幕上多了根柱子"。
        $centerY = [double]$script:barRestoreCenterY
        $top = $centerY - ($BarHeight / 2)

        # 夹在屏幕内（柱高可能超过可用高度，尤其是小屏 + 大柱高）
        if ($top -lt $wa.Top) { $top = $wa.Top }
        if (($top + $BarHeight) -gt $wa.Bottom) { $top = $wa.Bottom - $BarHeight }

        # 水平：贴边。用 $BarEdgeGap 和 Clamp-Position 的 +4 对齐（见常量处的说明）
        $left = 0.0
        if ($Side -eq 'left') {
            $left = $wa.Left + $BarEdgeGap
        } else {
            $left = $wa.Right - $BarWidth - $BarEdgeGap
        }

        # 先改尺寸再改位置：反过来的话 WPF 会按旧尺寸做一次边界处理，可能跳位
        $win.Width  = $BarWidth
        $win.Height = $BarHeight
        $win.Left   = $left
        $win.Top    = $top

        $script:curHeight = $BarHeight
        $script:anchorLeft = [double]$win.Left
        $script:anchorTop  = [double]$win.Top

        # ---------------------------------------------------------- 【v0.9.8 不再裁剪】
        #
        # 【为什么把 SetWindowRgn 那一段整个跳过】
        #   v0.9.4 加裁剪，是为了让"窗口形状" = "我们要的胶囊"，
        #   这样 WPF 的矩形底色就不会把 Border 的圆角填平。
        #
        #   但 v0.9.8 改成**纯直角矩形柱子**之后：
        #     · Border 的 CornerRadius = 0，没有圆角需要保护
        #     · 窗口本来就是矩形，和柱子形状完全一致
        #     · 磨砂按窗口矩形合成，也完全一致
        #   所以**不需要裁剪了**。而且这里必须主动不裁：
        #   如果还留着胶囊 region，窗口就会被裁成圆角，
        #   磨砂（按矩形合成）又会在四角露出来 —— 正是我们要消灭的那个问题。
        #
        #   【保留 MakeCapsuleRgn / ClearWindowRgn 这两个 P/Invoke】
        #     不删，因为 Exit-BarMode 里还要调 ClearWindowRgn 兜底
        #     （万一用户从旧版本热更新上来，窗口上可能还挂着旧 region）。
        #
        # 裁成胶囊形状（v0.9.4，已停用）
        #
        # 【为什么必须裁 —— 用户报"现在胶囊没有圆角了"】
        #   v0.9.3 把 $win.Background 设成了胶囊色（为了盖住半像素缝漏黑底）。
        #   但 WPF 的 Border.CornerRadius 只把 **Border 自己** 画成圆角，
        #   窗口底色永远是矩形 —— 同色一铺，矩形底色把圆角填平了，
        #   柱子就变成一根方头柱。这不是圆角"丢了"，是被底色盖住了。
        #
        #   实测（_lab\probe-round-window.ps1，数顶部每行洋红像素数）：
        #     只有 Border 圆角         6→12→16→18→20→22→24→24→26→26→26→28  ✅
        #     + 窗口底色同色(v0.9.3)   28→28→28→...→28                      ❌ 方角
        #     + SetWindowRgn 裁剪      4→12→14→18→20→22→22→24→26→26→26→26  ✅
        #
        # 【为什么放在这里（尺寸改完之后）而不是 Loaded 里】
        #   SetWindowRgn 要在窗口**完全渲染且尺寸稳定后**调。
        #   实测：在 Loaded 事件里调，函数返回成功但形状没变（还是方角）；
        #   放在这里（尺寸和位置都设完）才是有效的。
        #
        # 【单位：物理像素】
        #   SetWindowRgn 吃的是物理像素，而 $win.Width 是逻辑像素。
        #   所以要用 GetDpiScale 换算，否则 200% 缩放下裁出来的形状只有半个胶囊。
        # 【v0.9.8：主动清掉 region，让窗口恢复完整矩形】
        #
        #   为什么要主动清而不是"什么都不做"：
        #     卡片可能是从旧版本热更新上来的（用户不一定重启），
        #     那时窗口上还挂着 v0.9.4 留下的胶囊 region。
        #     不清掉的话，新形状是矩形、窗口却被裁成圆角 —— 更难看。
        #     所以每次进柱态都显式清一次，代价是一次 API 调用。
        try {
            [void][PanelNative]::ClearWindowRgn($hwnd)
            Log-Card '柱态形状：纯直角矩形（不裁剪，磨砂与窗口矩形完全重合）'
        } catch {
            Log-Card ('柱态清 region 失败（不影响功能）: ' + $_.Exception.Message)
        }
    } catch {
        Log-Card ('Set-BarGeometry 失败: ' + $_.Exception.Message)
    }
}

# 进入柱态
function Enter-BarMode {
    param([string]$Side = 'right')

    try {
        if (-not $BarEnabled) { return $false }
        if ($script:mode -eq 'bar') { return $false }

        # 1) 记住现状（退出时原样还原）
        $script:barRestore = [pscustomobject]@{
            Mode   = $script:mode
            Left   = [double]$win.Left
            Top    = [double]$win.Top
            Width  = [double]$win.Width
            Height = [double]$win.Height
            Rows   = $script:curRows
        }
        $script:barRestoreCenterY = [double]$win.Top + ([double]$win.Height / 2)

        # 2) 【冲突处理①】清掉"拖动后待补套的宽度"
        #    否则 MouseLeftButtonUp 尾部的补套逻辑会把柱宽覆盖回 260
        $script:pendingWidth = $null

        # 3) 【冲突处理②】先把"进柱前"的正常坐标存好
        #    Save-Position 只在柱态外调；进柱后不调，
        #    否则下次启动卡片会变成 14 宽、贴在屏幕边上
        Save-Position

        # 4) 切形态
        $script:mode = 'bar'
        $exp.Root.Visibility  = 'Collapsed'
        $mini.Root.Visibility = 'Collapsed'
        if ($null -ne $script:bar) { $script:bar.Root.Visibility = 'Visible' }

        # 【v0.9.2】关掉 DWM 的黑边框和系统圆角，把整个窗口让给自绘胶囊。
        #   原因（用户实测截图逐像素证明）见 PanelNative.ClearDwmFrame 的注释：
        #   属性 34 传 1 = 让系统把边框涂成 COLORREF 1（近乎纯黑），
        #   在 14 像素宽的柱态窗口上，左右黑框吃掉约 2.5 逻辑像素，
        #   胶囊塞不进去只能靠左，表现就是"色条不居中 + 磨砂没填满黑框"。
        #   放在 Set-BarGeometry 之前：先去掉装饰再改尺寸，
        #   避免改尺寸时 DWM 按旧边框重算一次可绘制区域。
        try { [void][PanelNative]::ClearDwmFrame($hwnd) } catch { }
        # 改窗口尺寸会把 DWM 属性冲掉，改完再刷一次（和 Update-Glass 同一个道理）
        Set-BarGeometry -Side $Side
        try { [void][PanelNative]::ClearDwmFrame($hwnd) } catch { }

        # 5) 立刻刷一次颜色条（不等下一次 500ms Tick，避免"白柱子闪一下"）
        try {
            $ph = $script:curPhase
            if ([string]::IsNullOrEmpty($ph)) { $ph = 'idle' }
            Update-BarStrip -Phase $ph
        } catch { Log-Fail 'L4355' $_ }

        Update-Glass

        # 【v0.9.5】进柱态时先把气泡藏起来 —— 拖到边缘触发变柱的那一刻，
        # 光标可能正好在窗口上，MouseMove 会立刻弹气泡，看起来像"刚缩成柱子
        # 就冒出一块东西"。等用户真的把鼠标移上去再显示，才符合预期。
        Hide-BarTip

        Log-Card ('进入柱态（' + $Side + ' 侧，' + $BarWidth + 'x' + $BarHeight + '）')
        return $true
    } catch {
        Log-Card ('进入柱态失败: ' + $_.Exception.Message)
        # 失败要把 mode 退回去，否则会卡在"以为自己是柱态但其实是展开态"
        $script:mode = ''
        return $false
    }
}

# 退出柱态（回到缩小前的形态和位置）
function Exit-BarMode {
    if ($script:mode -ne 'bar') { return $false }

    try {
        $r = $script:barRestore
        if ($null -ne $r) {
            # 先恢复尺寸，再恢复位置 —— 反过来的话 Clamp-Position 会按小尺寸夹一次
            $win.Width  = $r.Width
            $win.Height = $r.Height
            $win.Left   = $r.Left
            $win.Top    = $r.Top
        }

        if ($null -ne $script:bar) { $script:bar.Root.Visibility = 'Collapsed' }

        # 【冲突处理③】强制下一帧重算高度
        #    Set-WindowHeight 开头有 `if ($script:curHeight -eq $TargetHeight) { return }`。
        #    柱态把 curHeight 改成了 120，如果不重置，
        #    万一展开态目标高度恰好也是 120 就会误早退。
        $script:curHeight = -1
        # mode 置空，强制下一帧 Set-WindowMode 真正执行（它也有早退）
        $script:mode = ''
        $script:barRestore = $null

        # 【v0.9.2】把 DWM 装饰恢复成卡片的正常样式（圆角 + 正常边框 + 深浅模式）。
        #   必须在退出柱态时还原，否则卡片会一直顶着"无圆角无边框"的样子。
        #   插在 Clamp-Position 之前：先恢复装饰再夹位置，
        #   避免 Clamp 按柱态的小尺寸算完后 DWM 又改一次可绘制区。
        try { [void][PanelNative]::RestoreDwmFrame($hwnd, $(if ($script:curIsLight) { 0 } else { 1 })) } catch { }

        # 【v0.9.4】取消窗口形状裁剪。
        #   【为什么必须做】柱态时用 SetWindowRgn 把窗口裁成了胶囊。
        #   region 是**跟着窗口走**的：如果不取消，回到展开态（260×368）时
        #   整个卡片会被裁成一根巨大的竖胶囊，四角全被切掉。
        #   传 IntPtr.Zero 表示"恢复整个窗口矩形"。
        #   放在 Clamp-Position 之前，让后续布局按完整矩形计算。
        try { [void][PanelNative]::ClearWindowRgn($hwnd) } catch { }

        # 【v0.9.5】退出柱态必须收起气泡。
        #   不收的话，"柱子没了、气泡还浮在屏幕上"，而且它 IsHitTestVisible=False
        #   用户点不掉也关不掉，只能等下次进柱态才被藏起来 —— 非常难受。
        Hide-BarTip

        Clamp-Position
        Update-Glass
        Log-Card '退出柱态，已还原到缩小前的形态和位置'
        return $true
    } catch {
        Log-Card ('退出柱态失败: ' + $_.Exception.Message)
        $script:mode = ''
        $script:barRestore = $null
        return $false
    }
}

# 判断"这次松手要不要变柱"（方案甲的判据）
#
# 【为什么不能用"窗口越出屏幕的距离"当阈值】
#   实测（_lab\probe-dragmove-auto.ps1）：Windows 把光标锁在虚拟屏范围内，
#   光标到不了屏幕外 → 窗口也拖不出去 → 越界距离永远读到 0。
#
# 【改成两个都能真实观测的量】
#   ① 窗口边缘已贴到工作区边缘（吸边逻辑执行后必然满足）
#   ② 松手瞬间光标距工作区边缘 ≤ $BarEdgeTolerance
#
# 【单位】三者单位不同，必须统一：
#   · $win.Left / $win.Width  → 逻辑（WPF）
#   · Get-WorkArea            → 逻辑（实测确认，见 Get-WorkArea 的注释）
#   · Cursor.Position         → 物理（Win32）
#   所以判据①直接用逻辑比；判据②要把光标换算成逻辑（÷scale）或者把边缘换成物理（×scale）。
#   这里选"把光标换算成逻辑"，因为逻辑是 WPF 的原生单位、误差更小。
function Test-CollapseTrigger {
    param([int]$CursorX, [int]$CursorY)

    $result = [pscustomobject]@{ Hit = $false; Side = ''; Reason = '' }

    try {
        if (-not $BarEnabled) { $result.Reason = 'barEnabled=false'; return $result }
        if ($script:mode -eq 'bar') { $result.Reason = 'already-bar'; return $result }

        # 缩放比：算一次缓存起来（见 Get-DpiScale 的说明）
        if ($null -eq $script:dpiScale -or $script:dpiScale -le 0) {
            $script:dpiScale = Get-DpiScale
        }
        $scale = [double]$script:dpiScale
        if ($scale -le 0) { $scale = 1.0 }

        # 光标物理 → 逻辑
        $curLogicalX = [double]$CursorX / $scale

        $wa = Get-WorkArea

        # 光标距左右边缘（逻辑像素）
        $distLeft  = $curLogicalX - [double]$wa.Left
        $distRight = [double]$wa.Right - $curLogicalX

        # 窗口是否已经贴边（容差给 edgeMargin + 一点，因为吸边会把窗口放到 edgeMargin 处）
        $winAtLeft  = (( [double]$win.Left - [double]$wa.Left) -le ([double]$edgeMargin + 4))
        $winAtRight = ((([double]$wa.Right - ([double]$win.Left + [double]$win.Width))) -le ([double]$edgeMargin + 4))

        if (($distLeft -le $BarEdgeTolerance) -and $winAtLeft) {
            $result.Hit = $true
            $result.Side = 'left'
            $result.Reason = ('左边缘顶住 distLeft={0:N1} 逻辑' -f $distLeft)
            return $result
        }
        if (($distRight -le $BarEdgeTolerance) -and $winAtRight) {
            $result.Hit = $true
            $result.Side = 'right'
            $result.Reason = ('右边缘顶住 distRight={0:N1} 逻辑' -f $distRight)
            return $result
        }

        $result.Reason = ('未达阈值 distLeft={0:N1} distRight={1:N1} winAtL={2} winAtR={3}' -f `
            $distLeft, $distRight, $winAtLeft, $winAtRight)
        return $result
    } catch {
        $result.Reason = '判据异常: ' + $_.Exception.Message
        return $result
    }
}

# ---------------------------------------------------------------- 悬浮窗审批：写决定文件（v0.8.0）
#
# 【这个函数是卡片侧唯一的"决定出口"】
#   它把用户点的「允许/拒绝」写成一个 json 文件，插件轮询后 resolve 审批 Promise。
#
# 【必须带 nonce】
#   nonce 是插件攥住审批时随机生成、写进 state.json 给卡片看的一次性串。
#   插件收到文件后要求 nonce 完全匹配 —— 对不上就丢弃。
#   这一条挡的是：手滑写错文件、过期文件被误用、手工改 json。
#   （挡不住"已经拿到文件权限的恶意程序"，但那类程序本来就能干任何事）
#
# 【为什么写 .tmp 再 Move】
#   插件每 250ms 扫一次目录。如果直接写目标文件名，
#   插件可能正好读到"写了一半"的内容 → JSON 解析失败 → 这个决定被错误丢弃。
#   先写 .tmp（`.tmp` 后缀不在扫描范围内），写完再改名，插件永远读到完整文件。
#
# 【为什么文件名用 approvalId】
#   插件按 approvalId 找攥住的记录。用别的名字还得解析内容才能定位。
function Write-ApprovalDecision {
    param(
        [string]$ApprovalId,
        [string]$Outcome,
        [string]$Nonce,
        [string]$RequestId
    )

    try {
        if ([string]::IsNullOrWhiteSpace($ApprovalId)) { return $false }
        if ([string]::IsNullOrWhiteSpace($Nonce)) { return $false }
        if ($Outcome -ne 'allowed-once' -and $Outcome -ne 'rejected') { return $false }
        if (-not (Test-Path $DecisionsDir)) {
            New-Item -ItemType Directory -Force -Path $DecisionsDir | Out-Null
        }

        $payload = [ordered]@{
            approvalId = $ApprovalId
            outcome    = $Outcome
            nonce      = $Nonce
            ts         = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
            requestId  = $RequestId
            source     = 'desktop-card'
        }
        $json = $payload | ConvertTo-Json -Compress

        # 文件名里不能有路径分隔符；approvalId 是 uuid，安全。
        # 保险起见还是把非法字符换掉，避免手工构造的 id 写坏路径。
        $safe = ($ApprovalId -replace '[\\/:*?"<>|]', '_')
        $target = Join-Path $DecisionsDir ($safe + '.json')
        $tmp    = Join-Path $DecisionsDir ($safe + '.json.tmp')

        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        # PS 5.1 没有 [IO.File]::Move(a,b,true) 三参数重载（交接文档 4.3），
        # 所以先删目标再 Move。
        if (Test-Path $target) { Remove-Item $target -Force -ErrorAction SilentlyContinue }
        [System.IO.File]::Move($tmp, $target)

        Log-Card ('已写审批决定: ' + $Outcome + ' id=' + $ApprovalId.Substring(0, [Math]::Min(8, $ApprovalId.Length)))
        return $true
    }
    catch {
        Log-Card ('写审批决定失败: ' + $_.Exception.Message)
        return $false
    }
}

# 生成一个 requestId（回执用：插件处理完会把结果带着这个 id 写回 state.json）
function New-DecisionRequestId {
    return [guid]::NewGuid().ToString('N').Substring(0, 16)
}

# 二次确认（开关打开 + approvalConfirm 时，点「允许」前先问一句）
#
# 【为什么允许不用原生 MessageBox】
#   卡片是 Topmost + WS_EX_NOACTIVATE 工具窗。MessageBox 会抢走激活权，
#   弹在卡片后面或者让卡片失去置顶，体验很差（第三轮事故的邻居问题）。
#   这里用一个轻量 WPF 小窗，跟随卡片位置，不抢焦点。
function Confirm-ApprovalAllow {
    param([string]$Title, [string]$ToolName)

    try {
        $dlg = New-Object System.Windows.Window
        $dlg.WindowStyle = 'None'
        $dlg.ResizeMode = 'NoResize'
        $dlg.AllowsTransparency = $true
        $dlg.Background = [System.Windows.Media.Brushes]::Transparent
        $dlg.ShowInTaskbar = $false
        # 【v0.9.14】跟随主窗口置顶状态。
        #   这个对话框是"点允许前再确认一次"那个。它必须**至少和主窗口一样靠前**，
        #   否则用户点完看不见它（被主窗口挡住），会以为点击没反应。
        #   关掉置顶时它也跟随下沉，但仍会盖在主窗口之上（后创建的窗口在上）。
        $dlg.Topmost = [bool]$script:topmostEnabled
        $dlg.Width = 240
        $dlg.Height = 132

        # 跟在卡片左侧，别挡住卡片本身
        $dlg.Left = [Math]::Max(0, $win.Left - 250)
        $dlg.Top  = $win.Top + 20

        $outer = New-Object System.Windows.Controls.Border
        $outer.CornerRadius = New-Object System.Windows.CornerRadius(10)
        $outer.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(0xF2, 0x22, 0x24, 0x28))
        $outer.BorderThickness = New-Object System.Windows.Thickness(1)
        $outer.BorderBrush = New-Brush ([System.Windows.Media.Color]::FromArgb(0x40, 0xFF, 0xFF, 0xFF))
        $dlg.Content = $outer

        $stack = New-Object System.Windows.Controls.StackPanel
        $stack.Margin = New-Object System.Windows.Thickness(14, 12, 14, 12)
        $outer.Child = $stack

        $t1 = New-UiText -Text '确定允许这次操作？' -Size 12.5 -Brush (New-Brush ([System.Windows.Media.Color]::FromArgb(0xFF, 0xF2, 0xF4, 0xF8))) -Weight ([System.Windows.FontWeights]::SemiBold)
        [void]$stack.Children.Add($t1)

        $t2 = New-UiText -Text ([string]$ToolName) -Size 11 -Brush (New-Brush ([System.Windows.Media.Color]::FromArgb(0xFF, 0xA8, 0xB0, 0xBC)))
        $t2.Margin = New-Object System.Windows.Thickness(0, 4, 0, 0)
        $t2.TextTrimming = 'CharacterEllipsis'
        [void]$stack.Children.Add($t2)

        $row = New-Object System.Windows.Controls.StackPanel
        $row.Orientation = 'Horizontal'
        $row.HorizontalAlignment = 'Right'
        $row.Margin = New-Object System.Windows.Thickness(0, 14, 0, 0)
        [void]$stack.Children.Add($row)

        $script:dialogResult = $false

        $bNo = New-ApprovalButton -Text '取消' -Kind 'reject'
        $bNo.Margin = New-Object System.Windows.Thickness(0, 0, 8, 0)
        $bNo.Add_MouseLeftButtonUp({
            try { $script:dialogResult = $false; $script:confirmDlg.Close() } catch { }
        })
        [void]$row.Children.Add($bNo)

        $bYes = New-ApprovalButton -Text '确定允许' -Kind 'allow'
        $bYes.MinWidth = 68
        $bYes.Add_MouseLeftButtonUp({
            try { $script:dialogResult = $true; $script:confirmDlg.Close() } catch { }
        })
        [void]$row.Children.Add($bYes)

        $script:confirmDlg = $dlg
        [void]$dlg.ShowDialog()
        return $script:dialogResult -eq $true
    }
    catch {
        Log-Card ('二次确认弹窗失败: ' + $_.Exception.Message)
        # 弹窗失败时**按取消处理**（安全侧）：宁可让用户再点一次，
        # 也不能因为 UI 出问题就默默放行
        return $false
    }
}

# 记录"卡片顶端位置"，展开/收起时保持顶部不动，不会上下跳
$script:anchorTop = $null
$script:anchorLeft = $null

if ($null -ne $startLeft -and $null -ne $startTop) {
    $win.Left = $startLeft
    $win.Top = $startTop
}
else {
    $win.Left = $work.Right - $CardWidth - 40
    $win.Top  = $work.Top + [int](($work.Height - $CardHeight) * 0.42)
}
Clamp-Position

$script:anchorLeft = [double]$win.Left
$script:anchorTop  = [double]$win.Top

# ---------------------------------------------------------------- 六档高度
# 卡片有六个尺寸，按"要显示几行内容"决定，不再是"展开/收起"两态。
#
# 固定部分（见 PanelVisual.ps1）：
#   上留白 12 + 标题 30 + 分隔线 1 + 分隔线 1 + 底部 34 + 下留白 12 = 90
#   任务列表上下边距 4 + 4 = 8
# 每行任务占 54（行高 52 + 行间距 2）。
# 所以 N 行时高度 = 98 + 54N；N=5 时 = 368，正好是 260 的 1.414 倍。
#
#   档位        行数   高度    比例
#   无任务       -     96     收起扁条
#   1 个任务     1     152    1 : 0.58
#   2 个任务     2     206    1 : 0.79
#   3 个任务     3     260    1 : 1.00
#   4 个任务     4     314    1 : 1.21
#   5 个任务     5     368    1 : 1.41  ← 用户要的 A4 比例
$RowSlot    = 54
$FixedPart  = 98

# ---------------------------------------------------------------- 柱态常量
#
# 【v0.9.1 已整块上移到建面板之前（约 1417 行）】
#   原因见那里的注释：这些值必须在 New-BarPanel 之前就位，
#   否则柱子面板会被建成 0×0。此处不再重复定义，避免两个来源漂移。

function Get-HeightForRows {
    param([int]$Rows)
    if ($Rows -lt 1) { return $MiniHeight }
    if ($Rows -gt 5) { $Rows = 5 }
    return $FixedPart + $RowSlot * $Rows
}

$script:mode = ''              # 留空，保证第一次刷新一定真正按状态显示一次
$script:lastFinishedSeen = $null
$script:finishedUntil = $null
$script:showTokens = $true
$script:lastAlternate = [datetime]::Now
$script:rowPool = New-Object System.Collections.ArrayList
$script:lastLayoutKey = ''
$script:curHeight = $CardHeight
$script:curRows = -1

function Set-WindowHeight {
    param([int]$TargetHeight)

    if ($script:curHeight -eq $TargetHeight) { return }

    $script:curHeight = $TargetHeight
    $win.Height = $TargetHeight

    # 顶端锚点保持不动，卡片从下方伸缩，视觉上不会上下跳
    if ($null -ne $script:anchorTop) { $win.Top = $script:anchorTop }

    Clamp-Position
    $script:anchorTop  = [double]$win.Top
    $script:anchorLeft = [double]$win.Left

    # 尺寸变了必须重新刷磨砂，否则会留下白底
    Update-Glass
    $win.Dispatcher.BeginInvoke([action] { Update-Glass }, [System.Windows.Threading.DispatcherPriority]::Loaded) | Out-Null
}

# 切换 收起扁条 / 展开卡片 / 柱子
#
# 【v0.9.0 加了 'bar' 分支，注意两个要点】
#   1. 进 bar 时要显式把 exp / mini 藏掉（它们的 Visibility 由这里独占管理）
#   2. **柱态的尺寸和位置不在这里设**，由 Set-BarGeometry 做 ——
#      因为那需要工作区、柱高、贴边方向等信息，混在这里会让本函数职责过重，
#      而且 Set-WindowMode 现在还被 Apply-CardSettings 的"强制重排"逻辑调用
#      （它会先清 $script:mode = '' 再让下一帧重走），如果在里面做几何计算，
#      会重复触发位置计算。
function Set-WindowMode {
    param([string]$Mode)
    if ($script:mode -eq $Mode) { return }
    $script:mode = $Mode

    if ($Mode -eq 'bar') {
        $exp.Root.Visibility  = 'Collapsed'
        $mini.Root.Visibility = 'Collapsed'
        if ($null -ne $script:bar) { $script:bar.Root.Visibility = 'Visible' }
        # 几何由 Set-BarGeometry 定，这里不动尺寸
    }
    elseif ($Mode -eq 'mini') {
        $exp.Root.Visibility  = 'Collapsed'
        $mini.Root.Visibility = 'Visible'
        if ($null -ne $script:bar) { $script:bar.Root.Visibility = 'Collapsed' }
        Set-WindowHeight $MiniHeight
    }
    else {
        $mini.Root.Visibility = 'Collapsed'
        $exp.Root.Visibility  = 'Visible'
        if ($null -ne $script:bar) { $script:bar.Root.Visibility = 'Collapsed' }
        # 高度不在这里定，交给 Set-TaskList 按行数算，避免先设一次再改一次的抖动
    }
}

# 设置标题 + 状态色
#
# 【签名为什么从 $DotColor 改成 $Phase】
#   原来调用方直接传一个颜色，所以"圆点是什么色"的知识散在 Update-UI 的 switch 里。
#   现在标题文字也要按状态变色，而且颜色要分浅底/深底两套 —— 由 Set-Header 自己
#   查 $script:Palette + $script:curIsLight 决定，调用方只说明"我是哪个状态"。
#
# 【为什么圆点也改成只改 .Color 不再 New-Brush】
#   每次 New-Brush 都会造一个新画刷对象。这个函数每 500ms 被调一次，
#   卡片常驻跑一天就是十几万个短命对象。改成首次建一次、之后只改 .Color。
function Set-Header {
    param([string]$Text, [string]$Phase)

    $exp.HeadText.Text = $Text

    # 记住当前状态和文案。
    # 为什么记在这：Update-AdaptiveText 在明暗切换后需要"重算一次状态色"，
    # 但它不知道当前是哪个状态。记在这里，就不用去改 Update-UI 的调用处
    # （那块区域正在被别人改，尽量少碰）。
    $script:curPhase = $Phase
    $script:curHeadText = $Text

    # ---- 标题文字
    # 有专属状态色 → 用它；没有（running / idle）→ 抄共享画刷的当前颜色，
    # 保持"跟随壁纸明暗"的原有行为。
    $tc = Get-StateColor -Phase $Phase -Slot 'Text'
    if ($null -ne $tc) { $bHeadText.Color = $tc }
    else               { $bHeadText.Color = $bTextPrimary.Color }

    # ---- 圆点（展开态 + 收起态各一个）
    $dc = Get-StateColor -Phase $Phase -Slot 'Dot'
    if ($null -ne $dc) {
        if ($null -eq $exp.Dot.Fill)  { $exp.Dot.Fill  = New-Brush $dc }
        $exp.Dot.Fill.Color  = $dc
        if ($null -eq $mini.Dot.Fill) { $mini.Dot.Fill = New-Brush $dc }
        $mini.Dot.Fill.Color = $dc
    }

    # ---- 呼吸动画（v0.9.10）
    #
    # 【为什么放在 Set-Header 而不是 Update-UI 里单独算】
    #   Set-Header 是**唯一知道当前相位**的函数（它收到 $Phase 参数）。
    #   在别处再算一次"现在该不该呼吸"就是重复逻辑，两处一旦不一致
    #   就会出现"标题说运行中、点却不动"这种诡异状态。
    #
    # 【为什么每 500ms 调一次不会重置动画进度】
    #   BeginAnimation 用 replace 语义：重复调用会替换动画对象。
    #   这里有个真实的坑 —— 如果每次都 new 一个 DoubleAnimation 再 BeginAnimation，
    #   动画会**每 500ms 从头开始**，看起来是"呼吸到一半被打断重播"，
    #   比不呼吸更难看。
    #   所以下面 Set-DotsBreathingForPhase 内部对"已经在这个相位"的情况做了短路。
    Set-DotsBreathingForPhase -Dots @($exp.Dot, $mini.Dot) -Phase $Phase
}

# 为柱态悬停弹窗生成"人能看懂的一句话状态"（v0.9.5）
#
# 【为什么单独一个函数，不复用 Set-Header 的那套 switch】
#   Set-Header 那段逻辑是**写死在回调里**的（一堆 if/else 直接调 Set-Header），
#   而且它同时要改控件颜色、改窗口尺寸。悬停弹窗只需要"文字"，
#   不需要碰任何控件 —— 硬抽出来会把两个不相干的关注点拧在一起。
#   所以这里单独实现一份"只要文字"的版本。
#
# 【文字为什么和卡片标题保持一致】
#   用户在柱子里看到的字，应该和展开卡片后看到的标题是同一句，
#   否则会怀疑"是不是两个不同的状态"。所以规则照抄上面的：
#     running: N 个任务运行中 / 正在运行 / N 个子智能体在跑
#     approval: 有 N 项待你审批
#     finished: 已完成
#     idle: 空闲
function Get-StatusTextForPhase {
    param($State, [string]$Phase)

    if ($Phase -eq 'approval') {
        $n = 1
        try { if ($null -ne $State.approval) { $n = [int]$State.approval } } catch { }
        if ($n -gt 1) { return ("有 {0} 项待你审批" -f $n) }
        return '有 1 项待你审批'
    }
    if ($Phase -eq 'finished') {
        return '已完成'
    }
    if ($Phase -eq 'running') {
        $run = 0
        $sub = 0
        try { if ($null -ne $State.running) { $run = [int]$State.running } } catch { }
        try { if ($null -ne $State.subagentCount) { $sub = [int]$State.subagentCount } } catch { }
        $helper = ''
        if ($sub -gt 0) { $helper = (' · {0} 个子智能体' -f $sub) }

        if ($run -gt 1) { return (("{0} 个任务运行中" -f $run) + $helper) }
        if ($run -eq 1) { return ('正在运行' + $helper) }
        if ($sub -gt 1) { return ("{0} 个子智能体在跑" -f $sub) }
        if ($sub -eq 1) { return '子智能体在跑' }
        return '正在运行'
    }
    return '空闲'
}

# 组装柱态悬停气泡要显示的全部数据（v0.9.6 新增）
#
# 【为什么单独一个函数，不直接写在 Update-UI 的柱态分支里】
#   柱态分支里已经有一堆 try/catch 和早退逻辑，再塞 40 行数据组装进去，
#   下一次改气泡的人要在一堆柱态代码里翻找。抽出来之后：
#     · 气泡要显示什么，全在这一个函数里，一处改完
#     · Update-UI 里只剩一句 `$script:barTipData = New-BarTipData ...`
#     · 这个函数是**纯函数**（只读 $State/$Valley，不碰任何控件），能单独推理
#
# 【返回结构（Show-BarTip 直接消费）】
#   Phase      相位，决定圆点颜色（approval 红 / finished 绿 / running 蓝 / idle 灰）
#   StatusText 状态头文案，和卡片标题完全同句式
#   Tasks      任务明细数组，每项 { Title, Elapsed }
#   Overflow   超出 3 行没显示的条数
#   Today      "今日 X Token"
#   Valley     "谷时 还剩 X" / "谷时 还有 X"
#
# 【任务明细从哪来】
#   state.json 的 tasks.sessions[]（插件写的），每项有 title / elapsedSec / activity。
#   和展开卡片用的是同一份数据（Set-TaskList 也读这个），所以两边不会打架。
#
# 【为什么最多 3 行】
#   气泡是"瞥一眼"的信息层。3 行 + 一行"还有 N 个"足够判断要不要展开，
#   再多会把气泡撑到比柱子（120 高）还高，贴边时容易盖住相邻内容。
function New-BarTipData {
    param($State, [string]$Phase, $Valley)

    $tasks = New-Object System.Collections.ArrayList
    $overflow = 0
    # 【v0.9.7 行数从 3 涨到 4】
    #   去掉右边时长列后每行更窄，弹窗整体高度也降了（少了底部指标那一行）。
    #   多给一行不会撑破：4 行 × 约 17px = 68，加标题/分隔/提示约 60，总共 128，
    #   仍低于柱高 120 + 可溢出范围，且比原版（3 行 + 底部指标）还矮。
    $maxRows = 4

    try {
        if ($null -ne $State -and $null -ne $State.tasks) {
            $all = @($State.tasks)
            for ($i = 0; $i -lt $all.Count; $i++) {
                if ($i -ge $maxRows) { $overflow++; continue }
                $t = $all[$i]
                $title = [string]$t.Title
                if ([string]::IsNullOrWhiteSpace($title)) { $title = '未命名任务' }
                # 【v0.9.7】每个任务带自己的相位，用来给左边那个状态点上色。
                #   state.json 的 sessions 是"只含运行中的会话"（state.js 里 running.slice(0,10)），
                #   所以这里的任务默认都是 running。Phase 字段留给两种情况：
                #     ① 以后插件如果真的输出 idle/finished 的会话，这里自动跟着染色
                #     ② 下面"待审批"分支会显式写 approval
                $rowPhase = [string]$Phase
                try {
                    if ($null -ne $t.PSObject.Properties['Phase']) {
                        $p2 = [string]$t.Phase
                        if (-not [string]::IsNullOrEmpty($p2)) { $rowPhase = $p2 }
                    }
                } catch { Log-Fail 'L4913' $_ }

                # 【v0.9.10】把已跑时长取出来。
                #   【为什么必须 try/catch + 兜底 0】
                #     老版本的 state.json 没有 elapsedSec 字段（插件没升级时）。
                #     直接 [double]$t.Elapsed 会抛异常，把整行数据丢掉 —— 表现是
                #     "弹窗里任务名突然全没了"。兜底 0 之后最差只是显示 "0秒"。
                #   【为什么用 PSObject.Properties 判断而不是 $null -ne $t.Elapsed】
                #     PowerShell 对不存在属性的 $t.Elapsed 返回 $null 且**不报错**
                #     （非 StrictMode 下），所以两种写法都能防住；
                #     但显式判断属性存在更明确，且 StrictMode 下也安全。
                $elapsed = 0.0
                try {
                    if ($null -ne $t.PSObject.Properties['Elapsed']) {
                        $elapsed = [double]$t.Elapsed
                        if ($elapsed -lt 0) { $elapsed = 0 }
                    }
                } catch { $elapsed = 0.0 }

                [void]$tasks.Add([pscustomobject]@{
                    Title = $title
                    Phase = $rowPhase
                    # 【v0.9.10 新增】已跑时长，单位秒。
                    #   来源：state.json 的 tasks.sessions[].elapsedSec，
                    #   由插件 lib/state.js 每轮算出（Math.round((now - runningSince)/1000)）。
                    #   取不到就给 0，让 Format-Elapsed 输出 "0秒"，
                    #   而不是空白 —— 空白会让人以为这一行坏了。
                    Elapsed = $elapsed
                })
            }
        }
    } catch { Log-Fail 'L4944' $_ }

    # 只有子智能体在跑（主任务都停了）时，tasks 是空的但相位仍是 running。
    # 这时补一条说明，否则气泡会出现"2 个子智能体在跑"下面一片空白 ——
    # 用户会以为数据坏了。和展开卡片 Set-TaskList 里那条兜底行是同一个道理。
    if ($tasks.Count -eq 0 -and $Phase -eq 'running') {
        $sub = 0
        try { if ($null -ne $State) { $sub = [int]$State.subagentCount } } catch { $sub = 0 }
        if ($sub -gt 0) {
            [void]$tasks.Add([pscustomobject]@{
                Title = ('{0} 个子智能体正在跑' -f $sub)
                Phase = 'running'
            })
        }
    }

    # 待审批时也要给出明细，否则状态头说"有 1 项待你审批"、下面却是空的
    if ($tasks.Count -eq 0 -and $Phase -eq 'approval') {
        try {
            if ($null -ne $State -and $null -ne $State.approvals) {
                $aps = @($State.approvals)
                for ($i = 0; $i -lt $aps.Count; $i++) {
                    if ($i -ge $maxRows) { $overflow++; continue }
                    $ap = $aps[$i]
                    $title = [string]$ap.Title
                    if ([string]::IsNullOrWhiteSpace($title)) { $title = '有一项操作等待确认' }
                    # 【v0.9.7 审批行不再显示工具名】
                    #   用户要"简略"，而工具名（如 Bash）对"要不要去处理"这个判断没有帮助 ——
                    #   任务名本身已经说清是什么操作了。整行等于"红点 + 操作名"。
                    [void]$tasks.Add([pscustomobject]@{ Title = $title; Phase = 'approval' })
                }
            }
        } catch { Log-Fail 'L4976' $_ }
    }

    # ---- 底部两个指标，和展开卡片底部同一套文案
    $today = ''
    try {
        if ($null -ne $State) { $today = ('今日 {0} Token' -f (Format-Tokens $State.todayTokens)) }
    } catch { Log-Fail 'L4983' $_ }

    $valleyText = ''
    try {
        if ($null -ne $Valley) {
            if ($Valley.InValley) { $valleyText = ('谷时 还剩 {0}' -f (Format-Duration $Valley.Remaining)) }
            else                  { $valleyText = ('谷时 还有 {0}' -f (Format-Duration $Valley.Remaining)) }
        }
    } catch { Log-Fail 'L4991' $_ }

    # 【v0.10.8 · C2】把健康信息带进气泡快照。
    #
    # 【为什么气泡也要有】
    #   施工卡 C2-4 第 6 条要求三种形态（卡片 / 空闲小扁条 / 柱态气泡）
    #   用同一份健康判断。如果只有卡片提示、气泡不提示，
    #   用户缩成柱态后就看不到"数据拿不到"这件事了 ——
    #   而柱态恰恰是他"专注干活、不看卡片"的时候，更需要这个提示。
    #
    # 【为什么不直接持有 $State.Health】
    #   $script:barTipData 是一个**快照**，故意和 $State 解耦
    #   （见上面那段长注释：柱态下每帧重建，不能持有外部对象引用）。
    #   复制两个字段比持有整个 Health 对象更安全，也更好断言。
    $healthKind = 'ok'
    $healthMsg = ''
    try {
        if ($null -ne $State -and $null -ne $State.Health) {
            $healthKind = [string]$State.Health.Kind
            $healthMsg = [string]$State.Health.Message
        }
    } catch { $healthKind = 'ok'; $healthMsg = '' }

    return [pscustomobject]@{
        Phase      = $Phase
        StatusText = (Get-StatusTextForPhase -State $State -Phase $Phase)
        Tasks      = $tasks.ToArray()
        Overflow   = $overflow
        Today      = $today
        Valley     = $valleyText
        # 【v0.10.8 · C2】健康快照
        HealthKind = $healthKind
        HealthMsg  = $healthMsg
    }
}

# 把行复用起来，避免每次刷新都新建控件
function Get-Row {
    param([int]$Index)
    while ($script:rowPool.Count -le $Index) {
        $r = New-TaskRow -CardWidth $CardWidth
        $r.Name.Foreground = $bTextPrimary
        $r.Elapsed.Foreground = $bTextSecondary
        $r.Activity.Foreground = $bTextSecondary
        # 【v0.10.0】Token 小字也必须挂**共享画刷** $bTextSecondary（颜色用最弱的档）。
        #
        # 【为什么这一步不能省 —— 踩过同款坑】
        #   New-TaskRow 里给控件建的是私有画刷（New-Brush $script:ColTextSecondary）。
        #   而"深色壁纸变浅色壁纸时把字变深"这件事，是靠 Update-AdaptiveText
        #   （约 2781-2797 行）去改 $bTextPrimary / $bTextSecondary / $bTextTertiary
        #   这几个**共享画刷的颜色**实现的。私有画刷不在那张表里，改不到。
        #   所以这里必须换成共享画刷，否则浅色壁纸上这串小字会是错的颜色 ——
        #   而且完全不报错，只是"看着别扭"，和 v0.9.13 那个"日志说改过了、
        #   界面其实没改"是同一种病。
        #
        # 【为什么用 $bTextSecondary 而不是更弱的 tertiary】
        #   两个都是 v0.9.6 实测过对比度的档位（浅底 10.42 / 深底 13.94），
        #   和旁边的"正在做什么"同色，整行视觉更齐。用最弱档会让这串小字
        #   在磨砂上发虚，用户已经反馈过"小字可读性"问题。
        $r.Tokens.Foreground = $bTextSecondary
        $r.Root.Visibility = 'Collapsed'

        # ---- 审批按钮的点击事件（v0.8.0）
        #
        # 【为什么在 Get-Row 里挂，而不是每帧挂】
        #   行是复用的。每帧挂一次会让同一个控件上叠 N 个事件处理器，
        #   点一下触发 N 次（写 N 个决定文件）。所以只在**首次建这个复用槽**时挂一次。
        #
        # 【为什么点击后要 e.Handled = $true —— 这条最关键】
        #   整卡的点击是由 $host1.Add_MouseLeftButtonUp 处理的：
        #   按下和抬起位移 < 5 像素 → 认为是"点卡片" → 打开 DSH。
        #   而按钮在卡片内部。不阻止冒泡的话，点「允许」的同时
        #   会把 DSH 窗口拉到前台 —— 用户会觉得"我只是点了允许，怎么跳走了"。
        #   甚至更糟：拖拽流程被启动（$host1 的 MouseLeftButtonDown 会调 DragMove）。
        #   所以按钮的**按下**和**抬起**都必须吞掉。
        #
        # 【为什么要给按钮也挂 MouseLeftButtonDown】
        #   只挂 Up 不够：$host1 的 Down 会先启动 DragMove，
        #   一旦进入拖动状态，Up 就被 WPF 的拖动逻辑接管，按钮的 Click 可能收不到。
        #   两边都 $true 才是干净的。
        #
        # 【⚠ 血泪：事件块里读不到函数局部变量】
        #   最初写的是 Invoke-RowApprovalAction -Row $r，
        #   结果点击时日志写"找不到行索引" —— 因为 $r 是 Get-Row 的**局部变量**，
        #   事件块（Add_MouseLeftButtonUp 的 scriptblock）执行时 $r 已经是 $null。
        #   这就是交接文档里第三轮事故（DispatcherTimer 读不到局部变量导致整卡崩溃）
        #   的同一个坑，只是这次没崩，只是静默不工作。
        #
        #   解决办法：把行号**绑进控件自己的 Tag**。控件活在 UI 树里，
        #   事件触发时从 $s.Tag 取，不依赖任何局部变量。
        #   Tag 本来被 New-ApprovalButton 用来存 'allow'/'reject'，
        #   所以改成存一个 hashtable，两个信息都带上。
        $rowIndex = $script:rowPool.Count
        $r.BtnAllow.Tag  = @{ Kind = 'allow';  Index = $rowIndex }
        $r.BtnReject.Tag = @{ Kind = 'reject'; Index = $rowIndex }

        $r.BtnAllow.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
        $r.BtnReject.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })

        # 允许：需要二次确认（如果开关要求），然后写决定文件
        $r.BtnAllow.Add_MouseLeftButtonUp({
            param($s, $e)
            $e.Handled = $true
            try { Invoke-RowApprovalAction -Index ([int]$s.Tag.Index) -Kind 'allow' } catch {
                try { Log-Card ('点允许失败: ' + $_.Exception.Message) } catch { }
            }
        })

        # 拒绝：不需要二次确认（拒绝是安全侧的操作）
        $r.BtnReject.Add_MouseLeftButtonUp({
            param($s, $e)
            $e.Handled = $true
            try { Invoke-RowApprovalAction -Index ([int]$s.Tag.Index) -Kind 'reject' } catch {
                try { Log-Card ('点拒绝失败: ' + $_.Exception.Message) } catch { }
            }
        })

        [void]$exp.List.Children.Add($r.Root)
        [void]$script:rowPool.Add($r)
    }
    return $script:rowPool[$Index]
}

# 点审批按钮的统一处理入口（v0.8.0）
#
# 顺序：取这一行的上下文 → 判可用性 → （允许时）二次确认 → 写决定文件 → 提示
#
# 【为什么参数是 $Index 而不是 $Row】
#   行号由控件自己的 Tag 带进来（见 Get-Row 里的说明）——
#   事件块里读不到函数局部变量，只能靠控件自身携带数据。
function Invoke-RowApprovalAction {
    param([int]$Index, [string]$Kind)

    if ($Index -lt 0 -or $Index -ge $script:rowPool.Count) {
        Log-Card ('点审批按钮但行号无效: ' + $Index)
        return
    }

    $ctx = $null
    if ($null -ne $script:rowApprovalCtx -and $script:rowApprovalCtx.ContainsKey($Index)) {
        $ctx = $script:rowApprovalCtx[$Index]
    }
    if ($null -eq $ctx) {
        Log-Card '点审批按钮但没有上下文（可能行已刷新）'
        Set-RowHint $Index '这一条刚刚变了，请稍等'
        return
    }

    if (-not $ctx.Usable) {
        Log-Card '审批按钮不可用（已置灰），忽略点击'
        return
    }

    if ([string]::IsNullOrWhiteSpace($ctx.ApprovalId) -or [string]::IsNullOrWhiteSpace($ctx.Nonce)) {
        Log-Card '审批上下文缺 id/nonce，拒绝写决定'
        Set-RowHint $Index '数据不完整，请去 DSH 处理'
        return
    }

    # ---- 允许：二次确认（approvalConfirm 默认开）
    if ($Kind -eq 'allow') {
        $needConfirm = $true
        try { $needConfirm = [bool](Get-Setting $script:settings 'approvalConfirm' $true) } catch { }
        if ($needConfirm) {
            $ok = $false
            try { $ok = Confirm-ApprovalAllow -Title $ctx.Title -ToolName $ctx.ToolName } catch { $ok = $false }
            if (-not $ok) {
                Log-Card '用户在二次确认里取消了'
                return
            }
        }
    }

    # ---- 写决定文件
    $reqId = New-DecisionRequestId
    $outcome = if ($Kind -eq 'allow') { 'allowed-once' } else { 'rejected' }
    $wrote = Write-ApprovalDecision -ApprovalId $ctx.ApprovalId -Outcome $outcome `
        -Nonce $ctx.Nonce -RequestId $reqId

    if ($wrote) {
        if ($Kind -eq 'allow') { Set-RowHint $Index '已提交，等待 DSH 确认…' }
        else { Set-RowHint $Index '已拒绝' }
    }
    else {
        Set-RowHint $Index '提交失败，请去 DSH 处理'
    }
}

# 把某一行的第二行文字临时改成提示（3 秒后会被下一次 500ms 刷新覆盖回来）
function Set-RowHint {
    param([int]$Index, [string]$Text)
    try {
        if ($Index -ge 0 -and $Index -lt $script:rowPool.Count) {
            $script:rowPool[$Index].Activity.Text = $Text
        }
    } catch { Log-Fail 'L5146' $_ -Key 'L5146' }
}

function Set-TaskList {
    param($State, [string]$Phase)

    $maxRows = 5
    $rows = @()

    if ($Phase -eq 'approval') {
        for ($i = 0; $i -lt $State.approvals.Count; $i++) {
            $ap = $State.approvals[$i]
            # 【三态判断：决定这一行显示"去处理"还是"允许/拒绝"按钮】
            #   $ap.Answerable 是 $null = 插件没给 answerable 字段 = 开关关着（默认）
            #                  = 卡片只提供"去处理"跳转
            #   $true  = 扣住了，点「允许」真的会生效 → 显示两个按钮
            #   $false = 攥着但此刻点了不生效（心跳/会话/配对有问题）→ 按钮置灰
            #
            #   判据和 lib/approval-proxy.js 的 answerable 四条件一致：
            #   开关开 + 攥住了 + 会话没被淘汰 + 卡片心跳活。
            #   卡片不自己推理，只按这一个字段渲染 —— 契约越薄越不容易错。
            $inlineRow = ($null -ne $ap.Answerable)

            if ($inlineRow) {
                # 开关打开：右侧两个按钮，第二行给原因/工具名
                $act = if ($ap.ToolName) { ('需要你确认：' + $ap.ToolName) } else { '需要你确认这次操作' }
                $el = ''
            }
            else {
                # 开关关闭（默认）：还是老样子，点整卡去 DSH
                $act = '在 DSH 里点"允许"就能继续'
                $el = '待批准'
            }

            $rows += [pscustomobject]@{
                Title = $ap.Title
                Elapsed = $el
                Activity = $act
                Accent = [System.Windows.Media.Color]::FromArgb(255, 0xE0, 0x40, 0x40)
                Inline = $inlineRow
                Answerable = [bool]$ap.Answerable
                ApprovalId = $ap.Id
                Nonce = $ap.Nonce
                ExpiresAtMs = $ap.ExpiresAtMs
                ToolName = $ap.ToolName
            }
        }
        if ($rows.Count -eq 0) {
            $rows += [pscustomobject]@{
                Title = '有操作等待你确认'
                Elapsed = '待批准'
                Activity = '在 DSH 里点"允许"就能继续'
                Accent = [System.Windows.Media.Color]::FromArgb(255, 0xE0, 0x40, 0x40)
                Inline = $false
                Answerable = $false
                ApprovalId = ''
                Nonce = ''
                ExpiresAtMs = 0
                ToolName = ''
            }
        }
    }
    elseif ($Phase -eq 'finished') {
        $rows += [pscustomobject]@{
            Title = '全部任务已经跑完'
            Elapsed = '已完成'
            Activity = '空闲时会自动收起'
            Accent = [System.Windows.Media.Color]::FromArgb(255, 0x22, 0xA0, 0x5C)
        }
    }
    elseif ($Phase -eq 'running') {
        for ($i = 0; $i -lt $State.tasks.Count; $i++) {
            $rows += [pscustomobject]@{
                Title = $State.tasks[$i].Title
                Elapsed = (Format-Elapsed $State.tasks[$i].Elapsed)
                Activity = $State.tasks[$i].Activity
                # 【v0.10.0】这个任务自己今天用的 Token，显示在该行右下角。
                Tokens = (Format-TaskTokens $State.tasks[$i].Tokens)
                Accent = [System.Windows.Media.Color]::FromArgb(255, 0x2F, 0x6F, 0xE4)
            }
        }
        if ($rows.Count -eq 0) {
            if ($State.running -gt 0) {
                for ($i = 0; $i -lt $State.running; $i++) {
                    $rows += [pscustomobject]@{
                        Title = ("任务 {0}" -f ($i + 1))
                        Elapsed = ''
                        Activity = '正在运行'
                        Accent = [System.Windows.Media.Color]::FromArgb(255, 0x2F, 0x6F, 0xE4)
                    }
                }
            }
            else {
                # 【主任务都停了、只剩子代理在跑】
                #   必须给一行内容，不能留空。原因：卡片高度是按"实际行数"算的
                #   （Get-HeightForRows：0 行 → 96 = 扁条高度），如果这里不留行，
                #   phase 虽然是 running，卡片却会画成 96 高的扁条 ——
                #   而扁条里没有标题文字控件（PanelVisual.ps1 的 New-MiniPanel
                #   只有 Caption/Value/Dot），"3 个子智能体在跑"这句话**根本显示不出来**，
                #   用户看到的仍是"空闲扁条"，等于没修。
                #   所以这里补一行说明，行数=1 → 高度 152，和"1 个任务"同一档，
                #   98+54N 公式一个字不用改。
                $n = if ($State.subagentCount -gt 0) { $State.subagentCount } else { 1 }
                $rows += [pscustomobject]@{
                    Title = ("{0} 个子智能体正在跑" -f $n)
                    Elapsed = '进行中'
                    Activity = '主任务已结束，子代理还在干活'
                    Accent = [System.Windows.Media.Color]::FromArgb(255, 0x2F, 0x6F, 0xE4)
                }
            }
        }
    }

    # 超出的折成一行"还有 N 个"
    $overflow = 0
    if ($rows.Count -gt $maxRows) {
        $overflow = $rows.Count - $maxRows
        $rows = $rows[0..($maxRows - 1)]
    }

    $used = 0
    for ($i = 0; $i -lt $rows.Count; $i++) {
        $r = Get-Row $i
        $r.Name.Text = [string]$rows[$i].Title
        $r.Elapsed.Text = [string]$rows[$i].Elapsed
        $r.Activity.Text = [string]$rows[$i].Activity

        # 【v0.10.0】Token 小字。
        #
        # 【为什么用"字段在不在"判断，而不是直接取】
        #   $rows 里的对象形状不止一种：运行中的行有 Tokens 字段，
        #   而审批行 / 完成行 / "还有 N 个"溢出行**没有**这个字段。
        #   PowerShell 对不存在的属性取值会返回 $null 且不报错（非 StrictMode），
        #   所以直接取也行；但显式判断更明确，StrictMode 下也安全 ——
        #   和本文件里读 $t.Elapsed 的写法保持一致（约 4987 行的说明）。
        #
        # 【为什么每次都要显式赋值，包括赋空字符串】
        #   行是复用的（$script:rowPool）。上一帧是运行中的行、这一帧变成
        #   审批行时，如果不显式清空，那串 Token 会**留在审批行上** ——
        #   看起来像"这个待审批的操作花了 12.3k Token"，是错的。
        #   Actions 插槽那段（下面）踩过一模一样的坑，注释里有记录。
        #
        # 【为什么要同时管 Visibility —— 这条是复核时实测出来的】
        #   右列是 Auto 列，而一个"文本为空但可见"的 TextBlock 仍然带着
        #   8 像素左边距，于是 Auto 列宽 = 8 而不是 0。
        #   PS 5.1 + WPF 实测（232 可用宽）：
        #     空文本、Visible  → 左列 224，右列 8   ← 白丢 8 像素
        #     空文本、Collapsed → 左列 232，右列 0   ← 和改动前逐像素一致
        #   也就是说，不设 Collapsed 的话，**所有没有 Token 的行**
        #   （审批行、完成行、溢出行、以及刚开始跑还没用量的行）
        #   都会比以前早一个字变成省略号 —— 那就违反了用户"其他 UI 一律不许动"。
        #   所以这里文本和可见性必须一起设，不能只设文本。
        $tokText = ''
        if ($null -ne $rows[$i].PSObject.Properties['Tokens']) {
            $tokText = [string]$rows[$i].Tokens
        }
        $r.Tokens.Text = $tokText
        # 空 → Collapsed：不占位、不参与布局，activity 拿回满宽
        # 非空 → Visible
        if ([string]::IsNullOrEmpty($tokText)) {
            $r.Tokens.Visibility = 'Collapsed'
        }
        else {
            $r.Tokens.Visibility = 'Visible'
        }

        $r.Root.Visibility = 'Visible'

        # ---- Actions 插槽（v0.8.0 悬浮窗审批）
        #
        # 【为什么在这里统一管，而不是在审批分支里直接设】
        #   行是**复用**的（$script:rowPool）。同一个控件这一帧在显示审批，
        #   下一帧可能变成普通任务行。如果只在审批时把 Actions 设成 Visible、
        #   不复位，普通任务行就会带着上一轮的按钮，看起来像"任务能点允许"。
        #   所以每一行每次刷新都必须显式决定 Actions 的可见性。
        #
        # 【为什么 Elapsed 和 Actions 二选一】
        #   两者占的还是同一列（第 1 列）。同时显示会互相挤压：
        #   232 可用宽 - 90(两按钮) = 142 给标题，再塞个"3分24秒"就挤没了。
        #   开关开时隐藏 Elapsed、显示按钮；开关关时反过来。
        $inline = ($null -ne $rows[$i].PSObject.Properties['Inline']) -and ($rows[$i].Inline -eq $true)
        if ($inline) {
            $r.Elapsed.Visibility = 'Collapsed'
            $r.Actions.Visibility = 'Visible'
            $r.BtnAllow.Visibility = 'Visible'
            $r.BtnReject.Visibility = 'Visible'

            # 置灰判断：Answerable=false 或 已过期 → 点了不会生效
            $expired = $false
            if ($rows[$i].ExpiresAtMs -gt 0) {
                $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                $expired = ($nowMs -gt [long]$rows[$i].ExpiresAtMs)
            }
            $usable = ($rows[$i].Answerable -eq $true) -and (-not $expired)

            # ⚠️ 这里**不能再写** $r.BtnAllow.Tag = 'allow'！
            #
            # 【为什么（Lead 踩过的真 bug）】
            #   Get-Row 在首次建行时把 Tag 设成了一个 hashtable：
            #       @{ Kind = 'allow'; Index = $rowIndex }
            #   点击回调靠 $s.Tag.Index 拿行号（因为 PowerShell 的事件块
            #   **读不到函数局部变量**，只能靠控件自身携带数据）。
            #
            #   我这里原来又写了一句 $r.BtnAllow.Tag = 'allow'（把 Tag 换成字符串），
            #   于是每次刷新都把行号抹掉了 → 点击时 $s.Tag.Index 是 $null →
            #   Invoke-RowApprovalAction 收到 Index=0 → 找不到上下文 → 静默不写决定文件。
            #   表现：点按钮完全没反应，连日志都没有（因为 0 是合法行号，走的是"没有上下文"分支）。
            #
            #   Kind 已经存在 Tag 里了，点击回调也是按哪个按钮区分 Kind 的，不需要重设。

            # 注意：PS 5.1 不支持 `??` 空合并运算符（那是 PowerShell 7 的语法，
            # 写 `$x ?? $y` 会报 "Unexpected token '??'"）。所以必须显式判空。
            if ($null -eq $script:rowApprovalCtx) { $script:rowApprovalCtx = @{} }
            $script:rowApprovalCtx[$i] = [pscustomobject]@{
                ApprovalId   = [string]$rows[$i].ApprovalId
                Nonce        = [string]$rows[$i].Nonce
                Usable       = $usable
                ToolName     = [string]$rows[$i].ToolName
                Title        = [string]$rows[$i].Title
            }

            # 不可用时降低不透明度 —— 这是"图形"级弱化（按钮底和边框），
            # 文字色不动，避免把字也一起压到看不清（对比度问题）。
            $op = if ($usable) { 1.0 } else { 0.45 }
            $r.Actions.Opacity = $op
            $r.Actions.Cursor = if ($usable) { [System.Windows.Input.Cursors]::Hand } else { [System.Windows.Input.Cursors]::Arrow }

            if (-not $usable) {
                $r.Activity.Text = if ($expired) { '这条已过期，请去 DSH 处理' } else { '暂不可用，请去 DSH 处理' }
            }
        }
        else {
            $r.Elapsed.Visibility = 'Visible'
            $r.Actions.Visibility = 'Collapsed'
            $r.Actions.Opacity = 1.0
            $r.Actions.Cursor = [System.Windows.Input.Cursors]::Arrow
        }

        $used++
    }

    if ($overflow -gt 0) {
        $r = Get-Row $used
        $r.Name.Text = ("还有 {0} 个任务" -f $overflow)
        $r.Elapsed.Text = ''
        $r.Activity.Text = ''
        # 【v0.10.0】溢出行没有具体的会话，不能留着上一帧的 Token。
        #   文本和可见性一起清 —— 只清文本的话那 8 像素左边距还在，
        #   溢出行会比改动前更挤（见渲染循环里那段实测说明）。
        $r.Tokens.Text = ''
        $r.Tokens.Visibility = 'Collapsed'
        $r.Root.Visibility = 'Visible'
        $used++
    }

    # 用不到的旧行藏起来
    for ($i = $used; $i -lt $script:rowPool.Count; $i++) {
        $script:rowPool[$i].Root.Visibility = 'Collapsed'
    }

    # 按实际显示的行数决定卡片高度（六档自适应）
    if ($script:mode -eq 'expanded') {
        Set-WindowHeight (Get-HeightForRows $used)
    }
    $script:curRows = $used
    return $used
}

function Update-UI {
    param($State, $Valley)

    $now = [datetime]::Now

    # 刚完成 -> 记住一个截止时间
    if ($null -ne $State.lastFinished) {
        $key = [string]$State.lastFinished
        if ($key -ne $script:lastFinishedSeen) {
            $script:lastFinishedSeen = $key
            $script:finishedUntil = $now.AddSeconds(8)
        }
    }

    # 优先级：待审批 > 刚完成 > 运行中 > 空闲
    #
    # 【v0.6.0：加入"子智能体还在跑"这一档】
    #   插件从 v0.6.0 起在 state.json 里多报一个 tasks.subagentCount
    #   （只数运行中的子代理）。原来卡片完全看不见子代理，导致一个很坑的现象：
    #   主任务已经跑完、子代理还在跑时，running 变成 0，卡片判定成「空闲」，
    #   收成 96 高的扁条 + 灰点，用户以为没事了，其实还有活在跑。
    #
    #   所以这里让"子智能体还在跑"也算"有活干"：仍然进 running 相位，
    #   但不显示任何任务行（行数还是按主任务算），只在标题上写「· N 个子智能体」。
    #   六档高度公式 98+54N 一个字都不用改 —— 因为行数没变。
    #
    #   老 state.json 没有这个字段时，$State.subagentCount 由 Read-PanelState
    #   默认成 0，行为跟改动前完全一样（向后兼容）。
    #
    # 【v0.9.0：判定逻辑抽到 Get-PhaseFromState，本处只调用】
    #   柱态也要算相位（给颜色条上色），两份逻辑必然漂移，
    #   会出现"柱态显示绿色、展开态显示蓝色"这种不一致。
    $phase = Get-PhaseFromState -State $State -Now $now
    $script:curPhase = $phase

    # ===== v0.9.0 柱态早退 =====
    #
    # 【柱态只需要做一件事：更新颜色条】
    #   其余全部跳过 —— 下面那些代码要碰 $exp.* / $mini.* 的十几个控件，
    #   而柱态下它们全是 Collapsed：改了不显示，但照样触发 WPF 布局失效重算。
    #   每 500ms 一次、一天 17 万次，纯白烧 CPU。
    #
    # 【为什么放在"刚完成 8 秒窗口"更新之后】
    #   那个窗口（$script:finishedUntil）必须在柱态也维护，
    #   否则从柱态切回展开态时，"刚完成"绿点会立刻过期、不闪。
    if ($script:mode -eq 'bar') {
        try {
            Update-BarStrip -Phase $phase
        } catch {
            # 柱态出错绝不能把整卡带走（第三轮事故教训）
        }
        # ===== v0.9.6：填充气泡数据快照（修真 bug + 内容升级）=====
        #
        # 【v0.9.5 这里写的是 barStatus**Text**，但气泡读的是 barTip**Text**】
        #   两个名字差一个词，结果气泡永远拿不到值、永远显示"空闲"。
        #   现在写的是 Show-BarTip 真正会读的那个变量，名字只有一处定义
        #   （见上方 $script:barTipData 的长注释）。
        #
        # 【为什么在柱态早退之前填】
        #   下面那一大坨 Set-Header / 窗口尺寸逻辑柱态都不走，
        #   但悬停时需要"2 个任务运行中"这类人能看懂的话，
        #   所以在这里单独算一份，不改动任何展开态的行为。
        try {
            $script:barTipData = New-BarTipData -State $State -Phase $phase -Valley $Valley
        } catch {
            # 数据算不出来不能影响柱子本身（第三轮事故教训：柱态出错不能带走整卡）
            $script:barTipData = [pscustomobject]@{
                Phase = 'idle'; StatusText = '空闲'; Tasks = @()
                Overflow = 0; Today = ''; Valley = ''
            }
        }
        return
    }

    # 收起 / 展开
    if ($phase -eq 'idle') {
        Set-WindowMode 'mini'
    }
    else {
        Set-WindowMode 'expanded'
    }

    # 底部那行一直都在
    $exp.FootLeft.Text = ('今日 {0} Token' -f (Format-Tokens $State.todayTokens))
    if ($null -ne $Valley) {
        if ($Valley.InValley) {
            $exp.FootRight.Text = ('谷时 还剩 {0}' -f (Format-Duration $Valley.Remaining))
        }
        else {
            $exp.FootRight.Text = ('谷时 还有 {0}' -f (Format-Duration $Valley.Remaining))
        }
    }
    else {
        $exp.FootRight.Text = ''
    }

    switch ($phase) {
        'approval' {
            if ($State.approval -gt 1) {
                Set-Header ("有 {0} 项待你审批" -f $State.approval) 'approval'
            }
            else {
                Set-Header '有 1 项待你审批' 'approval'
            }
        }
        'finished' {
            Set-Header '已完成' 'finished'
        }
        'running' {
            # 「· N 个子智能体」角标：让用户知道除了看到的这些主任务，背后还有子代理在跑。
            # 为什么不单独占一行：六档高度公式是 98+54N、一行固定 54 高，
            # 加行会改变档位和 A4 比例；塞进标题里零成本、信息也够。
            $helper = ''
            if ($State.subagentCount -gt 0) {
                $helper = (' · {0} 个子智能体' -f $State.subagentCount)
            }

            if ($State.running -gt 1) {
                Set-Header (("{0} 个任务运行中" -f $State.running) + $helper) 'running'
            }
            elseif ($State.running -eq 1) {
                Set-Header ('正在运行' + $helper) 'running'
            }
            else {
                # 只有子智能体在跑（主任务已停）：标题必须说清楚，否则用户会以为没在干活
                if ($State.subagentCount -gt 1) {
                    Set-Header ("{0} 个子智能体在跑" -f $State.subagentCount) 'running'
                }
                else {
                    Set-Header '子智能体在跑' 'running'
                }
            }
        }
        default {
            Set-Header '空闲' 'idle'
        }
    }

    # ================================================================ 【v0.10.8 · C2】健康提示覆盖
    #
    # 【为什么放在 switch 之后而不是融进去】
    #   switch 里那套是"有活干时显示什么"，是**相位**逻辑。
    #   健康是另一个维度：它可能发生在任何相位下（比如正在跑的时候数据停了）。
    #   硬塞进 switch 会让两个维度互相纠缠，将来改动必然打架。
    #
    # 【覆盖规则：只在"拿不到数据"时覆盖标题】
    #   missing / readError / invalidJson —— 这三种是"根本读不到"，
    #   此时说什么"2 个任务运行中"都是编的，必须改成"数据未更新"。
    #
    #   stale —— 读到的是合法数据，只是旧了。
    #   标题**不覆盖**（内容本身是真实的，只是老了），
    #   而是在底部那行加一句轻提示。这样不会一过期就整个界面变脸。
    #
    #   ok / timeAnomaly —— 什么都不做。
    $health = $null
    try { $health = $State.Health } catch { $health = $null }

    $healthKind = 'ok'
    if ($null -ne $health) {
        try { $healthKind = [string]$health.Kind } catch { $healthKind = 'ok' }
    }

    if ($healthKind -eq 'missing' -or $healthKind -eq 'readError' -or $healthKind -eq 'invalidJson') {
        # 用 idle 相位配色（不抢眼、不冒充"出事了"），但文案明确说拿不到数据。
        Set-Header '数据未更新' 'idle'
    }

    Set-TaskList -State $State -Phase $phase

    # ---- 陈旧时的轻提示：只在底部那行加，不动标题、不动布局
    if ($healthKind -eq 'stale') {
        $exp.FootLeft.Text = ('今日 {0} Token · 数据未更新' -f (Format-Tokens $State.todayTokens))
    }

    # 收起态轮流显示 Token / 倒计时
    if ($script:mode -eq 'mini') {
        $elapsed = ($now - $script:lastAlternate).TotalSeconds
        if ($elapsed -ge $altSeconds) {
            $script:showTokens = -not $script:showTokens
            $script:lastAlternate = $now
        }
        if ($script:showTokens) {
            $mini.Caption.Text = '今日使用 Token'
            $mini.Value.Text = Format-Tokens $State.todayTokens
        }
        else {
            if ($null -ne $Valley) {
                $mini.Caption.Text = if ($Valley.InValley) { '距谷时结束' } else { '距谷时开始' }
                $mini.Value.Text = Format-Duration $Valley.Remaining
            }
            else {
                $mini.Caption.Text = '今日使用 Token'
                $mini.Value.Text = Format-Tokens $State.todayTokens
            }
        }
        $mini.Value.FontSize = if ($mini.Value.Text.Length -gt 8) { 19 } else { 25 }
    }
}

# ---------------------------------------------------------------- 拖动 / 点击 / 吸边
$script:dragStart = $null

# 【v0.9.5】柱态拖动用的三个状态（必须 $script:，事件回调读不到局部变量）
#
# 【为什么单独一套，不复用 $script:dragStart】
#   $script:dragStart 是"卡片拖动"用的，它的语义是"按下的光标位置"，
#   而柱态需要额外记住"窗口当时的左上角"，用来算新位置（绝对定位，避免误差累积）。
#   混用会让两条逻辑互相污染，所以分开。
#     barDragOrigin : 按下时光标的物理坐标（$null = 当前没在拖）
#     barDragWinLeft/Top : 按下时窗口的逻辑坐标
#     barDidDrag    : 这次按下后有没有真的移动过（用来区分"拖"和"点"）
$script:barDragOrigin = $null
$script:barDragWinLeft = 0.0
$script:barDragWinTop  = 0.0
$script:barDidDrag = $false

<#
 点卡片 -> 回到 DSH 的完整动作。

 为什么中间要"让位"：
   卡片是 Topmost（置顶）窗口。就算 DSH 被 SetForegroundWindow 切到前台，
   卡片仍然浮在 DSH 上面。用户看到的是"卡片还在最前面、DSH 没出来"，
   就会以为点击没生效 —— 这正是 v0.5.0 反馈的现象之一。

 所以：
   1. 先把卡片取消置顶（Topmost=$false），让它沉到普通层
   2. 激活 DSH
   3. 等 700ms，让用户看到 DSH 真的上来了
   4. 再把卡片恢复置顶 —— 否则卡片会被 DSH 完全盖住，用户找不到它

 为什么用定时器而不是 Start-Sleep：
   这是 WPF 的 UI 线程，Start-Sleep 会把界面冻住，
   连"取消置顶"这个动作都来不及渲染就被卡住了。

 【v0.5.2 事故：这里原来写错了，点一下卡片窗口就没了】
   原写法是：
       function Invoke-OpenDshFlow {
            $t = New-Object ...DispatcherTimer
            $t.Add_Tick({ $t.Stop(); ... })      # <-- 读的是函数局部变量 $t
       }
   问题：PowerShell 的事件处理脚本块**捕获不到函数的局部变量**。
   定时器在 700ms 后触发时，那个脚本块里 $t 是 $null，
   第一句 $t.Stop() 就抛 "You cannot call a method on a null-valued expression"。
   而这个异常发生在 WPF 定时器回调里，没人接住 ->
   WPF 认为应用该结束了 -> 卡片进程直接退出。

   因为"激活 DSH"是在抛出异常**之前**就完成的，所以用户看到的现象是：
   DSH 正常弹到前台了，卡片却凭空消失，而且等多久都不会自己回来。
   （心跳文件里 alive 还是 true、时间戳停在点击那一刻 —— 这正是
   被硬崩掉、没走到退出清理的特征。）

   修法：定时器存进 $script: 作用域。脚本级变量事件处理脚本块是能读到的
   （实测已确认：函数局部变量读不到，$script: 变量读得到）。
   另外整块加上 try/catch，双保险。
 #>
function Invoke-OpenDshFlow {
    try {
        # ================================================================
        # 【v0.9.14：关闭置顶时，整个"让位"流程直接跳过】
        #
        #   让位是为什么存在的：
        #     卡片原来是**永远置顶**。就算 SetForegroundWindow 把 DSH 切到前台，
        #     卡片仍然浮在 DSH 上面，用户看到"DSH 没出来"，以为点击没生效。
        #     所以要先取消置顶 → 激活 DSH → 700ms 后恢复置顶。
        #
        #   但用户关掉置顶之后，卡片本来就是普通窗口：
        #     · 它不在最前面，不可能挡住 DSH
        #     · 更没有"恢复置顶"这回事
        #   这时如果还跑那段让位逻辑，会出两个问题：
        #     ① 700ms 后那句"恢复"会执行 —— 如果它写死 $true，
        #        卡片就在用户明确关掉置顶之后又自己变回置顶了
        #        （这正是本方案最容易踩的坑，见 Set-TopmostMode 的注释）
        #     ② 白白多起一个定时器、多两次 DWM 状态扰动
        #
        #   所以整段跳过，只做"激活 DSH"这一件事。
        # ================================================================
        if (-not $script:topmostEnabled) {
            $ok = Open-Dsh
            return $ok
        }

        # 1. 让位
        try { $win.Topmost = $false } catch { }
        try { $win.Dispatcher.Invoke([action]{}, [System.Windows.Threading.DispatcherPriority]::Render) } catch { }

        # 2. 激活 DSH
        $ok = Open-Dsh

        # 3. 700ms 后恢复置顶
        #
        # 定时器必须存在 $script: 作用域里（理由见上面的注释）。
        # 先停掉上一个还没触发的，避免连点两次时后一个被前一个的 Tick 提前抹掉。
        if ($null -ne $script:restoreTopmostTimer) {
            try { $script:restoreTopmostTimer.Stop() } catch { }
            $script:restoreTopmostTimer = $null
        }

        $script:restoreTopmostTimer = New-Object System.Windows.Threading.DispatcherTimer
        $script:restoreTopmostTimer.Interval = [TimeSpan]::FromMilliseconds(700)
        $script:restoreTopmostTimer.Add_Tick({
            try {
                if ($null -ne $script:restoreTopmostTimer) { $script:restoreTopmostTimer.Stop() }
                # 【v0.9.14】恢复的是"用户设置的置顶状态"，不是写死的 $true。
                #   这里如果写死 $true，用户在 700ms 内关掉置顶就会被它覆盖回去。
                try { $win.Topmost = $script:topmostEnabled } catch { }
                try { Update-Glass } catch { }
            } catch {
                Log-Card ('恢复置顶失败: ' + $_.Exception.Message)
            }
        })
        $script:restoreTopmostTimer.Start()

        return $ok
    }
    catch {
        # 这个函数整体不能往外抛：它是鼠标/菜单回调，抛出去就会带走整个卡片
        Log-Card ('Invoke-OpenDshFlow 异常: ' + $_.Exception.Message)
        # 【v0.9.14】兜底也只恢复成用户设置的状态，不是 $true
        try { $win.Topmost = $script:topmostEnabled } catch { }
        return $false
    }
}

$host1.Add_MouseLeftButtonDown({
    # 【v0.9.5】柱态现在也能拖动（用户明确要求"胶囊态无法拖动位置，希望可以拖动"）
    #
    # 【为什么以前柱态故意不拖】
    #   旧注释的理由是"柱子太窄，拖动没意义，用户想要的是点一下展开"。
    #   而且 DragMove 是**阻塞**的：它内部跑一个自己的消息循环，
    #   会吃掉后续鼠标消息 —— 所以那时候 Down 里一拖，Up 里的"单击展开"就不执行了。
    #
    # 【现在怎么让"能拖"和"能点"共存】
    #   关键是**不用 DragMove**，改成手动跟手：
    #     Down：记下光标起点 + 窗口起点，不调 DragMove（不阻塞）
    #     Move：按光标位移量设置窗口位置
    #     Up：  位移小于阈值 → 当作单击（展开）；否则只算拖动，不展开
    #   这样既能拖，又不会吃掉点击。
    #   （Move 事件挂在 $win 上，见下方 Add_MouseMove）
    if ($script:mode -eq 'bar') {
        $script:barDragOrigin = [System.Windows.Forms.Cursor]::Position
        $script:barDragWinLeft = [double]$win.Left
        $script:barDragWinTop  = [double]$win.Top
        $script:barDidDrag     = $false
        return
    }

    $script:dragStart = [System.Windows.Forms.Cursor]::Position
    try { $win.DragMove() } catch { }
})

$host1.Add_MouseLeftButtonUp({
    # ===== v0.9.5 柱态：拖动 vs 单击，二选一 =====
    #
    # 【判据】位移超过 3 逻辑像素就算"拖动"，否则算"单击"
    #   3 是经验值：手抖一般不超过 2，超过 3 基本可以确定是有意拖。
    #   （用逻辑像素比，因为 $win.Left 是逻辑像素；光标是物理像素，
    #     所以要把物理位移除以缩放比再比 —— 见下面的 Get-DpiScale 换算）
    if ($script:mode -eq 'bar') {
        $moved = $false
        if ($null -ne $script:barDragOrigin) {
            $curPos = [System.Windows.Forms.Cursor]::Position
            $dpx = [Math]::Abs($curPos.X - $script:barDragOrigin.X)
            $dpy = [Math]::Abs($curPos.Y - $script:barDragOrigin.Y)
            # 物理像素 → 逻辑像素
            $sc = 1.0
            try { $sc = [double](Get-DpiScale) } catch { $sc = 1.0 }
            if ($sc -le 0) { $sc = 1.0 }
            $dlx = $dpx / $sc
            $dly = $dpy / $sc
            if ($dlx -gt 3 -or $dly -gt 3) { $moved = $true }
        }

        $script:barDragOrigin = $null
        $script:barDidDrag = $false

        if ($moved) {
            # 拖动结束了 —— 在这里决定柱子停在哪一侧
            #
            # 【为什么不直接留在松手的位置】
            #   柱子的语义是"贴边探头"，悬在屏幕中间会挡住内容。
            #   而且 Clamp-Position 也会把它拉回来。
            #   所以拖动松手后，按"窗口中心在屏幕左半还是右半"决定贴哪边，
            #   和卡片吸边是同一个思路（$edgeMargin 的量级）。
            try {
                $wa = Get-WorkArea
                $centerX = [double]$win.Left + ([double]$win.Width / 2)
                $midX = $wa.Left + ($wa.Width / 2)
                $side = if ($centerX -lt $midX) { 'left' } else { 'right' }

                # 垂直位置：保留用户拖到的高度（这才是"能拖动"的意义）
                #   只把水平方向重新贴边，垂直完全尊重用户。
                #   【为什么要夹一下】柱高 120，拖到屏幕最下面会超出工作区。
                $newTop = [double]$win.Top
                if ($newTop -lt $wa.Top) { $newTop = $wa.Top }
                if (($newTop + $BarHeight) -gt $wa.Bottom) { $newTop = $wa.Bottom - $BarHeight }

                $newLeft = if ($side -eq 'left') {
                    $wa.Left + $BarEdgeGap
                } else {
                    $wa.Right - $BarWidth - $BarEdgeGap
                }

                $win.Left = $newLeft
                $win.Top  = $newTop
                $script:anchorLeft = [double]$win.Left
                $script:anchorTop  = [double]$win.Top
                # Set_BarGeometry 会重算位置，这里不能调它（会覆盖用户拖的垂直位置）
                # 但窗口裁剪要重新做一次 —— 尺寸没变，形状本来就对，跳过即可。
                Log-Card ('柱态拖动结束：贴 ' + $side + ' 边，垂直 ' + $newTop)
            } catch {
                Log-Card ('柱态拖动收尾失败: ' + $_.Exception.Message)
            }
        } else {
            # 没怎么动 → 当作单击 → 展开
            try {
                [void](Exit-BarMode)
            } catch {
                Log-Card ('柱态单击展开失败: ' + $_.Exception.Message)
            }
        }
        return
    }

    if ($null -ne $script:dragStart) {
        $cur = [System.Windows.Forms.Cursor]::Position
        $dx = [math]::Abs($cur.X - $script:dragStart.X)
        $dy = [math]::Abs($cur.Y - $script:dragStart.Y)

        if ($dx -lt 5 -and $dy -lt 5) {
            if ($clickOpens) { [void](Invoke-OpenDshFlow) }
        }
        else {
            if ($snapToEdge) {
                $w = Get-WorkArea
                $centerX = $win.Left + ($win.Width / 2)
                $screenMid = $w.Left + ($w.Width / 2)
                if ($centerX -lt $screenMid) { $win.Left = $w.Left + $edgeMargin }
                else { $win.Left = $w.Right - $win.Width - $edgeMargin }
                Clamp-Position
            }
            $script:anchorLeft = [double]$win.Left
            $script:anchorTop  = [double]$win.Top
            Save-Position

            # ===== v0.9.0 方案甲：拖到边缘 + 光标顶住 → 松手变柱 =====
            #
            # 【为什么放在"吸边 + Save-Position"之后】
            #   1. 吸边先执行，窗口才会真的贴到边缘，判据① 才可能成立
            #   2. Save-Position 先执行，存的是"进柱前"的正常坐标
            #      （Enter-BarMode 里也会再存一次，双保险；而且这里存的是
            #        吸边之后的坐标，比拖动中的中间位置更合理）
            #   3. 然后才判要不要变柱
            #
            # 【为什么整个包在 try/catch 里】
            #   这是 WPF 鼠标事件回调，抛异常会带走整个卡片（第三轮事故）。
            try {
                if ($BarEnabled) {
                    $res = Test-CollapseTrigger -CursorX $cur.X -CursorY $cur.Y
                    if ($res.Hit) {
                        Log-Card ('触发柱态：' + $res.Reason)
                        [void](Enter-BarMode -Side $res.Side)
                    }
                }
            } catch {
                Log-Card ('柱态判据异常（已忽略）: ' + $_.Exception.Message)
            }
        }
    }
    $script:dragStart = $null

    # 拖动结束后补套"拖的时候没敢改的宽度"。
    # 为什么需要补：Apply-CardSettings 发现用户正在拖动时不会改窗口宽度
    # （否则宽度突变会让卡片跳位），而是记在 $script:pendingWidth。
    # mtime 那一次的"变更"已经被消费掉了，不会再来第二次，所以这里要主动补。
    #
    # 【v0.9.0】进柱态时 Enter-BarMode 已经把 $script:pendingWidth 置成 $null，
    # 所以这段不会把柱宽覆盖回 260 —— 这是方案 7.1 列的冲突①。
    if ($null -ne $script:pendingWidth) {
        try {
            $win.Width = [double]$script:pendingWidth
            Clamp-Position
            Save-Position
            Log-Card ('拖动结束后补套宽度: ' + $script:pendingWidth)
        } catch { Log-Fail 'L5816' $_ }
        $script:pendingWidth = $null
    }
})

# ================================================================ 柱态拖动跟随（v0.9.5）
#
# 【为什么挂在 $win 上而不是 $host1】
#   拖动时窗口本身在移动，光标会"离开" $host1 的命中区域，
#   挂在 $host1 上的 MouseMove 会在拖动中丢事件（表现为拖一半就不动了）。
#   挂 $win 上能持续收到（WPF 里窗口级别的事件覆盖整个客户区）。
#
# 【为什么不捕获鼠标（CaptureMouse）】
#   柱态窗口只有 14 宽，一旦 Capture 了，光标移出窗口后收不到 Up 事件，
#   会卡在"以为还在拖"的状态。用窗口级 MouseMove + 全局光标位置更稳。
$win.Add_MouseMove({
    try {
        if ($script:mode -ne 'bar') { return }

        # ---- v0.9.5 悬停显示气泡；v0.9.6 改成"每次都调"
        #
        # 【为什么在这里做，而不是挂 MouseEnter】
        #   柱态窗口是 WS_EX_NOACTIVATE，MouseEnter 在这种窗口上有时不触发
        #   （和 ToolTip 不稳定是同一个原因）。用 MouseMove 判断更可靠：
        #   只要光标在窗口里就会持续收到 Move，顺带就能判断"进入/离开"。
        #   代价是每次移动都判断一次 —— 只是一个布尔比较，可忽略。
        #
        # 【v0.9.6 为什么去掉 `if (-not $script:barTipVisible)` 这层判断】
        #   旧写法是"已经显示了就不再调"。但 Show-BarTip 现在还负责
        #   **刷新内容**（任务数变了、时间走了、Token 涨了）。
        #   如果只在"首次进入"时调一次，气泡里的数据会冻在鼠标放上去的那一刻，
        #   用户看到的就是"2 个任务"永远不变 —— 又是一个"看起来像卡的"假象。
        #   现在改成每次都调：Show-BarTip 内部有内容指纹，
        #   内容没变时只更新窗口位置（几次赋值），代价可以忽略。
        Show-BarTip

        if ($null -eq $script:barDragOrigin) { return }

        $cur = [System.Windows.Forms.Cursor]::Position
        $dpx = $cur.X - $script:barDragOrigin.X
        $dpy = $cur.Y - $script:barDragOrigin.Y

        # 物理像素 → 逻辑像素（$win.Left 是逻辑像素）
        $sc = 1.0
        try { $sc = [double](Get-DpiScale) } catch { $sc = 1.0 }
        if ($sc -le 0) { $sc = 1.0 }

        # 【为什么用"起点 + 位移"而不是"当前位置 - 上次位置"】
        #   累加式会累积舍入误差，拖久了会跑偏。
        #   每次都用起点的绝对值重算，误差不会累积。
        $newLeft = $script:barDragWinLeft + ($dpx / $sc)
        $newTop  = $script:barDragWinTop  + ($dpy / $sc)

        # 拖动中不贴边、不夹取 —— 让用户自由拖，松手时才归位（见 Up 事件）
        $win.Left = $newLeft
        $win.Top  = $newTop

        # 拖动时气泡跟着柱子走（否则会停在原地像"掉"了）
        if ($script:barTipVisible) {
            Show-BarTip
        }

        if ([Math]::Abs($dpx) -gt 3 -or [Math]::Abs($dpy) -gt 3) {
            $script:barDidDrag = $true
        }
    # 【故意静默】失败无害，下个周期会自动重试；记了会把日志刷爆
    } catch { }
})

# 鼠标离开柱子 → 收起气泡
#
# 【为什么同时挂 Leave 和主窗口的 MouseLeave】
#   $host1 是主内容网格，$win 是整个窗口。
#   挂两个是为了在"光标从柱态面板移到窗口边缘"和"完全离开窗口"两种情况下都能收到。
#   （都在 try/catch 里，气泡出问题不影响任何主功能）
$win.Add_MouseLeave({
    try {
        if ($script:mode -eq 'bar') {
            Hide-BarTip
            Log-Card '柱态气泡：隐藏'
        }
    } catch { Log-Fail 'L5896' $_ }
})

$host1.Add_MouseRightButtonUp({
    # ===== v0.9.0：菜单弹出前按当前形态更新菜单项文字 =====
    #
    # 【为什么必须在这里改，不能在建菜单时定死】
    #   同一个菜单项要随形态变文字：柱态显示「展开」、其它显示「缩成细条」。
    #   建菜单时还不知道用户会怎么用。
    #
    # 【为什么用 try/catch 包起来】
    #   这是鼠标事件回调，抛异常会带走整个卡片（第三轮事故）。
    #   $miBarToggle 在建菜单之后才存在，这里用 $null 检查兜底。
    try {
        if ($null -ne $miBarToggle) {
            if ($script:mode -eq 'bar') {
                $miBarToggle.Header = '展开'
            } else {
                $miBarToggle.Header = '缩成细条'
            }
            # 柱态下禁掉"设置…"以外的尺寸类操作没有意义，只改文字就够
        }
    } catch {
        Log-Card ('更新菜单文字失败: ' + $_.Exception.Message)
    }

    # ===== v0.9.14：菜单弹出前同步置顶勾选状态 =====
    #
    # 【为什么每次都要同步，不能在点击时改一次就完事】
    #   置顶状态有三个来源：
    #     ① 用户在菜单里点的           → IsChecked 已经对
    #     ② 卡片启动时读 settings.json → 建菜单时设过一次
    #     ③ 设置窗口改了 settings.json → **卡片完全不知道**
    #   第 ③ 种情况下，如果不同步，菜单里会显示一个过期的勾。
    #   用户看到"明明没勾着，卡片却浮在最前面"，会以为开关坏了。
    #   所以每次弹菜单都从 $script:topmostEnabled 重新对一次。
    #
    # 【为什么读 $script:topmostEnabled 而不是重读 settings.json】
    #   $script:topmostEnabled 是"**已经应用到窗口上**的那个状态"，
    #   而 settings.json 里可能是"用户刚改、但热更新还没跑到"的新值。
    #   菜单要反映界面的真实状态，不是文件的意图 —— 否则会点出"关两次才关掉"。
    try {
        if ($null -ne $miTopmost) {
            $miTopmost.IsChecked = [bool]$script:topmostEnabled
        }
    } catch { Log-Fail 'L5941' $_ }

    $menu.IsOpen = $true
})

# ---------------------------------------------------------------- 右键菜单
$menu = New-Object System.Windows.Controls.ContextMenu
$menu.PlacementTarget = $host1

$miSettings = New-Object System.Windows.Controls.MenuItem
$miSettings.Header = '设置…'
$miSettings.Add_Click({
    $editor = Join-Path $ScriptDir 'Settings.ps1'
    if (Test-Path $editor) {
        # 【必须带 -WindowStyle Hidden】—— Lead 实测补上的（2026-10-28）
        #   不加这个参数时，powershell.exe 会先弹一个黑色控制台窗口，
        #   设置窗口浮在那个黑窗上面，用户看到的是"设置界面套着一个黑框"。
        #   实测截图确认：设置窗口本身是 WindowStyle=None + 圆角 + 磨砂，很干净，
        #   但底下那个 PowerShell 5.1 黑窗把整体观感毁了。
        #
        #   run-panel.bat 启动卡片时就是这么写的（-WindowStyle Hidden），这里漏了。
        #   属于既有的小瑕疵（第三批只重写 Settings.ps1 内部，这行调用一直是老样子），
        #   不是第三批改动引入的。
        Start-Process 'powershell.exe' -ArgumentList '-NoProfile','-STA','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"`"$editor`""
    }
    else {
        Start-Process 'notepad.exe' -ArgumentList "`"$SettingsPath`""
    }
})
[void]$menu.Items.Add($miSettings)

# ---------------------------------------------------------------- 置顶开关（v0.9.14）
#
# 【用户需求】"置顶功能放在卡片右键打开的菜单里"
#
# 【为什么用 IsCheckable（打勾）而不是来回改文字】
#   改文字的写法是「置顶 / 取消置顶」两个状态互相切换。
#   问题：用户看到「取消置顶」时，得想一下"当前是置顶着的吧？"才敢点。
#   打勾则是**直接显示状态**：勾着 = 现在置顶；没勾 = 现在不置顶。
#   一次看懂了，不用推理。
#
# 【为什么放在"设置…"下面、"回到 DSH"上面】
#   菜单顺序按"使用频率 + 相关性"排：
#     设置…         （低频但总要能找着）
#     置顶           （低频，调一次就很久不动）  ← 放这
#     缩成细条/展开  （中频）
#     回到 DSH      （高频）
#   把它和"设置…"挨着，因为两者都属"调整卡片本身"，而不是"操作内容"。
#
# 【柱态怎么同步】
#   不需要额外处理 —— 柱态和卡片态用的是**同一个窗口对象**（$win），
#   柱态只是改了尺寸和可见面板（Set-WindowMode 里只动 Visibility）。
#   所以 Topmost 一处生效，两边天然一致。
#   这一点和"柱态配色要单独维护"完全不同（那个是另一套画刷），
#   别把两件事混起来。
$miTopmost = New-Object System.Windows.Controls.MenuItem
$miTopmost.Header = '置顶'
$miTopmost.IsCheckable = $true
$miTopmost.IsChecked = [bool]$script:topmostEnabled
$miTopmost.Add_Click({
    try {
        # 点击 IsCheckable 的 MenuItem 后，IsChecked 已经被 WPF 自动翻转了，
        # 所以这里读到的就是"用户想要的新状态"。
        $on = [bool]$miTopmost.IsChecked
        Set-TopmostMode -Enabled $on
        Save-TopmostSetting -Enabled $on
        # 【v0.9.15】用户操作用统一前缀「用户:」，排查时 grep 这个就能还原用户干了什么
        Log-Card ('用户: 置顶 → ' + $(if ($on) { '开' } else { '关' }))
    } catch {
        Log-Card ('切换置顶失败: ' + $_.Exception.Message)
        # 失败要把勾选状态退回真实值，否则界面显示"开"但实际没开
        try { $miTopmost.IsChecked = [bool]$script:topmostEnabled } catch { Log-Fail 'L6054' $_ }
    }
})
[void]$menu.Items.Add($miTopmost)

$miOpenDsh = New-Object System.Windows.Controls.MenuItem
$miOpenDsh.Header = '回到 DSH'
$miOpenDsh.Add_Click({
    # 右键菜单也要走同一套"让位 -> 激活 -> 恢复置顶"流程，
    # 否则菜单里点了同样会被置顶的卡片挡住
    [void](Invoke-OpenDshFlow)
})
[void]$menu.Items.Add($miOpenDsh)

# ---------------------------------------------------------------- 缩成细条 / 展开（v0.9.0）
#
# 【用户拍板】方案甲（拖到边缘顶住）+ 方案乙（右键菜单）都要，
# 菜单文案要直白 —— 用「缩成细条」而不是「进入 bar 模式」。
#
# 【为什么 Header 要动态改】
#   同一个菜单项在柱态下应该显示「展开」，非柱态显示「缩成细条」。
#   改是在 MouseRightButtonUp 里做的（菜单弹出前），见那里。
#
# 【⚠️ 点击处理里只能读 $script: 变量和控件自己的 Tag】
#   Lead 上一轮踩过：事件块读不到函数局部变量，$r 是 $null，静默不工作。
#   这里读 $script:mode（脚本级，安全），侧面信息用 Tag 携带。
$miBarToggle = New-Object System.Windows.Controls.MenuItem
$miBarToggle.Header = '缩成细条'
$miBarToggle.Tag = 'right'      # 默认贴右边；以后想记住上次贴哪侧可以改这里
$miBarToggle.Add_Click({
    try {
        if ($script:mode -eq 'bar') {
            Log-Card '用户: 菜单 → 展开（退出柱态）'
            [void](Exit-BarMode)
        }
        else {
            # 【为什么从菜单进柱态时默认贴右侧】
            #   菜单是"我要安静一下"的显式意图，但没告诉程序贴哪边。
            #   选右侧是因为现有吸边逻辑的默认倾向（卡片常在右下角），
            #   而且和"拖到左边缘"那条路互补 —— 想要左边就拖过去。
            $side = 'right'
            try {
                if ($null -ne $miBarToggle -and $null -ne $miBarToggle.Tag) {
                    $side = [string]$miBarToggle.Tag
                }
            } catch { Log-Fail 'L6055' $_ }
            Log-Card ('用户: 菜单 → 缩成细条（' + $side + ' 侧）')
            [void](Enter-BarMode -Side $side)
        }
    } catch {
        Log-Card ('菜单切换柱态失败: ' + $_.Exception.Message)
    }
})
[void]$menu.Items.Add($miBarToggle)

$miReset = New-Object System.Windows.Controls.MenuItem
$miReset.Header = '回到默认位置'
$miReset.Add_Click({
    try {
        $w = Get-WorkArea
        $win.Left = $w.Right - $CardWidth - 40
        $win.Top  = $w.Top + [int](($w.Height - $win.Height) * 0.42)
        $script:anchorLeft = [double]$win.Left
        $script:anchorTop  = [double]$win.Top
        Clamp-Position
        Save-Position
        Log-Card ('用户: 回到默认位置 → (' + [int]$win.Left + ',' + [int]$win.Top + ')')
    } catch {
        Log-Fail '回到默认位置' $_
    }
})
[void]$menu.Items.Add($miReset)

$miReload = New-Object System.Windows.Controls.MenuItem
$miReload.Header = '重新读取设置'
$miReload.Add_Click({
    if (Test-Path $SettingsPath) {
        try {
            $fresh = Get-Content $SettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $script:valleyConfig = Get-Setting $fresh 'valley' $script:valleyConfig
            $script:altSeconds = [int](Get-Setting $fresh 'alternateSeconds' $script:altSeconds)
        } catch { Log-Fail 'L6085' $_ }
    }
})
[void]$menu.Items.Add($miReload)

[void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))

# ================================================================
# 导出诊断包（v0.9.15）
#
# 【为什么需要这个功能】
#   用户需求："方便在其他人使用中出现错误的时候方便反馈"。
#
#   没有这个功能之前，让别人反馈问题时得这么说：
#     "麻烦把 C:\Users\你的用户名\.dsh\desktop-card\ 下的 plugin.log、
#      panel.log、panel-debug.log、state.json、heartbeat.json、
#      settings.json 打包发给我"
#   对非技术用户，这段话大概率执行不到位 —— 可能只发了一个、
#   可能发错目录、也可能把整个目录（含审批凭据）打包了。
#
#   现在变成："右键卡片 → 导出诊断包，然后把它发给我。"
#
# 【设计原则：只打包"能帮上忙"的东西，其余一律不碰】
#   下面 excludes 那段是**安全边界**，不能为了"多收集点信息"而放宽。
#
# 【为什么打包到桌面而不是数据目录】
#   数据目录是隐藏的（.dsh 开头），用户根本找不到。
#   放桌面用户一眼就能看到、能拖进聊天窗口。
#
# 【为什么只取日志的后 2000 行】
#   完整日志可能有几 MB，微信/QQ 传大文件麻烦，而且真正有用的信息
#   几乎都在最后（出事之前那段）。2000 行足够覆盖十几分钟的密集操作。
function Export-DiagnosticPackage {

    # ---- 判定输出位置
    #
    # 【v0.9.15 修：不能只看"目录存在"，还要看"能不能写"】
    #   第一版只做了 Test-Path 判断，实测发现：
    #   卡片进程在某些环境下（沙箱、组策略、只读桌面）
    #   **目录存在但写不进去**，导出直接失败，而且报的是一句
    #   "Access to the path ... is denied"，用户完全看不懂。
    #
    #   所以改成"先试着写一个探测文件"，写成功才算可用。
    #   （实测就是这么抓到的：Test-Path 为真，但 Compress-Archive 失败。）
    $outDir = $null
    $candidates = @()
    try { $candidates += [Environment]::GetFolderPath('Desktop') } catch { }
    try { $candidates += (Join-Path $env:USERPROFILE 'Desktop') } catch { }
    try { $candidates += $DataDir } catch { }
    try { $candidates += $env:TEMP } catch { }

    foreach ($c in $candidates) {
        if ([string]::IsNullOrEmpty($c)) { continue }
        if (-not (Test-Path $c)) { continue }
        try {
            $probe = Join-Path $c ('.dsh-write-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
            [System.IO.File]::WriteAllText($probe, 'x', (New-Object System.Text.UTF8Encoding($false)))
            [System.IO.File]::Delete($probe)
            $outDir = $c
            break
        } catch {
            # 【故意静默】这个候选目录不可写，换下一个候选就行 —— 不是错误
            continue
        }
    }
    if ($null -eq $outDir) {
        return [pscustomobject]@{
            Ok = $false; Path = ''; Collected = @(); Skipped = @()
            Error = '找不到可写的目录（桌面、数据目录、临时目录都写不进去）'
        }
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $zipPath = Join-Path $outDir ('dsh-card-diag-' + $stamp + '.zip')

    # ---- 临时工作目录
    $work = Join-Path $env:TEMP ('dsh-diag-' + $stamp)
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    $collected = @()
    $skipped = @()

    try {
        # ---- ① 日志（只取尾部）
        #
        # 【为什么用 Get-Content -Tail 而不是整份复制】
        #   日志可能有几 MB，全打包既慢又大。
        #   出事前的那段几乎总在文件末尾。
        #
        # 【v0.9.15 修跨端问题：不再找 plugin.old.log】
        #   插件端日志改造后**不再生成** plugin.old.log 这个名字了，
        #   改成和卡片这边同一套命名：plugin.yyyyMMdd-HHmmss.log
        #   （理由：按天命名会在一天轮两次时静默覆盖，见 lib/logger.js 的注释。）
        #
        #   如果这里还写死 plugin.old.log，后果是：
        #   诊断包里永远缺少插件的历史日志，**而且不报错**（只是 skipped 里多一条）。
        #   排查时拿不到"上一份日志"，而 DSH 常常开好几天才轮转一次 ——
        #   也就是说缺的恰好是最有信息量的那段。
        #
        #   所以改成：主日志固定收，历史轮转文件用通配符抓最近的几个。
        $logSpecs = @(
            @{ Src = (Join-Path $DataDir 'plugin.log');     Dst = 'plugin.log';     Tail = 2000 },
            @{ Src = (Join-Path $DataDir 'panel.log');      Dst = 'panel.log';      Tail = 2000 },
            @{ Src = (Join-Path $DataDir 'settings.log');   Dst = 'settings.log';   Tail = 500 }
        )
        foreach ($ls in $logSpecs) {
            try {
                if (-not (Test-Path $ls.Src)) { $skipped += ((Split-Path -Leaf $ls.Src) + '（不存在）'); continue }
                # 【v0.9.15 修：必须显式 -Encoding UTF8】
                #   这是个真 bug，实测抓到的：
                #   PS 5.1 的 Get-Content **默认按 ANSI（本地代码页）读**，
                #   我们的日志是 UTF-8 写的。结果导出的日志里
                #   所有中文变成乱码（"测试日志" → "娴嬭瘯鏃ュ織"）。
                #
                #   这个 bug 的可怕之处：它**不会报错**。
                #   导出流程一切正常、zip 也生成了，
                #   但发过来的诊断包完全没法看 —— 等于白导。
                #
                #   （这个坑是本项目的常客：之前排查 panel.log 也踩过一次，
                #     换成 [System.IO.File]::ReadAllLines($p, UTF8) 才好。）
                $tail = @(Get-Content $ls.Src -Tail $ls.Tail -Encoding UTF8 -ErrorAction Stop)
                $dstPath = Join-Path $work $ls.Dst
                [System.IO.File]::WriteAllLines($dstPath, $tail, (New-Object System.Text.UTF8Encoding($false)))
                $collected += $ls.Dst
            } catch {
                $skipped += ((Split-Path -Leaf $ls.Src) + '（读取失败）')
            }
        }

        # 历史轮转日志也带上（能反映前几天的情况）
        #
        # 【v0.9.15：panel 和 plugin 两边都要抓】
        #   两边现在用同一套命名：<名字>.yyyyMMdd-HHmmss.log
        #   合并成一个循环处理，避免"改了一边忘了另一边"
        #   （这正是刚才 plugin.old.log 那个跨端问题发生的原因）。
        #
        #   每类最多 3 个：再多打包就太大了，而"最近 3 次轮转"
        #   已经能覆盖好几天到几周（取决于日志量）。
        try {
            $rotated = @()
            try {
                $rotated += @(Get-ChildItem -Path $DataDir -Filter 'panel.*.log' -File -ErrorAction SilentlyContinue |
                              Sort-Object LastWriteTime -Descending | Select-Object -First 3)
            } catch { }
            try {
                $rotated += @(Get-ChildItem -Path $DataDir -Filter 'plugin.*.log' -File -ErrorAction SilentlyContinue |
                              Sort-Object LastWriteTime -Descending | Select-Object -First 3)
            } catch { }
            foreach ($r in $rotated) {
                try {
                    # 轮转文件里可能有几 MB，也截一下尾部（免得诊断包过大）
                    $rt = @(Get-Content $r.FullName -Tail 500 -Encoding UTF8 -ErrorAction Stop)
                    [System.IO.File]::WriteAllLines((Join-Path $work $r.Name), $rt,
                        (New-Object System.Text.UTF8Encoding($false)))
                    $collected += $r.Name
                } catch {
                    $skipped += ($r.Name + '（读取失败）')
                }
            }
        } catch { }

        # ---- ② 状态文件（不含任何凭据）
        #
        # 【⚠️ 安全边界：这几个绝对不能打包】
        #   decisions/   —— 审批决定的 nonce，属于凭据
        #   Token 的分会话明细 —— 不存在独立文件：账本只活在插件内存里。
        #                        但**汇总数字会随 state.json 带出**，这点已在下面隐私说明里告知。
        #   holidays.json —— 无意义的几百 KB
        #   这里用白名单而不是黑名单：新增文件不会意外被打包进去。
        $stateSpecs = @('state.json', 'settings.json', 'heartbeat.json', 'panel-pos.json')
        foreach ($s in $stateSpecs) {
            try {
                $src = Join-Path $DataDir $s
                if (-not (Test-Path $src)) { $skipped += ($s + '（不存在）'); continue }
                Copy-Item $src (Join-Path $work $s) -Force -ErrorAction Stop
                $collected += $s
            } catch {
                $skipped += ($s + '（复制失败）')
            }
        }

        # ---- ③ 环境信息
        #
        # 【为什么这些重要】
        #   绝大多数"别人的环境不对"的 bug 都和这些有关：
        #   系统版本、DPI 缩放、多显示器、系统主题。
        #   没有这些信息，你只能反复问用户"你是什么系统""你缩放多少"。
        $envLines = New-Object System.Collections.ArrayList

        $valleyInfo = ''
        try {
            $dto = [DateTimeOffset]::Now
            $valleyInfo = $dto.ToString('yyyy-MM-dd HH:mm:ss zzz')
        } catch { }
        [void]$envLines.Add('生成时间      : ' + $valleyInfo)
        [void]$envLines.Add('卡片 PID      : ' + $PID)

        # 卡片跑的代码版本（用 scriptStampMs 还原）
        $stampText = '未知'
        try {
            if ($script:scriptStampMs -gt 0) {
                $dto2 = [DateTimeOffset]::FromUnixTimeMilliseconds($script:scriptStampMs)
                $stampText = $dto2.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
            }
        } catch { }
        [void]$envLines.Add('代码版本时间  : ' + $stampText + '   （= 进程启动时读到的 Panel.ps1 修改时间）')

        # 插件版本（读 package.json）
        try {
            $pkgPath = Join-Path (Split-Path -Parent $ScriptDir) 'package.json'
            if (Test-Path $pkgPath) {
                $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
                [void]$envLines.Add('插件版本      : ' + [string]$pkg.version)
            }
        } catch { }

        [void]$envLines.Add('PowerShell    : ' + $PSVersionTable.PSVersion.ToString())
        [void]$envLines.Add('CLR 版本      : ' + [string]$PSVersionTable.CLRVersion)
        try {
            $os = [System.Environment]::OSVersion.VersionString
            [void]$envLines.Add('操作系统      : ' + $os)
        } catch { }
        try {
            $is64 = [System.Environment]::Is64BitProcess
            [void]$envLines.Add('进程位数      : ' + $(if ($is64) { '64 位' } else { '32 位' }))
        } catch { }

        # DPI 缩放（这是本项目的老大难，必须带上）
        try {
            $dpi = 1.0
            try { $dpi = [double](Get-DpiScale) } catch { $dpi = 1.0 }
            [void]$envLines.Add('DPI 缩放      : ' + $dpi.ToString('0.00') + 'x')
        } catch { }

        # 屏幕信息（多显示器相关的 bug 全靠这个）
        try {
            $wa = Get-WorkArea
            [void]$envLines.Add('工作区        : ' + [string]$wa.Left + ',' + [string]$wa.Top + '  ' +
                                [string]$wa.Width + 'x' + [string]$wa.Height)
        } catch { }
        try {
            $screens = [System.Windows.Forms.Screen]::AllScreens
            [void]$envLines.Add('显示器数量    : ' + $screens.Count)
            for ($i = 0; $i -lt $screens.Count; $i++) {
                $sc = $screens[$i]
                [void]$envLines.Add(('  屏{0}: {1}  主={2}  区域={3}' -f $i, $sc.DeviceName, $sc.Primary, [string]$sc.Bounds))
            }
        } catch { }

        # 系统主题（明暗判定相关）
        try {
            $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop
            $lt = $(if ($reg.AppsUseLightTheme -eq 1) { '浅色' } else { '深色' })
            [void]$envLines.Add('系统主题      : ' + $lt + '（AppsUseLightTheme=' + [string]$reg.AppsUseLightTheme + '）')
        } catch { }

        # 当前运行状态
        [void]$envLines.Add('')
        [void]$envLines.Add('--- 当前运行状态 ---')
        [void]$envLines.Add('形态          : ' + $(if ([string]::IsNullOrEmpty($script:mode)) { '卡片态/未知' } else { $script:mode }))
        [void]$envLines.Add('状态相位      : ' + $(if ([string]::IsNullOrEmpty($script:curPhase)) { '未知' } else { $script:curPhase }))
        [void]$envLines.Add('是否置顶      : ' + $(if ($script:topmostEnabled) { '是' } else { '否' }))
        [void]$envLines.Add('背景判定      : ' + $(if ($script:curIsLight) { '浅（用深色字）' } else { '深（用浅色字）' }))
        try {
            [void]$envLines.Add('窗口位置      : (' + [int]$win.Left + ',' + [int]$win.Top + ')  ' +
                                [int]$win.Width + 'x' + [int]$win.Height)
        } catch { }

        [void]$envLines.Add('')
        [void]$envLines.Add('--- 收集情况 ---')
        [void]$envLines.Add('已收集        : ' + ($collected -join ', '))
        if ($skipped.Count -gt 0) {
            [void]$envLines.Add('未收集        : ' + ($skipped -join ', '))
        }

        # ---- ④ 隐私提示（重要：必须让用户知道包里有什么）
        [void]$envLines.Add('')
        [void]$envLines.Add('--- 隐私说明 ---')
        [void]$envLines.Add('本压缩包【不包含】:')
        [void]$envLines.Add('  · 审批凭据（decisions 目录）')
        # 【v0.10.12 · D2 更正】原来这里写的是"Token 用量明细（tokens.json）"。
        #   但**根本没有 tokens.json 这个文件**（Token 账本只在内存里）。
        #   真正的隐私边界是：**Token 数字会随 state.json 带出**，
        #   只是没有单独的明细文件。说清这点比含糊承诺"不包含明细"更诚实。
        [void]$envLines.Add('  · Token 的分会话明细（插件不落盘，本机没有这个文件）')
        [void]$envLines.Add('  · 任何密码 / 密钥 / 登录信息')
        [void]$envLines.Add('')
        [void]$envLines.Add('本压缩包【可能包含】:')
        # 【v0.10.12 · D2】原来没写这一条。state.json 里有今日 Token 总额
        #   和每行任务的 Token，属使用信息，和"路径"一样属于需要告知的范围。
        [void]$envLines.Add('  · 今日 Token 汇总和各任务的 Token 数（来自 state.json）')
        [void]$envLines.Add('  · 你的文件路径（例如 C:\Users\<你的用户名>\...）')
        [void]$envLines.Add('    —— 这对排查"文件找不到"这类问题是必需的，因此未做打码')
        [void]$envLines.Add('')
        [void]$envLines.Add('发送前可以自己解压看一眼。如有顾虑，可以只发其中的日志文件。')

        [System.IO.File]::WriteAllLines((Join-Path $work '环境信息.txt'),
            @($envLines), (New-Object System.Text.UTF8Encoding($false)))
        $collected += '环境信息.txt'

        # ---- ⑤ 打包
        #
        # 【为什么先删旧 zip】
        # PS 5.1 的 Compress-Archive -Force 在目标已存在时有些版本会报错，
        # 先删掉最稳。而且时间戳到秒，同一秒内点两次才会撞。
        if (Test-Path $zipPath) {
            try { [System.IO.File]::Delete($zipPath) } catch { }
        }

        Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zipPath -Force -ErrorAction Stop

        return [pscustomobject]@{
            Ok = $true
            Path = $zipPath
            Collected = $collected
            Skipped = $skipped
        }
    }
    catch {
        Log-Fail '导出诊断包' $_
        return [pscustomobject]@{ Ok = $false; Path = ''; Error = $_.Exception.Message }
    }
    finally {
        # 无论成功失败都要清临时目录，否则用户机器上会积一堆 dsh-diag-*
        try { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue } catch { }
    }
}

$miDiag = New-Object System.Windows.Controls.MenuItem
$miDiag.Header = '导出诊断包…'
$miDiag.Add_Click({
    try {
        Log-Card '用户: 菜单 → 导出诊断包'
        $r = Export-DiagnosticPackage
        if ($r.Ok) {
            Log-Card ('诊断包已导出: ' + $r.Path + '  收集=' + ($r.Collected -join ','))
            # 【为什么用 MessageBox 而不是自绘对话框】
            #   这是一次性提示，不涉及视觉一致性；用系统对话框最省事，
            #   而且不需要动任何现有 UI 代码（用户明确要求不要动 UI）。
            try {
                $msg = "诊断包已生成：`r`n`r`n" + $r.Path + "`r`n`r`n" +
                       "请把这个文件发给开发者。`r`n`r`n" +
                       "包内不含密码或审批凭据，但可能包含你的文件路径。`r`n" +
                       "发送前可以自己打开看一眼。"
                [System.Windows.MessageBox]::Show($msg, '导出完成') | Out-Null
            } catch {
                # 消息框弹不出来不影响文件已经生成
                Log-Fail '诊断包提示框' $_ -Key 'diag-msgbox'
            }
        }
        else {
            Log-Fail '导出诊断包' $null
            try {
                [System.Windows.MessageBox]::Show(
                    "导出失败：`r`n" + [string]$r.Error,
                    '导出失败') | Out-Null
            } catch { Log-Fail '诊断包失败提示框' $_ -Key 'diag-fail-msgbox' }
        }
    } catch {
        Log-Fail '诊断包菜单' $_
    }
})
[void]$menu.Items.Add($miDiag)

[void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))

$miExit = New-Object System.Windows.Controls.MenuItem
$miExit.Header = '退出'
$miExit.Add_Click({ [System.Windows.Application]::Current.Shutdown() })
[void]$menu.Items.Add($miExit)

# ---------------------------------------------------------------- 主循环
$script:valleyConfig = $valleyConfig
$script:altSeconds = $altSeconds

# 首次渲染完再上磨砂，太早上会被 WPF 的初始化覆盖
$win.Dispatcher.BeginInvoke([action] { Update-Glass }, [System.Windows.Threading.DispatcherPriority]::Loaded) | Out-Null
$startupTimer = New-Object System.Windows.Threading.DispatcherTimer
$startupTimer.Interval = [TimeSpan]::FromMilliseconds(120)
$script:startupLeft = 6
$startupTimer.Add_Tick({
    Update-Glass
    $script:startupLeft--
    if ($script:startupLeft -le 0) { $startupTimer.Stop() }
})
$startupTimer.Start()

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
    try {
        # ---- 设置热更新（v0.7.0）
        # 放在最前面：尺寸/磨砂变化要在更新 UI 之前套用，
        # 否则本帧会按旧尺寸排一次版、下一帧再改，肉眼能看到抖一下。
        # 内部自己 try/catch，失败只是记一条日志，不影响下面的主流程。
        try { [void](Sync-CardSettingsIfChanged) } catch { }

        $state = Read-PanelState -Path $StatePath

        # 峰谷优先用插件算好的（官方规则 + 自动节假日），
        # 插件没给才退回 settings.json 里手填的老格式。
        # 这样"插件升级到一半"的中间状态也不会让卡片失去这个功能。
        $valley = $null
        try { $valley = Get-ValleyFromState $state.valley } catch { }
        if ($null -eq $valley) {
            try { $valley = Get-ValleyStatus -Config $script:valleyConfig -Now ([datetime]::Now) } catch { }
        }

        Update-UI -State $state -Valley $valley
    }
    catch {
        $exp.HeadText.Text = '读取状态出错'
    }
})
$timer.Start()

# 热更新的基线：把"启动时读的那一份"的修改时间记下来。
# 【为什么必须在这一行做】
#   不记的话，第一次 Tick 会发现 lastSettingsWrite 还是 MinValue，
#   于是白跑一次 Apply-CardSettings —— 虽然无害（值都一样、不产生变化），
#   但会往 panel.log 里写一条没有意义的"设置已热更新"。
try { $script:lastSettingsWrite = [System.IO.File]::GetLastWriteTimeUtc($SettingsPath) } catch { }

# 磨砂防止被系统偶发冲掉：定时轻刷一次，只在窗口可见且状态没变时也刷
$glassWatch = New-Object System.Windows.Threading.DispatcherTimer
$glassWatch.Interval = [TimeSpan]::FromMilliseconds(900)
$glassWatch.Add_Tick({
    # ================================================================
    # 【v0.10.5 修 BUG：一次未捕获异常会让这条定时器永久停掉】
    #
    # 【用户报的现象】
    #   2026-10-31 16:07，熄屏约 2 小时后点亮屏幕，卡片在浅色页面上
    #   一直是白字，而且之后 50 多分钟完全不恢复。
    #
    # 【根因 —— 已用隔离副本实测复现，不是推理】
    #   WPF 的 DispatcherTimer 有个硬规矩：回调里抛出未捕获异常之后，
    #   这条定时器从此不再触发（不是"跳过这一轮"，是"整条报废"）。
    #   实测对照（只让 Update-Glass 抛一次，之后永远正常）：
    #     · 抛之前 ticks=1，抛之后 10 秒内 ticks 仍然是 1
    #     · 同时 1 秒一次的心跳打了 13 次、一次没漏
    #       → UI 线程没死，只死了这一条定时器
    #
    #   定时器一死，Update-AdaptiveText 再也不会被调用，
    #   字色就永久停在最后一次写进去的值上 —— 界面看起来一切正常，
    #   只有字色错。而全局兜底只记一行 INFO「卡片继续运行」，
    #   日志里根本看不出"自适应已经死了"。
    #
    # 【为什么整段都要包，而不只是包 Update-Glass】
    #   Update-Glass 自己内部是全包了 try/catch 的（3792→3830），它基本不外抛。
    #   真正裸奔的是下面这几条：
    #     $script:anchorLeft = [double]$win.Left      坐标异常时转换抛
    #     $script:anchorTop  = [double]$win.Top       同上
    #     New-Object PanelNative+RECT                 类型解析/内存异常
    #     GetWindowRect($hwnd, ...)                   hwnd 失效时抛
    #   所以包住整个函数体，而不是只包一句。
    #
    # 【为什么 catch 里绝不能再抛】
    #   catch 里一旦再抛异常，等于没加这张网 —— 定时器照样报废。
    #   所以 Log-Fail 外面再套一层静默 try。
    #
    # 【行为退化说明（可接受）】
    #   万一某一轮出错，这一轮就什么都不改（可能少刷一次磨砂/少改一次字色），
    #   下一轮 900ms 后照常继续。最坏情况是"晚 0.9 秒"，而不是"永久死掉"。
    # ================================================================
    try {
    Update-Glass

    # ===== v0.9.0：柱态要跳过下面全部 =====
    #
    # 【为什么必须跳过 Update-AdaptiveText】
    #   它截取卡片画面算平均亮度，采样区是 x ∈ [3, 13] 逻辑像素
    #   （见 Update-AdaptiveText 里的 $bandIn / $bandOut）。
    #   柱宽只有 14 —— 采样区几乎等于**整根柱子**！
    #   于是它量到的是"颜色条的亮度"而不是"背景玻璃的亮度"，
    #   会把明暗判断彻底搞乱：红色柱 → 判成深色底 → 全部改浅色字 → 但没有字。
    #   而且 CopyFromScreen 每 900ms 一次，柱态下纯属浪费。
    #
    # 【副作用（接受）】
    #   $script:curIsLight 由 Update-AdaptiveText 维护。
    #   柱态跳过它 → 明暗判断会冻在"进柱态那一刻"的值。
    #   用户换壁纸/切主题时柱态颜色不会跟着变。
    #   可接受：柱态本来就是临时状态（用户拍板"不要自动变小"，说明是手动短时使用）。
    if ($script:mode -eq 'bar') { return }

    # 窗口位置变了要重新吸住顶端锚点
    $script:anchorLeft = [double]$win.Left
    if ($null -eq $script:dragStart) {
        $script:anchorTop = [double]$win.Top
    }

    # 文字颜色跟着背后的真实亮度走（深色壁纸用浅字，浅色壁纸用深字）
    #
    # 【v0.10.5：hwnd 失效时要重新取，不能拿着死句柄每轮空转】
    #   原来 $hwnd 只在一处用 EnsureHandle() 拿过一次，之后从不刷新。
    #   窗口句柄在下面这些情况下会失效：
    #     · 休眠/唤醒、DWM 重启、显示器拓扑变化（换屏/插拔/改缩放）
    #     · 资源管理器重启
    #   一旦失效，GetWindowRect 每轮都会失败或抛异常 ——
    #   这正是上面那个"定时器永久停掉"最可疑的触发源。
    #
    #   这里做两件事：
    #     ① GetWindowRect 失败 → 重新取一次 hwnd，下一轮就能恢复
    #     ② 重新取也失败（窗口真没了）→ 本轮直接跳过，不做任何改色
    #
    #   注意：$hwnd 在本文件是全局变量，其它地方也在用，必须原地更新它。
    $rr = New-Object PanelNative+RECT
    $gotRect = $false
    try {
        $gotRect = [PanelNative]::GetWindowRect($hwnd, [ref]$rr)
    } catch {
        $gotRect = $false
    }
    if (-not $gotRect) {
        try {
            $hwnd = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
            if ($hwnd -ne [IntPtr]::Zero) {
                $rr = New-Object PanelNative+RECT
                $gotRect = [PanelNative]::GetWindowRect($hwnd, [ref]$rr)
            }
        } catch {
            $gotRect = $false
        }
    }
    if ($gotRect) {
        Update-AdaptiveText -X $rr.Left -Y $rr.Top -W ($rr.Right - $rr.Left) -H ($rr.Bottom - $rr.Top)
    }
    } catch {
        # ================================================================
        # 【v0.10.5：这里绝对不能往外抛】
        #   WPF 的 DispatcherTimer 只要看到一次未捕获异常，这条定时器就永久停掉。
        #   所以 catch 里连写日志都要再套一层 try —— 日志系统自己也可能出问题。
        #
        #   带 -Key 做去重：同一类错误 60 秒内只记一条，
        #   避免某个持续失败的点把 panel.log 刷爆（项目历史踩过这个坑）。
        # ================================================================
        try { Log-Fail 'glassWatch-tick' $_ -Key 'glassWatchTick' } catch { }
    }
})
$glassWatch.Start()

# ---------------------------------------------------------------- 心跳
#
# 每 2 秒写一次"我还活着 + 我的进程号 + 窗口句柄"。
# 它同时干三件事：
#   1. 让插件知道卡片在不在（决定要不要再拉一次）
#   2. 让另一个被误启动的卡片知道"已经有实例了"（单实例保护）
#   3. 让用户在排查时能看到卡片最后一次活着是什么时候
#
# 为什么不靠查进程名：卡片是 powershell.exe，用户可能还开着别的 PS 窗口，
# 而且进程可能处于"活着但窗口没了"的异常状态。心跳能同时反映这两件事。
$script:heartbeatTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:heartbeatTimer.Interval = [TimeSpan]::FromMilliseconds(2000)
$script:heartbeatTimer.Add_Tick({
    Write-Heartbeat -Alive $true -Hwnd ([long]$hwnd)
})
$script:heartbeatTimer.Start()

# 退出时清理：把心跳标成"已退出"。
# 这样插件（和下一次启动）立刻就知道卡片是自己关的，
# 不用等 8 秒心跳过期。
$app.Add_Exit({
    try { $script:heartbeatTimer.Stop() } catch { }
    Write-Heartbeat -Alive $false -Hwnd 0
})

# ================================================================
# 【v0.10.4 修 BUG：到这里才让窗口第一次出现在屏幕上】
#
# 【顺序为什么是这样（和原来的区别）】
#   原来：Show() 在最前面（第 3092 行）→ 位置/高度/内容/磨砂 后面才慢慢补齐
#         → 用户先看到一块 260x368 的纯黑空窗口，半秒后才"化妆"
#   现在：先把位置（第 4835 行 Clamp-Position）、高度（下面这次 Update-UI 里的
#         Set-WindowHeight）、内容（Set-WindowMode 把面板设成非 Collapsed）、
#         磨砂（下面这次 Update-Glass）全部弄好，**最后**才 Show()。
#
# 【关键：这里必须先同步跑一次 Update-UI】
#   否则就算位置对了，窗口里三个面板还全是 Collapsed（空的），
#   而且高度还停在默认的 $CardHeight=368，要等 500ms 后主循环第一次 Tick
#   才改成 98+54N —— 那又会是一次可见的跳变。
#
#   实测（隔离副本，同一份代码只调顺序）：
#     改前 Show 后第一帧：390x552（368 高，错的）/ 100% 纯黑 / 位置 380,380
#     改后 Show 后第一帧：390x228（152 高，对的）/ 0% 纯黑（玻璃）/ 位置 3390,645
#
# 【为什么用 try/catch 包住，而不是直接调】
#   首次 Update-UI 万一因为 state.json 半截、字段异常等任何原因抛异常，
#   也**绝不能**让窗口永远不出现（那就从"闪一下"变成"卡片彻底不见"了）。
#   出错就只记一条日志，然后照常 Show —— 退化成"内容可能空一帧"，比不见了好。
try {
    $bootState = Read-PanelState -Path $StatePath
    $bootValley = $null
    try { $bootValley = Get-ValleyFromState $bootState.valley } catch { }
    if ($null -eq $bootValley) {
        try { $bootValley = Get-ValleyStatus -Config $script:valleyConfig -Now ([datetime]::Now) } catch { }
    }
    Update-UI -State $bootState -Valley $bootValley
} catch {
    Log-Fail 'L6809-首次渲染' $_
}

# 上磨砂（此时窗口还没显示，所以用户看不到中间态）
Update-Glass

# 真正显示。这一行之后用户才会第一次看到卡片 —— 而看到的就是成品。
$win.Show() | Out-Null

$app.Run() | Out-Null