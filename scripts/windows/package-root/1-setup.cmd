@echo off
rem 1 step: install + import data + start.  Double-click or run in a terminal.
rem (first time only; safe to re-run if interrupted)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "app\scripts\windows\setup-windows.ps1" -Data "%~dp0data" %*
echo.
pause
