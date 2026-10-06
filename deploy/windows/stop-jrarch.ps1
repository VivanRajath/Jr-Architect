# Stops Jr-Arch cleanly: ends the keep-alive task and terminates the distro. -Disable also stops it restarting at logon.
param([string]$Distro = "jrarch", [string]$TaskName = "JrArch Runtime", [switch]$Disable, [switch]$Uninstall)
$wsl = Join-Path $env:WINDIR "System32\wsl.exe"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  if ($Disable -or $Uninstall) { Disable-ScheduledTask -TaskName $TaskName | Out-Null }
  Stop-ScheduledTask -TaskName $TaskName
  if ($Uninstall) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
}
# SIGTERM reaches jr through systemd, which reaps every sandbox before the distro goes down.
& $wsl -d $Distro --cd ~ --exec sh -c 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop jrarch.service' 2>$null
& $wsl --terminate $Distro
Write-Host "Stopped $Distro." $(if ($Uninstall) { "Task removed." } elseif ($Disable) { "Task disabled; Enable-ScheduledTask '$TaskName' to turn it back on." } else { "The 5-minute re-check will start it again; use -Disable to keep it stopped." })
