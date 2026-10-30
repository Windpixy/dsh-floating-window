# Probe: does an application-level DispatcherUnhandledException handler keep a
# PowerShell WPF app alive when an event-handler scriptblock throws?
#
# ASCII only (PS 5.1 without BOM would mangle non-ASCII).

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnExplicitShutdown'

$script:notes = New-Object System.Collections.ArrayList
function Note { param($m) [void]$script:notes.Add($m) }

# Install the net BEFORE any handler can throw.
$app.Add_DispatcherUnhandledException({
    param($sender, $e)
    Note ('UNHANDLED CAUGHT: ' + $e.Exception.GetType().Name + ' / ' + $e.Exception.Message)
    $e.Handled = $true
})

$win = New-Object System.Windows.Window
$win.Width = 120; $win.Height = 60
$win.WindowStyle = 'None'; $win.ShowInTaskbar = $false; $win.Topmost = $true
$win.Show()

# Deliberately reproduce the real bug: function-local variable read from a
# DispatcherTimer Tick, with no try/catch around the throwing call.
function BadFlow {
    $t = New-Object System.Windows.Threading.DispatcherTimer
    $t.Interval = [TimeSpan]::FromMilliseconds(250)
    $t.Add_Tick({
        $t.Stop()                      # $t is $null in this scope -> throws
        $script:win.Topmost = $true
        Note 'reached line after throwing call (should not happen)'
    })
    $t.Start()
    $script:badTimer = $t
}
BadFlow

# After 1.2 s, report whether the app is still running and ticking.
$check = New-Object System.Windows.Threading.DispatcherTimer
$check.Interval = [TimeSpan]::FromMilliseconds(1200)
$check.Add_Tick({
    $check.Stop()
    Note 'check tick ran => dispatcher still alive'
    Note ('window still visible? ' + $win.IsVisible)
    foreach ($l in $script:notes) { [Console]::WriteLine('  ' + $l) }
    $app.Shutdown()
})
$check.Start()

try { $app.Run() | Out-Null }
catch { [Console]::WriteLine('APP RUN THREW (net did not help): ' + $_.Exception.Message) }

[Console]::WriteLine('--- final ---')
foreach ($l in $script:notes) { [Console]::WriteLine('  ' + $l) }
