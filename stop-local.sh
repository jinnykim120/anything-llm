#!/usr/bin/env bash
# stop-local.sh - server(3001) / frontend(3000) / collector(8888) 를 내린다.
# Postgres 와 Docling 은 건드리지 않는다(Docling 은 ./stop-docling.sh).
#
# 주의: LaunchAgent(com.nexus.autostart)를 설치했다면 5분 안에 다시 올라온다.
#       직접 내리고 작업할 때는 먼저  scripts/mac/install-launchagent.sh --pause
set -u
for port in 3000 3001 8888; do
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u)"
  if [ -z "$pids" ]; then
    echo ":$port  not running"
    continue
  fi
  for pid in $pids; do
    kill "$pid" 2>/dev/null && echo ":$port  stopped (pid $pid)"
  done
done
if launchctl list 2>/dev/null | grep -q "com.nexus.autostart"; then
  echo
  echo "알림: com.nexus.autostart 가 켜져 있어 5분 안에 다시 올라옵니다."
  echo "      멈추려면: scripts/mac/install-launchagent.sh --pause"
fi
