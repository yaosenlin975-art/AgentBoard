@echo off
setlocal
cd /d "%~dp0"

rem One-click packaging: portable zip + NSIS installer (main deliverable).
rem Runs scripts/desktop/build-all.mjs; all args pass through, e.g.:
rem   package-installer.bat                 full rebuild (pnpm -r build + both artifacts)
rem   package-installer.bat --skip-build    reuse existing dist, repackage only
rem   package-installer.bat --nsis-only     installer only
rem   package-installer.bat --portable-only portable zip only
rem   package-installer.bat --verify-only   verify existing artifacts without rebuilding

where node >nul 2>nul
if errorlevel 1 (
  echo [pkg] node not found in PATH. Install Node.js 20+ first.
  pause
  exit /b 1
)

echo [pkg] packaging... (10-25 min on first run; log tail in .logs\)
node scripts\desktop\build-all.mjs %*
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (
  echo [pkg] OK. Artifacts:
  echo   NSIS installer : desktop\src-tauri\target\release\bundle\nsis\
  echo   Portable zip   : dist-package\
  echo   Build record   : .logs\build-all-record.json
) else (
  echo [pkg] FAILED with code %CODE%. Check output above and .logs\build-all-record.json
)
pause
exit /b %CODE%
