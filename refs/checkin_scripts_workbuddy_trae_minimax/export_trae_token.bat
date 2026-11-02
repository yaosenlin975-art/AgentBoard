@echo off
title TRAE Token Export for Qinglong
echo ==========================================
echo  TRAE Token Export (for Qinglong check-in)
echo  Please make sure TRAE SOLO CN is running and logged in.
echo ==========================================
echo.
python "%~dp0trae_export.py"
echo.
if %errorlevel%==0 (
  echo [OK] Token exported to D:\qinglong\data\scripts\.trae_token.json
) else (
  echo [FAIL] Export failed, exit code %errorlevel%
)
echo.
pause