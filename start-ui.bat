@echo off
title aw2 panel
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  node src\cli.js ui
) else (
  echo Node.js not found. Install Node.js 18+ from https://nodejs.org and try again.
  pause
  exit /b 1
)

echo.
echo panel stopped.
pause >nul
