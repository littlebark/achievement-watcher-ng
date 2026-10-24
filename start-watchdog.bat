@echo off
title aw2 watchdog - Achievement Watcher NG
cd /d "%~dp0"

rem Use node from PATH
where node >nul 2>nul
if %errorlevel%==0 (
  node src\cli.js watch
) else (
  echo Node.js not found. Install Node.js 18+ from https://nodejs.org and try again.
  pause
  exit /b 1
)

echo.
echo watchdog exited. Press any key to close this window.
pause >nul
