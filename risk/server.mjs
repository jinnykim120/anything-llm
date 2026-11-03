// 리스크 모니터 서버: 접속 비밀번호 확인 → 페이지 제공 + 키워드 직접 검색·관심 키워드 API. 외부 라이브러리 없음.
//   node server.mjs                      # 포트 8081 (RISK_PORT 로 변경)
//   node server.mjs --set-password       # 접속 비밀번호 설정(환경변수 RISK_NEW_PASSWORD 로 전달, secrets/access.json 에 해시로 저장)
// 직접 검색은 한 번에 하나씩 순서대로 처리한다(risk.mjs --keywords). 결과는 risk.mjs 가 저장소·페이지를 갱신한다.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { handleApi } from "./api.mjs";

const here = join(fileURLToPath(import.meta.url), "..");
const PORT = Number(process.env.RISK_PORT || 8081), SECRETS = join(here, "secrets", "access.json"), DATA = join(here, "data"), WATCH = join(DATA, "watch.json"), PAGE = join(here, "site", "index.html"), APP = join(here, "app"), FONTS = join(here, "assets", "fonts");
mkdirSync(DATA, { recursive: true }); mkdirSync(join(here, "secrets"), { recursive: true });
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

if (process.argv.includes("--set-password")) {
  const pw = process.env.RISK_NEW_PASSWORD; if (!pw || pw.length < 6) { console.error("RISK_NEW_PASSWORD(6자 이상)를 환경변수로 전달하세요."); process.exit(1); }
  const salt = randomBytes(16); writeFileSync(SECRETS, JSON.stringify({ salt: salt.toString("hex"), hash: scryptSync(pw, salt, 32).toString("hex") }) + "\n");
  console.log("접속 비밀번호를 설정했습니다(해시만 저장)."); process.exit(0);
}
if (!existsSync(SECRETS)) { console.error("접속 비밀번호가 없습니다. RISK_NEW_PASSWORD=... node server.mjs --set-password"); process.exit(1); }
const cred = JSON.parse(readFileSync(SECRETS, "utf8"));
const checkPw = (pw) => { const h = scryptSync(String(pw), Buffer.from(cred.salt, "hex"), 32), e = Buffer.from(cred.hash, "hex"); return h.length === e.length && timingSafeEqual(h, e); };

// ── 세션·로그인 시도 제한
const sessions = new Map(), fails = new Map(), TTL = 12 * 3600e3;
const cookieOf = (req) => Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]));
const authed = (req) => { const t = cookieOf(req).rk, s = t && sessions.get(t); if (!s) return false; if (Date.now() > s) { sessions.delete(t); return false; } return true; };
const ipOf = (req) => req.socket.remoteAddress || "";
const locked = (ip) => { const f = fails.get(ip); return f && f.n >= 5 && Date.now() - f.at < 10 * 60e3; };

