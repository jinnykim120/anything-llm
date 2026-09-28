/**
 * Pure, stateless tuning/config helpers for the PGVector provider. None of
 * these need a PGVector instance, so they are plain module functions rather
 * than static class methods — `index.js` exposes them via thin static
 * delegators so the public `PGVector.xxx()` API is unchanged.
 */

/**
 * Get the table name for the PGVector database.
 * - Defaults to "anythingllm_vectors" if no table name is provided.
 * @returns {string}
 */
function tableName() {
  return process.env.PGVECTOR_TABLE_NAME || "anythingllm_vectors";
}

/**
 * Get the connection string for the PGVector database.
 * - Requires a connection string to be present in the environment variables.
 * @returns {string | null}
 */
function connectionString() {
  return process.env.PGVECTOR_CONNECTION_STRING;
}

function integerSetting(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name], 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function hnswSettings() {
  return {
    m: integerSetting("PGVECTOR_HNSW_M", 16, 2, 100),
    efConstruction: integerSetting("PGVECTOR_HNSW_EF_CONSTRUCTION", 64, 4, 1_000),
    // [auto-docu 검색 재현율] 기본 40 → 200. HNSW 는 ef_search 개까지만 돌려주므로
    // 40이면 "후보 60~200개를 넓게 뽑는다"는 코드 의도와 달리 실제로는 39~40행만
    // 나와, 큰 코퍼스(한 문서가 2천 청크)에서 정답 표 청크(밀집 순위 100위대)가
    // 후보에 못 들어왔다. 200이면 candidateK 상한(200)을 채울 수 있다.
    efSearch: integerSetting("PGVECTOR_HNSW_EF_SEARCH", 200, 1, 1_000),
  };
}

function rerankCandidateLimit(totalEmbeddings, topN = 4) {
  const configured = integerSetting("RERANKER_CANDIDATE_LIMIT", 30, 10, 50);
  const corpusCandidateCount = Math.ceil(totalEmbeddings * 0.1);
  return Math.max(
    topN,
    Math.min(configured, Math.max(10, corpusCandidateCount))
  );
}

function indexName(suffix) {
  const base = tableName().replace(/[^a-zA-Z0-9_]/g, "_");
  return `${base}_${suffix}`.slice(0, 63);
}

/**
 * Extract useful words for the database fallback search. Dense embeddings
 * are the primary retrieval path, but an exact product/document name should
 * still be found when the local embedding model is unavailable or returns no
 * candidates. Korean case particles are removed so queries such as
 * "우리동네GS 실적은?" match chunks containing "우리동네GS" and "실적".
 */
function lexicalSearchTerms(input = "") {
  const stopWords = new Set([
    "그리고",
    "그런데",
    "대해",
    "대한",
    "무엇",
    "어떤",
    "알려줘",
    "알려주세요",
    "해주세요",
    "해줘",
    "the",
    "and",
    "what",
    "which",
    "how",
    "about",
    "please",
  ]);
  const particles = [
    "으로부터",
    "로부터",
    "에서는",
    "에게서",
    "으로는",
    "이라는",
    "이라고",
    "까지는",
    "부터는",
    "에서는",
    "에게",
    "에서",
    "으로",
    "까지",
    "부터",
    "처럼",
    "보다",
    "마다",
    "조차",
    "은",
    "는",
    "이",
    "가",
    "을",
    "를",
    "에",
    "의",
    "도",
    "만",
    "로",
    "와",
    "과",
    "요",
  ];

  return String(input)
    .toLocaleLowerCase("ko-KR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((term) => {
      for (const particle of particles) {
        if (term.endsWith(particle) && term.length - particle.length >= 2)
          return term.slice(0, -particle.length);
      }
      return term;
    })
    .filter(
      (term, index, terms) =>
        term.length >= 2 &&
        !stopWords.has(term) &&
        terms.indexOf(term) === index
    );
}

/** Fraction (0..1) of `terms` that appear literally in `text`. */
function termMatchRatio(terms = [], text = "") {
  if (!terms.length) return 0;
  const searchable = String(text || "").toLocaleLowerCase("ko-KR");
  return (
    terms.filter((term) => searchable.includes(term)).length / terms.length
  );
}

/** Fraction (0..1) of `terms` that appear literally among a document's
 * classification tags. */
function termTagOverlap(terms = [], tags = []) {
  if (!terms.length || !Array.isArray(tags) || !tags.length) return 0;
  const tagText = tags.join(" ").toLocaleLowerCase("ko-KR");
  return terms.filter((term) => tagText.includes(term)).length / terms.length;
}

