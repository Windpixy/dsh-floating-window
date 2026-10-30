# Probe: with NO DispatcherUnhandledException handler, does an uncaught throw
# inside a DispatcherTimer Tick kill the WPF application?
#
# ASCII only (PS 5.1 without BOM would mangle non-ASCII).

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnExplicitShutdown'

$win = New-Object System.Windows.Window
$win.Width = 120; $win.Height = 60
$win.WindowStyle = 'None'; $win.ShowInTaskbar = $false; $win.Topmost = $true
$win.Show()

# Reproduce the real shape: function-local variable, read from the Tick,
# with NO try/catch anywhere (exactly like Invoke-OpenDshFlow in Panel.ps1).
function BadFlow {
    $t = New-Object System.Windows.Threading.DispatcherTimer
    $t.Interval = [TimeSpan]::FromMilliseconds(250)
    $t.Add_Tick({
        $t.Stop()                # $t is $null here -> RuntimeException
        $win.Topmost = $true
    })
    $t.Start()
    $script:keep = $t
}
BadFlow

# Second timer proving whether the dispatcher still processes work afterwards.
$check = New-Object System.Windows.Threading.DispatcherTimer
$check.Interval = [TimeSpan]::FromMilliseconds(1500)
$check.Add_Tick({
    $check.Stop()
    [Console]::WriteLine('  SURVIVED: check tick ran, window visible=' + $win.IsVisible)
    $app.Shutdown()
})
$check.Start()

[Console]::WriteLine('  entering app.Run')
try {
    $app.Run() | Out-Null
    [Console]::WriteLine('  app.Run returned normally')
}
catch {
    [Console]::WriteLine('  APP RUN THREW: ' + $_.Exception.Message)
}
[Console]::WriteLine('  after Run: window visible=' + $win.IsVisible)
