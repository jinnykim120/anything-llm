#!/usr/bin/env bash
# import-data.sh - 윈도 PC 에서 내보낸 데이터(패키지의 data/ 폴더)를 이 저장소로 가져온다.
#
#   scripts/mac/import-data.sh [--data DIR] [--force]
#
# 가져오는 것:  설정(.env) · server/storage(SQLite DB·문서·모델) · Docling 모델 캐시 ·
#               사내 프록시 CA · pgvector 벡터 DB(덤프 복원) · 문서 경로 변환(\ → /)
# 멱등: 이미 데이터가 있으면 건너뛴다.  --force 를 주면 덮어쓴다(기존 DB 는 .bak 로 보존).
# 선행조건: Node 와 Postgres 가 실행 중 (setup-mac.sh 가 준비한다).
set -eu
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE="$ROOT/.local-cache"
DATA="$ROOT/../data"
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --data) DATA="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
done

# shellcheck disable=SC1091
[ -f "$CACHE/mac-env.sh" ] && . "$CACHE/mac-env.sh"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"

info() { printf "\n\033[1;34m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!!\033[0m %s\n" "$*"; }
die() { printf "\033[1;31mxx\033[0m %s\n" "$*" >&2; exit 1; }

[ -d "$DATA" ] || die "데이터 폴더를 찾지 못했습니다: $DATA  (--data 로 지정)"
DATA="$(cd "$DATA" && pwd)"
info "데이터 폴더: $DATA"
[ -f "$DATA/MANIFEST.txt" ] && sed -n '1,12p' "$DATA/MANIFEST.txt"

# --- 1) 설정 파일 -------------------------------------------------------------
copy_cfg() { # <src> <dest>
  if [ ! -f "$1" ]; then return; fi
  if [ -f "$2" ] && [ "$FORCE" = 0 ]; then
    echo "  유지: $2 (이미 있음)"
  else
    mkdir -p "$(dirname "$2")"
    cp "$1" "$2"
    echo "  복사: $2"
  fi
}
info "설정 파일"
copy_cfg "$DATA/config/server.env.development" "$ROOT/server/.env.development"
copy_cfg "$DATA/config/collector.env.development" "$ROOT/collector/.env.development"
copy_cfg "$DATA/config/frontend.env" "$ROOT/frontend/.env"
copy_cfg "$DATA/config/corp-root-ca.pem" "$CACHE/corp-root-ca.pem"

# --- 2) server/storage --------------------------------------------------------
info "server/storage (SQLite DB · 문서 · 모델)"
STORAGE="$ROOT/server/storage"
if [ -f "$STORAGE/anythingllm.db" ] && [ "$FORCE" = 0 ]; then
  echo "  이미 DB 가 있어 건너뜁니다 (--force 로 덮어쓰기)"
else
  if [ -f "$STORAGE/anythingllm.db" ]; then
    cp "$STORAGE/anythingllm.db" "$STORAGE/anythingllm.db.bak.$(date +%Y%m%d%H%M%S)"
  fi
  [ -d "$DATA/storage" ] || die "$DATA/storage 가 없습니다"
  mkdir -p "$STORAGE"
  rsync -a "$DATA/storage/" "$STORAGE/"
  echo "  완료: $(du -sh "$STORAGE" | cut -f1)"
fi

# --- 3) Docling 모델 캐시 ------------------------------------------------------
if [ -d "$DATA/hf" ]; then
  info "Docling 모델 캐시"
  if [ -d "$CACHE/hf" ] && [ "$FORCE" = 0 ]; then
    echo "  이미 있어 건너뜁니다"
  else
    mkdir -p "$CACHE/hf"
    rsync -a "$DATA/hf/" "$CACHE/hf/"
    echo "  완료: $(du -sh "$CACHE/hf" | cut -f1)"
  fi
fi

