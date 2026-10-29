// 매일 한 건: 네이버 뉴스에서 사회적으로 이슈가 된 주제를 웹 검색으로 골라 카드(주제 페이지)를 만들고 맥북으로 보낸다.
//   node insights-site/daily.mjs            # 오늘 카드가 없으면 만들고 → 빌드 → 맥북 전송
//   node insights-site/daily.mjs --force    # 오늘 카드가 있어도 다시 만든다
//   node insights-site/daily.mjs --no-deploy
// 사내 프록시 인증서: NODE_EXTRA_CA_CERTS=<pem> (스케줄러 등록 스크립트가 넣어 준다)
// 카드는 이번 주 "Weekly Brief"(맨 위)에 쌓이고 다음 주 월요일부터 "Explore"로 내려간다.
// 만들어진 카드는 status:"draft" + 제목 위 "자동 생성 · 미검토" 표시로 올라간다.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { here, DATA, MODEL, lastJson } from "./lib.mjs";

const force = process.argv.includes("--force"), noDeploy = process.argv.includes("--no-deploy");
const DRAFTS = join(DATA, "drafts"), MEDIA = join(DATA, "media");
mkdirSync(MEDIA, { recursive: true });
const LOG = join(here, "logs", "daily.log");
mkdirSync(join(here, "logs"), { recursive: true });
const log = (...a) => { const s = `[${new Date().toISOString()}] ${a.join(" ")}`; console.log(s); appendFileSync(LOG, s + "\n"); };

const kst = new Date(Date.now() + 9 * 3600e3), ymd = kst.toISOString().slice(0, 10), compact = ymd.replace(/-/g, "");
const extra = process.argv.includes("--extra"); // 같은 날 하나 더(시험용): 시각을 붙여 오늘 카드를 덮어쓰지 않는다
const sfx = extra ? "-" + kst.toISOString().slice(11, 16).replace(":", "") : "";
const slug = `daily-${compact}${sfx}`, file = join(DRAFTS, `topic-${slug}.json`);
if (existsSync(file) && !force) { log(`오늘 카드가 이미 있습니다: ${slug}`); process.exit(0); }

// ── 최근 카드 제목(같은 주제 반복 방지)
const titles = readdirSync(DRAFTS).filter((f) => f.startsWith("topic-")).map((f) => { try { return JSON.parse(readFileSync(join(DRAFTS, f), "utf8")).title; } catch { return null; } }).filter(Boolean);

