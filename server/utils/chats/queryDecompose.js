// [auto-docu 복합질문] "2026년 매출 실적 + 2023~2025년 추이"처럼 한 문장에 서로 다른
// 시점·주제를 함께 묻으면 하나의 임베딩이 한쪽 섹션으로만 끌려가 나머지가
// "자료 없음"으로 누락되는 문제가 있다(대형 다중 섹션 PDF에서 재현).
//
// 접근: 질문이 복합으로 보일 때만(휴리스틱) LLM으로 2~3개의 독립 하위 질문으로
// 쪼개 각각 검색하고, 하위 질문마다 상위 결과 몇 건씩만 기존 결과 뒤에 "덧붙인다"
// (기존 결과는 절대 순서 변경/제거하지 않음). 이전에 실패한 "형제 섹션 보강"은
// 질문과 무관하게 다른 섹션을 끌어와 연결/별도 재무제표를 혼동시켰다 — 여기서는
// 하위 질문 자체가 원하는 대상을 명시하므로 추가되는 청크가 질문에 맞게 정밀하다.
//
// QUERY_DECOMPOSE=on 일 때만 동작(기본 off). 실패하면 조용히 원래 결과를 쓴다.
//
// [보류 — 2026-09-21 평가 결과] eval gs-half-year-revenue(대형 반기보고서)에서
// 분해·병합 방식을 4가지로 바꿔가며 측정했지만 completeness 0.0~0.25 로 개선이
// 없었다. 원인은 질문 분해가 아니라 검색 재현율이다 — 하위 질문("GS리테일 2026년
// 매출 실적")으로도 정답 청크(반기보고서 "(5) 주요 재무정보" 손익 표)가 상위에
// 들어오지 않고(반기보고서 청크 3개: 사업개요·영업부문 주석·재무상태표 일부만
// 검색됨), 작은 문서 하나가 통째로 확장되어 순위를 독점한다. 그래서 기본 off 로
// 두고 코드만 남긴다. 다시 켜보려면 재현율(청크 크기·표 청크·섹션 제목 가중)을
// 먼저 개선해야 한다. eval/FINDINGS.md 참고.
const MAX_SUBQUERIES = 3;
const PER_SUBQUERY = 3;
const DOCS_PER_SUB = 3; // 하위 질문마다 새로 가져올 문서 수(문서당 최고 점수 청크 1건)
const EXTRA_CAP = 8; // 하위 질문 결과로 덧붙일 수 있는 청크 총량(기존 결과 크기와 무관)

const YEAR_RE = /(?:19|20)\d{2}\s*년?|\b\d{2}\s*년|[1-4]\s*분기|상반기|하반기/g;

function isEnabled() {
  return String(process.env.QUERY_DECOMPOSE || "").toLowerCase() === "on";
}

/** 비용을 아끼려고, 명백히 단일 주제인 짧은 질문은 LLM 호출 없이 거른다. */
function looksCompound(message = "") {
  const q = String(message).trim();
  if (q.length < 14) return false;
  const periods = new Set(
    (q.match(YEAR_RE) || []).map((m) => m.replace(/\s/g, ""))
  );
  const hasRange = /\d{4}\s*[~\-–]\s*\d{2,4}/.test(q);
  if (periods.size >= 2 || (hasRange && periods.size >= 1)) return true;
  if (/[+＋]/.test(q)) return true;
  if (
    /(및|그리고|,\s*그리고|와\s+.+(?:도|을|를)\s|과\s+.+(?:도|을|를)\s)/.test(
      q
    ) &&
    q.length >= 24
  )
    return true;
  if (/(각각|별로|비교|대비)/.test(q) && q.length >= 20) return true;
  return false;
}

function parseSubqueries(text, original) {
  const m = String(text || "").match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set([original.trim()]);
  const out = [];
  for (const raw of arr) {
    const s = String(raw || "").trim();
    if (s.length < 4 || s.length > 300 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_SUBQUERIES) break;
  }
  return out;
}

async function decomposeQuery({ message, LLMConnector }) {
  const system = [
    "사용자의 질문이 서로 다른 시점·대상·주제를 함께 묻는 복합 질문이면, 각각을 그 자체로 검색 가능한 독립 질문으로 나눈다.",
    "규칙:",
    "- 원 질문의 회사명·문서명·지표명 같은 핵심 대상을 각 하위 질문에 그대로 넣는다(대명사 금지).",
    "- 원 질문에 없는 사실이나 범위를 추가하지 않는다.",
    `- 하위 질문은 2~${MAX_SUBQUERIES}개. 복합이 아니면 빈 배열 [] 을 반환한다.`,
    "- 출력은 JSON 문자열 배열 하나만. 설명·코드펜스 없이.",
    '예) "GS리테일의 2026년 매출 실적과 2023~2025년 추이" → ["GS리테일 2026년 매출 실적", "GS리테일 2023년~2025년 연도별 매출 추이"]',
  ].join("\n");
  const { textResponse } = await LLMConnector.getChatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: message },
    ],
    { temperature: 0 }
  );
  return parseSubqueries(textResponse, message);
}

