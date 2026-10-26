#!/usr/bin/env bash
# 2단계: 평소 시작.   사용법:  bash 2-start.sh
# 서버(3001) · 프론트(3000) · 콜렉터(8888) · Postgres 를 올립니다. → http://localhost:3000/
# Docling 은 수동입니다:  bash app/start-docling.sh   /   bash app/stop-docling.sh
cd "$(dirname "$0")" || exit 1
chmod +x app/*.sh 2>/dev/null
exec bash app/run-local.sh "$@"
