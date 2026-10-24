@echo off
rem Build single-file portable exe
rem Usage:
rem   build-portable.bat        -> compressed (normal, smaller, for distribution)
rem   build-portable.bat fast   -> no compression (store, fastest, for local testing)
rem China mirrors avoid github.com timeouts
cd /d "%~dp0"

rem Guard: electron-builder must delete dist\win-unpacked, which fails if the app is running from it
tasklist /FI "IMAGENAME eq Achievement Watcher NG.exe" 2>nul | find /I "Achievement Watcher NG.exe" >nul
if not errorlevel 1 (
  echo [INFO] App still running ^(Electron keeps several processes^), terminating it ...
  taskkill /F /IM "Achievement Watcher NG.exe" >nul 2>&1
  timeout /t 2 /nobreak >nul
)

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_CUSTOM_DIR={{ version }}
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

if "%~1"=="fast" (
  set COMP=-c.compression=store
  echo Building FAST mode [no compression, large exe] ...
) else (
  set COMP=-c.compression=normal
  echo Building COMPRESSED mode [normal, smaller exe, takes a few minutes] ...
)

node node_modules\electron-builder\cli.js --win portable %COMP%
if errorlevel 1 (
  echo.
  echo [FAILED] Build failed. Check the error lines above.
) else (
  echo.
  echo [OK] Done. Output: dist\aw2-desktop-portable.exe
)
pause
