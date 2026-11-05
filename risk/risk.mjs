// 리스크 모니터: 판매 상품·가맹·유통 관련 이슈를 하루 두 번(08:00·14:00) 모아 사태·당사와의 관계·관계부처 대응으로 정리한다.
//   node risk.mjs                 # 시각에 맞는 회차(08:00/14:00)로 수집 → 분석 → 저장 → 페이지 생성 → 게시
//   node risk.mjs --slot pm       # 회차 지정(am=08:00, pm=14:00)
//   node risk.mjs --build-only    # 수집 없이 저장된 이슈로 페이지만 다시 만든다
//   node risk.mjs --no-publish    # 게시(복사) 생략
// 환경: ARCHIVE_ROOT(NEXUS 앱 경로, 당사 관련 근거를 아카이브에서 찾는다), RISK_PUBLISH_DIR(게시 폴더), CLAUDE_CLI_BIN, NODE_EXTRA_CA_CERTS
// 이 페이지는 리스크 담당자용 별도 페이지다. 제외 기준 없이 전부 싣는다(당사가 직접 당사자인 이슈 포함).
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MODEL, claude, lastJson, usage, noteUsage } from "./lib.mjs";
import * as SCOPE from "./sensing-scope.mjs";
import { searchAny, remote, lastSearch, unknownNumbers, cleanRefs } from "./archive.mjs";
import { typeGuide, SCHEMA_FRAGMENT, normalizeAi } from "./classify.mjs";

const here = join(fileURLToPath(import.meta.url), "..");
const MACCFG = join(here, "deploy", "mac.config.json"); // PC 에서 돌릴 때 맥북 접속 정보(없으면 게시 생략)
const DATA = join(here, "data"), STORE = join(DATA, "issues.json"), SITE = join(here, "site");
mkdirSync(DATA, { recursive: true }); mkdirSync(join(here, "logs"), { recursive: true }); mkdirSync(SITE, { recursive: true });
const arg = (k) => process.argv.includes(k), argVal = (k) => (arg(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const log = (...a) => { const s = `[${new Date().toISOString()}] ${a.join(" ")}`; console.log(s); appendFileSync(join(here, "logs", "risk.log"), s + "\n"); };

const kst = new Date(Date.now() + 9 * 3600e3), today = kst.toISOString().slice(0, 10);
const slot = argVal("--slot") || (kst.getUTCHours() < 12 ? "am" : "pm"), slotLabel = slot === "am" ? "08:00" : "14:00";
const runAt = `${today} ${slotLabel}`;
const LV = { 높음: 0, 중간: 1, 낮음: 2 };
const AREAS = SCOPE.areaNames();   // config/sensing.json 의 분야(켜진 것)

const load = () => (existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : { issues: {}, runs: [] });
const save = (s) => writeFileSync(STORE, JSON.stringify(s, null, 2) + "\n");
const grams = (s) => { const t = String(s).replace(/[^\p{L}\p{N}]/gu, ""), g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
const jac = (a, b) => { const A = grams(a), B = grams(b); let n = 0; for (const x of A) if (B.has(x)) n++; return n / (A.size + B.size - n || 1); };
const idOf = (title) => createHash("sha1").update(title.replace(/\s+/g, "")).digest("hex").slice(0, 10);

// 웹 수집 단계 모델: 환경변수 INSIGHTS_WEB_MODEL (기본 claude-haiku-5-5). 이슈 분석 단계는 INSIGHTS_MODEL (기본 claude-sonnet-5-5).
const WEB_MODEL = process.env.INSIGHTS_WEB_MODEL || "claude-haiku-5-5";
// ── 웹 검색 호출(검색·열람만 허용)
const SYS_WEB = "당신은 GS리테일(편의점 GS25, 슈퍼 GS더프레시, 홈쇼핑 GS SHOP 등 운영)의 리스크 관리 담당 리서처입니다. 한국어로 쓰고, 열어본 자료에 있는 사실만 쓰며 확인 못 한 것은 쓰지 않습니다. 공식 출처(정부 부처·지자체·기관 보도자료)를 우선합니다. 최종 응답은 JSON 객체 하나만 출력합니다(설명·코드펜스 없이).";
function claudeWeb(prompt, timeoutMs = 25 * 60e3) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_CLI_BIN || "claude", ["-p", "--model", WEB_MODEL, "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch", "--settings", '{"disableAllHooks":true}', "--output-format", "json", "--system-prompt", SYS_WEB], { env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
    let out = "", err = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("claude 시간 초과")); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(t); reject(e); });
    child.on("close", (code) => { clearTimeout(t); if (code !== 0) return reject(new Error(`claude 종료 ${code}: ${(err || out).slice(0, 300)}`)); try { const o = JSON.parse(out.trim().split("\n").filter(Boolean).pop()); if (o.is_error) return reject(new Error(String(o.result).slice(0, 300))); noteUsage("수집", o, WEB_MODEL); resolve(String(o.result || "")); } catch { reject(new Error("CLI 응답을 읽지 못함")); } });
    child.stdin.write(prompt); child.stdin.end();
  });
}
// 출처 링크가 실제로 있는 주소인지 확인한다. 404·410·없는 도메인이면 버리고, 서버가 확인 요청 자체를 거부·지연하는 경우(큰 헤더·시간 초과·5xx·429)는 확인 불가로 보고 살린다.
async function alive(url) {
  try { const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, redirect: "follow", signal: AbortSignal.timeout(20000) }); return !(r.status === 404 || r.status === 410); }
  catch (e) { const c = e.cause?.code || e.code || ""; return !/ENOTFOUND|ECONNREFUSED|CERT|ERR_TLS/.test(c); }
}

