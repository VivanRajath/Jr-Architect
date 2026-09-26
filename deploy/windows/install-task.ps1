# Registers "JrArch Runtime": at logon, keeps the jrarch WSL distro running so systemd can start Podman and Jr-Arch.
# Run in a normal (non-admin) PowerShell: powershell -ExecutionPolicy Bypass -File install-task.ps1
param([string]$Distro = "jrarch", [string]$TaskName = "JrArch Runtime")
$ErrorActionPreference = "Stop"

$wsl = Join-Path $env:WINDIR "System32\wsl.exe"
$conhost = Join-Path $env:WINDIR "System32\conhost.exe"
if (-not ((& $wsl -l -q) -replace "`0", "" | Where-Object { $_.Trim() -eq $Distro })) { throw "WSL distro '$Distro' not found" }

# conhost --headless keeps wsl.exe attached to the task (so Stop-ScheduledTask ends it) without a visible window.
$action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$wsl`" -d $Distro --exec /usr/bin/sleep infinity"
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# A shut-down distro makes wsl.exe exit 0, which Task Scheduler does not retry; this re-check restarts it, and IgnoreNew makes it a no-op while running.
$recheck = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$trigger = @($logon, $recheck)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Keeps the $Distro WSL distro alive for Jr-Arch. Stop with stop-jrarch.ps1." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Registered and started '$TaskName'. It starts again at every logon."