// ── 모델 호출: 웹 검색·열람만 허용
const SYSTEM = `당신은 GS리테일 지속가능경영부문의 사내 "NEXUS Insight" 사이트에 올릴 이슈 카드를 쓰는 리서처입니다. 한국어로 쓰고, 근거 없는 숫자는 쓰지 않으며, 확인하지 못한 것은 숨기지 않고 적습니다. 최종 응답은 JSON 객체 하나만 출력합니다(설명·코드펜스 없이).`;
const PROMPT = `오늘은 ${ymd} 입니다.

[1단계: 주제 고르기]
웹 검색·열람으로 네이버 뉴스에서 오늘 사회적으로 가장 이슈가 되는 사안을 찾으세요(예: 네이버 뉴스 랭킹 '많이 본 뉴스' news.naver.com/main/ranking/popularDay.naver, '오늘 네이버 뉴스 주요 이슈' 검색). 후보 3~5개를 본 뒤 다음 기준으로 하나를 고릅니다.
- 유통업·소비·물가·고용·규제·기술·사회 변화 등 GS리테일(편의점 GS25, 슈퍼 GS더프레시, 홈쇼핑 GS샵, 파르나스 호텔 등)의 사업·고객·직원·평판과 이어지는 이슈를 우선합니다. 연결이 약하면 간접 영향을 가설로 적습니다.
- 다음은 제외합니다: 선거·정당·정치인 평가, 범죄·사건사고·재난 피해자 개인, 연예인 사생활, 특정 개인 비난, 선정·혐오 소재. 정책·제도·경제·산업 차원의 이슈만 다룹니다.
- 이미 만든 카드와 겹치면 안 됩니다: ${JSON.stringify(titles.slice(-25))}

[2단계: 조사]
고른 이슈를 서로 다른 매체의 기사 최소 3건 이상으로 확인하세요. 기사 본문을 옮기지 말고 사실·수치·일정만 자기 말로 정리합니다. 매체마다 수치가 다르면 그 차이를 적습니다. 직접 열어 보지 못한 출처는 sources 에 넣지 마세요. 사실과 가설(우리의 추정)을 구분해서 쓰세요.

[3단계: 카드 작성 — 기존 카드와 같은 구조 (반드시 지킬 것)]
섹션 4개, 이 순서와 id 를 지킵니다.
1) id "facts" (n "01") — 이슈의 사실: 무슨 일이고 숫자·일정은 무엇인가. stat 1~3개, 필요하면 table(시간순 경과 등) 1개.
2) id "why" (n "02") — 왜 이런 일이 생겼나(원인·배경·쟁점·관점 차이). case 또는 note 2~3개.
3) id "biz" (n "03") — 유통업과 우리 회사(GS리테일)에는 무슨 뜻인가: 업계 영향, GS25·GS더프레시·GS샵 등 당사 사업에 대한 영향 경로, 리스크와 기회. 확인된 사실이 아니라 추정이면 본문에 "가설"이라고 명시합니다. 경쟁사·비교 사례가 있으면 case 로.
4) id "think" (n "04") — 우리가 생각해 볼 것과 HOW: type "question" 항목 3~4개(우리 데이터·현장에서 무엇을 확인해야 하나를 묻는 'Inside' 질문)와 mark:"HOW" 인 question 항목 2~3개(구체적으로 무엇을 해 볼 수 있나 — 데모·점검·실험 수준의 제안).

JSON 스키마(모든 문자열은 평문, HTML 금지):
{
 "cats": ["카테고리 2~4개(예: 경제, 소비, 유통, 규제, 노동, 기술, 사회, GS리테일 중에서)"],
 "tag": "이슈 · 분야",
 "eyebrow": "ISSUE · 주제 짧게",
 "title": "한 줄 제목 (사실이 드러나는 문장, 70자 이내)",
 "summary": "3~4문장 요약: 무슨 일인지, 우리와 무슨 관련인지, 무엇이 확인되지 않았는지",
 "sections": [ {"id":"facts","n":"01","title":"...","lede":"한 줄 설명","items":[ ... ]}, ... ],
 "sources": [ {"id":"D1","title":"기사 제목","publisher":"매체","date":"YYYY-MM-DD","url":"https://..."} ],
 "unverified": ["확인하지 못한 것 3개 이상: 공식 발표 미확인, 수치 불일치, 당사 영향 미검증 등"]
}
items 종류(모든 item 에 고유 id, 사실 근거가 있으면 cites:["D1",...], 없으면 []):
 {"id","type":"stat","big":"1.0","unit":"%","lead":"무엇의 수치인지","text":"설명","cites":[]}
 {"id","type":"note","tag":"짧은 구분","title":"...","body":"...","cites":[]}
 {"id","type":"case","tag":"...","title":"...","body":"...","facts":["핵심 사실 2~4개"],"cites":[]}
 {"id","type":"table","span":2,"title":"...","head":["열1","열2"],"rows":[["..",".."]],"body":"표 아래 설명","cites":[]}
 {"id","type":"question","question":"질문 한 문장","body":"왜 묻는지·어떻게 확인할지","cites":[]}   // HOW 는 같은 형식에 "mark":"HOW" 추가
출처 id 는 D1, D2, ... 입니다. 수치를 쓴 항목에는 반드시 cites 를 답니다.`;

