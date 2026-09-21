#!/usr/bin/env node
// 자료 추출하기 호출 상한을 켜고 끄는 도우미 (server/.env.development 의
// EXTRACT_LIMITS 값을 바꾼다). 바꾼 뒤에는 서버를 재시작해야 적용된다.
//
//   node scripts/extract-limits.js status   # 지금 상태 확인
//   node scripts/extract-limits.js off      # 상한 해제(예전 동작: 문서 15건, 구간·호출 무제한)
//   node scripts/extract-limits.js on       # 상한 다시 적용(기본값)
const fs = require("fs");
const path = require("path");

const envPath = path.resolve(__dirname, "../.env.development");
const mode = (process.argv[2] || "status").toLowerCase();
const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const re = /^EXTRACT_LIMITS=.*$/m;
const current = (text.match(re)?.[0] || "").split("=")[1]?.replace(/["']/g, "");
const isOff = String(current).toLowerCase() === "off";

if (mode === "status") {
  console.log(
    isOff
      ? "상한 해제됨 (EXTRACT_LIMITS=off) — 문서 15건, 구간·호출 무제한"
      : "상한 적용 중 (기본: 문서 8건 · 문서당 10구간 · 실행당 50회)"
  );
  process.exit(0);
}
if (mode !== "on" && mode !== "off") {
  console.error("사용법: node scripts/extract-limits.js status|on|off");
  process.exit(1);
}
let next = text;
if (mode === "off") {
  next = re.test(text)
    ? text.replace(re, "EXTRACT_LIMITS=off")
    : text.replace(/\s*$/, "\n") + "EXTRACT_LIMITS=off\n";
} else {
  next = text.replace(/^EXTRACT_LIMITS=.*\r?\n?/m, "");
}
fs.writeFileSync(envPath, next);
console.log(
  `EXTRACT_LIMITS ${mode === "off" ? "해제(off)" : "다시 적용"} — 서버를 재시작하면 반영됩니다.`
);
