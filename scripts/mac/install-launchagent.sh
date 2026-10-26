#!/usr/bin/env bash
# install-launchagent.sh - 맥에서 "로그인 시 자동 시작 + 5분마다 복구"를 설정한다.
# (윈도의 작업 스케줄러 NEXUS-AutoStart 와 같은 역할)
#
#   scripts/mac/install-launchagent.sh              # 설치(= --install)
#   scripts/mac/install-launchagent.sh --pause      # 잠시 멈춤(서비스를 직접 내리고 작업할 때)
#   scripts/mac/install-launchagent.sh --resume     # 다시 켬
#   scripts/mac/install-launchagent.sh --status
#   scripts/mac/install-launchagent.sh --uninstall
#   옵션: --no-caffeinate   전원 연결 중 절전 방지(caffeinate -s) 에이전트를 만들지 않음
#
# 만드는 것:
#   ~/Library/LaunchAgents/com.nexus.autostart.plist   run-local.sh 를 로그인 시 + 300초마다 실행
#   ~/Library/LaunchAgents/com.nexus.caffeinate.plist  전원 어댑터 연결 중에는 잠자기 방지
# 한계: 로그아웃/재부팅 후 로그인 전까지는 내려가 있다. 덮개를 닫으면(외장 모니터 없이)
#       맥은 잠자기에 들어간다 — 서버로 돌릴 때는 덮개를 열어 두세요.
set -eu
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
UID_="$(id -u)"
L_AUTO="com.nexus.autostart"
L_CAFF="com.nexus.caffeinate"
ACTION="--install"; CAFF=1
for a in "$@"; do
  case "$a" in
    --install|--pause|--resume|--status|--uninstall) ACTION="$a" ;;
    --no-caffeinate) CAFF=0 ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done

load() { launchctl bootstrap "gui/$UID_" "$1" 2>/dev/null || launchctl load -w "$1" 2>/dev/null || true; }
unload() { launchctl bootout "gui/$UID_/$1" 2>/dev/null || launchctl unload "$AGENTS/$1.plist" 2>/dev/null || true; }
is_loaded() { launchctl list 2>/dev/null | grep -q "$1"; }

write_autostart() {
  mkdir -p "$AGENTS" "$ROOT/.local-cache"
  cat >"$AGENTS/$L_AUTO.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$L_AUTO</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$ROOT/run-local.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$ROOT/.local-cache/launchd.autostart.log</string>
  <key>StandardErrorPath</key><string>$ROOT/.local-cache/launchd.autostart.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict>
</plist>
EOF
}

write_caffeinate() {
  cat >"$AGENTS/$L_CAFF.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$L_CAFF</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/caffeinate</string><string>-s</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF
}

case "$ACTION" in
  --install)
    chmod +x "$ROOT"/*.sh 2>/dev/null || true
    write_autostart; unload "$L_AUTO"; load "$AGENTS/$L_AUTO.plist"
    echo "설치됨: $L_AUTO  (로그인 시 + 5분마다 run-local.sh)"
    if [ "$CAFF" = 1 ]; then
      write_caffeinate; unload "$L_CAFF"; load "$AGENTS/$L_CAFF.plist"
      echo "설치됨: $L_CAFF  (전원 연결 중 잠자기 방지)"
    fi
    echo "일시 정지: $0 --pause   |   제거: $0 --uninstall"
    ;;
  --pause)
    unload "$L_AUTO"; echo "일시 정지: $L_AUTO (다시 켜기: $0 --resume)" ;;
  --resume)
    [ -f "$AGENTS/$L_AUTO.plist" ] || { echo "설치되어 있지 않습니다 ($0 --install)"; exit 1; }
    load "$AGENTS/$L_AUTO.plist"; echo "다시 켬: $L_AUTO" ;;
  --status)
    for l in "$L_AUTO" "$L_CAFF"; do
      if is_loaded "$l"; then echo "$l: 실행 중"; else echo "$l: 꺼짐/없음"; fi
    done ;;
  --uninstall)
    unload "$L_AUTO"; unload "$L_CAFF"
    rm -f "$AGENTS/$L_AUTO.plist" "$AGENTS/$L_CAFF.plist"
    echo "제거됨: $L_AUTO, $L_CAFF" ;;
esac
