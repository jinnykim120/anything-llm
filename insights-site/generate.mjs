// Draft insights for one or more domains → data/drafts/<domain>.json (status "draft").
//   node insights-site/generate.mjs 공정거래 동반성장 ESG
//   node insights-site/generate.mjs --list        # general-doc counts per domain
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, MODEL, dir, loadGeneralDocs, allGeneralDomains, claude } from "./lib.mjs";

const MAX_DOCS = 45;
const MIN_DOCS = 5; // below this the model pads; skip the domain instead
const EXCERPT = 800;

const SYSTEM = `당신은 사내 아카이브 자료를 바탕으로 전사 구성원에게 알릴 '분야별 인사이트'와 '최신 동향'을 쓰는 편집자입니다.
규칙:
- 제공된 문서 발췌에 있는 사실만 쓰세요. 발췌에 없는 내용·수치·날짜를 만들지 마세요.
- 모든 항목은 근거 문서 번호(cites)를 1개 이상 달아야 합니다. 번호는 [n]의 정수 n입니다.
- 독자는 비전문가 전사 구성원입니다. 쉬운 말로, 왜 중요한지(so what)를 한 문장 포함하세요.
- 최신 동향은 문서의 날짜(date)가 최근인 순서로, 무엇이 바뀌었는지 중심으로 쓰세요. 날짜가 없는 문서는 동향에 쓰지 마세요.
반드시 JSON 객체 하나만 출력하세요(설명·코드펜스 금지). 형식:
{"headline":"분야 한 줄 요약(40자 내외)",
 "insights":[{"title":"","body":"2~4문장","cites":[0]}],
 "trends":[{"date":"YYYY-MM-DD","title":"","summary":"1~2문장","cites":[0]}]}
insights는 3~5개, trends는 3~6개(최신순)입니다. 단, 근거가 부족하면 억지로 채우지 말고 개수를 줄이세요(동향은 0개도 가능).`;

function prompt(domain, docs) {
  const list = docs
    .map(
      (d, i) =>
        `[${i}] ${d.title}\n  유형:${d.docType} 날짜:${d.date || "없음"}\n  ${d.text
          .replace(/\s+/g, " ")
          .slice(0, EXCERPT)}`
    )
    .join("\n\n");
  return `분야: ${domain}\n\n문서 발췌:\n${list}\n\n위 규칙대로 JSON을 출력하세요.`;
}

// The model sometimes emits a draft, then "corrected output". Scan for balanced
// top-level objects and take the last one that parses and has insights+trends.
function parse(raw) {
  const s = raw.replace(/```json\s*|\s*```/g, "");
  let found = null;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (c === "\\") j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const o = JSON.parse(s.slice(i, j + 1));
          if (Array.isArray(o.insights) && Array.isArray(o.trends)) found = o;
        } catch {
          /* not a valid object, keep scanning */
        }
        i = j;
        break;
      }
    }
  }
  if (!found) throw new Error("no valid JSON in response");
  return found;
}

async function generateWithRetry(domain, docs) {
  for (let attempt = 1; ; attempt++) {
    try {
      return parse(await claude(SYSTEM, prompt(domain, docs)));
    } catch (e) {
      if (attempt >= 2) throw e;
      console.log(`  재시도 (${e.message})`);
    }
  }
}

// Drop uncited / out-of-range items rather than publish unsupported claims.
function checkCites(items, n) {
  return (items || [])
    .map((x) => ({
      ...x,
      cites: (x.cites || []).filter((c) => Number.isInteger(c) && c >= 0 && c < n),
    }))
    .filter((x) => x.cites.length);
}

const args = process.argv.slice(2);
if (args[0] === "--list") {
  for (const r of allGeneralDomains()) console.log(`${r.domain}\t${r.n}`);
  process.exit(0);
}

dir(join(DATA, "drafts"));
for (const domain of args) {
  const docs = loadGeneralDocs(domain).slice(0, MAX_DOCS);
  if (docs.length < MIN_DOCS) {
    console.log(`${domain}: general 문서 ${docs.length}건 < ${MIN_DOCS}건, 건너뜀 (근거 부족)`);
    continue;
  }
  console.log(`${domain}: 문서 ${docs.length}건으로 생성 중…`);
  const out = await generateWithRetry(domain, docs);
  const draft = {
    domain,
    status: "draft",
    generatedAt: new Date().toISOString(),
    model: MODEL,
    headline: out.headline,
    insights: checkCites(out.insights, docs.length),
    trends: checkCites(out.trends, docs.length).sort((a, b) =>
      (b.date || "").localeCompare(a.date || "")
    ),
    sources: docs.map((d) => ({
      title: d.title,
      docType: d.docType,
      date: d.date,
      reviewed: d.reviewed,
      hash: d.hash,
    })),
  };
  writeFileSync(join(DATA, "drafts", `${domain}.json`), JSON.stringify(draft, null, 2));
  console.log(`  → 인사이트 ${draft.insights.length} · 동향 ${draft.trends.length}`);
}
