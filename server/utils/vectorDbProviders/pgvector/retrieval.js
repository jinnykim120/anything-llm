/**
 * Core retrieval pipeline for the PGVector provider: dense/lexical search,
 * hybrid rerank, section expansion, and the top-level performSimilaritySearch
 * orchestration. Each exported function takes the `PGVector` instance as an
 * explicit first parameter (`self`) instead of using `this` — see the note
 * at the top of `schema.js` for why. `index.js` exposes each of these under
 * the same public method name via a one-line delegator.
 */
const { expandQuery, mergeDenseCandidates } = require("../queryExpansion");
const { sourceIdentifier } = require("../../chats");
const { NativeEmbeddingReranker } = require("../../EmbeddingRerankers/native");
const SearchTuning = require("./searchTuning");
const FolderAccess = require("../../folderAccess");

/**
 * [NEXUS 폴더 잠금] 이 요청이 볼 수 없는 문서(잠긴 폴더)를 SQL 단계에서 먼저
 * 뺀다. 상위 K개를 뽑은 뒤 지우면 잠긴 문서가 상위권을 차지한 질문에서 결과가
 * 비어 버리므로, 후보를 뽑기 전에 조건으로 건다. `params` 에 목록을 추가하고
 * WHERE 에 붙일 조각을 돌려준다 (막을 문서가 없으면 빈 문자열).
 * @param {unknown[]} params
 */
async function deniedClause(params) {
  const denied = await FolderAccess.deniedDocIds();
  if (!denied.length) return "";
  params.push(denied);
  return `AND COALESCE(metadata->>'doc_id', '') <> ALL($${params.length}::text[])`;
}

/**
 * Search indexed text/title fields without requiring an embedding model.
 * This is intentionally a fallback: it protects exact Korean names and
 * numbers from becoming an empty-context answer during local ONNX pressure.
 */
