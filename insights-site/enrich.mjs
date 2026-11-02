// 이미 만든 카드에 NEXUS 아카이브(general 등급) 근거를 보강한다. 원본은 건드리지 않고 data/enriched/ 에 따로 만든다.
//   node insights-site/enrich.mjs                 # 모든 주제 카드 보강본 + data/enriched/REPORT.md
//   node insights-site/enrich.mjs coupang-ftc     # 일부만(slug)
//   node insights-site/enrich.mjs --adopt coupang-ftc [slug…|all]   # 보강본을 drafts 에 반영(원본은 data/enriched/_orig/ 에 보관)
// 보강 내용: ① 당사 관련 섹션 맨 앞에 "아카이브 근거" 항목 2~4개 ② 생각해 볼 것에 질문 1~2개 ③ 출처에 아카이브 문서(NX#) 추가.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, claude, lastJson } from "./lib.mjs";
import { search, catalog, cleanRefs, unknownNumbers } from "./archive.mjs";

const DRAFTS = join(DATA, "drafts"), OUT = join(DATA, "enriched"), ORIG = join(OUT, "_orig");
mkdirSync(ORIG, { recursive: true });
const args = process.argv.slice(2);

// ── 반영(adopt)
if (args[0] === "--adopt") {
  const want = args.slice(1), all = want.includes("all");
  for (const f of readdirSync(OUT).filter((x) => /^topic-.*\.json$/.test(x))) {
    const slug = f.replace(/^topic-|\.json$/g, "");
    if (!all && !want.includes(slug)) continue;
    copyFileSync(join(DRAFTS, f), join(ORIG, f)); copyFileSync(join(OUT, f), join(DRAFTS, f));
    console.log(`반영: ${slug} (원본 → data/enriched/_orig/${f})`);
  }
  process.exit(0);
}

const SYSTEM = `당신은 GS리테일 지속가능경영부문의 사내 "NEXUS Insight" 카드를 보강하는 리서처입니다. 한국어로 쓰고, 주어진 사내 아카이브 발췌에 실제로 있는 내용만 근거로 삼습니다. 최종 응답은 JSON 객체 하나만 출력합니다(설명·코드펜스 없이).`;
const ask = (p) => claude(SYSTEM, p, 15 * 60e3);
const FORBID = /(당사|우리 회사|사내|내부|GS리테일)[^."。]{0,30}(데이터|자료|실적|판매|매출)[^."。]{0,30}(확인|검증)(하지|되지|\s*못|\s*전|하기 전)/;
const UNFAV = /(시정명령|제재|과징금|과태료|벌금)[^.。]{0,14}(받았|받은|받아|부과받|납부|선고|확정|이력)|이력이 있|행정소송|고발|형사|검찰/;
const TYPES = new Set(["stat", "note", "case", "question"]);

const cards = readdirSync(DRAFTS).filter((f) => /^topic-.*\.json$/.test(f)).map((f) => ({ f, slug: f.replace(/^topic-|\.json$/g, "") }))
  .filter((c) => !args.length || args.includes(c.slug));

// 당사 관련 섹션 찾기: 제목에 회사·유통·GS리테일이 들어간 섹션 중 뒤쪽, 없으면 3번째
const bizIndex = (card) => {
  const find = (re) => card.sections.findIndex((s, i) => i >= 1 && re.test(s.title));
  const i1 = find(/우리 회사|우리가 영위|GS리테일|당사/), i2 = find(/유통업과|우리/);
  return i1 >= 0 ? i1 : i2 >= 0 ? i2 : Math.min(2, card.sections.length - 1);
};

