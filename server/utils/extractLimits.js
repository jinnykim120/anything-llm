// [auto-docu 자료 추출하기 호출 상한] 자료 추출하기는 문서를 1만 자씩 잘라 전부
// 훑으며 LLM을 부르기 때문에, 사업보고서 여러 건이면 한 번에 수백 회 호출이
// 나가 Claude 사용량이 폭증했다(2026-09-21 확인 요청). 그래서 기본값으로 상한을
// 둔다. 상한을 넘는 문서는 앞에서부터 자르지 않고, 요청 항목과 관련 있는
// 구간(excerptRelevant)만 골라 훑는다.
//
// 원상복구(제한 해제): server/.env.development 에
//     EXTRACT_LIMITS=off
// 를 넣고 서버를 재시작하면 상한이 전부 사라진다(예전 동작: 문서 15건, 청크·호출
// 무제한). 개별 조정은 아래 값을 env로 바꾼다.
//     EXTRACT_MAX_DOCS (기본 8) / EXTRACT_MAX_CHUNKS_PER_DOC (기본 10)
//     / EXTRACT_MAX_CALLS (기본 50, 한 번의 추출 실행 전체)
const LEGACY_MAX_DOCS = 15;

function num(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function extractLimits() {
  if (String(process.env.EXTRACT_LIMITS).toLowerCase() === "off") {
    return {
      limited: false,
      maxDocs: LEGACY_MAX_DOCS,
      maxChunksPerDoc: Infinity,
      maxCalls: Infinity,
    };
  }
  return {
    limited: true,
    maxDocs: num("EXTRACT_MAX_DOCS", 8),
    maxChunksPerDoc: num("EXTRACT_MAX_CHUNKS_PER_DOC", 10),
    maxCalls: num("EXTRACT_MAX_CALLS", 50),
  };
}

module.exports = { extractLimits };
