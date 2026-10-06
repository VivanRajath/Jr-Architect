# One-screen health view of the Jr-Arch runtime from Windows.
param([string]$Distro = "jrarch", [string]$TaskName = "JrArch Runtime")
$wsl = Join-Path $env:WINDIR "System32\wsl.exe"
$env:WSL_UTF8 = 1

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
"task      : " + $(if ($task) { "$($task.State)" } else { "not installed" })
"distro    : " + (((& $wsl -l -v) | Select-String -Pattern "\b$Distro\b") -replace '\s+', ' ').Trim()
& $wsl -d $Distro --cd ~ --exec /usr/local/lib/jrarch/status.sh
