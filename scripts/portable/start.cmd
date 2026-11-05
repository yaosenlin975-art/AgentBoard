@echo off
rem [DESKTOP-2] Default entry: launch the Tauri desktop shell first; if the shell is
rem unusable, fall back to "foreground server + default browser" so the package stays usable.
rem Legacy foreground mode is still reachable: "start.cmd server", "start.cmd 8899",
rem or double-click start-server.cmd (unchanged behavior: 8787, Ctrl+C / close window = stop).
rem ASCII-only on purpose: cmd.exe parses batch files with the active OEM codepage,
rem UTF-8 Chinese here breaks parsing on default zh-CN consoles.
setlocal
cd /d "%~dp0"

if /I "%~1"=="server" goto foreground
if not "%~1"=="" goto foreground

set "DESKTOP_EXE=%~dp0app\desktop\agentboard-desktop.exe"
set "NODE_EXE=%~dp0runtime\node.exe"
set "REASON="

if not exist "%DESKTOP_EXE%" set "REASON=desktop shell not found: app\desktop\agentboard-desktop.exe"
if not defined REASON if not exist "%NODE_EXE%" set "REASON=bundled Node runtime not found: runtime\node.exe"
if not defined REASON call :detect_webview2
if not defined REASON if not defined WV2 set "REASON=Microsoft Edge WebView2 Runtime not detected"

if defined REASON goto fallback

rem Already running: just focus it (the single-instance plugin exits the new process).
call :desktop_running
if not errorlevel 1 (
  start "" "%DESKTOP_EXE%"
  exit /b 0
)

rem The shell probes 8787: override any custom port in config.json so both agree.
set "AGENTBOARD_PORT=8787"
if not defined AGENTBOARD_LOG set "AGENTBOARD_LOG=%APPDATA%\AgentBoard\logs\server.log"

echo AgentBoard desktop window starting: server on 8787, close = minimize to tray, tray "Quit" = stop.
start "" "%DESKTOP_EXE%"

rem Give the shell 6 seconds; if the process is gone, it failed to boot (WebView2 / graphics).
ping -n 7 127.0.0.1 >nul 2>&1
call :desktop_running
if not errorlevel 1 exit /b 0

set "REASON=desktop shell exited right after start (WebView2 broken or no graphics session)"

:fallback
echo.
echo [AgentBoard] Desktop window unavailable: %REASON%
echo [AgentBoard] Falling back to "foreground server + default browser" mode.
echo [AgentBoard] Close the server window to stop it.
echo.
if not defined AGENTBOARD_PORT set "AGENTBOARD_PORT=8787"
start "AgentBoard server" cmd /c ""%~dp0start-server.cmd""
if exist "%NODE_EXE%" (
  "%NODE_EXE%" -e "const http=require('http');let n=0;const id=setInterval(()=>{const r=http.get('http://127.0.0.1:'+process.env.AGENTBOARD_PORT+'/api/version',s=>{s.resume();clearInterval(id);process.exit(0)});r.on('error',()=>{});if(++n>=60){clearInterval(id);process.exit(1)}},500)"
) else (
  ping -n 5 127.0.0.1 >nul 2>&1
)
start "" "http://127.0.0.1:%AGENTBOARD_PORT%"
exit /b 0

:foreground
call "%~dp0start-server.cmd" %*
exit /b %ERRORLEVEL%

:desktop_running
tasklist /FI "IMAGENAME eq agentboard-desktop.exe" /NH 2>nul | findstr /I /C:"agentboard-desktop.exe" >nul
if errorlevel 1 exit /b 1
exit /b 0

:detect_webview2
rem WebView2 Evergreen Runtime client GUID (Microsoft detection guidance).
rem Three locations cover 64-bit OS / 32-bit OS / per-user install; pv=0.0.0.0 means not installed.
set "WV2="
for %%K in (
  "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  "HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  "HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
) do (
  if not defined WV2 for /f "tokens=3" %%V in ('reg query %%K /v pv 2^>nul ^| findstr /I "pv"') do (
    if not "%%V"=="0.0.0.0" set "WV2=%%V"
  )
)
exit /b 0
