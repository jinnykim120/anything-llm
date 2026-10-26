#!/usr/bin/env bash
# setup-mac.sh - 맥에서 NEXUS 시스템을 처음 세팅한다 (설치 → 데이터 가져오기 → 실행).
#
#   scripts/mac/setup-mac.sh [--data DIR] [--force-data] [--skip-brew] [--skip-libreoffice]
#                            [--skip-python] [--skip-data] [--no-start]
#
# 하는 일 (모두 멱등 — 중간에 끊겨도 다시 실행하면 이어서 진행):
#   1 Homebrew 도구   git · node@24 · postgresql@17 · pgvector · python@3.12 · LibreOffice
#   2 Node 의존성     yarn install (server · collector · frontend) + prisma generate
#   3 Python 환경     .local-cache/docling-venv (Docling · 통계분석 · 한글 변환)
#   4 데이터          설정 · SQLite DB · 문서 · 모델 · pgvector 복원 · 문서 경로 변환
#   5 실행            ./run-local.sh  →  http://localhost:3000/
#
# 이 스크립트는 맥에서 실제로 돌려 본 적이 없다(개발은 윈도 PC). 막히는 단계가 있으면
# 메시지를 그대로 알려 주세요 — 각 단계는 따로 다시 실행할 수 있습니다.
set -eu
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE="$ROOT/.local-cache"
DATA="$ROOT/../data"
SKIP_BREW=0; SKIP_LO=0; SKIP_PY=0; SKIP_DATA=0; NO_START=0; FORCE_DATA=0
while [ $# -gt 0 ]; do
  case "$1" in
    --data) DATA="$2"; shift 2 ;;
    --force-data) FORCE_DATA=1; shift ;;
    --skip-brew) SKIP_BREW=1; shift ;;
    --skip-libreoffice) SKIP_LO=1; shift ;;
    --skip-python) SKIP_PY=1; shift ;;
    --skip-data) SKIP_DATA=1; shift ;;
    --no-start) NO_START=1; shift ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
done

