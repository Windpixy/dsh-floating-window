# M4 内存 / CPU 压力测试
#
# 为什么不用正在跑的那张卡：
#   那是 DSH 拉起来的子进程，我的命令沙箱看不见它的进程对象
#   （Get-ProcessById 直接报"进程未运行"、tasklist 报 Access denied），
#   拿不到内存读数。所以这里自己起一张卡，测它的内存/CPU。
#   卡片程序是同一份 Panel.ps1，内存行为一致。
#
# 为什么边测边切档：
#   单纯静置看不出泄漏，反复切六档（每次都重建磨砂、改窗口尺寸）才压得出问题。
#   这也是交接文档 tiermem.ps1 的思路。
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class MM {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[void][MM]::SetProcessDPIAware()
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$Root    = Split-Path -Parent $PSScriptRoot
$Panel   = Join-Path $Root 'panel\Panel.ps1'
$DataDir = Join-Path $PSScriptRoot '_mm-data'

$Script:App = New-Object System.Windows.Application
$Script:App.ShutdownMode = 'OnExplicitShutdown'
function Pump { param([int]$Ms = 300)
    $f = New-Object System.Windows.Threading.DispatcherFrame
    $t = New-Object System.Windows.Threading.DispatcherTimer
    $t.Interval = [TimeSpan]::FromMilliseconds($Ms)
    $t.Add_Tick({ $t.Stop(); $f.Continue = $false }); $t.Start()
    [System.Windows.Threading.Dispatcher]::PushFrame($f) }

function Write-State {
    param([int]$Rows)
    $sessions = @()
    for ($i = 0; $i -lt $Rows; $i++) { $sessions += [ordered]@{ title="任务$i"; elapsedSec=(100+$i*37); activity="正在处理 file$i.ts" } }
    $o = [ordered]@{
        updatedAt = [int]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
        tasks = [ordered]@{ running = $Rows; sessions = $sessions }
        approval = [ordered]@{ pending = 0; items = @() }
        lastFinished = $null
        tokens = [ordered]@{ today = 16900000 }
    }
    $tmp = Join-Path $DataDir 'state.json.tmp'; $dst = Join-Path $DataDir 'state.json'
    [System.IO.File]::WriteAllText($tmp, ($o | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
    for ($k=0; $k -lt 10; $k++) { try { Copy-Item -LiteralPath $tmp -Destination $dst -Force -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 30 } }
}

Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Copy-Item (Join-Path $Root 'panel\settings.json') $DataDir -Force

Write-State -Rows 0
$env:DSH_CARD_DATA_DIR = $DataDir
$proc = Start-Process powershell.exe -ArgumentList '-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',"`"$Panel`"" -PassThru -WindowStyle Hidden

$hwnd = [IntPtr]::Zero
$dl = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $dl) {
    Start-Sleep -Milliseconds 400
    $hb = Join-Path $DataDir 'heartbeat.json'
    if (Test-Path $hb) { try { $hwnd = [IntPtr][long]((Get-Content $hb -Raw -Encoding UTF8 | ConvertFrom-Json).hwnd) } catch {} }
    if ($hwnd -ne [IntPtr]::Zero) { break }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Host 'FATAL 卡片没起来'; exit 1 }

$r = New-Object MM+RECT
[void][MM]::GetWindowRect($hwnd, [ref]$r)
$scale = [math]::Round(($r.Right-$r.Left) / 260.0, 3)
Write-Host ("卡片 pid={0} hwnd={1} 缩放={2}" -f $proc.Id, $hwnd, $scale)

Write-Host ''
Write-Host '== 阶段一：静置 30 秒（3 行任务，不动它）=='
Write-State -Rows 3
Pump 1500
$proc.Refresh()
$ws0 = $proc.WorkingSet64 / 1MB
$cpu0 = $proc.TotalProcessorTime.TotalSeconds
Write-Host ("  起点 内存={0:N1}MB CPU={1:N2}s" -f $ws0, $cpu0)
for ($i = 1; $i -le 6; $i++) {
    Pump 5000
    $proc.Refresh()
    Write-Host ("  +{0,2}s 内存={1,7:N1}MB CPU={2,6:N2}s 较起点={3,6:N1}MB" -f ($i*5), ($proc.WorkingSet64/1MB), $proc.TotalProcessorTime.TotalSeconds, (($proc.WorkingSet64/1MB) - $ws0))
}
$proc.Refresh()
$wsStatic = $proc.WorkingSet64 / 1MB
$cpuStatic = $proc.TotalProcessorTime.TotalSeconds
Write-Host ("  静置结果：30 秒内存变化 {0:N1}MB  CPU 占用 {1:N1}%" -f ($wsStatic - $ws0), (($cpuStatic - $cpu0)/30.0*100))

Write-Host ''
Write-Host '== 阶段二：连续切六档 5 轮（每轮 6 档，共 30 次尺寸变化）=='
$proc.Refresh()
$wsB = $proc.WorkingSet64 / 1MB
$cpuB = $proc.TotalProcessorTime.TotalSeconds
$t0 = Get-Date
for ($round = 1; $round -le 5; $round++) {
    foreach ($rows in 0,1,2,3,4,5) {
        Write-State -Rows $rows
        Pump 320
    }
    $proc.Refresh()
    Write-Host ("  第 {0} 轮后：内存={1,7:N1}MB CPU={2,6:N2}s" -f $round, ($proc.WorkingSet64/1MB), $proc.TotalProcessorTime.TotalSeconds)
}
$proc.Refresh()
$wsStress = $proc.WorkingSet64 / 1MB
$cpuStress = $proc.TotalProcessorTime.TotalSeconds
$stressSec = ((Get-Date) - $t0).TotalSeconds
Write-Host ("  切档结果：30 次切档后内存变化 {0:N1}MB  CPU 占用 {1:N1}%" -f ($wsStress - $wsB), (($cpuStress - $cpuB)/$stressSec*100))

Write-Host ''
Write-Host '== 阶段三：切档后再静置 20 秒（看是否回落）=='
Write-State -Rows 3
Pump 1500
$proc.Refresh()
$wsC = $proc.WorkingSet64 / 1MB
for ($i = 1; $i -le 4; $i++) {
    Pump 5000
    $proc.Refresh()
    Write-Host ("  +{0,2}s 内存={1,7:N1}MB" -f ($i*5), ($proc.WorkingSet64/1MB))
}
$proc.Refresh()
$wsEnd = $proc.WorkingSet64 / 1MB

Write-Host ''
Write-Host '== 汇总 =='
Write-Host ("  全程起点      : {0,7:N1} MB" -f $ws0)
Write-Host ("  全程终点      : {0,7:N1} MB" -f $wsEnd)
Write-Host ("  全程净变化    : {0,7:N1} MB   （合格线 < 5）" -f ($wsEnd - $ws0))
Write-Host ("  静置 30 秒    : {0,7:N1} MB" -f ($wsStatic - $ws0))
Write-Host ("  切档 30 次    : {0,7:N1} MB" -f ($wsStress - $wsB))
Write-Host ("  总 CPU 时间   : {0,7:N1} 秒" -f ($proc.TotalProcessorTime.TotalSeconds))
$pass = ($wsEnd - $ws0) -lt 5
Write-Host ("  判定          : {0}" -f $(if ($pass) { 'PASS' } else { 'FAIL' }))

try { $proc.Kill() } catch {}
