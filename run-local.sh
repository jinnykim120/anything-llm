#!/usr/bin/env bash
# run-local.sh - macOS/Linux 용 시작 스크립트 (윈도의 run-local.ps1 대응).
#
# server(3001) / frontend(3000) / collector(8888) 와 pgvector Postgres 를 띄운다.
# 멱등: 이미 떠 있는 서비스는 건너뛰고 내려간 것만 올린다 — 그래서 LaunchAgent 가
# 5분마다 불러도 안전하다. Docling 은 자동으로 켜지 않는다(수동: ./start-docling.sh).
#
# 사용법:  ./run-local.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$ROOT/.local-cache"
mkdir -p "$CACHE"

# setup-mac.sh 가 만든 PATH / Postgres 포뮬러 설정
# shellcheck disable=SC1091
[ -f "$CACHE/mac-env.sh" ] && . "$CACHE/mac-env.sh"
# launchd 처럼 PATH 가 빈약한 환경에서도 brew 로 설치한 도구를 찾도록
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"

# 사내 프록시(MITM) CA 가 있으면 Node 가 신뢰하도록 (윈도 run-local.ps1 과 동일)
CA="$CACHE/corp-root-ca.pem"
if [ -f "$CA" ]; then
  export NODE_EXTRA_CA_CERTS="$CA"
  export SSL_CERT_FILE="$CA"
  export REQUESTS_CA_BUNDLE="$CA"
fi
export npm_config_strict_ssl=false

http_ok() { curl -s -m 3 -o /dev/null -w "%{http_code}" "$1" 2>/dev/null | grep -qE '^[23]'; }
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# --- PostgreSQL + pgvector ----------------------------------------------------
SERVER_ENV="$ROOT/server/.env.development"
if [ -f "$SERVER_ENV" ] && grep -Eq "^VECTOR_DB=[\"']?pgvector" "$SERVER_ENV"; then
  if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    echo "pgvector   already running :5432"
  else
    if command -v brew >/dev/null 2>&1 && [ -n "${NEXUS_PG_FORMULA:-}" ]; then
      brew services start "$NEXUS_PG_FORMULA" >/dev/null 2>&1
    fi
    for _ in $(seq 1 30); do
      pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break
      sleep 1
    done
    if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
      echo "pgvector   started :5432"
    else
      echo "pgvector   NOT RUNNING — 'brew services list' 로 ${NEXUS_PG_FORMULA:-postgresql} 상태를 확인하세요"
    fi
  fi
fi

echo "docling    manual mode (켜기: ./start-docling.sh 또는 화면의 Docling 켜기 버튼)"

# --- 서비스 시작 --------------------------------------------------------------
# start_service <name> <port> <health-url> <dir> <command...>
start_service() {
  local name="$1" port="$2" url="$3" dir="$4"
  shift 4
  if http_ok "$url"; then
    printf "%-10s already running :%s\n" "$name" "$port"
    return
  fi
  if listening "$port"; then
    printf "%-10s port %s is occupied; not starting a duplicate\n" "$name" "$port"
    return
  fi
  (
    cd "$dir" || exit 1
    # nohup + 백그라운드 + disown: 이 스크립트(또는 터미널)가 끝나도 계속 돈다
    nohup env NODE_ENV=development "$@" >"$CACHE/$name.run.log" 2>&1 &
    disown 2>/dev/null || true
  )
  printf "%-10s started (log: .local-cache/%s.run.log)\n" "$name" "$name"
}

# [NEXUS 폴더 잠금] 새 테이블/컬럼이 필요한 코드를 옛 DB(윈도 내보내기본 등) 위에서
# 켜도 깨지지 않게, 서버를 새로 띄우기 전에 마이그레이션을 적용한다(멱등).
if ! http_ok "http://localhost:3001/api/ping" && ! listening 3001; then
  if (cd "$ROOT/server" && npx prisma migrate deploy >"$CACHE/migrate.run.log" 2>&1); then
    printf "%-10s ok\n" "migrate"
  else
    printf "%-10s FAILED (see .local-cache/migrate.run.log)\n" "migrate"
  fi
fi

start_service server 3001 "http://localhost:3001/api/ping" "$ROOT/server" node --trace-warnings index.js
start_service collector 8888 "http://localhost:8888/health" "$ROOT/collector" node --trace-warnings index.js
start_service frontend 3000 "http://localhost:3000/index.html" "$ROOT/frontend" yarn dev

# --- 포트가 열릴 때까지 대기 (프론트는 첫 요청이 느릴 수 있음) --------------------
printf "\nWaiting for ports"
deadline=$(( $(date +%s) + 180 ))
while :; do
  all_up=1
  http_ok "http://localhost:3001/api/ping" || all_up=0
  http_ok "http://localhost:8888/health" || all_up=0
  http_ok "http://localhost:3000/index.html" || all_up=0
  [ "$all_up" = 1 ] && break
  [ "$(date +%s)" -ge "$deadline" ] && break
  printf "."
  sleep 3
done
echo

status() { if http_ok "$2"; then echo "UP"; else echo "DOWN"; fi; }
printf "server     :3001  %s\n" "$(status s http://localhost:3001/api/ping)"
printf "frontend   :3000  %s\n" "$(status f http://localhost:3000/index.html)"
printf "collector  :8888  %s\n" "$(status c http://localhost:8888/health)"
echo
echo "Open http://localhost:3000/"
