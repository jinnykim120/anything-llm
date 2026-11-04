@echo off
rem PC risk monitor wrapper (Task Scheduler, 08:00 and 14:00). Log: logs\run.log
rem 위치: <risk 폴더>\deploy\risk.cmd . NEXUS 경로·프록시 인증서는 config\nexus.json 에서 읽는다.
cd /d "%~dp0.."
if not exist logs mkdir logs
for /f "usebackq delims=" %%i in (`node nexus.mjs --ca`) do set "NODE_EXTRA_CA_CERTS=%%i"
echo == %DATE% %TIME% start>>logs\run.log
node risk.mjs %* >>logs\run.log 2>&1
echo == %DATE% %TIME% end %ERRORLEVEL%>>logs\run.log
