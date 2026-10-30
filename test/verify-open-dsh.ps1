# 「点卡片回到 DSH」的自动验收
#
# 两个场景都测：
#   A. DSH 最小化  -> 点卡片应还原并切前台
#   B. DSH 在后台  -> 点卡片应切前台
#
# 为什么要两个都测：
#   这是实测踩出来的关键教训 —— DSH 最小化后主窗口尺寸会从 1292x826
#   缩成 157x25，同时 Electron 的隐藏辅助窗口（1200x696）反而成了"最大窗口"。
#   只测一个场景会漏掉这个坑（我第一版就是这么漏的：找到的是辅助窗口，
#   激活后屏幕上什么都没发生，但代码"没报错"）。
#
# 跑法：powershell -File test\verify-open-dsh.ps1
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class VO {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int index);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOPMOST = 0x00000008;

    /** 卡片是不是又变回置顶了（"让位 -> 激活 -> 700ms 后恢复"这一步有没有真的执行） */
    public static bool IsTopmost(IntPtr h) {
        return (GetWindowLongW(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    }

    public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
    public const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
    public static void Click(int x, int y) {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(120);
        mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60);
        mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }
    public static void RightClick(int x, int y) {
        SetCursorPos(x, y); System.Threading.Thread.Sleep(120);
        mouse_event(RIGHTDOWN, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60);
        mouse_event(RIGHTUP, 0, 0, 0, UIntPtr.Zero);
    }
    /**
     * 菜单弹出后选到「回到 DSH」（第 2 项）并回车。
     *
     * 菜单顺序：设置… / 回到 DSH / 回到默认位置 / 重新读取设置 / --- / 退出
     * 刚弹出时没有任何项被选中，所以按两次 Down 才落到第 2 项。
     * 只按一次会落到「设置…」——那会弹出一个设置窗口，把测试环境搞乱。
     */
    public static void ChooseSecondMenuItem() {
        for (int i = 0; i < 2; i++) {
            keybd_event(0x28, 0, 0, UIntPtr.Zero);      // VK_DOWN
            System.Threading.Thread.Sleep(120);
            keybd_event(0x28, 0, 2, UIntPtr.Zero);
            System.Threading.Thread.Sleep(120);
        }
        keybd_event(0x0D, 0, 0, UIntPtr.Zero);          // VK_RETURN
        System.Threading.Thread.Sleep(80);
        keybd_event(0x0D, 0, 2, UIntPtr.Zero);
    }
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    /** 找 DSH 主窗口（和 Panel.ps1 里的判据一致：区分最小化） */
    public static IntPtr FindDsh(bool wantIconic) {
        IntPtr best = IntPtr.Zero; int bestArea = 0;
        var procs = System.Diagnostics.Process.GetProcessesByName("DeepSeek Harness");
        var pids = new uint[procs.Length];
        for (int i = 0; i < procs.Length; i++) pids[i] = (uint)procs[i].Id;
        EnumWindows((h, l) => {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (Array.IndexOf(pids, pid) < 0) return true;
            RECT r; GetWindowRect(h, out r);
            int w = r.Right - r.Left, ht = r.Bottom - r.Top;
            int area = w * ht;
            if (wantIconic) {
                if (IsIconic(h) && w > 0 && ht > 0 && area > bestArea) { bestArea = area; best = h; }
            } else {
                if (!IsIconic(h) && IsWindowVisible(h) && w >= 400 && ht >= 300 && area > bestArea) {
                    bestArea = area; best = h;
                }
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    /**
     * 找出这个进程里所有可见窗口的 hwnd。
     * 用途：右键前/后各取一次，差集就是新弹出的菜单窗口 ——
     * 不靠标题或类名猜，避免抓到别的窗口。
     */
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

    public static IntPtr FindOtherWindow(IntPtr exclude) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => {
            if (found != IntPtr.Zero) return true;
            if (h == exclude) return true;
            if (!IsWindowVisible(h) || IsIconic(h)) return true;
            var sb = new StringBuilder(300); GetWindowTextW(h, sb, 300);
            string t = sb.ToString();
            if (t.Contains("Harness") || t.Contains("DSH")) return true;
            RECT r; GetWindowRect(h, out r);
            if (r.Right - r.Left < 500 || r.Bottom - r.Top < 400) return true;
            found = h;
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
[void][VO]::SetProcessDPIAware()
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

# 这个脚本在插件包内的 test/ 目录下，插件根目录 = test 的上一级
$Root    = Split-Path -Parent $PSScriptRoot
$Panel   = Join-Path $Root 'panel\Panel.ps1'
$DataDir = Join-Path $PSScriptRoot '_verify-open-data'

$results = @()
function Check($name, $ok, $detail) {
    $script:results += [pscustomobject]@{ Name = $name; Ok = $ok; Detail = $detail }
    $mark = if ($ok) { 'OK  ' } else { 'FAIL' }
    Write-Host ("  {0} {1}{2}" -f $mark, $name, $(if ($detail) { "  ($detail)" } else { '' }))
}

$Script:App = New-Object System.Windows.Application
$Script:App.ShutdownMode = 'OnExplicitShutdown'
function Pump { param([int]$Ms = 300)
    $f = New-Object System.Windows.Threading.DispatcherFrame
    $t = New-Object System.Windows.Threading.DispatcherTimer
    $t.Interval = [TimeSpan]::FromMilliseconds($Ms)
    $t.Add_Tick({ $t.Stop(); $f.Continue = $false }); $t.Start()
    [System.Windows.Threading.Dispatcher]::PushFrame($f) }

function Write-State {
    $o = [ordered]@{
        updatedAt = [int]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
        tasks = [ordered]@{ running = 1; sessions = @([ordered]@{ title="任务"; elapsedSec=100; activity="处理中" }) }
        approval = [ordered]@{ pending = 0; items = @() }
        lastFinished = $null
        tokens = [ordered]@{ today = 16900000 }
        valley = [ordered]@{ inValley = $true; remainingSec = 1800; reason = 'off-window' }
    }
    $tmp = Join-Path $DataDir 'state.json.tmp'; $dst = Join-Path $DataDir 'state.json'
    [System.IO.File]::WriteAllText($tmp, ($o | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
    for ($k=0; $k -lt 10; $k++) { try { Copy-Item -LiteralPath $tmp -Destination $dst -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 30 } }
}

Write-Host ('=' * 60)
Write-Host '点卡片回到 DSH：自动验收'
Write-Host ('=' * 60)

# 找 DSH（正常显示状态）
$dsh = [VO]::FindDsh($false)
if ($dsh -eq [IntPtr]::Zero) {
    Write-Host 'DSH 不在显示状态，无法测试。请先把 DSH 窗口开出来。'
    exit 1
}
Write-Host ("DSH 主窗口 hwnd={0}" -f $dsh)

Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Copy-Item (Join-Path $Root 'panel\settings.json') $DataDir -Force
Write-State
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
if ($cardHwnd -eq [IntPtr]::Zero) {
    Write-Host 'FATAL 卡片没起来'
    exit 1
}
Pump 2500
Write-Host ("测试卡片 hwnd={0}" -f $cardHwnd)

# 卡片挪到屏幕中间，方便点击
[void][VO]::SetWindowPos($cardHwnd, [IntPtr](-1), 600, 400, 0, 0, 0x0001)
Pump 700
$cr = New-Object VO+RECT
[void][VO]::GetWindowRect($cardHwnd, [ref]$cr)
$clickX = $cr.Left + [int](($cr.Right - $cr.Left) / 2)
$clickY = $cr.Top + 40
Write-Host ("卡片位置 {0},{1}，点击点 ({2},{3})" -f $cr.Left, $cr.Top, $clickX, $clickY)

# ---------------------------------------------------------------- 场景 A：最小化
Write-Host ''
Write-Host '--- 场景 A：DSH 最小化后点卡片 ---'
[void][VO]::ShowWindow($dsh, 6)   # SW_MINIMIZE
Start-Sleep -Milliseconds 900
Check '前置：DSH 已最小化' ([VO]::IsIconic($dsh)) 

[VO]::Click($clickX, $clickY)
Start-Sleep -Milliseconds 2000

$fg = [VO]::GetForegroundWindow()
Check '点卡片后 DSH 成为前台窗口' ($fg -eq $dsh) ("前台=" + $fg)
Check '点卡片后 DSH 已还原（不是最小化）' (-not [VO]::IsIconic($dsh))

$r2 = New-Object VO+RECT
[void][VO]::GetWindowRect($dsh, [ref]$r2)
$sizeOk = (($r2.Right - $r2.Left) -ge 400) -and (($r2.Bottom - $r2.Top) -ge 300)
Check '还原后尺寸正常（>400x300）' $sizeOk ('{0}x{1}' -f ($r2.Right - $r2.Left), ($r2.Bottom - $r2.Top))

# ---------------------------------------------------------------- 卡片存活（v0.5.2 回归）
Write-Host ''
Write-Host '--- 点完之后卡片必须还活着（v0.5.1 崩在这里）---'
#
# 这是 v0.5.2 修的真实事故：点一下卡片 -> DSH 正常弹到前台 -> 700ms 后
# 恢复置顶的定时器抛出空引用 -> 整个 WPF 应用退出 -> 卡片凭空消失。
# 现象极具误导性：DSH 确实回来了，所以人会以为"功能好了"，
# 完全不会想到卡片已经死了。
#
# 所以下面三项必须都测：窗口还在 / 进程还在 / 又变回置顶了。
Check '点卡片后卡片窗口仍然存在（IsWindow）' ([VO]::IsWindow($cardHwnd)) ("hwnd=" + $cardHwnd)
Check '点卡片后卡片窗口仍然可见' ([VO]::IsWindowVisible($cardHwnd))
$aliveProc = $null
try { $aliveProc = Get-Process -Id $proc.Id -ErrorAction Stop } catch { $aliveProc = $null }
Check '点卡片后卡片进程仍然活着' ($null -ne $aliveProc) ("pid=" + $proc.Id)

# 700ms 后应恢复置顶。等足 2 秒再查，确认定时器真的跑完了。
Check '卡片已恢复置顶（定时器执行完）' ([VO]::IsTopmost($cardHwnd))

# 心跳必须还在更新：如果进程崩了，心跳会停在崩溃那一刻。
$hbBefore = $null
try { $hbBefore = (Get-Content (Join-Path $DataDir 'heartbeat.json') -Raw -Encoding UTF8 | ConvertFrom-Json).updatedAtMs } catch {}
Start-Sleep -Milliseconds 2600
$hbAfter = $null
try { $hbAfter = (Get-Content (Join-Path $DataDir 'heartbeat.json') -Raw -Encoding UTF8 | ConvertFrom-Json).updatedAtMs } catch {}
$hbOk = ($null -ne $hbBefore) -and ($null -ne $hbAfter) -and ([long]$hbAfter -gt [long]$hbBefore)
Check '心跳仍在更新（process 没死）' $hbOk ("$hbBefore -> $hbAfter")

# ---------------------------------------------------------------- 场景 B：后台
Write-Host ''
Write-Host '--- 场景 B：DSH 在后台（被别的窗口挡住）时点卡片 ---'
[void][VO]::ShowWindow($dsh, 9)   # 先确保可见
Start-Sleep -Milliseconds 500
$other = [VO]::FindOtherWindow($dsh)
if ($other -ne [IntPtr]::Zero) {
    [void][VO]::ShowWindow($other, 9)
    [void][VO]::SetForegroundWindow($other)
    Start-Sleep -Milliseconds 900
    Check '前置：前台已不是 DSH' ([VO]::GetForegroundWindow() -ne $dsh) ("前台=" + [VO]::GetForegroundWindow())
} else {
    Write-Host '  （找不到别的窗口，跳过场景 B）'
}

[VO]::Click($clickX, $clickY)
Start-Sleep -Milliseconds 2000
$fg2 = [VO]::GetForegroundWindow()
Check '点卡片后 DSH 回到前台' ($fg2 -eq $dsh) ("前台=" + $fg2)

# 连续点第二次也要活着（原 bug 每次点都会崩，第二次是最容易暴露"定时器没停"的）
Check '第二次点击后卡片仍然可见' ([VO]::IsWindowVisible($cardHwnd))
Check '第二次点击后卡片仍然置顶' ([VO]::IsTopmost($cardHwnd))

# ---------------------------------------------------------------- 右键菜单路径
Write-Host ''
Write-Host '--- 右键菜单「回到 DSH」也要活着 ---'
#
# 右键菜单走的是同一个 Invoke-OpenDshFlow，所以同一个 bug 也会在这里犯。
# 单独测一次，避免"只有左键修好了"。
#
# 【为什么用 UIAutomation 而不是发键盘 Down/Enter】
#   卡片是 WS_EX_NOACTIVATE 的 tool window（不在任务栏、不抢焦点）。
#   右键弹出菜单后，**前台窗口仍然是 DSH**，所以 keybd_event 发出的
#   Down/Enter 全都打到了 DSH 上，菜单项根本没被点中。
#   第一版就是这么写的，结果日志里恰好有一条上一场景遗留的"激活成功"，
#   差点让我误判"右键也好了"。改用 UIAutomation 按名字 Invoke，不依赖焦点。
if ([VO]::IsWindowVisible($cardHwnd)) {
    # 先记下当前可见窗口，用来识别新弹出的菜单窗口
    $pidsAll = @([uint32]$proc.Id)
    $visBefore = @([VO]::VisibleWindows($pidsAll))

    [void][VO]::ShowWindow($dsh, 6)          # 先最小化，验证右键真能还原
    Start-Sleep -Milliseconds 800
    Check '前置：右键前 DSH 已最小化' ([VO]::IsIconic($dsh))

    [VO]::RightClick($clickX, $clickY)
    Start-Sleep -Milliseconds 900

    $visAfter = @([VO]::VisibleWindows($pidsAll))
    $menuHwnds = @($visAfter | Where-Object { $visBefore -notcontains $_ })
    if ($menuHwnds.Count -eq 0) {
        Check '右键能弹出菜单' $false '没有新窗口出现'
    } else {
        Check '右键能弹出菜单' $true ("menu hwnd=" + $menuHwnds[0].ToInt64())

        # 在菜单里找到「回到 DSH」（必须限定 MenuItem：里面还嵌着一个同名 Text）
        $menuEl = [System.Windows.Automation.AutomationElement]::FromHandle($menuHwnds[0])
        $enabled = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::IsEnabledProperty, $true)
        $items = $menuEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $enabled)
        $target = $null
        foreach ($e in $items) {
            if ($e.Current.Name -eq '回到 DSH' -and
                $e.Current.ControlType.ProgrammaticName -eq 'ControlType.MenuItem') { $target = $e }
        }

        if ($null -eq $target) {
            Check '菜单里有「回到 DSH」这一项' $false
        } else {
            Check '菜单里有「回到 DSH」这一项' $true
            $inv = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $inv.Invoke()
            Start-Sleep -Milliseconds 2200

            Check '右键路径：DSH 回到前台' ([VO]::GetForegroundWindow() -eq $dsh) ("前台=" + [VO]::GetForegroundWindow())
            Check '右键路径：DSH 已还原（不是最小化）' (-not [VO]::IsIconic($dsh))
            Check '右键路径后卡片仍然可见（没崩）' ([VO]::IsWindowVisible($cardHwnd))
            Check '右键路径后卡片仍然置顶' ([VO]::IsTopmost($cardHwnd))
        }
    }
} else {
    Check '右键路径后卡片仍然可见（没崩）' $false '卡片已消失，无法测试右键'
}

# ---------------------------------------------------------------- 结果
Write-Host ''
Write-Host '--- 卡片日志 ---'
$logPath = Join-Path $DataDir 'panel.log'
if (Test-Path $logPath) {
    $lines = [System.IO.File]::ReadAllLines($logPath, [System.Text.Encoding]::UTF8)
    foreach ($l in $lines) { Write-Host ('  ' + $l) }
    # 出现「拦截到未捕获异常」说明兜底网救了卡片一命，但同时说明还有 bug 没修干净
    if ($lines -match '拦截到未捕获异常') {
        Write-Host ''
        Write-Host '  注意：日志里出现"拦截到未捕获异常" —— 卡片活下来了，但仍有异常发生，需要继续修。'
    }
} else {
    Write-Host '  （无日志）'
}

# 恢复 DSH 到前台
[void][VO]::ShowWindow($dsh, 9)
[void][VO]::SetForegroundWindow($dsh)
try { $proc.Kill() } catch {}
Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host ('=' * 60)
$pass = ($results | Where-Object { $_.Ok }).Count
$fail = $results.Count - $pass
Write-Host ("通过 {0}   失败 {1}" -f $pass, $fail)
if ($fail -eq 0) { Write-Host '全部通过' } else { Write-Host '有失败项' }
Write-Host ('=' * 60)
exit $(if ($fail -eq 0) { 0 } else { 1 })
