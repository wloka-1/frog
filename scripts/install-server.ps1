# Installs the frog server on Windows as a background task that starts when you log in.
# Run from the repo:  powershell -ExecutionPolicy Bypass -File scripts\install-server.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js 20+ is required: https://nodejs.org (or: winget install OpenJS.NodeJS.LTS)' }
New-Item -ItemType Directory -Force (Join-Path $env:USERPROFILE '.frog') | Out-Null

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$repo\scripts\run-hidden.vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'frog-server' -Action $action -Trigger $trigger -Settings $settings -Description 'frog terminal server' -Force | Out-Null

# Stop any running copy, then start fresh.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server\index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName 'frog-server'

# Let Tailscale devices (and only them) reach frog. Needs an elevated shell.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  Get-NetFirewallRule -DisplayName 'frog (Tailscale)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName 'frog (Tailscale)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort '7777','7801-7899' -RemoteAddress '100.64.0.0/10','fd7a:115c:a1e0::/48' | Out-Null
  Write-Host 'Firewall: allowed ports 7777 and 7801-7899 from Tailscale addresses.'
} else {
  Write-Host 'To reach frog from your phone, run this once in an *Administrator* PowerShell:' -ForegroundColor Yellow
  Write-Host "  New-NetFirewallRule -DisplayName 'frog (Tailscale)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort '7777','7801-7899' -RemoteAddress '100.64.0.0/10','fd7a:115c:a1e0::/48'"
}

Start-Sleep -Seconds 3
try { Invoke-RestMethod http://localhost:7777/healthz | Out-Null; Write-Host 'frog is running: http://localhost:7777' -ForegroundColor Green }
catch { Write-Host "frog did not start yet. Log: $env:USERPROFILE\.frog\server.log" -ForegroundColor Yellow }
