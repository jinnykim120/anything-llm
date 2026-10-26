#!/usr/bin/env bash
# 3단계: 점검.   사용법:  bash 3-verify.sh        (claude 응답까지 확인:  bash 3-verify.sh --llm)
cd "$(dirname "$0")" || exit 1
exec bash app/scripts/mac/verify-mac.sh "$@"