const chunkKey = (source) =>
  source?.id || `${source?.doc_id || ""}:${(source?.text || "").slice(0, 40)}`;
const docKey = (source) => source?.doc_id || source?.title || "";

/**
 * primary 결과 뒤에 하위 질문 결과를 덧붙인다. primary 는 절대 바꾸지 않는다.
 *  1) 새 근거 우선: 하위 질문마다 primary 에 없던 청크 중 문서별 최고 점수 청크를
 *     문서 다양성을 유지하며 DOCS_PER_SUB 건까지 넣는다.
 *  2) 남는 자리는 각 하위 질문의 상위 PER_SUBQUERY 건을 번갈아 채운다.
 * 덧붙이는 총량은 EXTRA_CAP 이하(primary 가 섹션 확장으로 이미 커도 자리를 확보).
 */
function mergeDecomposedResults(primary, subResults) {
  const seen = new Set((primary.sources || []).map(chunkKey));
  const contextTexts = [...(primary.contextTexts || [])];
  const sources = [...(primary.sources || [])];
  let added = 0;
  const push = (sub, idx) => {
    const src = sub.sources[idx];
    const key = chunkKey(src);
    if (seen.has(key) || added >= EXTRA_CAP) return false;
    seen.add(key);
    sources.push(src);
    contextTexts.push(sub.contextTexts?.[idx]);
    added += 1;
    return true;
  };

  // 하위 질문마다 "primary 에 없던 청크 중 문서별 최고 점수 1건"을 문서를 다양하게
  // (최대 DOCS_PER_SUB 개 문서) 고른다. 한 문서가 통째로 확장돼 순위를 독점하는
  // 경우(작은 문서 전체 확장)에도, 다른 문서의 가장 관련 높은 청크가 들어오게 한다.
  const claimedDocs = new Set();
  for (const sub of subResults) {
    const best = new Map(); // docKey -> {src, idx, score}
    (sub.sources || []).forEach((src, idx) => {
      const d = docKey(src);
      if (!d || claimedDocs.has(d) || seen.has(chunkKey(src))) return;
      const score = Number(src.score) || 0;
      if (!best.has(d) || score > best.get(d).score)
        best.set(d, { src, idx, score });
    });
    [...best.entries()]
      .sort((x, y) => y[1].score - x[1].score)
      .slice(0, DOCS_PER_SUB)
      .forEach(([d, { idx }]) => {
        if (push(sub, idx)) claimedDocs.add(d);
      });
  }

  // 하위 질문을 번갈아가며 채워, 한 하위 질문이 자리를 독점하지 않게 한다.
  for (let rank = 0; rank < PER_SUBQUERY; rank++)
    for (const sub of subResults) if (sub.sources?.[rank]) push(sub, rank);
  return { contextTexts, sources, added };
}

/**
 * @param {object} args
 * @param {object} args.results   primary performSimilaritySearch 결과(수정 대상)
 * @param {string} args.message   사용자 질문(또는 condense된 질문)
 * @param {(input:string)=>Promise<object>} args.search  같은 옵션으로 검색하는 함수
 * @returns {Promise<{subqueries:string[], added:number}>}
 */
async function augmentWithDecomposition({
  results,
  message,
  LLMConnector,
  search,
  topN,
}) {
  if (!isEnabled() || results?.message || !looksCompound(message))
    return { subqueries: [], added: 0 };
  try {
    const subqueries = await decomposeQuery({ message, LLMConnector });
    if (subqueries.length < 2) return { subqueries, added: 0 };
    const subResults = [];
    for (const q of subqueries) {
      const r = await search(q);
      if (r && !r.message) subResults.push(r);
    }
    const merged = mergeDecomposedResults(results, subResults);
    results.contextTexts = merged.contextTexts;
    results.sources = merged.sources;
    console.log(
      `[queryDecompose] ${subqueries.length} sub-queries, +${merged.added} chunks:`,
      subqueries
    );
    return { subqueries, added: merged.added };
  } catch (e) {
    console.error(
      "[queryDecompose] failed, using original results:",
      e.message
    );
    return { subqueries: [], added: 0 };
  }
}

module.exports = {
  isEnabled,
  looksCompound,
  parseSubqueries,
  decomposeQuery,
  mergeDecomposedResults,
  augmentWithDecomposition,
};
