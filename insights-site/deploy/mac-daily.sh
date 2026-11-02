#!/bin/bash
# 맥북에서 매일 이슈 카드(2장)를 만들고 사이트를 게시한다. launchd(com.nexus.insight.daily)가 호출한다.
# 로그: insights-site/logs/daily-task.log
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/AI_factory/NEXUS-Mac-Package/app"
export ARCHIVE_ROOT="$APP"                              # NEXUS 아카이브(분류 DB·문서)를 직접 읽는다
[ -f "$APP/.local-cache/corp-root-ca.pem" ] && export NODE_EXTRA_CA_CERTS="$APP/.local-cache/corp-root-ca.pem"
export CLAUDE_CLI_BIN="$HOME/.local/bin/claude"
mkdir -p "$HERE/logs"
cd "$HERE/.." && node "$HERE/daily.mjs" "$@" >> "$HERE/logs/daily-task.log" 2>&1
