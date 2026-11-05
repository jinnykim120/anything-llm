// 사건 카드 제목 자동 생성: '점포명_사건내용키워드' (앞의 시작연월은 폴더 이름이 자동으로 붙인다).
//   · 이미 만들어진 사건 카드(원본 자료로 분석한 결과)를 읽고 Sonnet 5.5 로 점포명(주체)과 키워드만 뽑는다. 원본을 다시 분석하지 않는다.
//   · 원본 자료가 없어 카드가 없는 사건(과거 이력 시드 등)은 바꾸지 않는다. 담당자가 직접 고친 제목은 force 없이는 덮어쓰지 않는다.
import * as S from "./store.mjs";
import * as CF from "./casefiles.mjs";
import * as A from "./analyze.mjs";

const SYS = `당신은 기업 리스크 사건 카드의 제목을 정리합니다. 입력의 사건 카드 내용만 근거로 씁니다.
출력은 JSON 하나만: {"place":"사건의 주체(점포명·협력사명·상품명 등, 예: GS25 ○○점)","keyword":"사건 내용 키워드 2개(많아야 3개)를 가운데점(·)으로 이어 전체 14자 이내(예: 이물질·환불, 표기오류·회수, 점주분쟁·보상)"}
규칙: place 에는 괄호·부연 설명을 넣지 않고 짧게 씁니다(점포 사건이면 "GS25 ○○점", 협력사·상품 사건이면 "협력사명 상품명" 정도). 쉼표(,)는 쓰지 않습니다. 날짜는 쓰지 않습니다. 개인 이름·연락처는 쓰지 않습니다. 문서에 없는 말을 만들지 않습니다.`;
export const cleanPart = (s, n) => String(s || "").split(String.fromCharCode(92)).join("").replace(/[,，、]/g, "·").replace(/[/:*?"<>|_]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export async function retitle(caseId, { force = false } = {}) {
  const c = S.getCase(caseId);
  if (c.titleSource === "manual" && !force) throw new S.HttpError(409, "담당자가 직접 정한 제목이라 바꾸지 않았습니다");
  if (A.activeRun(caseId)) throw new S.HttpError(409, "AI 분석이 진행 중이라 지금은 바꿀 수 없습니다");
  const card = CF.getCard(caseId).card;
  if (!card) throw new S.HttpError(409, "사건 카드가 없습니다. 원본 자료를 올려 AI 분석을 먼저 하세요(자료가 있어야 제목을 만들 수 있습니다)");
  const input = JSON.stringify({ title: card.title, summary: card.summary, parties: card.parties, firstEvents: (card.timeline || []).slice(0, 3).map((t) => t.event) }).slice(0, 3500);
  const { result, cost } = await A.askClaude({ system: SYS, user: input, timeoutMs: 90000 });
  const o = A.lastJson(result, (x) => typeof x.place === "string" && typeof x.keyword === "string");
  const place = cleanPart(o.place, 24), keyword = cleanPart(o.keyword, 18);
  if (!place || !keyword) throw new S.HttpError(502, "제목을 만들지 못했습니다. 다시 시도하세요");
  return { case: CF.setCaseTitle(caseId, `${place}_${keyword}`, "auto"), cost, before: c.title };
}
