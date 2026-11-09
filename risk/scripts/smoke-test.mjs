#!/usr/bin/env node
// 자동 점검(스모크 테스트): 가짜 AI(스텁)로 핵심 흐름이 깨지지 않았는지 한 번에 확인한다.
//   node scripts/smoke-test.mjs        → 통과/실패 목록을 출력하고, 실패가 있으면 종료 코드 1
// 실제 데이터·실제 AI·NEXUS 를 쓰지 않는다: 코드를 임시 폴더로 복사해 새 DB 로 서버와 센싱을 띄우고, 끝나면 모두 지운다.
// 수정할 때마다 돌리면 정규식·삽입 위치 같은 실수를 바로 잡을 수 있다(AI 호출 0, 약 20~40초).
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { inflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const results = []; let tmp = "", server = null, srcServer = null;
const pass = (n) => { results.push([true, n]); console.log("  PASS", n); };
const fail = (n, why) => { results.push([false, n]); console.log("  FAIL", n, "—", why); };
async function check(name, fn) { try { const r = await fn(); if (!r) fail(name, "조건 불일치"); else pass(name); } catch (e) { fail(name, String(e.message || e).slice(0, 160)); } }
// 자식 프로세스를 비동기로 실행한다(동기 실행은 같은 프로세스의 시험용 웹서버를 멈춰 세운다)
const runAsync = (cmd, args, opts) => new Promise((ok) => { const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); const t = setTimeout(() => p.kill(), opts.timeout || 120000); p.on("close", (code) => { clearTimeout(t); ok({ status: code, stdout: out, stderr: err }); }); });
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 가짜 claude: 프롬프트(system) 종류를 보고 알맞은 JSON 을 돌려준다
const STUB = `
import { appendFileSync } from "node:fs";
const a = process.argv, si = a.indexOf("--system-prompt"), sys = si >= 0 ? a[si + 1] : "";
let u = ""; process.stdin.on("data", (d) => (u += d)).on("end", () => {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const web = sys.includes("리서처");
  if (web && process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, "web" + String.fromCharCode(10));
  if (web && process.env.STUB_MAXTURNS) { console.log(JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "", total_cost_usd: 0.001, num_turns: 3, usage: {} })); return; }
  let r;
  if (sys.includes("리서처")) r = { issues: !(u.includes("최대 18회까지") && a.includes("--max-turns") && a.includes("--max-budget-usd")) ? [] : [{ updateOf: null, keyword: "", area: process.env.STUB_AREA || "기타", title: "스모크 시험 이슈 점포 사고", status: "발생", occurredAt: today, summary: "시험용 이슈 요약입니다. 점포 앞에서 사고가 있었다는 가상의 내용입니다.", agencies: [{ name: "시험기관", action: "점검 착수" }], products: ["삼각김밥"], keywords: ["점포", "사고"], sources: [{ title: "시험 기사", url: process.env.STUB_SRC, date: today }] }] };
  else if (sys.includes("사내 아카이브 발췌")) r = { relation: "시험용 관계 설명입니다. 당사 점포와 관련될 수 있습니다.", exposure: ["점포 운영"], contact: "불명", level: "중간", levelWhy: "시험용 근거", responses: ["현황 파악", "유관부서 공유"], cites: [], typeSuggestion: { typeId: "store-dispute", confidence: 0.8, why: "시험" }, buSuggestion: { buId: null, why: "" } };
  else if (sys.includes("보조자입니다")) r = { items: [{ text: "시험용 제안: 사실관계를 먼저 정리한다.", why: "시험", basis: "general", caseId: null }] };
  else if (sys.includes("보고서(종결 보고")) r = { overview: "시험 사건 개요입니다.", timeline: [{ stage: "인지/접수", text: "접수함" }], actions: "- 첫째 대응\\n- 둘째 대응", prevention: "- 점검 강화", lessons: "- 교훈 하나" };
  else if (sys.includes("제목을 정리")) r = { place: "GS25 시험점", keyword: "이물·환불" };
  else r = {};
  console.log(JSON.stringify({ result: JSON.stringify(r), total_cost_usd: 0.001, is_error: false, num_turns: 1, usage: {} }));
});`;

