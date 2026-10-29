@echo off
rem 매일 이슈 카드 만들기 → 빌드 → 맥북 전송 (작업 스케줄러가 호출). 로그: insights-site\logs\daily-task.log
cd /d "%~dp0..\.."
if not exist "insights-site\logs" mkdir "insights-site\logs"
set "NODE_EXTRA_CA_CERTS=%CD%\.local-cache\corp-root-ca.pem"
node insights-site\daily.mjs %* >>insights-site\logs\daily-task.log 2>&1