info() { printf "\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n" "$*"; }
ok() { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!!\033[0m %s\n" "$*"; }
die() { printf "\033[1;31mxx\033[0m %s\n" "$*" >&2; exit 1; }
on_err() { printf "\n\033[1;31m단계 실패\033[0m (스크립트 %s 줄). 위 메시지를 확인하고 같은 명령을 다시 실행하세요.\n" "$1" >&2; }
trap 'on_err $LINENO' ERR

mkdir -p "$CACHE"

# brew 가 PATH 에 없으면 흔한 설치 위치에서 환경을 불러온다
load_brew() {
  command -v brew >/dev/null 2>&1 && return 0
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then
      eval "$("$b" shellenv)"
      return 0
    fi
  done
  return 1
}

# --- 0) 사전 점검 -------------------------------------------------------------
info "0. 환경 점검"
[ "$(uname -s)" = "Darwin" ] || warn "macOS 가 아닙니다 ($(uname -s)) — 일부 단계(brew cask)는 건너뛰어야 할 수 있습니다"
[ "$(uname -m)" = "arm64" ] && ok "Apple Silicon (arm64)" || warn "arm64 가 아닙니다 ($(uname -m)) — 인텔 맥은 미검증"
ok "저장소: $ROOT"

# 사내 프록시(MITM) CA 가 데이터에 들어 있으면 먼저 적용해 brew/pip/yarn 이 통하게
if [ -f "$DATA/config/corp-root-ca.pem" ] && [ ! -f "$CACHE/corp-root-ca.pem" ]; then
  cp "$DATA/config/corp-root-ca.pem" "$CACHE/corp-root-ca.pem"
fi
if [ "${NEXUS_SKIP_CORP_CA:-0}" != 1 ] && [ -f "$CACHE/corp-root-ca.pem" ]; then
  export SSL_CERT_FILE="$CACHE/corp-root-ca.pem"
  export NODE_EXTRA_CA_CERTS="$CACHE/corp-root-ca.pem"
  export REQUESTS_CA_BUNDLE="$CACHE/corp-root-ca.pem"
  export PIP_CERT="$CACHE/corp-root-ca.pem"
  export CURL_CA_BUNDLE="$CACHE/corp-root-ca.pem"
  export npm_config_strict_ssl=false
  ok "사내 프록시 CA 적용"
fi

# --- 1) Homebrew ----------------------------------------------------------------
if [ "$SKIP_BREW" = 0 ]; then
  info "1. Homebrew 도구"
  load_brew || true
  command -v brew >/dev/null 2>&1 || die "Homebrew 가 없습니다. 먼저 설치하세요:
   /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"
   설치 후 터미널을 다시 열고 이 스크립트를 다시 실행하세요."
  ok "brew $(brew --version | head -n1)"

  brew_formula() { brew list --formula "$1" >/dev/null 2>&1 && ok "$1 (이미 설치됨)" || { echo "  설치: $1"; brew install "$1"; }; }
  brew_formula git
  brew_formula node@24
  brew_formula postgresql@17
  brew_formula pgvector
  brew_formula python@3.12
  if [ "$SKIP_LO" = 0 ]; then
    if [ -d "/Applications/LibreOffice.app" ] || brew list --cask libreoffice >/dev/null 2>&1; then
      ok "LibreOffice (이미 설치됨)"
    else
      echo "  설치: LibreOffice (PPT→PDF 변환·HWP 변환에 사용, 용량이 큽니다)"
      brew install --cask libreoffice
    fi
  fi
fi

load_brew || true
NODE_PREFIX="$(brew --prefix node@24 2>/dev/null || true)"
PG_PREFIX="$(brew --prefix postgresql@17 2>/dev/null || true)"

# 이후 모든 스크립트(run-local.sh 등)가 같은 PATH 를 쓰도록 기록
cat >"$CACHE/mac-env.sh" <<EOF
# setup-mac.sh 가 생성 — Node / Postgres 경로 (run-local.sh · start-docling.sh 가 읽음)
export PATH="${NODE_PREFIX:+$NODE_PREFIX/bin:}${PG_PREFIX:+$PG_PREFIX/bin:}\$PATH"
export NEXUS_PG_FORMULA="postgresql@17"
EOF
# shellcheck disable=SC1090,SC1091
. "$CACHE/mac-env.sh"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"

command -v node >/dev/null 2>&1 || die "node 를 찾지 못했습니다 (brew install node@24)"
ok "node $(node -v)"
if ! command -v yarn >/dev/null 2>&1; then
  echo "  설치: yarn (npm i -g yarn)"
  npm install -g yarn
fi
ok "yarn $(yarn -v)"

# --- 2) Node 의존성 -------------------------------------------------------------
info "2. Node 의존성 (처음에는 5~10분 걸립니다)"
for d in server collector frontend; do
  echo "  yarn install: $d"
  (cd "$ROOT/$d" && { yarn install --frozen-lockfile || yarn install; })
done
echo "  prisma generate"
(cd "$ROOT/server" && npx prisma generate)
ok "Node 의존성 준비됨"

# --- 3) Python (Docling · 통계분석 · 한글 변환) --------------------------------------
if [ "$SKIP_PY" = 0 ]; then
  info "3. Python 환경 (Docling 등, 처음에는 5~15분 걸립니다)"
  PY="$(brew --prefix python@3.12 2>/dev/null)/bin/python3.12"
  [ -x "$PY" ] || PY="$(command -v python3.12 || true)"
  [ -x "$PY" ] || die "python3.12 를 찾지 못했습니다 (brew install python@3.12)"
  VENV="$CACHE/docling-venv"
  [ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
  "$VENV/bin/python" -m pip install --upgrade pip >/dev/null
  if "$VENV/bin/pip" install -r "$ROOT/scripts/mac/requirements-docling.txt"; then
    ok "고정 버전으로 설치됨"
  else
    warn "고정 버전 설치에 실패해 버전 제한 없이 다시 시도합니다"
    "$VENV/bin/pip" install -r "$ROOT/scripts/mac/requirements-docling.loose.txt"
  fi
  "$VENV/bin/python" - <<'PY'
import importlib
for m in ("docling", "sklearn", "statsmodels", "pandas", "openpyxl", "docx"):
    importlib.import_module(m)
print("  python modules OK")
PY
  [ -x "$VENV/bin/docling-serve" ] && ok "docling-serve 설치됨" || warn "docling-serve 실행 파일이 없습니다"
  [ -x "$VENV/bin/hwp5odt" ] && ok "hwp5odt 설치됨 (HWP 변환)" || warn "hwp5odt 가 없습니다 (HWP 렌더 변환 불가, 텍스트 추출은 가능)"
fi

# --- 4) Postgres 실행 + 데이터 -------------------------------------------------------
if [ "$SKIP_DATA" = 0 ]; then
  info "4. Postgres 시작 + 데이터 가져오기"
  if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    brew services start postgresql@17 >/dev/null
    for _ in $(seq 1 40); do pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break; sleep 1; done
  fi
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 || die "Postgres 를 시작하지 못했습니다 (brew services list 확인)"
  ok "Postgres 실행 중"
  if [ -d "$DATA" ]; then
    if [ "$FORCE_DATA" = 1 ]; then
      "$ROOT/scripts/mac/import-data.sh" --data "$DATA" --force
    else
      "$ROOT/scripts/mac/import-data.sh" --data "$DATA"
    fi
  else
    warn "데이터 폴더($DATA)가 없어 새 설치로 진행합니다 — 설정 파일(.env)은 직접 만들어야 합니다"
  fi
fi

# --- 5) 외부 도구 점검 -----------------------------------------------------------------
info "5. 외부 도구 점검"
if command -v claude >/dev/null 2>&1; then
  ok "claude CLI: $(command -v claude)"
else
  warn "claude CLI 가 없습니다. 답변·보고서 생성에 필요합니다:
     npm install -g @anthropic-ai/claude-code   (또는 공식 설치 방법)
     설치 후 터미널에서  claude  를 한 번 실행해 로그인하세요."
fi
[ -d "/Applications/LibreOffice.app" ] && ok "LibreOffice" || warn "LibreOffice 가 없습니다 (PPT→PDF 변환 불가)"

# --- 6) 실행 ----------------------------------------------------------------------------
if [ "$NO_START" = 0 ]; then
  info "6. 서비스 시작"
  chmod +x "$ROOT"/*.sh "$ROOT"/scripts/mac/*.sh 2>/dev/null || true
  "$ROOT/run-local.sh"
  echo
  ok "완료.  http://localhost:3000/  를 열어 보세요."
  echo "   점검:  scripts/mac/verify-mac.sh"
  echo "   자동 시작(로그인 시 + 5분마다 복구):  scripts/mac/install-launchagent.sh"
fi
