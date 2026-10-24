@echo off
rem Stop aw2: first the hidden supervisor (wscript + aw2-hidden.vbs), then the node watchdog.
rem Only touches aw2's own processes, other node.js apps are left alone.
powershell -NoProfile -Command "$s = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*aw2-hidden.vbs*' -and $_.Name -like 'wscript*' }; foreach($p in $s){ Stop-Process -Id $p.ProcessId -Force -Confirm:$false; Write-Host ('stopped supervisor ' + $p.ProcessId) }; Start-Sleep -Milliseconds 500; $n = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*cli.js watch*' }; foreach($p in $n){ Stop-Process -Id $p.ProcessId -Force -Confirm:$false; Write-Host ('stopped watchdog ' + $p.ProcessId) }; if(-not $s -and -not $n){ Write-Host 'aw2 is not running' }"
pause
