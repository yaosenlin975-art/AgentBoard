@echo off
rem WorkBuddy token auto refresh for Qinglong check-in.
rem Runs workbuddy_export.py; scans the running WorkBuddy client for a live
rem Keycloak token and writes it to the shared .workbuddy_token.json.
rem If WorkBuddy is not running it is started automatically and closed again
rem afterwards (a client the user already had open is never touched).
rem Output is appended to workbuddy_auto_refresh.log in the same folder.

set LOGFILE=%~dp0workbuddy_auto_refresh.log
echo ========================================== >> "%LOGFILE%"
echo [%date% %time%] WorkBuddy token auto refresh start >> "%LOGFILE%"
python "%~dp0workbuddy_export.py" >> "%LOGFILE%" 2>&1
if %errorlevel%==0 (
  echo [%date% %time%] refresh OK >> "%LOGFILE%"
) else (
  echo [%date% %time%] refresh FAILED, exit code %errorlevel% ^(WorkBuddy not running?^) >> "%LOGFILE%"
)