async function enrich({ f, slug }) {
  const card = JSON.parse(readFileSync(join(DRAFTS, f), "utf8"));
  const bi = bizIndex(card), biz = card.sections[bi], last = card.sections[card.sections.length - 1];
  // 1) 검색어: 이 카드가 우리 회사에 닿는 지점을 사내 문서에서 찾기 위한 용어
  const kw = lastJson(await ask(`아래 카드가 GS리테일에 닿는 지점을 사내 문서(법령·지침·사규·사업보고서·지속가능보고서·동반성장 평가자료)에서 찾으려 합니다. 문서에 실제로 나올 법한 한국어 검색어 12~16개(법률명·제도명·사업부문명·재무/위험 항목 등)를 JSON {"keywords":[...]} 로 주세요.\n제목: ${card.title}\n요약: ${card.summary}\n당사 관련 섹션(${biz.title}): ${biz.items.map((i) => i.title || i.question).join(" / ")}\n사내 자료 종류 참고: ${JSON.stringify(catalog().slice(0, 80))}`), (o) => Array.isArray(o.keywords)).keywords;
  const found = search(kw, { top: 10 });
  const passages = found.passages;
  if (passages.length < 2) return { slug, skipped: `아카이브 대목 ${passages.length}개 — 연결할 근거가 부족해 보강하지 않음`, kw };

  // 2) 보강 항목 작성
  const prompt = `[카드] 제목: ${card.title}\n요약: ${card.summary}\n\n[당사 관련 섹션 "${biz.title}"에 이미 있는 항목]\n${biz.items.map((i) => `- (${i.type}) ${i.title || i.question}: ${(i.body || i.text || "").slice(0, 160)}`).join("\n")}\n\n[사내 아카이브 발췌] 당사 관련 내용의 우선 근거입니다.\n${passages.map((p) => `[${p.id}] ${p.title}${p.date ? " (" + p.date + ")" : ""} — ${p.docType}\n${p.text}`).join("\n\n")}\n\n[할 일]\n위 발췌에 실제로 있는 내용만 근거로, 이 카드의 이슈가 GS리테일(사업·규정·재무·위험)에 어떻게 닿는지 보강하는 항목을 만드세요.\n- items: 2~4개. type 은 note | case | stat. 각 항목은 발췌의 구체 내용(법령 조항·기준, 사규 절차, 사업보고서의 사업부문·매출·위험관리·공시 내용 등)을 자기 말로 요약하고, 그것이 이 이슈에 어떻게 적용되는지 씁니다. 적용·해석은 "가설"이라고 표시합니다. 이미 있는 항목과 겹치지 않게 합니다.\n- think: 1~2개의 question(이 근거를 바탕으로 우리가 확인·점검해 볼 것). 1개는 mark:"HOW"(구체적 제안)로.\n- 모든 항목의 cites 는 위 발췌 id(A#)만 씁니다. 본문·제목에는 A# 같은 번호를 쓰지 말고 문서 이름(예: 사내 자율준수 편람, 사업보고서, 대규모유통업법 과징금 고시)으로 부르세요. 숫자는 발췌에 있는 그대로만 쓰고, 보고서 기준 시점을 본문에 적습니다. 발췌에 없는 당사 내용은 숫자 없이 "가설"로만 씁니다. 발췌 문장을 길게 그대로 옮기지 마세요.\n- 금지(불리한 내용): 당사(GS리테일·GS그룹·임직원)의 법 위반, 시정명령·과징금·과태료·벌금·소송·고발·조사 이력, 사고·유출 이력, 처분 후속 조치 등 당사에 불리한 사실은 쓰지 마세요. 법령·기준·사규가 무엇을 정하는지, 일반적인 위험 요인 설명, 앞으로 점검할 일은 괜찮습니다.
- 금지: "당사 데이터로는 확인하지 않았습니다", "내부 데이터로 검증 전" 같은 내부 데이터 미확인 문구.\n형식(모든 문자열은 평문):\n{"items":[{"id":"ar-1","type":"note","tag":"짧은 구분","title":"...","body":"...","cites":["A1"]},{"id":"ar-2","type":"stat","big":"..","unit":"..","lead":"..","text":"..","cites":["A2"]},{"id":"ar-3","type":"case","tag":"..","title":"..","body":"..","facts":["..",".."],"cites":["A3"]}],"think":[{"id":"ar-q1","type":"question","question":"..","body":"..","cites":["A1"]},{"id":"ar-q2","type":"question","mark":"HOW","question":"..","body":"..","cites":[]}]}`;
  let res, problems = [];
  const archIds = new Set(passages.map((p) => p.id)), flat = passages.map((p) => p.text).join(" ").replace(/[,\s]/g, "");
  for (let attempt = 1; attempt <= 2; attempt++) {
    res = lastJson(await ask(attempt === 1 ? prompt : `${prompt}\n\n[이전 시도의 문제 — 고쳐서 다시 출력]\n${problems.join("\n")}`), (o) => Array.isArray(o.items));
    problems = [];
    const all = [...res.items, ...(res.think || [])];
    if (res.items.length < 2) problems.push("items 2개 이상 필요");
    for (const it of all) {
      if (!TYPES.has(it.type) || !it.id) problems.push(`형식 오류 ${it.id}`);
      for (const x of it.cites || []) if (!archIds.has(x)) problems.push(`발췌에 없는 id ${x}`);
      if (it.type !== "question" && !(it.cites || []).length) problems.push(`근거(cites) 없음 ${it.id}`);
      if (it.type === "stat" && !flat.includes(String(it.big).replace(/[,\s]/g, ""))) problems.push(`수치가 발췌에 없음 ${it.id} (${it.big})`);
      { const u = unknownNumbers([it.body, it.text, it.big, ...(it.facts || [])].join(" ")); if (u.length) problems.push(`발췌에 없는 숫자 ${it.id}: ${u.join(", ")}`); }
      if (UNFAV.test(JSON.stringify(it))) problems.push(`당사에 불리한 이력 서술 금지 ${it.id}`);
      if (FORBID.test(JSON.stringify(it))) problems.push(`내부 데이터 미확인 문구 금지 ${it.id}`);
      if (/<[a-z][^>]*>/i.test(JSON.stringify(it))) problems.push(`HTML 금지 ${it.id}`);
    }
    if (!problems.length) break;
  }
  if (problems.length) return { slug, skipped: `검증 실패: ${problems.join(" / ")}`, kw };

  // 3) 합치기: 아카이브 문서는 하나의 출처로 묶는다(파일 경로 없이 제목·날짜만)
  const firstOf = {}, srcAdd = [], remap = (arr) => [...new Set((arr || []).map((x) => {
    const p = passages.find((q) => q.id === x);
    if (!firstOf[p.title]) { firstOf[p.title] = `NX${Object.keys(firstOf).length + 1}`; srcAdd.push({ id: firstOf[p.title], kind: "archive", title: p.title, publisher: "NEXUS 아카이브", date: p.date || "—", url: null }); }
    return firstOf[p.title];
  }))];
  const used = new Set(card.sections.flatMap((s) => s.items.map((i) => i.id)));
  const mk = (it) => { const o = { ...it, cites: remap(it.cites) }; while (used.has(o.id)) o.id += "x"; used.add(o.id); return o; };
  const clean = (it) => { for (const k of ["title", "body", "text", "lead", "question", "tag"]) if (typeof it[k] === "string") it[k] = cleanRefs(it[k]); if (it.facts) it.facts = it.facts.map(cleanRefs); return it; };
  const items = res.items.map(mk).map(clean), think = (res.think || []).map(mk).map(clean);
  const out = JSON.parse(JSON.stringify(card));
  out.sections[bi].items = [...items, ...out.sections[bi].items];
  out.sections[out.sections.length - 1].items.push(...think);
  const existing = new Set(out.sources.map((s) => s.id)); // 기존 출처 id 와 충돌하지 않게 A# 만 추가
  out.sources = [...out.sources, ...srcAdd.filter((s) => !existing.has(s.id))];
  out.unverified = [...(out.unverified || []), "당사 관련 근거는 NEXUS 아카이브(일반 등급 문서)의 발췌에서 가져왔으며, 보고서·법령은 문서에 적힌 기준 시점의 내용입니다."];
  writeFileSync(join(OUT, f), JSON.stringify(out, null, 2) + "\n");
  return { slug, section: biz.title, items, think, docs: srcAdd.map((s) => s.title), kw, count: found.count };
}

