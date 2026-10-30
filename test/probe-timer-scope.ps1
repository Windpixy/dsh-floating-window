# Decisive probe: is a DispatcherTimer Tick scriptblock able to see a variable
# that lives in the FUNCTION scope where the handler was created?
#
# ASCII only on purpose (PS 5.1 + no BOM would mangle non-ASCII).

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnExplicitShutdown'

$script:out = New-Object System.Collections.ArrayList
function Note { param($m) [void]$script:out.Add($m) }

# ---- case 1: handler created INSIDE a function, reads function local
function CaseFunctionLocal {
    $localTimer = New-Object System.Windows.Threading.DispatcherTimer
    $localTimer.Interval = [TimeSpan]::FromMilliseconds(200)
    $localTimer.Add_Tick({
        try {
            Note ('C1 tick: localTimer null? ' + ($null -eq $localTimer))
            if ($null -ne $localTimer) { $localTimer.Stop() }
        }
        catch { Note ('C1 tick EXCEPTION: ' + $_.Exception.Message) }
    })
    $localTimer.Start()
    $script:case1Timer = $localTimer   # keep a root reference so it is not GC'd
}

# ---- case 2: handler created INSIDE a function, reads SCRIPT scope variable
$script:scriptTimer = $null
function CaseScriptVar {
    $script:scriptTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:scriptTimer.Interval = [TimeSpan]::FromMilliseconds(200)
    $script:scriptTimer.Add_Tick({
        try {
            Note ('C2 tick: scriptTimer null? ' + ($null -eq $script:scriptTimer))
            if ($null -ne $script:scriptTimer) { $script:scriptTimer.Stop() }
        }
        catch { Note ('C2 tick EXCEPTION: ' + $_.Exception.Message) }
    })
    $script:scriptTimer.Start()
}

CaseFunctionLocal
CaseScriptVar

$done = New-Object System.Windows.Threading.DispatcherTimer
$done.Interval = [TimeSpan]::FromMilliseconds(1200)
$done.Add_Tick({
    $done.Stop()
    foreach ($l in $script:out) { [Console]::WriteLine('  ' + $l) }
    $app.Shutdown()
})
$done.Start()

try { $app.Run() | Out-Null } catch { [Console]::WriteLine('APP RUN THREW: ' + $_.Exception.Message) }
