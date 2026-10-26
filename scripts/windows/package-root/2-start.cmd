@echo off
rem Daily start: server(3001) / frontend(3000) / collector(8888) + pgvector Postgres  ->  http://localhost:3000/
rem Docling is manual (button in the app, or app\start-docling.ps1).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "app\run-local.ps1"
echo.
pause
