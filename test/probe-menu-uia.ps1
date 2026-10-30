# 诊断：用 UIAutomation 找到右键菜单里的「回到 DSH」并 Invoke 它。
#
# 为什么不用键盘：卡片是 taskbar 隐藏的 tool window（WS_EX_NOACTIVATE），
# 菜单弹出后**前台窗口仍然是 DSH**，所以 keybd_event 发的 Down/Enter
# 全打到 DSH 上去了，菜单项根本没被点中。
# （第一版验收脚本就是这么误判的：日志里有一条"激活成功"，但那是我前面
#   左键点卡片触发的，不是菜单触发的 —— 差点把这个当成"右键也好了"。）
#
# UIAutomation 直接按名字找控件并 Invoke，不依赖焦点，可靠得多。
#
# 跑法：powershell -File test\probe-menu-uia.ps1

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PU {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
    public static void RightClick(int x, int y) {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(150);
        mouse_event(RIGHTDOWN, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60);
        mouse_event(RIGHTUP, 0, 0, 0, UIntPtr.Zero);
    }
    /** 找出这个进程里所有可见窗口的 hwnd（用来定位弹出的菜单窗口） */
    public static IntPtr[] VisibleWindows(uint[] pids) {
        var list = new System.Collections.Generic.List<IntPtr>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (Array.IndexOf(pids, pid) >= 0) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }
}
'@
[void][PU]::SetProcessDPIAware()
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$Root    = Split-Path -Parent $PSScriptRoot
$Panel   = Join-Path $Root 'panel\Panel.ps1'
$DataDir = Join-Path $PSScriptRoot '_probe-uia-data'

$App = New-Object System.Windows.Application
$App.ShutdownMode = 'OnExplicitShutdown'
function Pump { param([int]$Ms = 300)
    $f = New-Object System.Windows.Threading.DispatcherFrame
    $t = New-Object System.Windows.Threading.DispatcherTimer
    $t.Interval = [TimeSpan]::FromMilliseconds($Ms)
    $t.Add_Tick({ $t.Stop(); $f.Continue = $false }); $t.Start()
    [System.Windows.Threading.Dispatcher]::PushFrame($f) }

Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Copy-Item (Join-Path $Root 'panel\settings.json') $DataDir -Force
$o = [ordered]@{
    updatedAt = [int]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
    tasks = [ordered]@{ running = 1; sessions = @([ordered]@{ title="任务"; elapsedSec=100; activity="处理中" }) }
    approval = [ordered]@{ pending = 0; items = @() }
    lastFinished = $null
    tokens = [ordered]@{ today = 16900000 }
    valley = [ordered]@{ inValley = $true; remainingSec = 1800; reason = 'off-window' }
}
[System.IO.File]::WriteAllText((Join-Path $DataDir 'state.json'), ($o | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))

$env:DSH_CARD_DATA_DIR = $DataDir
$proc = Start-Process powershell.exe -ArgumentList '-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',"`"$Panel`"" -PassThru -WindowStyle Hidden

$cardHwnd = [IntPtr]::Zero
$dl = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $dl) {
    Start-Sleep -Milliseconds 400
    $hb = Join-Path $DataDir 'heartbeat.json'
    if (Test-Path $hb) { try { $cardHwnd = [IntPtr][long]((Get-Content $hb -Raw -Encoding UTF8 | ConvertFrom-Json).hwnd) } catch {} }
    if ($cardHwnd -ne [IntPtr]::Zero) { break }
}
if ($cardHwnd -eq [IntPtr]::Zero) { Write-Host 'FATAL 卡片没起来'; exit 1 }
Pump 2500

[void][PU]::SetWindowPos($cardHwnd, [IntPtr](-1), 600, 400, 0, 0, 0x0001)
Pump 700
$cr = New-Object PU+RECT
[void][PU]::GetWindowRect($cardHwnd, [ref]$cr)
$cx = $cr.Left + [int](($cr.Right - $cr.Left) / 2)
$cy = $cr.Top + 40

$pids = @([uint32]$proc.Id)
$before = [PU]::VisibleWindows($pids)

Write-Host '=== 右键点卡片，弹出菜单 ==='
[PU]::RightClick($cx, $cy)
Pump 1000

$after = [PU]::VisibleWindows($pids)
$newOnes = @($after | Where-Object { $before -notcontains $_ })
Write-Host ("新增窗口 {0} 个" -f $newOnes.Count)
foreach($h in $newOnes){
    $r = New-Object PU+RECT; [void][PU]::GetWindowRect($h, [ref]$r)
    Write-Host ("  menu hwnd={0} rect={1},{2} {3}x{4}" -f $h.ToInt64(), $r.Left, $r.Top, ($r.Right-$r.Left), ($r.Bottom-$r.Top))
}
if ($newOnes.Count -eq 0) { Write-Host 'FATAL 菜单没弹出来'; try{$proc.Kill()}catch{}; exit 1 }

Write-Host ''
Write-Host '=== 用 UIAutomation 遍历菜单项 ==='
$menuEl = [System.Windows.Automation.AutomationElement]::FromHandle($newOnes[0])
$cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::IsEnabledProperty, $true)
$all = $menuEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
Write-Host ("找到 {0} 个控件" -f $all.Count)
$target = $null
foreach($e in $all){
    $n = $e.Current.Name
    $ct = $e.Current.ControlType.ProgrammaticName
    Write-Host ("  name='{0}'  type={1}" -f $n, $ct)
    # 必须限定 MenuItem：每个菜单项内部还嵌着一个同名 Text 元素，
    # 而 Text 不支持 InvokePattern（第一版就在这儿报了 Unsupported Pattern）。
    if ($n -eq '回到 DSH' -and $ct -eq 'ControlType.MenuItem') { $target = $e }
}

if ($null -eq $target) { Write-Host 'FATAL 没找到「回到 DSH」这一项'; try{$proc.Kill()}catch{}; exit 1 }
$sup = @($target.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
Write-Host ('命中 MenuItem，支持的模式: ' + ($sup -join ', '))

Write-Host ''
Write-Host '=== 先把 DSH 最小化，再 Invoke「回到 DSH」 ==='
$dsh = [IntPtr]::Zero
foreach($p in Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue){
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $dsh = $p.MainWindowHandle }
}
Write-Host ("DSH hwnd = {0}" -f $dsh.ToInt64())
if ($dsh -ne [IntPtr]::Zero) { [void][PU]::ShowWindow($dsh, 6); Pump 600 }
Write-Host ("最小化后 isIconic = {0}" -f [PU]::IsIconic($dsh))

$inv = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$inv.Invoke()
Pump 2200

Write-Host ''
Write-Host ("前台 = {0}  (DSH = {1})" -f [PU]::GetForegroundWindow().ToInt64(), $dsh.ToInt64())
Write-Host ("DSH isIconic = {0}" -f [PU]::IsIconic($dsh))

Write-Host ''
Write-Host '=== panel.log ==='
$lp = Join-Path $DataDir 'panel.log'
if (Test-Path $lp) { Get-Content $lp -Encoding UTF8 } else { Write-Host '（无日志）' }

Write-Host ''
Write-Host '=== 卡片还活着吗 ==='
Write-Host ("IsWindow={0}  visible={1}  procAlive={2}" -f `
    [PU]::IsWindowVisible($cardHwnd), [PU]::IsWindowVisible($cardHwnd), $null -ne (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue))

if ($dsh -ne [IntPtr]::Zero) { [void][PU]::ShowWindow($dsh, 9); [void][PU]::SetForegroundWindow($dsh) }
try { $proc.Kill() } catch {}
Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
