#!/usr/bin/env bash
# start-docling.sh - macOS/Linux 용 Docling 켜기 (start-docling.ps1 대응).
#
# 자료 적재(특히 표가 중요한 PDF/PPT)를 할 때만 켜고 끝나면 ./stop-docling.sh 로 끈다.
# 화면의 "Docling 켜기" 버튼도 이 스크립트를 호출한다(server/utils/doclingControl).
#
# 튜닝(환경변수로 덮어쓰기, 기본값은 윈도 16GB PC 에서 메모리 부족을 피하려고 낮춘 값):
#   NEXUS_DOCLING_THREADS (기본 2)   NEXUS_DOCLING_BATCH (기본 2)
#   NEXUS_DOCLING_DEVICE  (auto|cpu|mps, 기본: 설정 안 함 = docling 자동 선택)
# 맥에서 표 인식이 깨지거나 오류가 나면  NEXUS_DOCLING_DEVICE=cpu  로 시험해 보세요.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$ROOT/.local-cache"
EXE="$CACHE/docling-venv/bin/docling-serve"
LOGDIR="$CACHE/docling"
STARTUP_TIMEOUT="${1:-300}"

# shellcheck disable=SC1091
[ -f "$CACHE/mac-env.sh" ] && . "$CACHE/mac-env.sh"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"

if [ ! -x "$EXE" ]; then
  echo "Docling is not installed at $EXE (scripts/mac/setup-mac.sh 를 먼저 실행하세요)"
  exit 1
fi

if curl -fs -m 3 http://127.0.0.1:5001/health >/dev/null 2>&1; then
  echo "Docling already running: http://127.0.0.1:5001"
  exit 0
fi

mkdir -p "$LOGDIR"
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8
export HF_HOME="$CACHE/hf"
CA="$CACHE/corp-root-ca.pem"
if [ -f "$CA" ]; then
  export SSL_CERT_FILE="$CA"
  export REQUESTS_CA_BUNDLE="$CA"
fi
export DOCLING_SERVE_ENABLE_UI=false
export DOCLING_SERVE_LOAD_MODELS_AT_BOOT=false
export DOCLING_SERVE_MAX_SYNC_WAIT=900
export DOCLING_SERVE_ENABLE_MANAGEMENT_ENDPOINTS=true
export DOCLING_SERVE_MAX_NUM_PAGES=1000
export DOCLING_SERVE_MAX_FILE_SIZE=209715200
export DOCLING_NUM_THREADS="${NEXUS_DOCLING_THREADS:-2}"
export DOCLING_PERF_PAGE_BATCH_SIZE="${NEXUS_DOCLING_BATCH:-2}"
export DOCLING_SERVE_LAYOUT_BATCH_SIZE="${NEXUS_DOCLING_BATCH:-2}"
export DOCLING_SERVE_TABLE_BATCH_SIZE="${NEXUS_DOCLING_BATCH:-2}"
if [ -n "${NEXUS_DOCLING_DEVICE:-}" ]; then
  export DOCLING_DEVICE="$NEXUS_DOCLING_DEVICE"
fi

nohup "$EXE" run --host 127.0.0.1 --port 5001 \
  >"$LOGDIR/serve.stdout.log" 2>"$LOGDIR/serve.stderr.log" &
PID=$!
disown "$PID" 2>/dev/null || true

deadline=$(( $(date +%s) + STARTUP_TIMEOUT ))
while ! curl -fs -m 2 http://127.0.0.1:5001/health >/dev/null 2>&1; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "Docling exited during startup. See $LOGDIR/serve.stderr.log"
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    kill "$PID" 2>/dev/null
    echo "Docling failed to start within ${STARTUP_TIMEOUT}s. See $LOGDIR/serve.stdout.log and serve.stderr.log"
    exit 1
  fi
  sleep 2
done
echo "Docling ready: http://127.0.0.1:5001 (pid=$PID)"