// ── 1단계: 이슈 수집
async function collectBy(store, label, focusText, tag) {
  const recent = Object.values(store.issues).filter((i) => i.status !== "종결" || (Date.now() - Date.parse(i.lastUpdated)) < 5 * 864e5).sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated)).slice(0, 40);
  const prompt = `지금은 ${runAt} (KST) 입니다. 웹 검색·열람으로 최근 24시간(없으면 48시간) 안에 보도·발표된 리스크 이슈를 찾으세요.
${SCOPE.promptText()}
${focusText} 같은 사건의 기사는 하나로 묶습니다. 이미 아래 목록에 있는 이슈의 새 전개(새 조치·새 피해·후속 발표)가 있으면 updateOf 에 그 id 를 적고, 새 내용만 summary 에 씁니다. 목록과 같은 내용이고 새 소식이 없으면 넣지 마세요.
[이미 다룬 이슈]
${recent.map((i) => `- ${i.id} | ${i.title} | ${i.status}`).join("\n") || "(없음)"}
JSON: {"issues":[{"updateOf":null,"keyword":"키워드 검색일 때만: 이 이슈를 찾은 키워드(아니면 빈 문자열)","area":"${[...AREAS, "기타"].join("|")}","title":"사실이 드러나는 한 줄 제목(60자 이내)","status":"발생|진행 중|종결","occurredAt":"YYYY-MM-DD","summary":"사태와 상황: 무슨 일이 언제 어떻게, 규모·피해·원인(확인된 것만) 3~5문장","agencies":[{"name":"관계부처·기관 이름","action":"그 기관이 한 대응·조치·예정","date":"YYYY-MM-DD 또는 빈 문자열"}],"products":["관련 상품·업태 이름"],"keywords":["사내 문서 검색용 용어 8~12개(법률명·제도명·상품군·사업부문 등)"],"sources":[{"title":"기사·공고 제목","publisher":"매체·기관","date":"YYYY-MM-DD","url":"https://..."}]}]}
sources 는 이슈마다 2건 이상(가능하면 공식 자료 1건 포함)이고 열어본 URL 만 씁니다.`;
  let items = [];
  for (let k = 1; k <= 2 && items.length < 2; k++) { try { items = lastJson(await claudeWeb(prompt), (o) => Array.isArray(o?.issues)).issues; } catch (e) { log(`수집 시도 ${k}: ${e.message}`); } }
  const ok = await Promise.all(items.map(async (it) => { const s = []; for (const x of it.sources || []) if (/^https?:\/\//.test(x.url || "") && (await alive(x.url))) s.push(x); const n0 = (it.sources || []).length; it.sources = s; const good = s.length >= 1 && it.title && it.summary && [...AREAS, "기타"].includes(it.area); if (!good) log(`    제외: ${String(it.title).slice(0, 40)} | 분야=${it.area} | 출처 ${s.length}/${n0}건 확인`); return good; }));
  const kept = items.filter((_, i) => ok[i]);
  kept.forEach((it) => { if (tag) it.origin = tag; });
  log(`  [${label}] 수집 ${items.length}건 → 출처 확인된 ${kept.length}건`);
  return kept;
}
const collectArea = (store, a) => collectBy(store, a, `이번 호출에서는 "${a}" 분야에 집중해 검색어를 바꿔 가며 여러 번 찾고, 3~7개를 담습니다(그 분야 이슈가 더 없으면 적게).`, null);
// 키워드는 3개씩 묶어 한 번에 검색한다(키워드가 많아져도 시간이 크게 늘지 않게). 이슈마다 어느 키워드로 찾았는지 keyword 에 적게 한다.
const collectKeywords = async (store, kws, type) => {
  const out = await collectBy(store, kws.join(", "), `이번 호출에서는 사용자가 지정한 키워드 ${kws.map((k) => `"${k}"`).join(", ")} 각각과 관련된 이슈를 찾습니다(키워드마다 따로 검색). 최근 24~48시간 보도가 없으면 최근 1~2주 안의 관련 보도까지 넓히고, 키워드와 직접 관련된 이슈만 키워드당 1~5개 담으며, 각 이슈의 keyword 에 해당 키워드를 그대로 적습니다. 분야는 가장 가까운 것으로 고르고 해당 없으면 "기타"로 합니다.`, null);
  out.forEach((it) => { it.origin = { type, keyword: kws.includes(it.keyword) ? it.keyword : kws.find((k) => String(it.keyword || "").includes(k)) || kws[0] }; });
  return out;
};
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const WATCH = join(DATA, "watch.json");
const readWatch = () => { try { return JSON.parse(readFileSync(WATCH, "utf8")).keywords || []; } catch { return []; } };
// 협력사·취급 품목 목록 검색: 이름 여러 개를 한 번에 묶어 검색한다. 이슈마다 어느 이름으로 찾았는지 keyword 에 적게 한다.
const collectList = async (store, names, kind) => {
  const q = names.map((k) => `"${k}"`).join(", ");
  const focus = kind === "partner"
    ? `이번 호출에서는 우리와 거래하는 협력사·제조사 ${q} 각각의 최근 이슈(위생·품질 사고, 회수·행정처분, 공정위 신고·갑질 분쟁, 산재·사망사고, 노조 단체행동, 불법 고용, 소송·계약 분쟁)를 찾습니다(업체마다 따로 검색).`
    : `이번 호출에서는 우리가 홈쇼핑·편의점·슈퍼에서 파는 품목 ${q} 각각의 최근 안전·표시 문제(식약처 회수·판매중단·부적합·행정처분, 소비자원 위해정보, 이물·세균·곰팡이·유통기한·원산지·원재료 표시 오류)를 국내 유통 기준으로 찾습니다(품목마다 따로 검색).`;
  const out = await collectBy(store, names.join(", "), `${focus} 최근 24~48시간 보도가 없으면 최근 1주 안으로 넓히고, 해당 이름과 직접 관련된 이슈만 담으며, 각 이슈의 keyword 에 해당 이름을 적습니다.`, null);
  out.forEach((it) => { it.origin = { type: kind, keyword: names.includes(it.keyword) ? it.keyword : names.find((n) => String(it.keyword || "").includes(n)) || names[0] }; });
  return out;
};
// 이번 회차에 어떤 호출을 하는지 미리 보기(AI 호출 없음): node risk.mjs --plan
function printPlan() {
  const lim = SCOPE.limits(), kw = chunk(readWatch(), 3), pb = SCOPE.nextBatches("partner"), prb = SCOPE.nextBatches("product");
  log(`[계획] 분야 ${AREAS.length}개 호출: ${AREAS.join(" / ")}`);
  log(`[계획] 관심 키워드 ${readWatch().length}개 → ${kw.length}회 호출`);
  log(`[계획] 협력사 목록 ${SCOPE.allTerms("partner").length}개 중 이번에 ${pb.flat().length}개 → ${pb.length}회 호출 (한 바퀴 약 ${SCOPE.cycleRuns("partner")}회차)${pb.length ? ": " + pb.flat().join(", ") : ""}`);
  log(`[계획] 품목 목록 ${SCOPE.allTerms("product").length}개 중 이번에 ${prb.flat().length}개 → ${prb.length}회 호출 (한 바퀴 약 ${SCOPE.cycleRuns("product")}회차): ${prb.flat().join(", ")}`);
  log(`[계획] 웹 수집 호출 합계 ${AREAS.length + kw.length + pb.length + prb.length}회 (모델 ${WEB_MODEL}), 한도: 협력사 ${lim.partnerCallsPerRun}회·품목 ${lim.productCallsPerRun}회`);
}
// 분야마다 따로 검색해(2개씩 병렬) 빠지는 분야가 없게 한다. 같은 사건은 제목이 비슷하면 하나로 합친다.
async function collect(store, manualKw) {
  const lists = [], fail = (a) => (e) => (log(`  [${a}] 수집 실패: ${e.message}`), []);
  if (manualKw && manualKw.length) { // 사용자가 직접 입력한 키워드만 검색한다
    lists.push(...(await collectKeywords(store, manualKw.slice(0, 3), "manual").catch(fail(manualKw.join(", ")))));
  } else {
    for (let i = 0; i < AREAS.length; i += 2) lists.push(...(await Promise.all(AREAS.slice(i, i + 2).map((a) => collectArea(store, a).catch(fail(a))))));
    const groups = chunk(readWatch(), 3); // 관심 키워드: 등록한 전부를 매 회차에 같이 검색(3개씩 묶어 2묶음 병렬)
    for (let i = 0; i < groups.length; i += 2) lists.push(...(await Promise.all(groups.slice(i, i + 2).map((g) => collectKeywords(store, g, "watch").catch(fail(g.join(", ")))))).flat());
    for (const kind of ["partner", "product"]) {   // 협력사·취급 품목 목록: 오래 검색하지 않은 순으로 한도만큼 돌려 가며 검색
      const batches = SCOPE.nextBatches(kind);
      for (let i = 0; i < batches.length; i += 2) lists.push(...(await Promise.all(batches.slice(i, i + 2).map((b) => collectList(store, b, kind).then((r) => (SCOPE.markChecked(kind, b), r)).catch(fail(kind + ": " + b.slice(0, 2).join(", ")))))));
    }
  }
  const out = [];
  for (const it of lists.flat()) { const dup = out.find((o) => jac(o.title, it.title) >= 0.5 || o.sources.some((x) => it.sources.some((y) => y.url === x.url))); if (!dup) out.push(it); else if (it.origin && !dup.origin) dup.origin = it.origin; }
  log(`수집 합계 ${out.length}건`);
  return out;
}

// ── 2단계: 당사와의 관계·위험도·대응(사내 아카이브 발췌만 근거)
const SYS_REL = "당신은 GS리테일 리스크 관리 담당입니다. 이슈 사실과 [사내 아카이브 발췌]만 근거로 한국어로 쓰고, 발췌에 없는 당사 사실·숫자는 만들지 않습니다. 추정은 '가설'이라고 표시합니다. 결과는 JSON 객체 하나만 출력합니다(설명·코드펜스 없이).";
// 유형 안내(9개 유형 + 과거 사례 예시)는 한 번만 만들어 모든 이슈 분석 프롬프트에 붙인다 — 별도 LLM 호출 없이 기존 분석 호출에 '유형·사업부문 제안' 필드만 추가한다.
const TYPE_GUIDE = typeGuide();
async function analyze(it, passages) {
  const prompt = `[이슈] (${it.area}) ${it.title}\n상태: ${it.status}\n사태: ${it.summary}\n관계부처 대응: ${(it.agencies || []).map((a) => `${a.name}: ${a.action}`).join(" / ") || "(확인된 대응 없음)"}\n관련 상품·업태: ${(it.products || []).join(", ")}\n\n[사내 아카이브 발췌]\n${passages.map((p) => `${p.id} | ${p.title}\n${p.text}`).join("\n\n") || "(관련 발췌를 찾지 못함)"}\n
${TYPE_GUIDE}\n
JSON: {"relation":"당사와의 관계: 이 이슈가 우리 사업·취급 상품·가맹·협력사 거래와 어떻게 닿는지 3~5문장. 당사 사실은 발췌에서만, 근거가 약하면 '가설'로","exposure":["우리 쪽 노출 지점 2~4개(상품군·업태·거래·규정 이름 등)"],"level":"높음|중간|낮음","levelWhy":"위험도 근거 1~2문장(높음=당사 취급 상품·거래에 직접 영향이거나 당사가 거론됨/제재 가능성 큼, 중간=업계 전반·간접 영향, 낮음=참고)","responses":["확인할 점·대응 제안 3~5개: 무엇을 누가(담당 부서 예시) 언제까지 확인할지"],"cites":["근거로 쓴 발췌 번호(A1 등), 없으면 빈 배열"],${SCHEMA_FRAGMENT}}
본문에는 A1 같은 번호를 쓰지 말고 문서 이름으로 부르세요(번호는 cites 에만).`;
  let out, problems = [];
  for (let k = 1; k <= 3; k++) {
    try { out = lastJson(await claude(SYS_REL, k === 1 ? prompt : `${prompt}\n\n[이전 시도의 문제 — 고쳐서 다시 출력]\n${problems.join(" / ")}`, 10 * 60e3), (o) => o && o.relation && Array.isArray(o.responses)); } catch (e) { problems = [e.message]; continue; }
    problems = [];
    const ids = new Set(passages.map((p) => p.id));
    if (!["높음", "중간", "낮음"].includes(out.level)) problems.push("level 은 높음|중간|낮음");
    for (const c of out.cites || []) if (!ids.has(c)) problems.push(`없는 발췌 번호 ${c}`);
    const u = unknownNumbers([out.relation, ...(out.exposure || [])].join(" "), remote() ? passages.map((p) => p.text).join(" ") + " " + [it.title, it.summary].join(" ") : undefined); if (u.length) problems.push(`아카이브·이슈에 없는 숫자: ${u.join(", ")}`);
    if (!problems.length) break;
  }
  if (!out) throw new Error("관계 분석 실패");
  for (const k of ["relation", "levelWhy"]) out[k] = cleanRefs(out[k] || "");
  out.exposure = (out.exposure || []).map(cleanRefs); out.responses = (out.responses || []).map(cleanRefs);
  out.ai = normalizeAi(out); // 유형·사업부문 제안(잘못된 값이면 제안 없음으로 처리 — 분석 자체는 실패시키지 않음)
  out.cites = (out.cites || []).filter((c) => passages.some((p) => p.id === c));
  const seen = new Set(); out.archive = out.cites.map((c) => passages.find((p) => p.id === c)).filter((p) => p && !seen.has(p.title) && seen.add(p.title)).map((p) => ({ title: p.title, date: p.date || "" }));
  return out;
}

async function pool(list, n, fn) { const res = []; let i = 0; await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; res[k] = await fn(list[k], k).catch((e) => (log(`  분석 실패: ${list[k].title}: ${e.message}`), null)); } })); return res; }