async function lexicalSearchResponse(
  self,
  {
    client,
    namespace,
    input,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
    filterDocIds = null,
  }
) {
  const terms = SearchTuning.lexicalSearchTerms(input);
  const empty = { contextTexts: [], sourceDocuments: [], scores: [] };
  if (!terms.length) return empty;

  const patterns = terms.map((term) => `%${term}%`);
  const limit = Math.max(50, Math.min(500, Number(topN) * 25));
  const docIds =
    Array.isArray(filterDocIds) && filterDocIds.length ? filterDocIds : null;
  const params = [namespace, patterns, limit];
  if (docIds) params.push(docIds);
  const deniedSql = await deniedClause(params);
  const response = await client.query(
    `SELECT metadata FROM "${SearchTuning.tableName()}"
     WHERE namespace = $1
       AND concat_ws(' ',
         metadata->>'text',
         metadata->>'title',
         metadata->>'sourceDocument',
         metadata->>'chunkSource'
       ) ILIKE ANY($2::text[])
       ${docIds ? "AND metadata->>'doc_id' = ANY($4::text[])" : ""}
       ${deniedSql}
     LIMIT $3`,
    params
  );

  const ranked = response.rows
    .map(({ metadata }) => {
      const searchable = [
        metadata?.text,
        metadata?.title,
        metadata?.sourceDocument,
        metadata?.chunkSource,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("ko-KR");
      const textSearchable = String(metadata?.text || "").toLocaleLowerCase(
        "ko-KR"
      );
      const matchedTerms = terms.filter((term) => searchable.includes(term));
      const matchedTextTerms = terms.filter((term) =>
        textSearchable.includes(term)
      );
      if (!matchedTerms.length) return null;

      const title =
        `${metadata?.title || ""} ${metadata?.sourceDocument || ""}`.toLocaleLowerCase(
          "ko-KR"
        );
      const matchRatio = matchedTerms.length / terms.length;
      const textMatchRatio = matchedTextTerms.length / terms.length;
      const titleBonus = matchedTerms.some((term) => title.includes(term))
        ? 0.15
        : 0;
      const score = Math.min(
        0.99,
        0.35 + matchRatio * 0.3 + textMatchRatio * 0.35 + titleBonus
      );
      return {
        metadata,
        score,
        matchedTerms: matchedTerms.length,
        matchedTextTerms: matchedTextTerms.length,
      };
    })
    .filter(
      (item) =>
        item &&
        item.score >= similarityThreshold &&
        !filterIdentifiers.includes(sourceIdentifier(item.metadata))
    )
    .sort(
      (a, b) =>
        b.matchedTextTerms - a.matchedTextTerms ||
        b.matchedTerms - a.matchedTerms ||
        b.score - a.score ||
        (a.metadata?.chunk_index ?? 0) - (b.metadata?.chunk_index ?? 0)
    )
    .slice(0, topN);

  return {
    contextTexts: ranked.map(({ metadata }) => metadata.text),
    sourceDocuments: ranked.map(({ metadata, score }) => ({
      ...metadata,
      score,
    })),
    scores: ranked.map(({ score }) => score),
  };
}

/**
 * [auto-docu v18] Map chunk-level doc_id -> classification tags, for the
 * hybrid rerank's tag boost. A chunk's metadata only carries doc_id (not
 * content_hash), so this joins workspace_documents (docId -> content_hash)
 * with document_classifications (content_hash -> tags, the same tags a
 * reviewer confirms during ingestion). Best-effort: any DB hiccup returns
 * an empty map — the tag boost is an enhancement, never a hard dependency
 * for retrieval to keep working.
 */
async function tagsForDocIds(self, docIds = []) {
  const empty = new Map();
  if (!Array.isArray(docIds) || !docIds.length) return empty;

  try {
    const prisma = require("../../prisma");
    const { safeJsonParse } = require("../../http");
    const documents = await prisma.workspace_documents.findMany({
      where: { docId: { in: docIds } },
      select: { docId: true, metadata: true },
    });

    const hashByDocId = new Map();
    for (const doc of documents) {
      const hash = safeJsonParse(doc.metadata, {})?.content_hash;
      if (hash) hashByDocId.set(doc.docId, hash);
    }
    if (!hashByDocId.size) return empty;

    const classifications = await prisma.document_classifications.findMany({
      where: { contentHash: { in: [...new Set(hashByDocId.values())] } },
      select: { contentHash: true, tags: true },
    });
    const tagsByHash = new Map(
      classifications.map((c) => [c.contentHash, safeJsonParse(c.tags, [])])
    );

    const result = new Map();
    for (const [docId, hash] of hashByDocId)
      result.set(docId, tagsByHash.get(hash) || []);
    return result;
  } catch (err) {
    self.logger(`tagsForDocIds failed: ${err.message}`);
    return empty;
  }
}

/**
 * Performs a SimilaritySearch on a given PGVector namespace.
 * @param {Object} params
 * @param {pgsql.Client} params.client
 * @param {string} params.namespace
 * @param {number[]} params.queryVector
 * @param {number} params.similarityThreshold
 * @param {number} params.topN
 * @param {string[]} params.filterIdentifiers
 * @returns
 */
async function similarityResponse(
  self,
  {
    client,
    namespace,
    queryVector,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
    filterDocIds = null,
  }
) {
  const result = {
    contextTexts: [],
    sourceDocuments: [],
    scores: [],
  };

  await self.configureVectorSearch(client);
  const embedding = `[${queryVector.map(Number).join(",")}]`;
  const docIds =
    Array.isArray(filterDocIds) && filterDocIds.length ? filterDocIds : null;
  const params = [embedding, namespace, topN];
  if (docIds) params.push(docIds);
  const deniedSql = await deniedClause(params);
  const response = await client.query(
    `SELECT embedding ${self.operator.cosine} $1 AS _distance, metadata FROM "${SearchTuning.tableName()}" WHERE namespace = $2 ${
      docIds ? "AND metadata->>'doc_id' = ANY($4::text[])" : ""
    } ${deniedSql} ORDER BY _distance ASC LIMIT $3`,
    params
  );
  response.rows.forEach((item) => {
    const distance = Number(item._distance);
    if (!Number.isFinite(distance)) return;
    const score = self.distanceToSimilarity(distance);
    if (score < similarityThreshold) return;
    if (filterIdentifiers.includes(sourceIdentifier(item.metadata))) {
      self.logger(
        "A source was filtered from context as it's parent document is pinned."
      );
      return;
    }

    result.contextTexts.push(item.metadata.text);
    result.sourceDocuments.push({
      ...item.metadata,
      score,
    });
    result.scores.push(score);
  });

  return result;
}

/** Retrieve a wider dense candidate set, then apply the local multilingual
 * reranker. This mirrors the LanceDB path so changing vector stores does not
 * silently lower Korean retrieval quality.
 */
async function rerankedSimilarityResponse(
  self,
  {
    client,
    namespace,
    query,
    queryVector,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
    filterDocIds = null,
  }
) {
  const totalEmbeddings = await self.namespaceCount(namespace);
  const searchLimit = SearchTuning.rerankCandidateLimit(totalEmbeddings, topN);
  await self.configureVectorSearch(client);
  const embedding = `[${queryVector.map(Number).join(",")}]`;
  const docIds =
    Array.isArray(filterDocIds) && filterDocIds.length ? filterDocIds : null;
  const params = [embedding, namespace, searchLimit];
  if (docIds) params.push(docIds);
  const deniedSql = await deniedClause(params);
  const response = await client.query(
    `SELECT embedding ${self.operator.cosine} $1 AS _distance, metadata FROM "${SearchTuning.tableName()}" WHERE namespace = $2 ${
      docIds ? "AND metadata->>'doc_id' = ANY($4::text[])" : ""
    } ${deniedSql} ORDER BY _distance ASC LIMIT $3`,
    params
  );
  const candidates = response.rows.map((item) => ({
    ...item.metadata,
    _distance: Number(item._distance),
  }));
  const result = { contextTexts: [], sourceDocuments: [], scores: [] };
  const reranker = new NativeEmbeddingReranker();

  try {
    const reranked = await reranker.rerank(query, candidates, { topK: topN });
    for (const item of reranked) {
      if (self.distanceToSimilarity(item._distance) < similarityThreshold)
        continue;
      const { vector: _vector, ...rest } = item;
      if (filterIdentifiers.includes(sourceIdentifier(rest))) {
        self.logger(
          "A source was filtered from context as it's parent document is pinned."
        );
        continue;
      }
      const score =
        item.rerank_score || self.distanceToSimilarity(item._distance);
      result.contextTexts.push(rest.text);
      result.sourceDocuments.push({ ...rest, score });
      result.scores.push(score);
    }
  } catch (err) {
    self.logger("rerankedSimilarityResponse", err.message);
    self.logger("Falling back to dense similarity search.");
    return await self.similarityResponse({
      client,
      namespace,
      queryVector,
      similarityThreshold,
      topN,
      filterIdentifiers,
      filterDocIds,
    });
  }
  return result;
}

/**
 * Expand repeated hits in one top-level section into the section's remaining
 * chunks. Location-aware metadata and chunk_index make this deterministic.
 */
async function expandSections(
  self,
  {
    client,
    namespace,
    result,
    queryYears = new Set(),
    queryCompanies = new Set(),
  }
) {
  const { contextTexts, sourceDocuments, scores } = result;
  if (process.env.SECTION_EXPANSION === "off" || sourceDocuments.length === 0)
    return result;

  const minHits = Number(process.env.SECTION_EXPANSION_MIN_HITS) || 2;
  // [auto-docu v14 P5] budgets raised — a "전부 알려줘" question is answered by
  // one whole 지침 section (판단기준 ≈ 34 chunks / ~34k chars) and the LLM is
  // claudecli (large window). The old 16k cap skipped exactly these sections.
  const sectionMaxChars =
    Number(process.env.SECTION_EXPANSION_SECTION_MAX_CHARS) || 40_000;
  const budgetMax = Number(process.env.SECTION_EXPANSION_BUDGET_CHARS) || 50_000;
  const topSegment = (sectionPath) =>
    String(sectionPath || "")
      .split(">")
      .at(0)
      .trim();
  const rowKey = (docId, value) => JSON.stringify([docId || "", value]);

  const groups = new Map();
  sourceDocuments.forEach((source, index) => {
    const segment = topSegment(source.section_path);
    if (!source.doc_id || !segment) return;
    const key = rowKey(source.doc_id, segment);
    if (!groups.has(key))
      groups.set(key, { docId: source.doc_id, segment, hits: [] });
    groups.get(key).hits.push(index);
  });

  const seen = new Set(
    sourceDocuments.map((source) => rowKey(source.doc_id, source.chunk_index))
  );
  const additions = [];
  let budget = budgetMax;

  for (const group of groups.values()) {
    if (group.hits.length < minHits) continue;
    const groupScore = Math.min(
      ...group.hits.map((index) => scores[index] ?? 0)
    );
    let rows = [];
    try {
      const response = await client.query(
        `SELECT metadata FROM "${SearchTuning.tableName()}" WHERE namespace = $1 AND metadata->>'doc_id' = $2 LIMIT 5000`,
        [namespace, group.docId]
      );
      rows = response.rows.map((row) => row.metadata);
    } catch (err) {
      self.logger(`expandSections: query failed - ${err.message}`);
      continue;
    }

    // [auto-docu 복합질문] 질문에 연도가 있는데 이 문서 제목의 연도와 전혀
    // 겹치지 않으면 확장하지 않는다 — 실측: "2026년" 질문에서 FY2023 정정
    // 보고서의 무관한 절이 라벨링 오류로 61개 청크째 통째로 딸려온 사례.
    if (queryYears.size) {
      const docYears = SearchTuning.docYearTokens(rows[0]?.title);
      if (docYears.size && ![...docYears].some((year) => queryYears.has(year)))
        continue;
    }
    if (queryCompanies.size) {
      const docCompany = SearchTuning.docCompanyTag(rows[0]?.title);
      if (docCompany && !queryCompanies.has(docCompany)) continue;
    }

    const section = rows
      .filter((row) => topSegment(row.section_path) === group.segment)
      .sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
    const sectionChars = section.reduce(
      (total, row) => total + (row.text?.length || 0),
      0
    );
    if (!section.length || sectionChars > sectionMaxChars) continue;

    // 절 라벨링이 잘못 뭉쳐져(예: 무관한 여러 장이 한 top-level segment 아래로
    // 묶임) 글자수 캡은 통과하면서 개수만 폭증하는 경우의 2차 방어선 — 히트
    // 수에 비례한 캡(기본 히트당 10개, 최소 20개)을 넘으면 그만 추가한다.
    const groupCap = Math.max(
      group.hits.length * 10,
      Number(process.env.SECTION_EXPANSION_MAX_GROUP_ADDITIONS) || 20
    );
    let groupAdditions = 0;
    for (const row of section) {
      if (groupAdditions >= groupCap) break;
      const key = rowKey(row.doc_id, row.chunk_index);
      if (seen.has(key)) continue;
      const length = row.text?.length || 0;
      if (length > budget) continue;
      additions.push({ metadata: row, text: row.text, score: groupScore });
      seen.add(key);
      budget -= length;
      groupAdditions += 1;
    }
  }

  // [auto-docu v14 P5] Whole small document: when a document is clearly THE
  // answer (>=minHits chunks retrieved) and the entire document is short, its
  // facts are often spread across several sections (a 유통혁신 report, not a
  // hierarchical 지침) — section-by-section expansion misses them. Pull the
  // whole doc so nothing is dropped.
  const wholeDocMaxChars =
    Number(process.env.SECTION_EXPANSION_WHOLE_DOC_MAX_CHARS) || 28_000;
  const hitsByDoc = new Map();
  sourceDocuments.forEach((source, index) => {
    if (!source.doc_id) return;
    const e = hitsByDoc.get(source.doc_id) || { hits: 0, best: 0 };
    e.hits += 1;
    e.best = Math.max(e.best, scores[index] ?? 0);
    hitsByDoc.set(source.doc_id, e);
  });
  // [auto-docu 초단문서] 짧은 문서(예: 조문 3개짜리 1,485자 고시)는 그 중
  // 단 1개 청크만 히트해도 이미 그 문서 전체가 정답일 확률이 높다 — 실측:
  // franchise-disclosure 질문에서 정답 문서(정보공개서 표준양식 고시)가
  // 청크 1개만 히트해 minHits=2에 막혀 통째로 확장 안 됐고, 그 결과
  // 목적조항(제1조)이 답변에서 빠짐(completeness 0.75). 문서 크기를 먼저
  // 확인해야 하므로, 초단문서 여부는 쿼리 후 판단하고 원래 게이트는
  // "히트 1개 이상 + (minHits 충족 OR 초단문서)"로 완화한다.
  const smallDocMaxChars =
    Number(process.env.SECTION_EXPANSION_SMALL_DOC_MAX_CHARS) || 3_000;
  for (const [docId, e] of hitsByDoc) {
    if (e.hits < 1) continue;
    let rows = [];
    try {
      const response = await client.query(
        `SELECT metadata FROM "${SearchTuning.tableName()}" WHERE namespace = $1 AND metadata->>'doc_id' = $2 LIMIT 5000`,
        [namespace, docId]
      );
      rows = response.rows.map((row) => row.metadata);
    } catch {
      continue;
    }
    const isSmallDoc =
      rows.length > 0 &&
      rows.reduce((t, r) => t + (r.text?.length || 0), 0) <= smallDocMaxChars;
    if (e.hits < minHits && !isSmallDoc) continue;
    // [auto-docu 복합질문] 위 섹션 확장과 같은 연도 게이트 — 실측: 연도가 다른
    // (FY2025 연간) XBRL 문서가 "매출/영업이익" 같은 범용 키워드만으로 히트
    // 조건을 넘겨 통째로(18/18) 덤프된 사례("2026년 반기" 질문).
    if (queryYears.size) {
      const docYears = SearchTuning.docYearTokens(rows[0]?.title);
      if (docYears.size && ![...docYears].some((year) => queryYears.has(year)))
        continue;
    }
    // [auto-docu 복합질문] 회사 게이트 — 실측: 경쟁사 "[BGF리테일][정정]
    // 반기보고서"가 연도(2026)는 겹치는데 회사가 달라 whole-doc 확장에서
    // 22개 청크로 불어난 사례. 하이브리드 리랭크 페널티만으로는 이미
    // otherBudget 안에 들어온 청크를 막지 못하므로 확장 단계에서도 막는다.
    if (queryCompanies.size) {
      const docCompany = SearchTuning.docCompanyTag(rows[0]?.title);
      if (docCompany && !queryCompanies.has(docCompany)) continue;
    }
    const docChars = rows.reduce((t, r) => t + (r.text?.length || 0), 0);
    if (!rows.length) continue;
    if (docChars <= wholeDocMaxChars && docChars <= budget) {
      rows
        .sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0))
        .forEach((row) => {
          const key = rowKey(row.doc_id, row.chunk_index);
          if (seen.has(key)) return;
          additions.push({ metadata: row, text: row.text, score: e.best });
          seen.add(key);
          budget -= row.text?.length || 0;
        });
      continue;
    }

    // [auto-docu 총칙/정의조항] 문서 전체는 whole-doc 확장 캡을 넘길 만큼
    // 크지만(예: 가맹거래법 본문 39,880자), 목적/정의 조항(제1~3조)은
    // 실체 조항과 다른 top-level 절이라 section-group 확장도 못 닿는다.
    // 이미 근거 문서로 확정된 문서(>=minHits)에 한해 정의/목적 조항만
    // 작은 캡을 두고 별도로 끌어온다.
    const frontMatterMaxChars =
      Number(process.env.SECTION_EXPANSION_FRONT_MATTER_MAX_CHARS) || 3_000;
    const frontMatterPattern = /^제[1-3]조\s*\(/;
    const frontMatter = rows
      .filter((row) => frontMatterPattern.test(String(row.text || "").trim()))
      .sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
    let frontMatterAdded = 0;
    for (const row of frontMatter) {
      const key = rowKey(row.doc_id, row.chunk_index);
      if (seen.has(key)) continue;
      const length = row.text?.length || 0;
      if (frontMatterAdded + length > frontMatterMaxChars || length > budget)
        continue;
      additions.push({ metadata: row, text: row.text, score: e.best });
      seen.add(key);
      budget -= length;
      frontMatterAdded += length;
    }
  }

  if (!additions.length) return result;
  self.logger(
    `expandSections: +${additions.length} chunks from ${
      new Set(additions.map((item) => item.metadata.doc_id)).size
    } section(s).`
  );
  const rows = [
    ...sourceDocuments.map((source, index) => ({
      metadata: source,
      text: contextTexts[index],
      score: scores[index] ?? 0,
    })),
    ...additions,
  ];
  const bestByDocument = {};
  for (const row of rows) {
    const docId = row.metadata.doc_id || "";
    bestByDocument[docId] = Math.max(bestByDocument[docId] ?? -Infinity, row.score);
  }
  rows.sort((a, b) => {
    const aDoc = a.metadata.doc_id || "";
    const bDoc = b.metadata.doc_id || "";
    if (aDoc !== bDoc)
      return (bestByDocument[bDoc] ?? 0) - (bestByDocument[aDoc] ?? 0);
    return (a.metadata.chunk_index ?? 0) - (b.metadata.chunk_index ?? 0);
  });

  return {
    contextTexts: rows.map((row) => row.text),
    sourceDocuments: rows.map((row) => ({
      ...row.metadata,
      score: row.score,
    })),
    scores: rows.map((row) => row.score),
  };
}

