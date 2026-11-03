// 기존 센싱 이슈에 AI 유형·사업부문 제안을 한 번에 채우는 백필 스크립트. ※ 준비만 해 둔 것 — 틀이 완성된 뒤 사용자 확인을 받고 실행한다.
//   node scripts/backfill-ai-types.mjs            # 계획만 출력(대상 건수·호출 수·프롬프트 크기). LLM 을 부르지 않는다.
//   node scripts/backfill-ai-types.mjs --yes      # 실제 실행: 이슈 5건씩 묶어 claude -p 를 호출(토큰 소모)
//   RISK_MOCK_LLM=1 node scripts/backfill-ai-types.mjs --yes   # 모의 응답으로 흐름만 점검(LLM 호출 없음)
//   RISK_DB=<경로>  다른 DB 파일 사용(테스트용)
// 대상: 아직 AI 제안이 없고(ai_type_status 비어 있음) 담당자·문서가 유형을 확정하지 않은 이슈. 확정값은 store.applyAiSuggestion 이 보호한다.
import { listIssues, applyAiSuggestion } from "../store.mjs";
import { typeGuide, normalizeAi } from "../classify.mjs";
import { claude, lastJson, MODEL } from "../lib.mjs";

const YES = process.argv.includes("--yes"), MOCK = !!process.env.RISK_MOCK_LLM, BATCH = 5;
const targets = listIssues().filter((i) => !i.aiType && !i.typeConfirmed);
const chunks = Array.from({ length: Math.ceil(targets.length / BATCH) }, (_, k) => targets.slice(k * BATCH, k * BATCH + BATCH));
const SYS = "당신은 GS리테일 리스크 관리 담당입니다. 이슈 제목·요약만 보고 유형을 제안합니다. 없는 사실은 만들지 않습니다. 결과는 JSON 객체 하나만 출력합니다(설명·코드펜스 없이).";
const GUIDE = typeGuide();
const promptOf = (list) => `${GUIDE}\n\n[분류할 이슈]\n${list.map((i) => `- id=${i.id} | (${i.area || "-"}) ${i.title}\n  ${String(i.summary || "").slice(0, 280)}`).join("\n")}\n\nJSON: {"items":[{"id":"이슈 id","typeSuggestion":{"typeId":"유형 id 또는 hold","confidence":0.0~1.0,"why":"근거 1문장"},"buSuggestion":{"buId":"사업부문 id 또는 null","why":"근거 1문장"}}]}  (이슈마다 정확히 하나)`;

console.log(`대상 ${targets.length}건 → 호출 ${chunks.length}회 (5건씩 묶음, 모델 ${MODEL})`);
if (chunks.length) console.log(`프롬프트 크기(첫 묶음): 약 ${promptOf(chunks[0]).length}자`);
if (!YES) { console.log("계획만 출력했습니다. 실제 실행은 --yes (토큰 소모) — 사용자 확인 후에만."); process.exit(0); }

const mock = (list) => ({ items: list.map((i, k) => ({ id: i.id, typeSuggestion: k % 2 ? { typeId: "hold", confidence: 0.3, why: "모의" } : { typeId: "product-quality", confidence: 0.9, why: "모의" }, buSuggestion: { buId: k % 2 ? null : "PBU", why: "모의" } })) });
let applied = 0, hold = 0, skipped = 0;
for (const list of chunks) {
  let res;
  try { res = MOCK ? mock(list) : lastJson(await claude(SYS, promptOf(list), 10 * 60e3), (o) => Array.isArray(o?.items)); }
  catch (e) { console.log(`  묶음 실패(건너뜀): ${e.message}`); skipped += list.length; continue; }
  for (const it of res.items) {
    if (!list.some((i) => i.id === it.id)) continue;
    const ai = normalizeAi(it);
    if (!ai.type && !ai.bu) { skipped++; continue; }
    applyAiSuggestion(it.id, ai.type, ai.bu); applied++; if (ai.type?.status === "hold") hold++;
  }
}
console.log(`완료: 반영 ${applied}건(분류 보류 ${hold}건), 건너뜀 ${skipped}건`);
