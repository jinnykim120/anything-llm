#!/bin/bash
# 맥북에서 한 번만 실행: 사이트를 8080 포트로 열어 두는 서버를 만들고, 로그인할 때마다 자동으로 켜지게 한다.
#   bash mac-setup.sh
set -e
DIR="$HOME/nexus-insight"
PORT=8080
LABEL="com.nexus.insight"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
[ -f "$DIR/index.html" ] || echo "<meta charset=utf-8><p>NEXUS Insight — 아직 파일이 전송되지 않았습니다.</p>" > "$DIR/index.html"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string><string>-I</string><string>-m</string><string>http.server</string>
    <string>$PORT</string><string>--bind</string><string>0.0.0.0</string><string>--directory</string><string>$DIR</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "?")
echo "서버 시작: http://$IP:$PORT"
echo "이 맥의 IP: $IP  /  사용자: $(whoami)  (PC의 deploy/mac.config.json 에 적으세요)"
echo "※ 원격 로그인(시스템 설정 > 일반 > 공유 > 원격 로그인)이 켜져 있어야 PC에서 파일을 보낼 수 있습니다."
echo "※ 맥이 잠자기에 들어가면 접속이 끊깁니다. 전원 어댑터 연결 시 잠자기 방지를 설정하세요."
