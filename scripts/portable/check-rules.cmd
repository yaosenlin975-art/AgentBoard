@echo off
setlocal
cd /d "%~dp0"

"%~dp0runtime\node.exe" "%~dp0app\verify-rules.mjs"
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" (
  echo Rules check FAILED with code %CODE%.
) else (
  echo Rules check passed.
)
pause
exit /b %CODE%
