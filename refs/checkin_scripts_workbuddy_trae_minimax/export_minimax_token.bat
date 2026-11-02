@echo off
title MiniMax Code Token Export for Qinglong
echo ==========================================
echo  MiniMax Code Token Export (for Qinglong check-in)
echo  Please make sure MiniMax Code is logged in at least once.
echo ==========================================
echo.
rem --launch : 令牌过期时自动拉起 MiniMax Code，等它续期后导出
python "%~dp0minimax_export.py" --launch
echo.
if %errorlevel%==0 (
  echo [OK] Token exported to D:\qinglong\data\scripts\.minimax_token.json
) else (
  echo [FAIL] Export failed, exit code %errorlevel%
)
echo.
pause