/** [auto-docu 내부생성자료] Drop every row whose doc_id is in `excludeSet` —
 * used to keep an unapproved auto-archived draft/전사문서작성tool result out
 * of every stage of ranking, not just the final truncation. Pure function:
 * does not depend on the PGVector instance. */
function excludeDocIds(
  { contextTexts = [], sourceDocuments = [], scores = [] },
  excludeSet
) {
  const out = { contextTexts: [], sourceDocuments: [], scores: [] };
  for (let i = 0; i < sourceDocuments.length; i++) {
    if (excludeSet.has(sourceDocuments[i]?.doc_id)) continue;
    out.contextTexts.push(contextTexts[i]);
    out.sourceDocuments.push(sourceDocuments[i]);
    out.scores.push(scores[i]);
  }
  return out;
}

/**
 * Cap chunks per document to keep results spanning the archive — BUT the
 * single top-ranked document is left uncapped (up to `topLimit`). A question
 * like "판단기준을 전부 알려줘" is answered by one document's whole section;
 * capping its best doc to 3 chunks was starving the answer (completeness).
 * Documents #2+ are still capped at `cap`. Pure function: does not depend on
 * the PGVector instance.
 */
function capPerDocument(
  { contextTexts = [], sourceDocuments = [], scores = [] },
  cap,
  topLimit = 40
) {
  const perDoc = new Map();
  const out = { contextTexts: [], sourceDocuments: [], scores: [] };
  let leadKey = null;
  for (let i = 0; i < sourceDocuments.length; i++) {
    const src = sourceDocuments[i] || {};
    const key = src.doc_id || src.title || `_row_${i}`;
    if (leadKey === null) leadKey = key;
    const limit = key === leadKey ? topLimit : cap;
    const seen = perDoc.get(key) || 0;
    if (seen >= limit) continue;
    perDoc.set(key, seen + 1);
    out.contextTexts.push(contextTexts[i]);
    out.sourceDocuments.push(src);
    out.scores.push(scores[i] ?? src.score ?? 0);
  }
  return out;
}

