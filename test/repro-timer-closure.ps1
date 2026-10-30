param([switch]$Ascii)
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
# ASCII only on purpose: PS 5.1 without BOM mangles non-ASCII bytes and can
# even break the parser, which would hide the thing we are measuring.

$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnLastWindowClose'

$win = New-Object System.Windows.Window
$win.Width = 200; $win.Height = 100
$win.WindowStyle = 'None'; $win.ShowInTaskbar = $false
$win.Topmost = $true
$win.Show()

$script:results = New-Object System.Collections.ArrayList

function Add-R { param($m) [void]$script:results.Add($m) }

# Mimic Invoke-OpenDshFlow exactly: timer is a FUNCTION-LOCAL variable,
# and its Tick scriptblock reads that local variable.
function Invoke-Flow {
    $t = New-Object System.Windows.Threading.DispatcherTimer
    $t.Interval = [TimeSpan]::FromMilliseconds(300)
    $t.Add_Tick({
        try {
            $t.Stop()
            Add-R 'tick reached'
        }
        catch {
            Add-R ('TICK CAUGHT: ' + $_.Exception.GetType().Name + ' / ' + $_.Exception.Message)
            throw
        }
        try { $script:win.Topmost = $true; Add-R 'topmost ok' } catch { Add-R ('topmost caught: ' + $_.Exception.Message) }
    })
    $t.Start()
    Add-R ('flow: local t is null? ' + ($null -eq $t))
    return $true
}

$probe = New-Object System.Windows.Threading.DispatcherTimer
$probe.Interval = [TimeSpan]::FromMilliseconds(1500)
$probe.Add_Tick({
    $probe.Stop()
    Add-R '--- results ---'
    foreach ($r in $script:results) { [Console]::WriteLine('  ' + $r) }
    [Console]::WriteLine('  app still alive; pid=' + $PID)
    $app.Shutdown()
})
$probe.Start()

Invoke-Flow | Out-Null

try {
    $app.Run() | Out-Null
}
catch {
    [Console]::WriteLine('APP RUN THREW: ' + $_.Exception.Message)
}

[Console]::WriteLine('--- after app.Run ---')
foreach ($r in $script:results) { [Console]::WriteLine('  ' + $r) }
[Console]::WriteLine('exit normally')