/** [auto-docu 복합질문] 문서 제목에서 4자리 연도를 전부 뽑아 Set으로 반환 —
 * "GS리테일 2026년 반기보고서" -> {"2026"}. 하이브리드 리랭크/섹션 확장에서
 * 질문의 연도와 비교해 기간이 명백히 다른 문서를 걸러내는 데 쓴다. */
function docYearTokens(title = "") {
  const years = String(title || "").match(/\b(19|20)\d{2}\b/g) || [];
  return new Set(years);
}

/** [auto-docu 복합질문] 이 코퍼스 제목 컨벤션 — "[회사명]사업보고서...",
 * "[BGF리테일][정정]반기보고서..." — 맨 앞 "[...]" 안의 회사명만 뽑는다
 * (두 번째 이후 괄호는 "정정" 같은 상태 태그라 무시). 브래킷이 없는 제목
 * (내부 md/hwp 등)은 null — 회사 정보가 없다는 뜻이니 게이트에서 그냥
 * 통과시킨다(오탐 방지, 확실한 불일치만 걸러낸다). */
function docCompanyTag(title = "") {
  const m = String(title || "").match(/^\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
}

/** [auto-docu v18] How much the hybrid rerank (performSimilaritySearch step
 * 2b) trusts keyword-overlap and classification-tag matches relative to
 * raw cosine similarity. Both are expressed as % of a similarity point so
 * they can be tuned via env without touching the scoring formula. */
function hybridWeights() {
  return {
    keyword: integerSetting("HYBRID_KEYWORD_WEIGHT_PCT", 12, 0, 100) / 100,
    tag: integerSetting("HYBRID_TAG_WEIGHT_PCT", 15, 0, 100) / 100,
    // [auto-docu 문서 연계성 학습] affinityBoostFor()가 돌려주는 0~1 가산점에
    // 곱해지는 가중치. **기본 0 = 랭킹에 반영하지 않음(기록만 계속 쌓음).**
    // 밀집 점수가 0.91~0.94로 거의 평평한 이 코퍼스에서 +0.10 은 이력이 있는
    // 문서가 순위를 통째로 덮어(실측: "GS리테일 2026년 매출 실적"에서 정답
    // 문서가 밀려남) 데이터가 충분히 쌓이기 전에는 켜지 않는다. 다시 켜려면
    // HYBRID_AFFINITY_WEIGHT_PCT=2~3 처럼 작게 시작해 eval 로 확인할 것.
    affinity: integerSetting("HYBRID_AFFINITY_WEIGHT_PCT", 0, 0, 100) / 100,
    // [auto-docu 복합질문] 질문에 연도가 있는데 후보 문서 제목의 연도와 전혀
    // 겹치지 않으면 이 점수만큼 깎는다. 이 코퍼스 밀집 점수가 0.91~0.94로 거의
    // 평평해서(위 affinity 주석 참고) 순위를 확실히 뒤집으려면 이 정도 크기가
    // 필요하다 — 실측: "2026년 매출 실적" 질문에서 2024년에 제출된 FY2023
    // 정정 사업보고서가 리드 문서로 잘못 뽑힌 사례.
    yearMismatchPenalty:
      integerSetting("HYBRID_YEAR_MISMATCH_PENALTY_PCT", 20, 0, 100) / 100,
    // [auto-docu 복합질문] 질문이 겨냥한 회사와 제목의 "[회사명]" 접두사가
    // 다르면 이 점수만큼 깎는다 — 실측: "GS리테일 2026년 매출 실적 + 2023~
    // 2025년 추이"에서 경쟁사 "[BGF리테일][정정]반기보고서"가 "매출/실적"
    // 같은 범용 키워드만으로 상위권에 끼어들어(연도도 2026이라 연도 페널티도
    // 안 걸림) otherBudget을 넉넉히 늘린 뒤 whole-doc 확장까지 타면서 22개
    // 청크로 불어난 사례. 연도 페널티보다 크게 잡는다 — 회사가 다르면 거의
    // 항상 무관한 문서이지 "참고할 만한 다른 관점"이 아니다.
    companyMismatchPenalty:
      integerSetting("HYBRID_COMPANY_MISMATCH_PENALTY_PCT", 35, 0, 100) / 100,
  };
}

module.exports = {
  tableName,
  connectionString,
  integerSetting,
  hnswSettings,
  rerankCandidateLimit,
  indexName,
  lexicalSearchTerms,
  termMatchRatio,
  termTagOverlap,
  docYearTokens,
  docCompanyTag,
  hybridWeights,
};