/**
 * Append lexical hits for documents the dense result did not include at all.
 * Dense ordering is untouched; lexical is a recall net, not a re-ranker.
 * Pure function: does not depend on the PGVector instance.
 */
function mergeLexicalAdditions(dense, lexical, topN) {
  if (!lexical?.sourceDocuments?.length) return dense;
  const docKey = (s = {}) => s.doc_id || s.title || "";
  const seenDocs = new Set(dense.sourceDocuments.map(docKey));
  const out = {
    contextTexts: [...dense.contextTexts],
    sourceDocuments: [...dense.sourceDocuments],
    scores: [...dense.scores],
  };
  const room = Math.max(0, topN - out.sourceDocuments.length) + 3;
  let added = 0;
  for (let i = 0; i < lexical.sourceDocuments.length && added < room; i++) {
    const src = lexical.sourceDocuments[i];
    const key = docKey(src);
    if (!key || seenDocs.has(key)) continue;
    out.contextTexts.push(lexical.contextTexts[i]);
    out.sourceDocuments.push(src);
    out.scores.push(src.score ?? 0);
    seenDocs.add(key);
    added++;
  }
  return out;
}

/**
 * [auto-docu v14 P1] Retrieval pipeline — rebuilt from stock AnythingLLM's
 * `embed -> cosine top-N` with the minimum on top:
 *   1. embed the query — a failure is a real fault, surfaced as an abort
 *      message (NOT a silent degrade to keyword-only search)
 *   2. wide dense candidate pull (rank, not threshold, does the work —
 *      multilingual-e5 similarities sit in a compressed high band)
 *   3. per-document cap so results span multiple source documents
 *   4. additive lexical merge — lexical only *adds* documents dense missed,
 *      it never reorders dense results
 *   5. truncate to the workspace topN
 *   6. conservative whole-section expansion (budget-capped, no re-truncate)
 *
 * @param {object} params
 * @param {string[]|null} [params.filterDocIds] - restrict the search to these
 *   doc_ids (the "업무별 뷰" tag filter, resolved by the caller). null = all.
 */
