@echo off
rem Health check. Add -Llm to also ask claude one short question:  3-verify.cmd -Llm
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "app\scripts\windows\verify-windows.ps1" %*
echo.
pause