// 4개씩 병렬
const results = []; let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => { while (next < cards.length) { const c = cards[next++]; try { const r = await enrich(c); results.push(r); console.log(r.skipped ? `- ${c.slug}: ${r.skipped}` : `+ ${c.slug}: ${r.items.length}개 항목, 문서 ${r.docs.length}건`); } catch (e) { results.push({ slug: c.slug, skipped: e.message }); console.log(`! ${c.slug}: ${e.message}`); } } }));

const md = ["# 아카이브 보강 결과 (검토용)", "", "원본은 그대로이고, 보강본은 `data/enriched/` 에 있습니다. 채택: `node insights-site/enrich.mjs --adopt <slug…|all>`", ""];
for (const r of results.sort((a, b) => a.slug.localeCompare(b.slug))) {
  md.push(`## ${r.slug}`);
  if (r.skipped) { md.push(`보강 안 함 — ${r.skipped}`, ""); continue; }
  md.push(`당사 관련 섹션: ${r.section} · 근거 문서: ${r.docs.join(" / ")}`, "");
  for (const it of [...r.items, ...r.think]) md.push(`- **[${it.type}${it.mark ? " " + it.mark : ""}] ${it.title || it.question || it.lead}** ${it.big ? it.big + (it.unit || "") + " — " : ""}${it.body || it.text || ""} _(cites ${it.cites.join(",")})_`);
  md.push("");
}
writeFileSync(join(OUT, "REPORT.md"), md.join("\n"));
console.log(`\n보고서: ${join(OUT, "REPORT.md")}`);
