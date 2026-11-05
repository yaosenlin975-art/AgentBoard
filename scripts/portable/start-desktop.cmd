@echo off
rem [DESKTOP-2] Compatibility entry kept from the original wiring: delegates to start.cmd,
rem which now launches the desktop shell by default and falls back to browser mode.
rem ASCII-only on purpose.
call "%~dp0start.cmd" %*
exit /b %ERRORLEVEL%
