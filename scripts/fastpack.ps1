# Fast local repack (fully offline, seconds): rebuild app.asar and swap into dist/win-unpacked
# Usage: powershell -ExecutionPolicy Bypass -File scripts\fastpack.ps1
# Requires: dist/win-unpacked produced once by electron-builder
# Note: single-file portable exe still uses electron-builder; this script is for local testing only
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = "C:\Users\bark\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
Set-Location $root

if (-not (Test-Path "dist\win-unpacked\Achievement Watcher NG.exe")) {
    Write-Error "dist/win-unpacked not found; run electron-builder successfully once first"
    exit 1
}

# 1. Stage sources per build.files (robocopy; fs.cpSync crashes on non-ASCII paths)
$stage = "dist\_fastpack-stage"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory $stage | Out-Null
Copy-Item package.json,electron\main.js,electron\preload.js,electron\panel-preload.js,electron\overlay.html,electron\overlay.js,electron\tray.png $stage
foreach ($d in "src", "web", "vendor") {
    robocopy $d "$stage\$d" /E /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { Write-Error "robocopy $d failed"; exit 1 }
}

# 2. Pack asar (vendor unpacked, same as build.asarUnpack)
& $node node_modules\@electron\asar\bin\asar.js pack $stage dist\_app.asar --unpack "vendor/**"
if ($LASTEXITCODE -ne 0) { Write-Error "asar pack failed"; exit 1 }

# 3. Swap into win-unpacked
Copy-Item dist\_app.asar dist\win-unpacked\resources\app.asar -Force
robocopy dist\app.asar.unpacked dist\win-unpacked\resources\app.asar.unpacked /E /NFL /NDL /NJH /NJS | Out-Null
Remove-Item dist\_app.asar -Force
Remove-Item -Recurse -Force $stage

$size = [math]::Round((Get-Item dist\win-unpacked\resources\app.asar).Length / 1MB, 1)
Write-Output "[fastpack] done. app.asar = ${size} MB"
Write-Output "[fastpack] run dist\win-unpacked\Achievement Watcher NG.exe for the latest build"
