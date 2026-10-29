// 이 PC에서 사이트를 만들어 맥북으로 보낸다.
//   node insights-site/deploy.mjs            # 빌드 → 단일 파일 → 맥북 전송
//   node insights-site/deploy.mjs --no-build # 이미 만든 dist/NEXUS-Insight.html 만 전송
// 설정: insights-site/deploy/mac.config.json (mac.config.example.json 을 복사해 채운다. git 에는 안 들어감)
// SSH 키 로그인(BatchMode)만 쓴다. 비밀번호는 다루지 않는다.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { here } from "./lib.mjs";

const cfgFile = join(here, "deploy", "mac.config.json");
if (!existsSync(cfgFile)) { console.error("deploy/mac.config.json 이 없습니다. deploy/mac.config.example.json 을 복사해 host, user 를 채우세요."); process.exit(1); }
const { host, user, remoteDir = "nexus-insight" } = JSON.parse(readFileSync(cfgFile, "utf8"));
if (!host || !user || /맥북/.test(host + user)) { console.error("mac.config.json 의 host, user 를 실제 값으로 채우세요."); process.exit(1); }
const run = (cmd, args, label) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) { console.error(`실패: ${label}`); process.exit(r.status || 1); }
};
if (!process.argv.includes("--no-build")) {
  run("node", [join(here, "build.mjs"), "--preview", "--no-banner"], "빌드");
  run("node", [join(here, "bundle.mjs")], "단일 파일 만들기");
}
const file = join(here, "dist", "NEXUS-Insight.html");
if (!existsSync(file)) { console.error("dist/NEXUS-Insight.html 이 없습니다."); process.exit(1); }
const target = `${user}@${host}`, ssh = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
run("ssh", [...ssh, target, `mkdir -p ~/${remoteDir}`], "맥북 접속(SSH 키 로그인이 설정됐는지 확인)");
run("scp", [...ssh, file, `${target}:${remoteDir}/index.html.tmp`], "파일 전송");
run("ssh", [...ssh, target, `mv ~/${remoteDir}/index.html.tmp ~/${remoteDir}/index.html`], "교체");
console.log(`전송 완료 → http://${host}:8080`);