// 동시에 두 수집(예약 실행·직접 검색)이 저장소를 건드리지 않게 한다
const LOCK = join(DATA, ".lock");
async function lock() { for (let i = 0; i < 270; i++) { try { writeFileSync(LOCK, process.pid + " " + Date.now(), { flag: "wx" }); return; } catch { try { if (Date.now() - Number(readFileSync(LOCK, "utf8").split(" ")[1]) > 45 * 60e3) rmSync(LOCK, { force: true }); } catch {} await new Promise((r) => setTimeout(r, 10000)); } } throw new Error("앞선 수집이 끝나지 않아 대기 시간을 넘겼습니다"); }
function logUsage() {
  const by = {}; for (const u of usage) { const b = (by[u.kind] ||= { calls: 0, usd: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sec: 0 }); b.calls++; for (const k of ["usd", "turns", "input", "output", "cacheRead", "cacheWrite", "sec"]) b[k] += u[k] || 0; }
  for (const [k, b] of Object.entries(by)) log(`[사용량] ${k}: 호출 ${b.calls}회 · 비용 US$${b.usd.toFixed(2)} · 대화턴 ${b.turns} · 입력 ${b.input} · 출력 ${b.output} · 캐시읽기 ${b.cacheRead} · 캐시쓰기 ${b.cacheWrite} · ${b.sec}초`);
  log(`[사용량] 합계 US$${usage.reduce((a, u) => a + u.usd, 0).toFixed(2)}`);
  try { appendFileSync(join(here, "logs", "sensing-cost.jsonl"), JSON.stringify({ at: runAt, calls: usage }) + "\n"); } catch {}
}
async function main() {
  const locked = !arg("--build-only") && !arg("--plan"); if (locked) await lock();
  try { await run(); } finally { if (locked) rmSync(LOCK, { force: true }); }
}
async function run() {
  if (arg("--plan")) { printPlan(); return; }
  const store = load(); let added = 0, updated = 0;
  const manualKw = (argVal("--keywords") || "").split(";").map((x) => x.trim()).filter(Boolean);
  if (!arg("--build-only")) {
    log(`시작 ${runAt} (수집 모델 ${WEB_MODEL} · 분석 모델 ${MODEL}) · 누적 이슈 ${Object.keys(store.issues).length}건`);
    const found = await collect(store, manualKw);
    const analyzed = await pool(found, 3, async (it) => {
      const { passages } = await searchAny(it.keywords || []); if (remote()) log(`  [NEXUS 검색] ${it.title.slice(0, 30)} → 가져옴 ${lastSearch.fetched} · 사용 ${lastSearch.allowed} · 허용 목록 밖 제외 ${lastSearch.dropped}`);
      const a = await analyze(it, passages); log(`  ✓ [${a.level}] ${it.title}`); return { it, a };
    });
    for (const r of analyzed) {
      if (!r) continue; const { it, a } = r;
      let id = it.updateOf && store.issues[it.updateOf] ? it.updateOf : Object.values(store.issues).find((x) => jac(x.title, it.title) >= 0.55)?.id;
      const note = { at: runAt, slot: slotLabel, text: it.summary };
      if (id) { // 기존 이슈의 새 전개
        const x = store.issues[id];
        x.status = it.status || x.status; x.lastUpdated = new Date().toISOString(); if ((LV[a.level] ?? 3) <= (LV[x.level] ?? 3)) { x.level = a.level; x.levelWhy = a.levelWhy; } // 새 전개가 약해도 위험도를 낮추지 않는다(올라갈 때만 갱신)
        x.relation = x.relation + " [" + runAt + " 업데이트] " + a.relation; x.exposure = a.exposure; x.responses = a.responses; x.archive = a.archive;
        if (a.ai?.type) x.aiType = { ...a.ai.type, at: runAt }; if (a.ai?.bu) x.aiBu = { ...a.ai.bu, at: runAt }; // 제안만 갱신 — 담당자가 확정한 값은 store.mjs 가 보호한다
        x.agencies = [...(x.agencies || []), ...(it.agencies || []).filter((n) => !(x.agencies || []).some((o) => o.name === n.name && o.action === n.action))];
        x.sources = [...x.sources, ...it.sources.filter((n) => !x.sources.some((o) => o.url === n.url))]; x.timeline.push(note); if (it.origin) x.origin = [...(x.origin || []), { ...it.origin, at: runAt }]; updated++;
      } else {
        id = idOf(it.title);
        store.issues[id] = { id, area: it.area, title: it.title, status: it.status, occurredAt: it.occurredAt || today, firstSeen: new Date().toISOString(), lastUpdated: new Date().toISOString(), summary: it.summary, agencies: it.agencies || [], products: it.products || [], sources: it.sources, level: a.level, levelWhy: a.levelWhy, relation: a.relation, exposure: a.exposure, responses: a.responses, archive: a.archive, timeline: [note], origin: it.origin ? [{ ...it.origin, at: runAt }] : [],
          aiType: a.ai?.type ? { ...a.ai.type, at: runAt } : undefined, aiBu: a.ai?.bu ? { ...a.ai.bu, at: runAt } : undefined }; added++;
      }
    }
    store.runs.push({ at: runAt, slot: manualKw.length ? "수동" : slotLabel, keywords: manualKw, found: found.length, added, updated, finishedAt: new Date().toISOString() }); store.runs = store.runs.slice(-200);
    logUsage();
    save(store); log(`저장: 신규 ${added} · 업데이트 ${updated} · 누적 ${Object.keys(store.issues).length}`);
  }
  build(store);
}

