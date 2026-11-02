@echo off
rem MiniMax Code token auto refresh for Qinglong check-in.
rem Runs minimax_export.py; reads the live OAuth credential the desktop client
rem writes to %USERPROFILE%\.minimax\auth\<env>\<region>\mcode-public\auth.json
rem (token mmoat_..., TTL ~1h, refreshed by the running client).
rem The old on-disk JWT (local-runtime.auth.json) expired 2026-10-19 and the
rem client no longer updates it, so that path is only a fallback.
rem --launch lets the script start the client if it is not running, so the
rem credential can be renewed; the client is never closed afterwards.
rem Output is appended to minimax_auto_refresh.log in the same folder.

set LOGFILE=%~dp0minimax_auto_refresh.log
echo ========================================== >> "%LOGFILE%"
echo [%date% %time%] MiniMax token auto refresh start >> "%LOGFILE%"
python "%~dp0minimax_export.py" --launch >> "%LOGFILE%" 2>&1
if %errorlevel%==0 (
  echo [%date% %time%] refresh OK >> "%LOGFILE%"
) else (
  echo [%date% %time%] refresh FAILED, exit code %errorlevel% ^(MiniMax Code not running?^) >> "%LOGFILE%"
)
