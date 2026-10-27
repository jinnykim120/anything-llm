// 토픽 보드(핀터레스트형) 초안 생성: forecast.json + research/*.json → data/drafts/board-<slug>.json
// 차트·수치 카드는 build 단계가 forecast.json 에서 직접 그린다(LLM 미개입).
// LLM 은 '대외환경 / 위기 요인 / 우리가 고민할 것' 서술 카드만 만들고, 근거 id 가 없는 카드는 버린다.
//
//   node insights-site/board.mjs gsretail-2026
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, MODEL, dir, claude } from "./lib.mjs";

const slug = process.argv[2] || "gsretail-2026";
const forecast = JSON.parse(readFileSync(join(DATA, "forecast.json"), "utf8"));
const research = JSON.parse(readFileSync(join(DATA, "research", `${slug}.json`), "utf8"));
const ids = new Set(research.sources.map((s) => s.id));

const jo = (v) => (v / 1e6).toFixed(2); // 백만원 → 조원
const pct = (v) => (v * 100).toFixed(1) + "%";
const f = forecast.forecast;
const digest = `[전망 요약 — 통계모델 결과, 단위 조원, P10~P50~P90]
${["total", "편의점", "수퍼마켓", "홈쇼핑"]
  .map((k) => `${k === "total" ? "연결(부문합)" : k}: ` + f[k].map((x) => `${x.year}E ${jo(x.p10)}~${jo(x.p50)}~${jo(x.p90)}`).join(" / "))
  .join("\n")}
2025 실적 연결 ${jo(forecast.consolidated[2025])}조, 영업이익률 ${pct(forecast.targetCheck.margin2025)}.
회사 목표(2028 영업이익 3,800억원) 달성에 필요한 영업이익률: 중앙 ${pct(forecast.targetCheck.requiredMargin.p50)} (P10 시나리오 ${pct(forecast.targetCheck.requiredMargin.p10)}, P90 시나리오 ${pct(forecast.targetCheck.requiredMargin.p90)}).
2026E 성장률(상반기 확정+하반기 추정): ${["편의점", "수퍼마켓", "홈쇼핑", "기타"].map((s) => `${s} ${pct(forecast.model[s].g2026)}`).join(", ")}.
모델 가정: 장기성장 앵커 ${JSON.stringify(forecast.assumptions.gLR)}.`;

const evidence = research.sources
  .map((s) => `[${s.id}] ${s.title} (${s.publisher}, ${s.date})\n` + s.facts.map((x) => `  - ${x}`).join("\n"))
  .join("\n\n");

const SYSTEM = `당신은 GS리테일 정책지원 조직의 전략 분석가입니다. 전사 구성원이 읽는 '인사이트 보드'의 카드를 씁니다.
규칙:
- 아래 [전망 요약]과 [근거] 안의 사실·수치만 사용하세요. 없는 수치·사건·날짜를 만들지 마세요. 추정은 '추정'이라고 쓰세요.
- 모든 카드에 근거 id(예: "E1","A3")를 1개 이상 cites로 다세요. 카드 본문에 수치를 쓰면 그 수치가 있는 근거를 cites에 포함하세요.
- 쉬운 한국어, 비전문가도 이해. 카드 본문은 2~3문장. '그래서 우리에게 무슨 의미인지'를 포함.
- 위기 요인은 '무엇이 관측되면 현실화된 것인지'(trigger)를 구체적 지표로 쓰세요.
- '우리가 고민할 것'은 정답 제시가 아니라 의사결정자가 논의할 질문(question)과 판단 근거(body)로 구성하세요.
반드시 JSON 객체 하나만 출력(설명·코드펜스 금지):
{"summary":"전망 한 줄 요약(60자 내외, 구간 개념 포함)",
 "environment":[{"title":"","body":"","segment":"편의점|수퍼마켓|홈쇼핑|전사","direction":"순풍|역풍|양면","cites":["E1"]}],
 "risks":[{"title":"","body":"","severity":"높음|중간|관찰","segment":"편의점|수퍼마켓|홈쇼핑|전사","trigger":"","cites":["E1"]}],
 "insights":[{"title":"","question":"","body":"","cites":["E1"]}]}
environment 5~6개, risks 5~6개, insights 5~6개.`;

const prompt = `${digest}\n\n[근거]\n${evidence}\n\n위 규칙대로 JSON을 출력하세요.`;

function parse(raw) {
  const s = raw.replace(/```json\s*|\s*```/g, "");
  let found = null;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0, inStr = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { const o = JSON.parse(s.slice(i, j + 1)); if (o.environment && o.risks && o.insights) found = o; } catch { /* keep scanning */ }
        i = j;
        break;
      }
    }
  }
  if (!found) throw new Error("no valid JSON in response");
  return found;
}
const keep = (items) =>
  (items || [])
    .map((x) => ({ ...x, cites: (x.cites || []).filter((c) => ids.has(c)) }))
    .filter((x) => x.cites.length);

let out;
for (let attempt = 1; ; attempt++) {
  try { out = parse(await claude(SYSTEM, prompt)); break; }
  catch (e) { if (attempt >= 2) throw e; console.log(`재시도 (${e.message})`); }
}
const draft = {
  slug,
  status: "draft",
  generatedAt: new Date().toISOString(),
  model: MODEL,
  summary: out.summary,
  environment: keep(out.environment),
  risks: keep(out.risks),
  insights: keep(out.insights),
};
dir(join(DATA, "drafts"));
writeFileSync(join(DATA, "drafts", `board-${slug}.json`), JSON.stringify(draft, null, 2));
console.log(`환경 ${draft.environment.length} · 위기 ${draft.risks.length} · 고민 ${draft.insights.length}`);
console.log(draft.summary);
