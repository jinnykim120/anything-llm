// 테스트 전용 가짜 claude 실행기. RISK_CLAUDE_STUB=<이 파일> 로 지정하면 analyze.mjs 가 `claude` 대신 이것을 실행한다. 실제 AI 를 호출하지 않는다.
//   FAKE_CLAUDE_MODE : ok | limit-card-once(카드 호출을 처음 한 번만 한도 초과로 실패) | limit-vision-once | badjson
//   FAKE_CLAUDE_STATE: limit-* 모드의 '이미 한 번 실패함' 표시 파일 경로
//   FAKE_CLAUDE_LOG  : 호출 기록(JSON 줄) 파일 경로
//   FAKE_DELAY_MS    : 응답 지연(실행 중 서버 재시작 시험용)
//   FAKE_TYPE / FAKE_CONF / FAKE_START : 카드의 유형 제안·확신도·시작일
import { readFileSync, appendFileSync, existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2), mode = process.env.FAKE_CLAUDE_MODE || "ok", input = readFileSync(0, "utf8");
const ti = args.indexOf("--tools"), vision = ti >= 0 && args[ti + 1] === "Read";
// leaked: 'AI 로 보내면 안 되는' 표식이 입력에 들어 있었는지(테스트가 확인)
const log = (o) => { if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ kind: vision ? "vision" : "card", chars: input.length, at: Date.now(), leaked: ["고객 주문 리스트", "확인표.csv", "홍길동", "010-1111-2222", "김철수", "02-1234-5678"].filter((x) => input.includes(x)), ...o }) + "\n"); };
const out = (o) => { console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 10, total_cost_usd: vision ? 0.05 : 0.15, usage: { input_tokens: 1200, output_tokens: 600 }, ...o })); process.exit(0); };
const limit = () => { console.log(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "You've hit your 5-hour limit · resets 1:30pm (Asia/Seoul)" })); process.exit(1); };
const delay = Number(process.env.FAKE_DELAY_MS || 0);
if (delay) await new Promise((r) => setTimeout(r, delay));

const once = (m) => { const st = process.env.FAKE_CLAUDE_STATE; if (mode !== m || !st || existsSync(st)) return false; writeFileSync(st, "1"); return true; };
if ((vision && once("limit-vision-once")) || (!vision && once("limit-card-once"))) { log({ result: "limit" }); limit(); }
if (mode === "badjson" && !vision) { log({ result: "badjson" }); out({ result: "죄송합니다. 분석할 수 없습니다." }); }

if (vision) {
  const paths = [...input.matchAll(/^i(\d+)\)\s+(.+)$/gm)].map((m) => ({ id: `i${m[1]}`, path: m[2].trim() }));
  log({ images: paths.length });
  out({ result: JSON.stringify({ images: paths.map((p, i) => ({ id: p.id, doc_type: i === 0 ? "식약처 조사결과" : "사진", decorative: false, date: "2026-06-22", transcription: `조사결과 안내 — 담당 010-1234-5678 / 서울특별시 송파구 올림픽로 300 (고객 연락처 포함)`,
    key_facts: i === 0 ? ["ZZ식약처공문 2026-06-22 접수, 제조단계 혼입은 확인되지 않음"] : ["현장 사진 확인"], numbers: [{ label: "수량", value: "11,160", confidence: "medium" }], masked_or_unreadable: [], low_confidence: [], readability: "high" })) }) });
}
// 입력의 파일 블록: "=== [F12] 경로 [종류]" 다음 줄들이 본문
const blocks = input.split(/^=== \[/m).slice(1).map((b) => { const m = b.match(/^((?:F|E)\d+)\] (.+?) \[(사건자료|절차참고)\][^\n]*\n([\s\S]*)$/); return m && { id: m[1], path: m[2], kind: m[3], body: m[4].trim() }; }).filter(Boolean);
const files = blocks.filter((b) => b.id.startsWith("F"));
log({ files: files.length });
const first = files[0], second = files[1] || files[0], png = files.find((f) => /\.png$/i.test(f.path)) || first;
const realQuote = (first?.body.split("\n").find((l) => l.trim().length >= 8) || "").trim().slice(0, 30);
const srcMode = process.env.FAKE_SRC || "mixed";
const card = {
  title: "테스트 사건", issue_type: { primary: process.env.FAKE_TYPE || "product-quality", confidence: Number(process.env.FAKE_CONF || 0.9), secondary_tags: ["partner"], reasoning: "이물질 민원" },
  business_unit: { value: "HBU", reasoning: "홈쇼핑 판매 상품" },
  start_date: { value: process.env.FAKE_START === "none" ? null : process.env.FAKE_START || "2026-06-20", basis: "보고서 개요표의 최초 민원 접수일", is_estimate: false, conflict: false, candidates: [{ date: "2026-06-20", src: { file: first?.id, loc: "1쪽", quote: realQuote } }] },
  end_date: { value: null, basis: "문서에 없음", is_estimate: false }, status_at_documents: "진행중", risk_level: { value: "높음", reasoning: "고객 부상" },
  summary: "이물 민원이 접수되었다. 고객(010-9999-8888)이 서울특별시 강남구 테헤란로 152 에서 신고했다.",
  timeline: [{ date: "2026-06-20", event: "최초 민원 접수", src: { file: first?.id, loc: "슬라이드 1", quote: realQuote } }], parties: { internal_departments: ["CX팀"], partners_and_third_parties: ["제조사"], agencies: [] },
  // 인용문이 본문에 없는 경우(quote-unverified)
  legal_issues: [{ issue: "식품 표시 기준", src: { file: second?.id, loc: "표 2", quote: "본문에 전혀 없는 가짜 인용문입니다 ZZZ" } }],
  // 이미지 근거(검수 필요) + 존재하지 않는 ID
  figures: [{ label: "수량", value: "11,160", src: { file: png?.id, loc: "", quote: "" }, confidence: "medium", needs_review: false }, { label: "금액", value: "1,000원", src: { file: srcMode === "ok" ? first?.id : "F9999", loc: "", quote: "" }, confidence: "high", needs_review: false }],
  // 파일 이름으로 적었는데 그 이름은 보관만으로 내려간 작은 판본(규정.pdf) → 큰 판본(규정.docx)으로 연결되어야 함
  stage_actions: { intake: [{ action: "민원 접수", date: "2026-06-20", src: { file: srcMode === "ok" ? first?.id : "규정.pdf", loc: "", quote: "" } }] },
  inconsistencies: [{ item: "접수일", values: [{ value: "6/20", src: { file: first?.id, loc: "", quote: realQuote } }, { value: "6/25", src: { file: "F7777", loc: "", quote: "" } }], note: "" }],
  review_flags: [{ text: "객체 형태 검수 항목", src: { file: first?.id, loc: "", quote: "" } }, "문자열 검수 항목"], not_in_documents: ["종결일"], uncertainties: [], notes: [], filled_from_embedded_images: [],
};
const file_stages = files.map((f, i) => ({ file: f.id, primary_stage: /가이드|프로세스/.test(f.path) ? "reference" : i === 0 ? "overall" : "fact-check", secondary_stage: null, confidence: 0.8, reason: "내용 근거", other_case: /다른사건/.test(f.path), other_case_reason: /다른사건/.test(f.path) ? "다른 사건 문서로 보임" : "" }));
out({ result: JSON.stringify({ case_card: card, file_stages }) });
