#!/usr/bin/env bash
# verify-mac.sh - 맥에서 시스템이 제대로 세팅됐는지 점검한다 (읽기 전용).
#   scripts/mac/verify-mac.sh [--llm]     # --llm: claude 에 짧은 질문 1회(사용량 극소)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE="$ROOT/.local-cache"
# shellcheck disable=SC1091
[ -f "$CACHE/mac-env.sh" ] && . "$CACHE/mac-env.sh"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"

PASS=0; FAIL=0; WARN=0
pass() { printf "  \033[32mPASS\033[0m %s\n" "$*"; PASS=$((PASS+1)); }
fail() { printf "  \033[31mFAIL\033[0m %s\n" "$*"; FAIL=$((FAIL+1)); }
note() { printf "  \033[33mWARN\033[0m %s\n" "$*"; WARN=$((WARN+1)); }
http_ok() { curl -s -m 5 -o /dev/null -w "%{http_code}" "$1" 2>/dev/null | grep -qE '^[23]'; }

echo "[도구]"
command -v node >/dev/null 2>&1 && pass "node $(node -v)" || fail "node 없음"
command -v yarn >/dev/null 2>&1 && pass "yarn $(yarn -v)" || fail "yarn 없음"
[ -d "$ROOT/server/node_modules" ] && pass "server/node_modules" || fail "server/node_modules 없음 (yarn install)"
[ -d "$ROOT/collector/node_modules" ] && pass "collector/node_modules" || fail "collector/node_modules 없음"
[ -d "$ROOT/frontend/node_modules" ] && pass "frontend/node_modules" || fail "frontend/node_modules 없음"
if [ -x "$CACHE/docling-venv/bin/docling-serve" ]; then
  "$CACHE/docling-venv/bin/python" -c "import docling, sklearn, statsmodels" >/dev/null 2>&1 \
    && pass "Docling 파이썬 환경 (docling · sklearn · statsmodels)" || fail "Docling 파이썬 모듈 import 실패"
else
  fail "docling-serve 없음 (setup-mac.sh)"
fi
[ -x "$CACHE/docling-venv/bin/hwp5odt" ] && pass "hwp5odt (HWP 변환)" || note "hwp5odt 없음 — HWP 렌더 변환 불가(텍스트 추출은 가능)"
[ -d "/Applications/LibreOffice.app" ] && pass "LibreOffice" || note "LibreOffice 없음 — PPT→PDF 변환 불가"

echo "[Claude]"
if command -v claude >/dev/null 2>&1; then
  pass "claude CLI: $(command -v claude)"
  MODEL="$(sed -n "s/^CLAUDE_CLI_MODEL=['\"]\{0,1\}\([^'\" ]*\).*/\1/p" "$ROOT/server/.env.development" 2>/dev/null | head -n1)"
  echo "       모델 설정: ${MODEL:-claude-sonnet-5-5 (기본값)}"
  if [ "${1:-}" = "--llm" ]; then
    out="$(claude -p --model "${MODEL:-claude-sonnet-5-5}" "한 단어로만 답해: 안녕" 2>&1 | head -n2)"
    [ -n "$out" ] && pass "claude 응답: $out" || fail "claude 응답 없음 (터미널에서 claude 를 실행해 로그인했는지 확인)"
  else
    echo "       (실제 응답 시험은 --llm 옵션)"
  fi
else
  fail "claude CLI 없음 — npm install -g @anthropic-ai/claude-code 후 claude 로 로그인"
fi

echo "[Postgres / pgvector]"
if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  pass "Postgres 응답"
  if [ -f "$ROOT/server/.env.development" ] && command -v node >/dev/null 2>&1; then
    eval "$(node "$ROOT/scripts/mac/parse-pg-url.cjs" "$ROOT/server/.env.development" 2>/dev/null)"
    n="$(PGPASSWORD="${PGPW:-}" psql -h "${PGHOST_:-127.0.0.1}" -p "${PGPORT_:-5432}" -U "${PGU:-}" -d "${PGDB_:-}" -Atc "select count(*) from anythingllm_vectors" 2>/dev/null || true)"
    if [ -n "${n:-}" ]; then
      pass "앱 계정으로 접속 OK — 벡터 ${n}행"
      [ -f "$ROOT/../data/MANIFEST.txt" ] && echo "       내보낼 때: $(sed -n 's/^pgvector_rows=//p' "$ROOT/../data/MANIFEST.txt" | head -n1)행"
    else
      fail "앱 계정으로 벡터 테이블을 읽지 못함 (import-data.sh)"
    fi
  fi
else
  fail "Postgres 꺼짐 — brew services start postgresql@17"
fi

echo "[데이터]"
[ -f "$ROOT/server/storage/anythingllm.db" ] && pass "SQLite DB $(du -h "$ROOT/server/storage/anythingllm.db" | cut -f1)" || fail "server/storage/anythingllm.db 없음"
[ -d "$ROOT/server/storage/documents" ] && pass "문서 폴더 $(du -sh "$ROOT/server/storage/documents" | cut -f1)" || fail "문서 폴더 없음"
[ -d "$ROOT/server/storage/models" ] && pass "임베딩/리랭커 모델 $(du -sh "$ROOT/server/storage/models" | cut -f1)" || note "모델 폴더 없음 — 첫 사용 때 다운로드(사내 프록시면 실패할 수 있음)"
if [ -d "$ROOT/server/node_modules" ]; then
  if (cd "$ROOT" && node scripts/mac/migrate-docpaths.cjs --check) >/tmp/nexus-docpaths.txt 2>&1; then
    pass "문서 경로 → 파일 확인: $(grep '파일 확인' /tmp/nexus-docpaths.txt)"
  else
    fail "일부 문서 파일을 찾지 못함 — $(grep -E '파일 확인|누락' /tmp/nexus-docpaths.txt | head -n3 | tr '\n' ' ')"
  fi
fi

echo "[서비스]"
http_ok "http://localhost:3001/api/ping" && pass "server :3001" || fail "server :3001 응답 없음 (./run-local.sh)"
http_ok "http://localhost:8888/health" && pass "collector :8888" || fail "collector :8888 응답 없음"
http_ok "http://localhost:3000/index.html" && pass "frontend :3000" || note "frontend :3000 응답 없음 — 시작 직후엔 30초쯤 걸릴 수 있음"
http_ok "http://127.0.0.1:5001/health" && pass "Docling 켜짐" || echo "       Docling 꺼짐 (정상: 필요할 때 ./start-docling.sh)"

echo "[메모리]"
if command -v vm_stat >/dev/null 2>&1; then
  mb="$(node -e 'console.log(require(process.argv[1]).availableMemoryMb())' "$ROOT/server/utils/helpers/availableMemory.js" 2>/dev/null || true)"
  [ -n "${mb:-}" ] && echo "       사용 가능 메모리(캐시 포함): ${mb}MB"
fi

echo
printf "결과: PASS %d · WARN %d · FAIL %d\n" "$PASS" "$WARN" "$FAIL"
[ "$FAIL" = 0 ]
