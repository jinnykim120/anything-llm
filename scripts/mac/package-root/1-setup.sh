#!/usr/bin/env bash
# 1단계: 설치 + 데이터 가져오기 + 실행.   사용법:  bash 1-setup.sh
# (처음 한 번만. 중간에 끊겨도 같은 명령을 다시 실행하면 이어서 진행됩니다)
cd "$(dirname "$0")" || exit 1
chmod +x app/*.sh app/scripts/mac/*.sh 2>/dev/null
exec bash app/scripts/mac/setup-mac.sh --data "$(pwd)/data" "$@"