// ── 페이지 생성(템플릿에 데이터·글꼴을 내장한 파일 하나) + 게시
function build(store) {
  const font = (f) => { const p = join(here, "assets", "fonts", f); return existsSync(p) ? "data:font/woff2;base64," + readFileSync(p).toString("base64") : ""; };
  const issues = Object.values(store.issues).sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
  const data = { builtAt: new Date().toISOString(), runs: store.runs.slice(-12), issues };
  let h = readFileSync(join(here, "template.html"), "utf8");
  h = h.split("@@FP@@").join(font("PretendardVariable.woff2")).split("@@FO@@").join(font("Outfit-latin-wght.woff2")).replace("@@DATA@@", () => JSON.stringify(data).replace(/</g, "\\u003c"));
  writeFileSync(join(SITE, "index.html"), h);
  log(`페이지 생성: 이슈 ${issues.length}건 (${(h.length / 1048576).toFixed(1)}MB)`);
  const pub = process.env.RISK_PUBLISH_DIR;
  if (pub && !arg("--no-publish")) { mkdirSync(pub, { recursive: true }); copyFileSync(join(SITE, "index.html"), join(pub, "index.html.tmp")); renameTmp(join(pub, "index.html.tmp"), join(pub, "index.html")); log(`게시: ${join(pub, "index.html")}`); }
  else if (arg("--publish-mac") && existsSync(MACCFG)) { // PC: 맥북(8081 서비스 폴더 ~/risk-monitor)으로 전송 — SSH 키 로그인
    const { host, user } = JSON.parse(readFileSync(MACCFG, "utf8")), t = `${user}@${host}`, o = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
    const ok = spawnSync("ssh", [...o, t, "mkdir -p ~/risk-monitor"]).status === 0 && spawnSync("scp", [...o, join(SITE, "index.html"), `${t}:risk-monitor/index.html.tmp`]).status === 0 && spawnSync("ssh", [...o, t, "mv ~/risk-monitor/index.html.tmp ~/risk-monitor/index.html"]).status === 0;
    log(ok ? `게시: http://${host}:8081/` : "게시(맥북 전송) 실패 — 페이지는 site/index.html 에 만들어졌습니다");
  }
}
import { renameSync } from "node:fs";
const renameTmp = (a, b) => renameSync(a, b);
main().catch((e) => { log("실패:", e.message); process.exit(1); });
