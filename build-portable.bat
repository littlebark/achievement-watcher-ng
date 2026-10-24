@echo off
rem Build single-file portable exe
rem Force China mirrors (github.com is unreachable without proxy here)
cd /d "%~dp0"

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_CUSTOM_DIR={{ version }}
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

echo Building aw2-desktop-portable.exe (mirror: npmmirror) ...
node node_modules\electron-builder\cli.js --win portable
if errorlevel 1 (
  echo.
  echo [FAILED] Build failed. Check the error lines above.
) else (
  echo.
  echo [OK] Done. Output: dist\aw2-desktop-portable.exe
)
pause
