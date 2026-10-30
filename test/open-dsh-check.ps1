# 「点卡片回到 DSH」的实测
#
# 分两步：
#   1. 检测：注册表里 dsh:// 协议指向哪里（只读，不改任何东西）
#   2. 实测：真的发起一次 dsh:// 调用，确认它把 DSH 唤到前台
#
# 为什么不放在自动化测试里跑第 2 步：
#   真的唤起 DSH 会抢焦点，可能打断用户的输入。所以这个脚本要手动跑。
#
# 跑法：powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\open-dsh-check.ps1 [-Live]
param(
    [switch]$Live
)

$ErrorActionPreference = 'Continue'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class OD2 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    public static string Fg() {
        var h = GetForegroundWindow();
        var sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        uint pid; GetWindowThreadProcessId(h, out pid);
        return string.Format("hwnd={0} pid={1} title='{2}'", h, pid, sb.ToString());
    }
}
'@

Write-Host ('=' * 58)
Write-Host '点卡片回到 DSH —— 实测'
Write-Host ('=' * 58)

# ---------------------------------------------------------------- 1. 协议注册
Write-Host ''
Write-Host '--- 1) dsh:// 协议注册情况（只读）---'
$cmd = $null
try {
    $cmd = (Get-ItemProperty 'HKCU:\Software\Classes\dsh\shell\open\command' -ErrorAction Stop).'(default)'
} catch { }

if ($cmd) {
    Write-Host ("  已注册: " + $cmd)
    if ($cmd -match '\.exe') {
        Write-Host '  OK   指向一个可执行文件'
    } else {
        Write-Host '  警告 没看到 .exe，可能不是指向程序'
    }
    if ($cmd -match '%1') {
        Write-Host '  OK   含 %1 占位符（系统会把 URL 传进去）'
    } else {
        Write-Host '  警告 不含 %1，系统可能传不进 URL'
    }
} else {
    Write-Host '  未注册 dsh:// 协议'
    Write-Host '  => 卡片会自动退回用网址（settings.json 里的 dshUrl）'
}

# ---------------------------------------------------------------- 2. 当前 foreground
Write-Host ''
Write-Host '--- 2) 当前前台窗口 ---'
Write-Host ('  ' + [OD2]::Fg())

# ---------------------------------------------------------------- 3. 实测
Write-Host ''
Write-Host '--- 3) 实测协议调用 ---'
if (-not $Live) {
    Write-Host '  跳过（没加 -Live 参数）'
    Write-Host '  要真测请跑：powershell -File test\open-dsh-check.ps1 -Live'
    Write-Host '  注意：会抢焦点，可能打断你正在做的输入'
}
else {
    if (-not $cmd) {
        Write-Host '  协议没注册，无法实测'
    }
    else {
        Write-Host '  3 秒后发起 dsh:// 调用，注意观察 DSH 窗口有没有被切到前面…'
        Start-Sleep -Seconds 3
        $before = [OD2]::Fg()
        Write-Host ('  调用前: ' + $before)

        try {
            Start-Process 'dsh://' -ErrorAction Stop
            Write-Host '  Start-Process dsh:// 已发出'
        } catch {
            Write-Host ('  调用失败: ' + $_.Exception.Message)
        }

        Start-Sleep -Seconds 3
        $after = [OD2]::Fg()
        Write-Host ('  调用后: ' + $after)

        if ($after -ne $before) {
            Write-Host '  结果: 前台窗口变了，说明协议调用产生了效果'
        } else {
            Write-Host '  结果: 前台窗口没变。可能 DSH 本来就在前台，或系统忽略了这次调用'
        }
    }
}

Write-Host ''
Write-Host ('=' * 58)
