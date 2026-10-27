// 전체 매출 해설 + 부문별 전망 해설을 만들어 보드 초안에 병합한다(기존 카드는 건드리지 않음).
//   node insights-site/outlook.mjs gsretail-2026
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, claude, lastJson } from "./lib.mjs";

const slug = process.argv[2] || "gsretail-2026";
const draftP = join(DATA, "drafts", `board-${slug}.json`);
const draft = JSON.parse(readFileSync(draftP, "utf8"));
const F = JSON.parse(readFileSync(join(DATA, "forecast.json"), "utf8"));
const R = JSON.parse(readFileSync(join(DATA, "research", `${slug}.json`), "utf8"));
const ids = new Set(R.sources.map((s) => s.id));

const jo = (v) => (v / 1e6).toFixed(2);
const pc = (v) => (v * 100).toFixed(1) + "%";
const S = ["편의점", "수퍼마켓", "홈쇼핑"];
const digest = `[연결] 2023 ${jo(F.consolidated[2023])}조 · 2024 ${jo(F.consolidated[2024])}조 · 2025 ${jo(F.consolidated[2025])}조(영업이익률 ${pc(F.targetCheck.margin2025)})
[연결 전망 P10/P50/P90, 조원] ${F.forecast.total.map((p) => `${p.year}E ${jo(p.p10)}/${jo(p.p50)}/${jo(p.p90)}`).join(" · ")}
[연결 성장률(중앙)] ${F.growth.total.map((g) => `${g.year}E ${pc(g.g)}`).join(" · ")}
[부문 이력, 조원] ${S.map((s) => `${s}: ${[2023, 2024, 2025].map((y) => jo(F.history[y][s])).join("→")}`).join(" | ")}
[부문 전망 P10/P50/P90, 조원] ${S.map((s) => `${s}: ` + F.forecast[s].map((p) => `${p.year}E ${jo(p.p10)}/${jo(p.p50)}/${jo(p.p90)}`).join(", ")).join(" | ")}
[부문 2026E 성장률 / 상반기 실제 성장률] ${S.map((s) => `${s} ${pc(F.model[s].g2026)} / ${pc(F.model[s].h1yoy)}`).join(", ")}
[부문 장기 성장 앵커] ${JSON.stringify(F.assumptions.gLR)}
[매출 구성비 2025→2028E] ${S.map((s) => `${s} ${pc(F.mix[2025][s])}→${pc(F.mix["2028E"][s])}`).join(", ")}
[영업이익률 2025 / 2026 상반기] ${S.map((s) => `${s} ${pc(F.margins[s][2025])} / ${pc(F.margins[s].h1_2026)}`).join(", ")}
[목표] 2028 영업이익 3,800억원 → 필요 영업이익률 ${pc(F.targetCheck.requiredMargin.p50)} (2025 실제 ${pc(F.targetCheck.margin2025)})
[민감도: 2028E 중앙 매출 변화] ${F.sensitivity.map((x) => `${x.label} ${x.delta >= 0 ? "+" : ""}${jo(x.delta)}조`).join("; ")}`;

const evidence = R.sources.map((s) => `[${s.id}] ${s.title} (${s.publisher}, ${s.date})\n` + s.facts.map((x) => `  - ${x}`).join("\n")).join("\n\n");

const SYSTEM = `당신은 GS리테일 정책지원 조직의 전략 분석가입니다. 전사 구성원이 읽는 '매출 전망' 섹션의 해설을 씁니다.
규칙:
- [전망 요약]과 [근거]에 있는 사실·수치만 사용하세요. 없는 수치를 만들지 마세요. 해석·추정은 '추정'이라고 밝히세요.
- 숫자를 쓰면 반드시 위 자료와 일치해야 합니다(반올림 허용). 매출은 조원, 소수 둘째 자리까지.
- 쉬운 한국어. 전문 용어는 한 번 풀어 쓰세요. 구간(P10~P90)은 '80% 구간'이라고 부르세요.
- 모든 항목에 근거 id를 cites로 다세요(통계모델 결과만 쓴 문단은 cites를 비워도 됩니다).
반드시 JSON 객체 하나만 출력(설명·코드펜스 금지):
{"totalNarrative":[{"heading":"짧은 소제목","body":"3~4문장"}],
 "segmentOutlook":[{"segment":"편의점|수퍼마켓|홈쇼핑","headline":"한 줄 결론(30자 내외)","body":"4~5문장: 전망 수치, 이유, 의미","drivers":["성장 요인 2~3개(짧게)"],"watch":["주시할 신호 2~3개(짧게)"],"cites":["E1"]}]}
totalNarrative는 3개(① 한눈에 보는 전망 ② 어디서 성장이 나오나 ③ 이익과 3,800억 목표). segmentOutlook은 편의점·수퍼마켓·홈쇼핑 3개.`;

let out;
for (let attempt = 1; ; attempt++) {
  try {
    out = lastJson(await claude(SYSTEM, `${digest}\n\n[근거]\n${evidence}\n\n위 규칙대로 JSON을 출력하세요.`), (o) => o.totalNarrative && o.segmentOutlook);
    break;
  } catch (e) {
    if (attempt >= 2) throw e;
    console.log(`재시도 (${e.message})`);
  }
}
draft.outlook = {
  totalNarrative: out.totalNarrative,
  segmentOutlook: out.segmentOutlook.map((x) => ({ ...x, cites: (x.cites || []).filter((c) => ids.has(c)) })),
};
writeFileSync(draftP, JSON.stringify(draft, null, 2));
console.log("outlook 병합 완료:", draft.outlook.totalNarrative.length, "문단,", draft.outlook.segmentOutlook.length, "부문");
