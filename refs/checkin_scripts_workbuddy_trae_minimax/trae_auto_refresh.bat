@echo off
rem TRAE token auto refresh for Qinglong check-in.
rem Runs trae_export.py silently; requires TRAE to be running and logged in.
rem Output is appended to trae_auto_refresh.log in the same folder.

set LOGFILE=%~dp0trae_auto_refresh.log
echo ========================================== >> "%LOGFILE%"
echo [%date% %time%] TRAE token auto refresh start >> "%LOGFILE%"
python "%~dp0trae_export.py" >> "%LOGFILE%" 2>&1
if %errorlevel%==0 (
  echo [%date% %time%] refresh OK >> "%LOGFILE%"
) else (
  echo [%date% %time%] refresh FAILED, exit code %errorlevel% ^(TRAE not running?^) >> "%LOGFILE%"
)
