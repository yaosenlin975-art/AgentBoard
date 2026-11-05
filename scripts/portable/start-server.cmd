@echo off
rem [DESKTOP-2] Legacy foreground mode: run the server in this console window.
rem Kept for troubleshooting / custom ports: "start-server.cmd 8899".
rem ASCII-only on purpose: cmd.exe parses batch files with the active OEM codepage.
setlocal
cd /d "%~dp0"

rem Optional first argument: port, e.g. "start-server.cmd 8899"
if not "%~1"=="" set "AGENTBOARD_PORT=%~1"
if not defined AGENTBOARD_PORT set "AGENTBOARD_PORT=8787"
if not defined AGENTBOARD_LOG set "AGENTBOARD_LOG=%APPDATA%\AgentBoard\logs\server.log"

echo AgentBoard
echo   URL   : http://127.0.0.1:%AGENTBOARD_PORT%
echo   DB    : %APPDATA%\AgentBoard\agentboard.db
echo   Log   : %AGENTBOARD_LOG%
echo   Rules : app\rules\ (run check-rules.cmd to verify)
echo   Stop  : close this window or press Ctrl+C
echo.

"%~dp0runtime\node.exe" "%~dp0app\apps\server\dist\index.js"

echo.
echo Server exited with code %ERRORLEVEL%.
pause