# --- 4) pgvector 벡터 DB ------------------------------------------------------
DUMP="$DATA/pg/anythingllm_vectors.sql.gz"
if [ -f "$DUMP" ]; then
  info "pgvector 벡터 DB 복원"
  command -v psql >/dev/null 2>&1 || die "psql 이 없습니다 (setup-mac.sh 먼저 실행)"
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 || die "Postgres 가 꺼져 있습니다 (brew services start ${NEXUS_PG_FORMULA:-postgresql@17})"
  eval "$(node "$ROOT/scripts/mac/parse-pg-url.cjs" "$ROOT/server/.env.development")"
  PSQL_SU="psql -h $PGHOST_ -p $PGPORT_ -v ON_ERROR_STOP=1 -q"

  has_role="$($PSQL_SU -d postgres -Atc "select 1 from pg_roles where rolname = '$PGU'" || true)"
  if [ "$has_role" = "1" ]; then
    $PSQL_SU -d postgres -v u="$PGU" -v pw="$PGPW" <<'SQL'
ALTER ROLE :"u" WITH LOGIN PASSWORD :'pw';
SQL
    echo "  역할 유지: $PGU (비밀번호 갱신)"
  else
    $PSQL_SU -d postgres -v u="$PGU" -v pw="$PGPW" <<'SQL'
CREATE ROLE :"u" WITH LOGIN PASSWORD :'pw';
SQL
    echo "  역할 생성: $PGU"
  fi
  has_db="$($PSQL_SU -d postgres -Atc "select 1 from pg_database where datname = '$PGDB_'" || true)"
  if [ "$has_db" != "1" ]; then
    $PSQL_SU -d postgres -v d="$PGDB_" -v u="$PGU" <<'SQL'
CREATE DATABASE :"d" OWNER :"u";
SQL
    echo "  DB 생성: $PGDB_"
  fi
  $PSQL_SU -d "$PGDB_" -c "CREATE EXTENSION IF NOT EXISTS vector" \
    || die "pgvector 확장을 만들지 못했습니다. 'brew install pgvector' 후 Postgres 버전과 맞는지 확인하세요 (brew info pgvector)"

  have_rows="$($PSQL_SU -d "$PGDB_" -Atc "select coalesce((select count(*) from anythingllm_vectors), 0)" 2>/dev/null || echo 0)"
  if [ "${have_rows:-0}" -gt 0 ] && [ "$FORCE" = 0 ]; then
    echo "  벡터 ${have_rows}행이 이미 있어 복원을 건너뜁니다 (--force 로 덮어쓰기)"
  else
    if [ "${have_rows:-0}" -gt 0 ]; then
      $PSQL_SU -d "$PGDB_" -c "DROP TABLE IF EXISTS public.anythingllm_vectors"
    fi
    echo "  덤프 복원 중 (HNSW 인덱스를 다시 만들어 1~2분 걸릴 수 있음)..."
    # pg_dump 16 의 \restrict 메타명령은 구버전 psql 이 모를 수 있어 제거
    gunzip -c "$DUMP" | sed '/^\\restrict /d;/^\\unrestrict /d' | $PSQL_SU -d "$PGDB_"
    $PSQL_SU -d "$PGDB_" -v u="$PGU" <<'SQL'
ALTER TABLE public.anythingllm_vectors OWNER TO :"u";
GRANT ALL ON SCHEMA public TO :"u";
SQL
    $PSQL_SU -d "$PGDB_" -c "ANALYZE public.anythingllm_vectors"
  fi
  n="$($PSQL_SU -d "$PGDB_" -Atc "select count(*) from anythingllm_vectors")"
  echo "  벡터 행 수: $n"
  if [ -f "$DATA/MANIFEST.txt" ]; then
    want="$(sed -n 's/^pgvector_rows=//p' "$DATA/MANIFEST.txt" | head -n1)"
    if [ -n "$want" ] && [ "$want" != "$n" ]; then
      warn "내보낼 때 벡터 행 수($want)와 다릅니다 — 복원이 불완전할 수 있습니다"
    fi
  fi
else
  warn "벡터 덤프($DUMP)가 없어 건너뜁니다 — 필요하면 문서함에서 워크스페이스를 다시 임베딩하세요"
fi

# --- 5) 문서 경로 변환 ----------------------------------------------------------
info "문서 경로 변환 (윈도 \\ → /)"
if [ -d "$ROOT/server/node_modules" ]; then
  (cd "$ROOT" && node scripts/mac/migrate-docpaths.cjs) || warn "일부 문서 파일을 찾지 못했습니다 — 위 목록을 확인하세요"
else
  warn "server/node_modules 가 없어 경로 변환을 건너뜁니다 (yarn install 후 node scripts/mac/migrate-docpaths.cjs)"
fi

info "데이터 가져오기 완료"
