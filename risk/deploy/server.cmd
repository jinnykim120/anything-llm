@echo off
rem Risk Monitor 서버 시작 래퍼(작업 스케줄러가 로그인 때 호출). 위치: <risk 폴더>\deploy\server.cmd — 경로가 박혀 있지 않아 폴더째 옮겨도 된다.
rem 이미 같은 포트에서 서버가 돌고 있으면 아무것도 하지 않는다. 로그: logs\server.out.log
cd /d "%~dp0.."
if not exist logs mkdir logs
set "NODE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if "%RISK_PORT%"=="" set "RISK_PORT=8081"
netstat -ano | findstr /R /C:":%RISK_PORT% .*LISTENING" >nul && exit /b 0
for /f "usebackq delims=" %%i in (`"%NODE%" nexus.mjs --ca 2^>nul`) do set "NODE_EXTRA_CA_CERTS=%%i"
echo == %DATE% %TIME% start>>logs\server.out.log
"%NODE%" server.mjs >>logs\server.out.log 2>&1
echo == %DATE% %TIME% exit %ERRORLEVEL%>>logs\server.out.log