function zipText(buf, name) { // docx(zip)에서 파일 하나의 텍스트를 읽는다(저장된 크기 정보를 쓰는 간단한 판독)
  let i = 0;
  while (i + 30 < buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8), csz = buf.readUInt32LE(i + 18), nl = buf.readUInt16LE(i + 26), el = buf.readUInt16LE(i + 28);
    const nm = buf.slice(i + 30, i + 30 + nl).toString("utf8"), data = buf.slice(i + 30 + nl + el, i + 30 + nl + el + csz);
    if (nm === name) return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    i += 30 + nl + el + csz;
  }
  return "";
}

async function main() {
  console.log("자동 점검을 시작합니다(가짜 AI 사용, 임시 폴더에서 실행)…");
  tmp = mkdtempSync(join(tmpdir(), "risk-smoke-"));
  const skip = (p) => { const rel = p.slice(ROOT.length + 1).split("\\").join("/"); return /^(logs|secrets|site|pilot|reports|node_modules|data\/(?!seed)|\.git)/.test(rel) || rel === "config/nexus.json" || /\.bak|\.tmp-|\.lo-profile/.test(rel); };
  cpSync(ROOT, tmp, { recursive: true, filter: (src) => src === ROOT || !skip(src) });
  mkdirSync(join(tmp, "data"), { recursive: true }); mkdirSync(join(tmp, "secrets"), { recursive: true });
  writeFileSync(join(tmp, "stub.mjs"), STUB);
  const pw = "smoke-pw-1234";
  spawnSync(process.execPath, ["server.mjs", "--set-password"], { cwd: tmp, env: { ...process.env, RISK_NEW_PASSWORD: pw }, stdio: "ignore" });

  // 출처 링크 확인용 작은 웹서버(센싱의 '링크 실재 확인'을 통과시킨다)
  const srcPort = await freePort();
  srcServer = http.createServer((q, s) => { s.writeHead(200, { "content-type": "text/plain" }); s.end("ok"); }).listen(srcPort, "127.0.0.1");
  const env = { ...process.env, RISK_CLAUDE_STUB: join(tmp, "stub.mjs"), STUB_SRC: `http://127.0.0.1:${srcPort}/ok` };

  // ── 센싱: NEXUS 가 안 되는 상태에서도 이슈가 저장되는가(대조 없이 분석 + 표시)
  console.log("\n[센싱 실행]");
  const sc = JSON.parse(readFileSync(join(tmp, "config", "sensing.json"), "utf8")); env.STUB_AREA = sc.areas[0].name;
  writeFileSync(join(tmp, "config", "nexus.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:1", workspace: "archive-full", caseFolder: "리스크관리", keyFile: "secrets/nexus-key.txt", allowTitlePatterns: ["^법규/"] }));
  writeFileSync(join(tmp, "secrets", "nexus-key.txt"), "dummy-key\n");
  let planOut = "";
  await check("센싱 --plan 이 AI 없이 계획을 출력", () => { const r = spawnSync(process.execPath, ["risk.mjs", "--plan"], { cwd: tmp, env, encoding: "utf8", timeout: 30000 }); planOut = r.stdout; return /\[계획\]/.test(r.stdout) && /분야 6개/.test(r.stdout); });
  const run = await runAsync(process.execPath, ["risk.mjs", "--slot", "am"], { cwd: tmp, env, timeout: 180000 });
  const issuesPath = join(tmp, "data", "issues.json");
  await check("센싱이 끝까지 실행(종료 코드 0)", () => run.status === 0 || (console.log((run.stdout || "").slice(-400), (run.stderr || "").slice(-300)), false));
  let saved = null;
  await check("NEXUS 가 안 돼도 이슈가 저장됨", () => { saved = existsSync(issuesPath) ? Object.values(JSON.parse(readFileSync(issuesPath, "utf8")).issues || {}) : []; return saved.length === 1 || (console.log("    저장된 이슈 수:", saved.length, saved.map((i) => i.title + "/" + i.area).join(" | ")), console.log("    센싱 로그 끝:" + String.fromCharCode(10) + (run.stdout || "").split(String.fromCharCode(10)).slice(-12).join(String.fromCharCode(10))), false); });
  await check("대조하지 못한 이슈에 '대조 전' 표시(archiveCheck.ok=false)", () => saved && saved[0] && saved[0].archiveCheck && saved[0].archiveCheck.ok === false);
  await check("수집 호출 수가 계획과 같다(결과가 적어도 재호출하지 않음)", () => { const m = planOut.match(/웹 수집 호출 합계 (\d+)회/); const ls = readFileSync(join(tmp, "logs", "sensing-cost.jsonl"), "utf8").trim().split(String.fromCharCode(10)); const n = JSON.parse(ls[ls.length - 1]).calls.filter((c) => c.kind === "수집").length; return !!m && Number(m[1]) === n && n >= 6 || (console.log("    계획", m && m[1], "실제", n), false); });
  await check("프롬프트의 도구 사용 한도·호출 상한 인자가 전달됨(이슈가 저장됨)", () => saved && saved.length === 1);
  await check("접점 판정(contact)이 이슈에 저장됨", () => saved && saved[0] && saved[0].contact === "불명");
  let plan2 = "";
  await check("기본 품목 범주는 훑은 직후엔 건너뜀(--plan)", () => { const r = spawnSync(process.execPath, ["risk.mjs", "--plan"], { cwd: tmp, env, encoding: "utf8", timeout: 30000 }); plan2 = r.stdout; return /이번 회차 건너뜀/.test(r.stdout) && /품목 목록 \d+개 중 이번에 0개/.test(r.stdout); });
  await check("상한(max_turns)에 걸린 호출은 다시 호출하지 않는다", async () => {
    const logp = join(tmp, "stub-calls.log"), want = Number((plan2.match(/웹 수집 호출 합계 (\d+)회/) || [])[1]);
    const r2 = await runAsync(process.execPath, ["risk.mjs", "--slot", "pm"], { cwd: tmp, env: { ...env, STUB_MAXTURNS: "1", STUB_LOG: logp }, timeout: 120000 });
    const calls = existsSync(logp) ? readFileSync(logp, "utf8").trim().split(String.fromCharCode(10)).length : 0;
    return r2.status === 0 && want > 0 && calls === want || (console.log("    계획", want, "실제 호출", calls, "종료코드", r2.status), false);
  });
  await check("센싱 로그에 NEXUS 연결 안 됨 안내", () => /NEXUS\] 연결 안 됨/.test(run.stdout || ""));

  // ── 서버
  const port = await freePort(), B = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.mjs"], { cwd: tmp, env: { ...env, RISK_PORT: String(port) }, stdio: "ignore" });
  for (let i = 0; i < 40; i++) { try { await fetch(B + "/login", { method: "GET" }); break; } catch { await sleep(250); } }
  const lg = await fetch(B + "/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "pw=" + encodeURIComponent(pw), redirect: "manual" });
  const ck = (lg.headers.get("set-cookie") || "").split(";")[0];
  const H = { cookie: ck, "content-type": "application/json" };
  const api = async (p, b, m) => { const x = await fetch(B + p, { method: m || (b === undefined ? "GET" : "POST"), headers: H, body: b === undefined || m === "GET" ? undefined : JSON.stringify(b) }); const t = await x.text(); let j = {}; try { j = JSON.parse(t); } catch { /* 본문이 JSON 아님 */ } return { s: x.status, t, ...j }; };
  console.log("\n[서버 API]");
  await check("로그인", () => !!ck);
  await check("로그인 없이 API 는 401", async () => (await fetch(B + "/api/dashboard")).status === 401);
  await check("대시보드", async () => (await api("/api/dashboard")).s === 200);

  console.log("\n[센싱 범위·목록]");
  let cfg;
  await check("범위 조회(분야 6개, 기본 품목 20개 이상)", async () => { cfg = await api("/api/sensing/config"); return cfg.s === 200 && cfg.areas.length === 6 && cfg.products.length >= 20 && cfg.limits.webMaxToolUses === 18 && cfg.limits.defaultProductSweepDays === 7; });
  await check("분야 끄기 → 반영, 모두 끄기는 거부(400)", async () => {
    const id = cfg.areas[1].id; const a = await api("/api/sensing/config", { areas: [{ id, on: false }] }); const c2 = await api("/api/sensing/config");
    const off = c2.areas.find((x) => x.id === id).on === false;
    const all = await api("/api/sensing/config", { areas: cfg.areas.map((x) => ({ id: x.id, on: false })) });
    await api("/api/sensing/config", { areas: [{ id, on: true }] });
    return a.s === 200 && off && all.s === 400;
  });
  await check("호출 한도 저장·범위 밖은 거부(400)", async () => { const ok = await api("/api/sensing/config", { limits: { productCallsPerRun: 3 } }); const bad = await api("/api/sensing/config", { limits: { productCallsPerRun: 99 } }); await api("/api/sensing/config", { limits: { productCallsPerRun: 2 } }); return ok.s === 200 && bad.s === 400; });
  await check("협력사 추가·중복 건너뜀·삭제", async () => {
    const a = await api("/api/sensing/terms", { kind: "partner", names: ["(주)시험업체", "시험제조", "A"] }), b = await api("/api/sensing/terms", { kind: "partner", names: ["(주)시험업체"] });
    const d = await api("/api/sensing/terms/remove", { kind: "partner", name: "시험제조" }); const c2 = await api("/api/sensing/config");
    return a.added === 2 && b.added === 0 && d.removed === 1 && c2.partners.length === 1;
  });
  await check("CSV 업로드 미리보기: 열 추측(협력사·품목·채널)", async () => {
    const csv = Buffer.from("번호,협력사명,주요 취급상품,판매채널\n1,가나식품,삼각김밥,편의점\n2,다라푸드,두부,슈퍼\n", "utf8");
    const x = await fetch(B + "/api/sensing/terms/preview?name=a.csv", { method: "POST", headers: { cookie: ck, "content-type": "application/octet-stream" }, body: csv }); const j = await x.json();
    return x.status === 200 && j.sheets[0].guess.partner === 1 && j.sheets[0].guess.product === 2 && j.sheets[0].guess.channel === 3 && j.sheets[0].totalRows === 2;
  });
  await check(".xls 는 거부(400)", async () => (await fetch(B + "/api/sensing/terms/preview?name=a.xls", { method: "POST", headers: { cookie: ck }, body: "x" })).status === 400);
  await check("내부 신호 등록 → 센싱 목록에 나타남(인지 경로 저장)", async () => {
    const r = await api("/api/sensing/internal", { title: "스모크 내부 신호", summary: "시험", signal: "점주", level: "높음" }); const none = await api("/api/sensing/internal", { summary: "x" });
    const l = await api("/api/issues"); const mine = (l.issues || []).find((i) => i.origin === "internal");
    return r.s === 200 && none.s === 400 && mine && mine.signal === "점주" && mine.state === "센싱됨";
  });
  await check("센싱된 이슈가 목록에 보이고 '아카이브 대조 전' 표시", async () => { const l = await api("/api/issues"); const it = (l.issues || []).find((i) => i.origin !== "internal"); return it && it.archiveOk === false; });

  await check("추적관찰: 표시→목록 유지·메모, 해제→분류 대기, 대시보드 집계", async () => {
    const l = await api("/api/issues"); const id = (l.issues || []).find((i) => i.origin === "internal").id;
    const w = await api(`/api/issues/${id}/watch`, { note: "발표 여부 확인" }); const l2 = await api("/api/issues"); const it = (l2.issues || []).find((i) => i.id === id);
    const dash = await api("/api/dashboard"); const st = await api("/api/stats"); const un = await api(`/api/issues/${id}/unwatch`, {}); const un2 = await api(`/api/issues/${id}/unwatch`, {});
    return w.s === 200 && w.issue.state === "추적관찰" && it && it.state === "추적관찰" && it.watchNote === "발표 여부 확인" && dash.t.includes('"st":"추적관찰"') && st.kpi && st.kpi.watching === 1 && st.funnel && st.funnel.watching === 1 && un.s === 200 && un.issue.state === "센싱됨" && un2.s === 409;
  });
  await check("추적관찰 이슈도 보류 가능·보류 해제, 사건화한 이슈는 추적관찰 거부", async () => {
    const l = await api("/api/issues"); const id = (l.issues || []).find((i) => i.origin === "internal").id;
    await api(`/api/issues/${id}/watch`, {}); const h = await api(`/api/issues/${id}/hold`, { reason: "시험 보류" }); const r = await api(`/api/issues/${id}/restore`, {});
    const p = await api(`/api/issues/${id}/promote`, { typeId: "sys-ops", typeConfirmed: true }); const w2 = await api(`/api/issues/${id}/watch`, {});
    return h.s === 200 && h.issue.state === "보류" && r.issue.state === "센싱됨" && p.s === 200 && w2.s === 409;
  });
  console.log("\n[아카이브]");
  let cid = 0;
  await check("사건 만들기(폴더 업로드 경로, 종결로)", async () => { const r = await api("/api/archive/cases/quick", { title: "스모크 사건", ym: "2026-07", closed: true }); cid = r.case && r.case.id; return r.s === 200 && r.case.status === "종결" && /^2026-07_/.test(r.case.folderName); });
  await check("파일 올리기", async () => { const x = await fetch(B + `/api/archive/cases/${cid}/files?name=t.txt&relPath=t.txt&kind=case-doc`, { method: "POST", headers: { cookie: ck, "content-type": "application/octet-stream" }, body: "시험 파일" }); return x.status === 200; });
  await check("올린 파일은 NEXUS 연결 실패 시에도 PC 에 저장되고 '실패'로 표시", async () => { await sleep(2500); const d = await api(`/api/archive/cases/${cid}`); return d.files.length === 1 && d.files[0].nexusState === "failed"; });
  await check("카드 없이 제목 자동 만들기는 409 안내", async () => (await api(`/api/archive/cases/${cid}/retitle`, {})).s === 409);
  await check("제목 직접 고치기 → 폴더 이름 동기화(날짜_제목)", async () => { const r = await api(`/api/archive/cases/${cid}/title`, { title: "GS25 시험점_직접 제목" }); return r.s === 200 && r.case.folderName === "2026-07_GS25시험점_직접제목" && r.case.titleSource === "manual"; });
  await check("진행/종결 상태 바꾸기", async () => { const a = await api(`/api/archive/cases/${cid}/status`, { status: "진행" }); const b = await api(`/api/archive/cases/${cid}/status`, { status: "종결" }); return a.s === 200 && a.case.status === "진행" && b.case.status === "종결"; });

  console.log("\n[사건 대응·종합 요약]");
  await api(`/api/archive/cases/${cid}/status`, { status: "진행" });
  await check("단계 기록 저장", async () => { const r = await api(`/api/respond/cases/${cid}/steps/intake`, { state: "완료", owner: "시험", date: "2026-07-01", note: "접수 기록" }); return r.s === 200 && r.step.state === "완료"; });
  await check("제안 받기(가짜 AI): 출처 표시 포함", async () => { const r = await api(`/api/respond/cases/${cid}/steps/fact-check/suggest`, {}); return r.s === 200 && r.step.suggestion.items.length === 1 && r.step.suggestion.items[0].trust === "general"; });
  await check("자료 없는 사건의 요약은 거부, 기록이 있으면 생성", async () => {
    const e = await api("/api/archive/cases/quick", { title: "빈 사건", ym: "2026-08" }); const none = await api(`/api/respond/cases/${e.case.id}/summary/generate`, {}); const ok = await api(`/api/respond/cases/${cid}/summary/generate`, {});
    return none.s === 409 && ok.s === 200 && ok.summary.overview.length > 0;
  });
  await check("종합 요약 HTML: 현황 보고서·글머리표·근거 단어 없음", async () => { const x = await fetch(B + `/api/respond/cases/${cid}/report.html`, { headers: { cookie: ck } }); const t = await x.text(); const body = t.replace(/<style>[\s\S]*<\/style>/, ""); return x.status === 200 && t.includes("사건 현황 보고서") && t.includes("<ul>") && !/근거 자료|출처/.test(body); });
  await check("종합 요약 Word: 글머리표(•) 문단", async () => { const x = await fetch(B + `/api/respond/cases/${cid}/report.docx`, { headers: { cookie: ck } }); const doc = zipText(Buffer.from(await x.arrayBuffer()), "word/document.xml"); return x.status === 200 && doc.includes("•") && doc.includes("사건 현황 보고서"); });
  await check("종결 확정: 틀린 비밀번호 거부, 맞으면 종결·모든 단계 완료", async () => {
    const bad = await api(`/api/respond/cases/${cid}/summary/confirm`, { name: "시험자", password: "wrong-pw" }); const ok = await api(`/api/respond/cases/${cid}/summary/confirm`, { name: "시험자", password: pw });
    return bad.s === 403 && ok.s === 200 && ok.case.status === "종결" && ok.steps.every((s) => s.state === "완료");
  });
  await check("종결 확정 후 요약 HTML 은 종결 보고서", async () => (await (await fetch(B + `/api/respond/cases/${cid}/report.html`, { headers: { cookie: ck } })).text()).includes("사건 종결 보고서"));

  console.log("\n[사건 삭제]");
  await check("확인 입력 없이 삭제는 거부(400)", async () => (await api(`/api/archive/cases/${cid}/delete`, {})).s === 400);
  await check("삭제: 백업·휴지통·기록 생성, 사건 조회 404", async () => {
    const d = await api(`/api/archive/cases/${cid}/delete`, { confirm: "삭제" }); const g = await api(`/api/archive/cases/${cid}`);
    const trash = existsSync(join(tmp, "data", ".trash")) && readdirSync(join(tmp, "data", ".trash")).length === 1, bak = readdirSync(join(tmp, "data")).some((f) => f.includes("bak-delete"));
    return d.s === 200 && g.s === 404 && trash && bak;
  });
  await check("과거 이력으로 불러온 사건은 삭제 거부(409, 시드가 있을 때)", async () => { const l = await api("/api/archive/cases?year=2025"); const seed = (l.cases || []).find((c) => c.source === "과거이력"); if (!seed) return true; return (await api(`/api/archive/cases/${seed.id}/delete`, { confirm: "삭제" })).s === 409; });

  console.log("\n[모듈 단위]");
  await check("NEXUS 재시도 분류: 연결 오류만 재시도, NEXUS 거부(500·403)는 제외", async () => { const m = await import(pathToFileURL(join(tmp, "nexussync.mjs")).href); return m.networkErr("fetch failed") && !m.networkErr("NEXUS 500: fetch failed") && m.networkErr("NEXUS 503: x") && !m.networkErr("NEXUS 403: locked"); });
  await check("CSV 파서: 따옴표·쉼표·줄바꿈", async () => { const { parseCsv } = await import(pathToFileURL(join(tmp, "termimport.mjs")).href); const r = parseCsv(Buffer.from('a,"b,c"\n"d\ne",f\n')); return r.length === 2 && r[0][1] === "b,c" && r[1][0] === "d\ne"; });
}

try { await main(); } catch (e) { fail("점검 실행 자체", String(e.stack || e).slice(0, 300)); }
finally {
  try { if (server) server.kill(); } catch { /* 이미 종료 */ }
  try { if (srcServer) srcServer.close(); } catch { /* 이미 종료 */ }
  await sleep(500);
  try { if (tmp) rmSync(tmp, { recursive: true, force: true }); } catch { /* 임시 폴더 정리 실패는 무시 */ }
}
const bad = results.filter((r) => !r[0]).length;
console.log(`\n결과: ${results.length - bad}/${results.length} 통과${bad ? ` — 실패 ${bad}건` : " — 모두 통과"}`);
process.exit(bad ? 1 : 0);
