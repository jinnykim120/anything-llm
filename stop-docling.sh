#!/usr/bin/env bash
# stop-docling.sh - macOS/Linux 용 Docling 끄기 (stop-docling.ps1 대응).
# 이 저장소의 venv 에서 띄운 docling-serve 만 종료한다(5001 포트를 다른 프로세스가 쓰면 거부).
set -u
PORT=5001
pid="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n1)"
if [ -z "$pid" ]; then
  echo "Docling already stopped."
  exit 0
fi

cmdline="$(ps -p "$pid" -o command= 2>/dev/null)"
case "$cmdline" in
  *docling-serve*) ;;
  *)
    echo "Port $PORT is owned by an unexpected process (pid=$pid): $cmdline"
    echo "refusing to stop it."
    exit 1
    ;;
esac

# 모델/변환기 메모리를 먼저 비운다(실패해도 종료는 계속)
curl -s -m 10 http://127.0.0.1:$PORT/v1/clear/converters >/dev/null 2>&1 || true

kill "$pid" 2>/dev/null
for _ in $(seq 1 15); do
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || { echo "Docling stopped (pid=$pid)."; exit 0; }
  sleep 1
done
kill -9 "$pid" 2>/dev/null
sleep 1
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Docling did not release port $PORT."
  exit 1
fi
echo "Docling stopped (pid=$pid, force)."