async function performSimilaritySearch(
  self,
  {
    namespace = null,
    input = "",
    LLMConnector = null,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
    filterDocIds = null,
    rerank = false,
  }
) {
  let connection = null;
  if (!namespace || !input || !LLMConnector)
    throw new Error("Invalid request to performSimilaritySearch.");

  try {
    connection = await self.connect();
    const exists = await self.namespaceExists(connection, namespace);
    if (!exists) {
      self.logger(
        `The namespace ${namespace} does not exist or has no vectors. Returning empty results.`
      );
      return { contextTexts: [], sources: [], message: null };
    }

    const docIdFilter =
      Array.isArray(filterDocIds) && filterDocIds.length ? filterDocIds : null;

    // 1. Embed the query. No silent fallback — if this fails the search aborts
    //    with a visible reason so the operator notices a broken embedder.
    let queryVector;
    try {
      queryVector = await LLMConnector.embedTextInput(input);
      if (!Array.isArray(queryVector) || queryVector.length === 0)
        throw new Error("the embedder returned an empty vector");
    } catch (err) {
      self.logger(`Query embedding failed: ${err.message}`);
      return {
        contextTexts: [],
        sources: [],
        message: `검색어 임베딩 생성에 실패했습니다 (${err.message}). 임베딩 모델 상태를 확인하세요.`,
        error: err.message,
        success: false,
      };
    }

    // 2. Wide dense candidate pull.
    const candidateK = Math.min(200, Math.max(Number(topN) * 5, 60));
    let rawDense = rerank
      ? await self.rerankedSimilarityResponse({
          client: connection,
          namespace,
          query: input,
          queryVector,
          similarityThreshold,
          topN,
          filterIdentifiers,
          filterDocIds: docIdFilter,
        })
      : await self.similarityResponse({
          client: connection,
          namespace,
          queryVector,
          similarityThreshold,
          topN: candidateK,
          filterIdentifiers,
          filterDocIds: docIdFilter,
        });

    // [auto-docu 검색 재현율] 질문 용어 확장 — "매출 실적" → +"재무정보 매출액
    // 영업이익 연결". 확장 질문의 후보를 원래 후보에 청크별 최고 점수로 합친다
    // (원 질문의 순위 신호는 유지, 어휘 차이로 후보 풀에서 빠진 표 청크를 구제).
    if (!rerank) {
      const expandedInput = expandQuery(input);
      if (expandedInput) {
        try {
          const expandedVector = await LLMConnector.embedTextInput(expandedInput);
          if (Array.isArray(expandedVector) && expandedVector.length) {
            const expandedDense = await self.similarityResponse({
              client: connection,
              namespace,
              queryVector: expandedVector,
              similarityThreshold,
              topN: candidateK,
              filterIdentifiers,
              filterDocIds: docIdFilter,
            });
            rawDense = mergeDenseCandidates(rawDense, expandedDense);
          }
        } catch (err) {
          self.logger(`Query expansion skipped: ${err.message}`);
        }
      }
    }

    // [auto-docu 내부생성자료] 다운로드 시점에 자동 아카이빙된 초안/전사문서
    // 결과물은, 사람이 분류 검수에서 확정(승인)하기 전까지는 검색에서 아예
    // 빠져야 한다 — 이 목록에 해당하는 문서가 없으면 아무 영향도 없다.
    const {
      resolveUnapprovedGeneratedDocIds,
    } = require("../../classification/generatedDocs");
    // [NEXUS 폴더 잠금] 잠긴 폴더 문서도 같은 집합에 합쳐, SQL 사전 필터를 거친
    // 뒤에도 한 번 더(검색 단계마다) 걸러낸다.
    const deniedByFolder = await FolderAccess.deniedDocIds();
    const unapprovedGenerated = new Set([
      ...(await resolveUnapprovedGeneratedDocIds().catch(() => [])),
      ...deniedByFolder,
    ]);
    const dense = unapprovedGenerated.size
      ? excludeDocIds(rawDense, unapprovedGenerated)
      : rawDense;

    // 2b. Hybrid rerank — blend a modest keyword-overlap and classification
    //    -tag boost into the dense candidate order before capping/truncating.
    //    Keyword overlap rescues chunks (e.g. a contract's item table) that
    //    embed poorly against the query's literal wording; tag overlap
    //    rescues them further using the human-confirmed ingestion tags — a
    //    file tagged "필수품목"/"구입강제" should out-rank generic boilerplate
    //    for a matching question even when raw cosine similarity ranks it
    //    far down the candidate list.
    // 키워드 중첩 점수는 확장 용어("재무정보·매출액·영업이익·연결")까지 포함해
    // 계산한다 — 표 청크는 이 용어를 절 제목/본문에 갖고 있어, 어휘 차이로 밀린
    // 정답 청크가 무관한 청크보다 높은 키워드 점수를 받는다.
    const hybridTerms = SearchTuning.lexicalSearchTerms(
      expandQuery(input) || input
    );
    // [auto-docu 복합질문] 질문에 들어있는 4자리 연도 — 하이브리드 리랭크의
    // 연도 불일치 페널티와 expandSections()의 연도 게이트가 함께 쓴다.
    // hybridTerms(파티클 제거 토큰)에서 뽑으면 "2026년"처럼 한글 조사/단위가
    // 안 떨어져 나간 토큰이 섞여 정규식이 매칭 안 되므로, 원문에 직접 적용.
    const queryYears = SearchTuning.docYearTokens(expandQuery(input) || input);
    // [auto-docu 복합질문] 후보 풀 제목들의 "[회사명]" 태그 중 질문 원문에
    // 그대로 들어있는 것만 추린다 — 이 코퍼스는 회사명을 별도 태그로 분류
    // 하지 않아서(business_unit은 내부 조직 축, 회사 축이 아님), DB 추가
    // 조회 없이 이미 가져온 후보들의 제목 컨벤션에서 역추출한다. 질문이
    // 여러 회사를 실제로 비교하면(둘 다 원문에 들어있음) 페널티가 둘 다에
    // 안 걸려 정상 동작한다.
    const candidateCompanyTags = new Set(
      dense.sourceDocuments
        .map((src) => SearchTuning.docCompanyTag(src.title))
        .filter(Boolean)
    );
    const queryCompanies = new Set(
      [...candidateCompanyTags].filter((c) => input.includes(c))
    );
    let scored = dense;
    if (hybridTerms.length && dense.sourceDocuments.length) {
      const docIds = [
        ...new Set(dense.sourceDocuments.map((src) => src.doc_id).filter(Boolean)),
      ];
      const tagsByDoc = await self.tagsForDocIds(docIds);
      const weights = SearchTuning.hybridWeights();
      const ranked = dense.sourceDocuments
        .map((src, i) => {
          const keywordScore = SearchTuning.termMatchRatio(
            hybridTerms,
            dense.contextTexts[i]
          );
          const tagScore = SearchTuning.termTagOverlap(
            hybridTerms,
            tagsByDoc.get(src.doc_id) || []
          );
          let yearPenalty = 0;
          if (queryYears.size) {
            const docYears = SearchTuning.docYearTokens(src.title);
            if (
              docYears.size &&
              ![...docYears].some((year) => queryYears.has(year))
            )
              yearPenalty = weights.yearMismatchPenalty;
          }
          let companyPenalty = 0;
          if (queryCompanies.size) {
            const docCompany = SearchTuning.docCompanyTag(src.title);
            if (docCompany && !queryCompanies.has(docCompany))
              companyPenalty = weights.companyMismatchPenalty;
          }
          const hybridScore =
            (dense.scores[i] ?? 0) +
            keywordScore * weights.keyword +
            tagScore * weights.tag -
            yearPenalty -
            companyPenalty;
          return { i, hybridScore };
        })
        .sort((a, b) => b.hybridScore - a.hybridScore);
      scored = {
        contextTexts: ranked.map(({ i }) => dense.contextTexts[i]),
        sourceDocuments: ranked.map(({ i }) => dense.sourceDocuments[i]),
        scores: ranked.map(({ i }) => dense.scores[i]),
      };
    }

    // 2c. 연계성(affinity) 가산점 — 지금 상위권인 문서와 역사적으로
    //    자주 "같이 쓰인" 다른 문서를 추가로 밀어올린다(§문서 연계성 학습).
    //    이력이 없으면(occurrences 미달 포함) 0점이라 아무 영향 없음 —
    //    기존 랭킹을 건드리지 않는 안전한 추가 항목.
    const affinityWeight = SearchTuning.hybridWeights().affinity;
    if (affinityWeight > 0 && scored.sourceDocuments.length > 1) {
      const scoredDocIds = scored.sourceDocuments.map((src) => src.doc_id);
      const uniqueDocIds = [...new Set(scoredDocIds.filter(Boolean))];
      if (uniqueDocIds.length > 1) {
        const prisma = require("../../prisma");
        const workspaceRow = await prisma.workspaces
          .findUnique({ where: { slug: namespace }, select: { id: true } })
          .catch(() => null);
        if (workspaceRow?.id) {
          const {
            affinityBoostFor,
          } = require("../../classification/documentAffinity");
          const anchorDocIds = uniqueDocIds.slice(
            0,
            Math.min(3, uniqueDocIds.length)
          );
          const boosts = await affinityBoostFor({
            workspaceId: workspaceRow.id,
            anchorDocIds,
            candidateDocIds: uniqueDocIds,
          }).catch(() => new Map());
          if (boosts.size) {
            const reranked = scored.sourceDocuments
              .map((src, i) => ({
                i,
                score:
                  (scored.scores[i] ?? 0) +
                  (boosts.get(src.doc_id) || 0) * affinityWeight,
              }))
              .sort((a, b) => b.score - a.score);
            scored = {
              contextTexts: reranked.map(({ i }) => scored.contextTexts[i]),
              sourceDocuments: reranked.map(({ i }) => scored.sourceDocuments[i]),
              scores: reranked.map(({ i }) => scored.scores[i]),
            };
          }
        }
      }
    }

    // 3. Per-document cap — keep an answer able to synthesize across the
    //    archive instead of drowning in one file's chunks.
    const perDocCap = Math.max(1, Number(process.env.SEARCH_PER_DOC_CAP) || 3);
    let picked = capPerDocument(scored, perDocCap);

    // 4. Additive lexical merge — recall safety net for exact names/numbers
    //    that embed poorly. Only appends documents dense did not return.
    const rawLexical = await self.lexicalSearchResponse({
      client: connection,
      namespace,
      input,
      similarityThreshold: 0,
      topN: Math.max(Number(topN), 10),
      filterIdentifiers,
      filterDocIds: docIdFilter,
    });
    const lexical = unapprovedGenerated.size
      ? excludeDocIds(rawLexical, unapprovedGenerated)
      : rawLexical;
    picked = mergeLexicalAdditions(picked, lexical, Number(topN));

    // 5. Truncate to the workspace topN — but a document that is clearly
    //    THE answer (the lead document #capPerDocument left uncapped) keeps
    //    every chunk it was allotted; only the OTHER documents' chunks are
    //    trimmed to fit the remaining budget. A flat slice(0, topN) here was
    //    quietly discarding a lead document's own later-ranked-but-still-
    //    correct chunks (e.g. a contract's item table, or any "이 문서 안에
    //    서 ~" question naming a specific file) once earlier chunks from
    //    that SAME document had already filled the topN budget first.
    const leadKey =
      picked.sourceDocuments[0]?.doc_id ||
      picked.sourceDocuments[0]?.title ||
      null;
    const leadIdx = [];
    const otherIdx = [];
    picked.sourceDocuments.forEach((src, i) => {
      const key = src?.doc_id || src?.title || null;
      (leadKey !== null && key === leadKey ? leadIdx : otherIdx).push(i);
    });
    // The lead's allowance is generous (it may legitimately need more than
    // topN chunks — a contract's item table, a whole 지침 section) but is
    // NOT unlimited: a document that dense-matches nearly everything (an
    // embedding-model quirk for a particular phrasing, not a real answer —
    // confirmed to happen for real, not just theoretical) must never be
    // able to crowd out EVERY other candidate, including the lexical
    // merge's exact-name rescues.
    const leadCeiling = Math.max(Number(topN), 30);
    const leadKeep = leadIdx.slice(0, leadCeiling);
    // [auto-docu 검색 재현율] 실측 회귀 — 리드 문서가 topN 이상의 청크를 가져가면
    // (전형적: 30-청크 확장) 다른 모든 문서를 합쳐 "3개" 바닥으로 눌렀다. 정답이
    // 다른 문서(예: XBRL 재무제표, 별도 공시)에 있고 원시 유사도로는 상위권(예:
    // 13위)인데도 그 3자리를 다른 후보들과 다투다 밀려 최종 결과에서 빠지는 걸
    // 확인했다(사업보고서 PDF 대 반기 XBRL 재무제표, "GS리테일 2026년 매출 실적").
    // 바닥을 올려 여러 개의 좋은 비-리드 후보가 함께 생존할 여지를 둔다 — 여전히
    // 상한(SEARCH_OTHER_MAX_SLOTS)으로 컨텍스트가 무한히 커지는 건 막는다.
    // [auto-docu 복합질문] 여러 연도를 명시한 추이/비교 질문("2023~2025년 추이")은
    // 리드 문서(보통 최신 연차보고서) 하나가 leadCeiling(30)까지 차지해버려서
    // otherBudget이 바닥(minOtherSlots)까지 눌리는데, 그 바닥이 8개뿐이면 질문이
    // 언급한 연도마다 있는 보고서/XBRL 문서(연도별로 최대 perDocCap개씩)가 전부
    // 들어갈 자리가 없다 — 실측: "GS리테일 2026년 매출 실적 + 2023~2025년 추이"에서
    // 정답인 2026 반기 XBRL 문서의 청크 3개가 딱 이 컷에 걸려 전부 탈락했다.
    // 연도 하나당 "본문 보고서 + XBRL" 두 종류 문서가 각각 perDocCap까지 살 수
    // 있게 바닥을 올린다(질문이 연도 2개 이상을 언급할 때만 — 일반 질문은 그대로).
    const multiYearFloor =
      queryYears.size > 1 ? queryYears.size * perDocCap * 2 : 0;
    const minOtherSlots = Math.min(
      otherIdx.length,
      Math.max(
        SearchTuning.integerSetting("SEARCH_OTHER_MIN_SLOTS", 8, 0, 200),
        Math.ceil(Number(topN) * 0.3),
        multiYearFloor
      )
    );
    const otherBudget = Math.min(
      Math.max(minOtherSlots, Number(topN) - leadKeep.length),
      SearchTuning.integerSetting("SEARCH_OTHER_MAX_SLOTS", 20, 1, 200)
    );
    const keepIdx = [...leadKeep, ...otherIdx.slice(0, otherBudget)];
    let result = {
      contextTexts: keepIdx.map((i) => picked.contextTexts[i]),
      sourceDocuments: keepIdx.map((i) => picked.sourceDocuments[i]),
      scores: keepIdx.map((i) => picked.scores[i]),
    };

    // 6. Conservative whole-section expansion. Runs on the final set and its
    //    additions are NOT re-truncated (that self-defeat is why sections
    //    never actually expanded before).
    result = await self.expandSections({
      client: connection,
      namespace,
      result,
      queryYears,
      queryCompanies,
    });

    // [NEXUS 폴더 잠금] 마지막 안전망 — 구간 확장 등으로 늘어난 결과까지 포함해
    // 잠긴 폴더 문서가 하나라도 남아 있으면 제거한다.
    if (deniedByFolder.length)
      result = excludeDocIds(result, new Set(deniedByFolder));

    const { contextTexts, sourceDocuments } = result;
    const sources = sourceDocuments.map((metadata, i) => ({
      metadata: { ...metadata, text: contextTexts[i] },
    }));
    return {
      contextTexts,
      sources: self.curateSources(sources),
      message: false,
    };
  } catch (err) {
    self.logger(`Similarity search failed: ${err.message}`);
    return {
      contextTexts: [],
      sources: [],
      message: null,
      error: err.message,
      success: false,
    };
  } finally {
    if (connection) await connection.end();
  }
}

module.exports = {
  lexicalSearchResponse,
  tagsForDocIds,
  similarityResponse,
  rerankedSimilarityResponse,
  expandSections,
  performSimilaritySearch,
};
