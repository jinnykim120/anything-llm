// [auto-docu 검색 재현율] 사용자는 "매출 실적"이라고 묻지만 공시·보고서 문서는
// "재무정보 · 매출액 · 영업이익 · 연결"이라고 쓴다. 밀집 임베딩(e5-small)은 이
// 어휘 차이를 잘 못 넘어서, 정답 표 청크가 후보 풀에 아예 못 들어오는 경우가
// 있다(실측: "GS리테일 2026년 매출 실적" → 반기보고서 손익 표 청크가 후보에 없음,
// "재무정보 매출액 영업이익 연결"을 붙이면 같은 청크가 7·8·25위).
//
// 그래서 질문에 업무 용어 동의어를 덧붙인 "확장 질문"을 하나 더 만들어 임베딩하고,
// 그 후보를 원래 후보에 합집합(청크별 최고 점수)으로 더한다 — LLM 호출 없음,
// 임베딩 1회 추가. 원래 질문의 순위 신호는 그대로 유지된다(점수 max 병합).
//
// QUERY_EXPANSION=off 로 끌 수 있다.

// [트리거 정규식, 덧붙일 용어들] — 앞에서부터 모두 적용(중복 제거).
const RULES = [
  {
    when: /(매출|실적|영업이익|순이익|손익|수익)/,
    add: ["재무정보", "매출액", "영업이익", "연결"],
  },
  {
    when: /(자산|부채|자본|재무상태|현금)/,
    add: ["재무상태표", "연결", "재무정보"],
  },
  {
    when: /(점포|매장|출점)/,
    add: ["점포수", "사업의 내용", "영업현황"],
  },
];

function isEnabled() {
  return String(process.env.QUERY_EXPANSION || "").toLowerCase() !== "off";
}

/**
 * @returns {string|null} 확장된 질문(원 질문 + 용어). 덧붙일 게 없으면 null.
 */
function expandQuery(input = "") {
  const q = String(input || "").trim();
  if (!q || !isEnabled()) return null;
  const extra = [];
  for (const rule of RULES) {
    if (!rule.when.test(q)) continue;
    for (const term of rule.add) {
      if (!q.includes(term) && !extra.includes(term)) extra.push(term);
    }
  }
  return extra.length ? `${q} ${extra.join(" ")}` : null;
}

// 주의: 청크 메타데이터의 `id` 는 청크가 아니라 "문서" 단위 값이라 키로 쓰면 한
// 문서의 청크가 전부 하나로 합쳐진다 — 문서 ID + 청크 번호로 구분한다.
const chunkKey = (src = {}) =>
  `${src.doc_id || src.id || src.title || ""}:${src.chunk_index ?? (src.text || "").slice(0, 40)}`;

/**
 * 두 밀집 결과({contextTexts, sourceDocuments, scores})를 청크별 최고 점수로
 * 합치고 점수 내림차순으로 정렬한다.
 */
function mergeDenseCandidates(a, b) {
  const map = new Map();
  const add = (res) => {
    (res?.sourceDocuments || []).forEach((src, i) => {
      const key = chunkKey(src);
      const score = res.scores?.[i] ?? src.score ?? 0;
      const prev = map.get(key);
      if (!prev || score > prev.score)
        map.set(key, { src, text: res.contextTexts?.[i], score });
    });
  };
  add(a);
  add(b);
  const rows = [...map.values()].sort((x, y) => y.score - x.score);
  return {
    contextTexts: rows.map((r) => r.text),
    sourceDocuments: rows.map((r) => r.src),
    scores: rows.map((r) => r.score),
  };
}

module.exports = { expandQuery, mergeDenseCandidates, isEnabled, RULES };