function claudeWeb(prompt, timeoutMs = 25 * 60e3) {
  return new Promise((resolve, reject) => {
    const bin = process.env.CLAUDE_CLI_BIN || "claude";
    const child = spawn(bin, ["-p", "--model", MODEL, "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch",
      "--settings", '{"disableAllHooks":true}', "--output-format", "json", "--system-prompt", SYSTEM],
    { env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
    let out = "", err = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("claude 시간 초과")); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(t); reject(e); });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`claude 종료 ${code}: ${(err || out).slice(0, 300)}`));
      try { const o = JSON.parse(out.trim().split("\n").filter(Boolean).pop()); if (o.is_error) return reject(new Error(String(o.result).slice(0, 300))); resolve(String(o.result || "")); }
      catch { reject(new Error("CLI 응답을 읽지 못함")); }
    });
    child.stdin.write(prompt); child.stdin.end();
  });
}

// ── 검증: 기존 카드와 같은 구조인지
const TYPES = new Set(["stat", "note", "case", "table", "question"]);
function validate(c) {
  const e = [], str = (v) => typeof v === "string" && v.trim().length > 0;
  for (const k of ["tag", "eyebrow", "title", "summary"]) if (!str(c[k])) e.push(`${k} 없음`);
  if (!Array.isArray(c.cats) || !c.cats.length) e.push("cats 없음");
  if (!Array.isArray(c.unverified) || c.unverified.length < 3) e.push("unverified 3개 이상 필요");
  if (!Array.isArray(c.sources) || c.sources.length < 3) e.push("sources 3개 이상 필요");
  const ids = new Set((c.sources || []).map((s) => s.id));
  for (const s of c.sources || []) if (!/^https?:\/\//.test(s.url || "") || !str(s.title) || !str(s.publisher)) e.push(`출처 형식 오류 ${s.id}`);
  const want = ["facts", "why", "biz", "think"];
  const got = (c.sections || []).map((s) => s.id);
  if (want.join() !== got.join()) e.push(`섹션 구성이 ${want.join(",")} 이어야 함(받은 값: ${got.join(",")})`);
  const used = new Set();
  for (const s of c.sections || []) for (const it of s.items || []) {
    if (!TYPES.has(it.type) || !str(it.id)) e.push(`항목 형식 오류 ${it.id}`);
    if (used.has(it.id)) e.push(`항목 id 중복 ${it.id}`); used.add(it.id);
    for (const x of it.cites || []) if (!ids.has(x)) e.push(`없는 출처 인용 ${x}`);
    if (it.type === "stat" && !(it.cites || []).length) e.push(`수치 항목에 cites 없음 ${it.id}`);
  }
  const think = (c.sections || []).find((s) => s.id === "think")?.items || [];
  if (think.filter((i) => i.type === "question" && i.mark !== "HOW").length < 3) e.push("Inside 질문 3개 이상 필요");
  if (think.filter((i) => i.mark === "HOW").length < 2) e.push("HOW 제안 2개 이상 필요");
  if ((c.sections || []).find((s) => s.id === "biz")?.items?.length < 2) e.push("biz 섹션 항목 2개 이상 필요");
  if (/<[a-z][^>]*>/i.test(JSON.stringify(c))) e.push("HTML 태그 포함");
  return e;
}

// ── 출처 URL 확인(없는 주소·다른 도메인으로 튕기는 주소 제거), 대표 이미지(og:image) 찾기
const bare = (h) => h.replace(/^(www|m|n|mobile)\./, "");
async function probe(s) {
  try {
    const r = await fetch(s.url, { headers: { "user-agent": "Mozilla/5.0" }, redirect: "follow", signal: AbortSignal.timeout(25000) });
    const a = bare(new URL(s.url).hostname), b = bare(new URL(r.url).hostname);
    if (!(a.endsWith(b) || b.endsWith(a))) return { alive: false, why: `다른 도메인으로 이동(${b})` };
    if ([404, 410].includes(r.status)) return { alive: false, why: String(r.status) };
    const html = r.ok && /html/.test(r.headers.get("content-type") || "") ? (await r.text()).slice(0, 300000) : "";
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    return { alive: true, img: m ? new URL(m[1].replace(/&amp;/g, "&"), r.url).href : null };
  } catch (e) { return { alive: false, why: e.cause?.code || e.message }; }
}
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

async function main() {
  log(`시작 ${slug} (모델 ${MODEL})`);
  let card, problems = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await claudeWeb(attempt === 1 ? PROMPT : `${PROMPT}\n\n[이전 시도의 문제 — 고쳐서 다시 출력]\n${problems.join("\n")}`);
    try { card = lastJson(raw, (o) => o && Array.isArray(o.sections) && o.title); } catch (e) { problems = [e.message]; log(`시도 ${attempt}: ${e.message}`); continue; }
    problems = validate(card);
    if (!problems.length) break;
    log(`시도 ${attempt}: 검증 실패 → ${problems.join(" / ")}`);
  }
  if (problems.length || !card) throw new Error("검증을 통과하지 못해 오늘 카드는 만들지 않았습니다");

  // 출처 확인
  const allSources = card.sources, probes = await Promise.all(allSources.map(probe));
  const dead = new Set(allSources.filter((_, i) => !probes[i].alive).map((s) => s.id));
  if (dead.size) log(`확인되지 않는 출처 제거: ${allSources.map((s, i) => (dead.has(s.id) ? `${s.id}(${probes[i].why})` : null)).filter(Boolean).join(", ")}`);
  card.sources = card.sources.filter((s) => !dead.has(s.id));
  for (const sec of card.sections) for (const it of sec.items) it.cites = (it.cites || []).filter((x) => !dead.has(x));
  if (card.sources.length < 2) throw new Error("열리는 출처가 2건 미만이라 카드를 만들지 않았습니다");
  if (dead.size) card.unverified.push(`일부 출처 링크(${dead.size}건)가 열리지 않아 뺐습니다.`);

  // 대표 이미지: 출처 기사 중 처음으로 내려받아지는 og:image
  const id = `d-${compact}${sfx}`;
  const mediaList = JSON.parse(readFileSync(join(DATA, "media.json"), "utf8"));
  let got = false;
  for (const [s, p] of allSources.map((s, i) => [s, probes[i]])) {
    if (dead.has(s.id) || !p.img) continue;
    try {
      const r = await fetch(p.img, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) });
      const ext = EXT[(r.headers.get("content-type") || "").split(";")[0]], buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok || !ext || buf.length < 20000) continue;
      writeFileSync(join(MEDIA, `${id}.${ext}`), buf);
      mediaList[id] = { url: p.img, credit: s.publisher }; got = true; break;
    } catch { /* 다음 출처 */ }
  }
  if (got) writeFileSync(join(DATA, "media.json"), JSON.stringify(mediaList, null, 2) + "\n");
  else { log("대표 이미지를 찾지 못했습니다(이미지 없는 카드로 올립니다)"); card.unverified.push("대표 이미지를 자동으로 찾지 못했습니다."); }

  const out = {
    order: Number((0.5 - (Number(compact) - 20260000) / 1e6 - Number(sfx.slice(1) || 0) / 1e10).toFixed(10)), // 최근일수록 앞
    section: "new",
    cats: [...new Set([...card.cats, "Weekly Brief"])],
    tag: `Weekly Brief · ${String(card.tag).replace(/^이슈\s*·\s*/, "")} · 자동 생성`,
    eyebrow: card.eyebrow, title: card.title, summary: card.summary,
    heroMedia: got ? id : undefined, cardMedia: got ? id : undefined,
    sections: card.sections, sources: card.sources,
    unverified: ["이 카드는 AI가 네이버 뉴스 이슈를 웹 검색으로 모아 자동으로 만들었고, 사람의 검토를 거치지 않았습니다.", ...card.unverified],
    slug, kind: "topic", status: "draft", generatedAt: new Date().toISOString(), videos: {},
  };
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  log(`카드 저장: ${out.title}`);

  // 이번 주/지난 주 구역은 빌드(build.mjs)가 카드 날짜로 정한다 — 여기서 파일을 옮기지 않는다

  if (noDeploy) return log("--no-deploy: 전송 생략");
  const r = spawnSync("node", [join(here, "deploy.mjs")], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("빌드·전송 실패(위 출력 확인)");
  log("전송 완료");
}
main().catch((e) => { log("실패:", e.message); process.exit(1); });
