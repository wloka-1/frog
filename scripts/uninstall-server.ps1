# Removes the frog background task (your ~/.frog data is kept).
Unregister-ScheduledTask -TaskName 'frog-server' -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server\index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*run-server.cmd*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host 'frog server removed.'