const LOGIN = (msg = "") => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>Risk Monitor 접속</title>
<script>try{if(localStorage.getItem("rk-theme")==="dark")document.documentElement.setAttribute("data-theme","dark")}catch(e){}</script><style>
/* 기본은 항상 라이트(OS 다크 설정과 무관). 화면 모드를 직접 다크로 바꾼 브라우저에서만 다크. */
:root{--bg:#f6f7fa;--card:#fff;--ink:#222;--mute:#6b6b6b;--line:#e4e7ec;--blue:#2f6fed;--bg2:#eef4ff}
:root[data-theme=dark]{--bg:#15130f;--card:#211e19;--ink:#f1ede6;--mute:#a39c92;--line:#35302a;--blue:#7ba4ff;--bg2:#1d2742}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(900px 500px at 80% -10%,var(--bg2),transparent 60%),var(--bg);color:var(--ink);font:15px/1.6 "Pretendard Variable","Malgun Gothic","Apple SD Gothic Neo",sans-serif}
.c{width:min(380px,90vw);background:var(--card);border-radius:22px;padding:34px 30px;box-shadow:0 0 0 1px rgba(28,40,64,.05),0 12px 36px rgba(28,40,64,.1)}
h1{margin:0 0 6px;font-size:22px;letter-spacing:-.02em}h1 b{color:var(--blue)}p{margin:0 0 20px;color:var(--mute);font-size:13.5px}
input{width:100%;height:46px;border-radius:999px;border:1.5px solid var(--line);background:var(--card);color:var(--ink);padding:0 18px;font:inherit;outline:none;box-sizing:border-box}input:focus{border-color:var(--blue);box-shadow:0 0 0 3px color-mix(in srgb,var(--blue) 22%,transparent)}
button{width:100%;height:46px;margin-top:12px;border:0;border-radius:999px;background:var(--blue);color:#fff;font:inherit;font-weight:800;cursor:pointer;box-shadow:0 6px 16px color-mix(in srgb,var(--blue) 30%,transparent)}
:root[data-theme=dark] button{color:#0b1226}
.e{margin-top:12px;color:#d63a3a;font-size:13px;font-weight:700;min-height:18px}</style></head><body><form class="c" method="post" action="/login">
<h1>NEXUS <b>Risk</b> Monitor</h1><p>리스크 담당자용 페이지입니다. 접속 비밀번호를 입력하세요.</p>
<input type="password" name="pw" placeholder="접속 비밀번호" autofocus autocomplete="current-password" aria-label="접속 비밀번호"><button type="submit">들어가기</button><div class="e">${msg}</div></form></body></html>`;

const body = (req) => new Promise((res) => { let b = ""; req.on("data", (d) => { b += d; if (b.length > 20000) req.destroy(); }); req.on("end", () => res(b)); });
const send = (res, code, type, data, extra = {}) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra }); res.end(data); };
const json = (res, code, o) => send(res, code, "application/json; charset=utf-8", JSON.stringify(o));

// ── 관심 키워드
const readWatch = () => { try { return JSON.parse(readFileSync(WATCH, "utf8")).keywords || []; } catch { return []; } };
const writeWatch = (k) => writeFileSync(WATCH, JSON.stringify({ keywords: k }, null, 2) + "\n");
const cleanKw = (s) => String(s || "").replace(/[\r\n;<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

// ── 직접 검색 작업 큐(한 번에 하나)
const jobs = []; let running = false, seq = 0;
function pump() {
  if (running) return; const job = jobs.find((j) => j.status === "대기"); if (!job) return;
  running = true; job.status = "진행 중"; job.startedAt = Date.now();
  const child = spawn(process.execPath, [join(here, "risk.mjs"), "--keywords", job.keywords.join(";"), "--no-publish"], { cwd: here, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  const to = setTimeout(() => child.kill("SIGKILL"), 40 * 60e3);
  child.on("close", (code) => { clearTimeout(to); job.status = code === 0 ? "완료" : "실패"; job.endedAt = Date.now(); const m = out.match(/저장: 신규 (\d+) · 업데이트 (\d+)/); const fm = out.match(/수집 합계 (\d+)건/); job.result = m ? { found: fm ? +fm[1] : null, added: +m[1], updated: +m[2] } : null; if (code !== 0) job.error = out.trim().split("\n").slice(-2).join(" ").slice(0, 200); running = false; log(`작업 ${job.id} ${job.status}`); pump(); });
}
const jobView = (j) => ({ id: j.id, keywords: j.keywords, status: j.status, createdAt: j.createdAt, result: j.result || null, error: j.error || null });

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x"), p = url.pathname, ip = ipOf(req);
    if (p === "/login" && req.method === "POST") {
      if (locked(ip)) return send(res, 429, "text/html; charset=utf-8", LOGIN("시도가 너무 많습니다. 10분 뒤에 다시 하세요."));
      const pw = new URLSearchParams(await body(req)).get("pw") || "";
      if (checkPw(pw)) { fails.delete(ip); const t = randomBytes(32).toString("hex"); sessions.set(t, Date.now() + TTL); return send(res, 302, "text/plain", "", { location: "/", "set-cookie": `rk=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL / 1000}` }); }
      const f = fails.get(ip) || { n: 0, at: 0 }; fails.set(ip, { n: f.n + 1, at: Date.now() }); log(`로그인 실패 ${ip}`);
      return send(res, 401, "text/html; charset=utf-8", LOGIN("비밀번호가 맞지 않습니다."));
    }
    if (p === "/logout") return send(res, 302, "text/plain", "", { location: "/", "set-cookie": "rk=; Path=/; Max-Age=0" });
    if (!authed(req)) return p.startsWith("/api/") ? json(res, 401, { error: "login" }) : send(res, 200, "text/html; charset=utf-8", LOGIN());
    // 첫 화면 = 대시보드 앱(app/index.html, 4개 탭). 센싱 탭은 기존 센싱 페이지(/sensing)를 그대로 보여준다.
    if ((p === "/" || p === "/index.html") && existsSync(join(APP, "index.html"))) return send(res, 200, "text/html; charset=utf-8", readFileSync(join(APP, "index.html")));
    { const a = p.match(/^\/app\/([\w.-]+\.(css|js))$/); if (a && existsSync(join(APP, a[1]))) return send(res, 200, a[2] === "css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", readFileSync(join(APP, a[1]))); }
    if (p === "/sensing") return existsSync(PAGE) ? send(res, 200, "text/html; charset=utf-8", url.searchParams.has("embed") ? readFileSync(PAGE, "utf8").replace("</head>", "<style>.top{display:none}.ctl{top:0!important}</style></head>") : readFileSync(PAGE)) : send(res, 200, "text/html; charset=utf-8", "<meta charset=utf-8><p>아직 생성된 센싱 페이지가 없습니다. node risk.mjs --build-only</p>");
    { const f = p.match(/^\/assets\/fonts\/([\w.-]+\.woff2)$/); if (f && existsSync(join(FONTS, f[1]))) return send(res, 200, "font/woff2", readFileSync(join(FONTS, f[1])), { "cache-control": "public, max-age=86400" }); }
    if (await handleApi(req, res, p, url, { body, json })) return;
    if (p === "/" || p === "/index.html") return existsSync(PAGE) ? send(res, 200, "text/html; charset=utf-8", readFileSync(PAGE)) : send(res, 200, "text/html; charset=utf-8", "<meta charset=utf-8><p>아직 생성된 페이지가 없습니다. risk.mjs 를 먼저 실행하세요.</p>");
    if (p === "/api/watch" && req.method === "GET") return json(res, 200, { keywords: readWatch() });
    if (p === "/api/watch" && req.method === "POST") {
      const b = JSON.parse((await body(req)) || "{}"), w = readWatch();
      if (b.add) { const k = cleanKw(b.add); if (k && !w.includes(k)) w.push(k); if (w.length > 300) return json(res, 400, { error: "관심 키워드는 300개까지입니다" }); }
      if (b.remove) { const i = w.indexOf(cleanKw(b.remove)); if (i >= 0) w.splice(i, 1); }
      writeWatch(w); return json(res, 200, { keywords: w });
    }
    if (p === "/api/search" && req.method === "POST") {
      const b = JSON.parse((await body(req)) || "{}"), kws = [...new Set(String(b.keywords || "").split(/[,;\n]/).map(cleanKw).filter(Boolean))].slice(0, 3);
      if (!kws.length) return json(res, 400, { error: "키워드를 입력하세요" });
      if (jobs.filter((j) => j.status === "대기" || j.status === "진행 중").length >= 5) return json(res, 429, { error: "대기 중인 검색이 많습니다. 잠시 뒤에 다시 하세요" });
      const job = { id: ++seq, keywords: kws, status: "대기", createdAt: Date.now() }; jobs.push(job); if (jobs.length > 30) jobs.shift(); log(`작업 ${job.id} 접수: ${kws.join(", ")}`); pump();
      return json(res, 200, { job: jobView(job) });
    }
    if (p === "/api/jobs") return json(res, 200, { jobs: jobs.slice(-10).map(jobView), running });
    return send(res, 404, "text/plain; charset=utf-8", "not found");
  } catch (e) { log("오류", e.message); try { json(res, 500, { error: "server" }); } catch {} }
}).listen(PORT, "0.0.0.0", () => log(`Risk Monitor 서버: http://0.0.0.0:${PORT}`));
