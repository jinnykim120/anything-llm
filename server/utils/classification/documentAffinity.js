// [auto-docu 문서 연계성 학습] "이 두 문서는 실제로 같이 쓰인다"는 이력을
// 쌓아, PGVector의 하이브리드 랭크(키워드·태그 가산점과 같은 자리)에서
// 이미 상위인 문서와 역사적으로 자주 같이 쓰인 다른 문서를 추가로 밀어올릴
// 때 쓴다. 세 가지 신호를 서로 다른 가중치로 기록한다:
//
//   EXPLICIT (가중치 3) — 사람이 한 화면에서 여러 문서를 직접 동시에 골랐을
//     때(전사문서작성tool 기준문서 다중선택 · 자료 추출하기/통계분석 아카이브
//     선택 · 우선 자료 동시 고정). 우연한 검색 결과가 아니라 사람의 명시적
//     판단이라 가장 신뢰도가 높다.
//   VALIDATED (가중치 2) — 채팅 답변이 여러 문서를 같이 인용했고, 그 답변이
//     실제로 문서 작성 결과물(HTML/DOCX/XLSX/PPTX)로 다운로드까지 이어졌을
//     때만 기록한다. 그냥 인용된 것만으로는 기록하지 않는다 — 탐색적 질문의
//     인용까지 전부 학습하면 우연한 동시-인용이 계속 자기강화되는 문제가
//     생기므로, "실제로 쓸모 있었다고 확인된" 경우만 반영한다(다운로드를
//     확인 신호로 삼자는 판단).
//   IMPLICIT은 두지 않는다 — 위 VALIDATED 원칙과 모순되므로, 단순 공동인용은
//     아예 기록하지 않는다.
//
// 자기강화 편향을 막기 위한 두 가지 안전장치:
//   - 최소 발생 횟수(occurrences) 미만인 쌍은 랭킹에 전혀 반영하지 않는다.
//   - 마지막 관측 이후 경과 시간에 따라 지수적으로 감쇠시킨다(오래된 이력은
//     점점 영향력이 줄어든다).
const prisma = require("../prisma");

const EXPLICIT_WEIGHT = 3;
const VALIDATED_WEIGHT = 2;
const MIN_OCCURRENCES_TO_RANK = 2;
const HALF_LIFE_DAYS = 45; // 이만큼 지나면 가중치가 절반으로 감쇠

function normalizePair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function decayFactor(lastSeenAt) {
  const ageDays = (Date.now() - new Date(lastSeenAt).getTime()) / 86400000;
  return Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);
}

/** 정수 workspace_documents.id 목록을, 랭킹 단계에서 실제로 쓰는 문자열
 * docId(= PGVector 청크의 doc_id)로 변환한다. */
async function resolveDocIdStrings(workspaceDocumentIds = []) {
  const ids = [...new Set(workspaceDocumentIds.map(Number))].filter((n) =>
    Number.isFinite(n)
  );
  if (!ids.length) return [];
  const rows = await prisma.workspace_documents.findMany({
    where: { id: { in: ids } },
    select: { docId: true },
  });
  return rows.map((r) => r.docId).filter(Boolean);
}

/** docIds(문자열, 2개 이상) 사이의 모든 쌍에 weight를 누적 기록한다.
 * @param {{workspaceId:number, docIds:string[], weight:number}} params
 */
async function recordCoUsageByDocIdStrings({
  workspaceId,
  docIds = [],
  weight,
}) {
  const unique = [...new Set(docIds)].filter(Boolean);
  if (!workspaceId || unique.length < 2) return;

  const pairs = [];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      pairs.push(normalizePair(unique[i], unique[j]));
    }
  }

  for (const [docIdA, docIdB] of pairs) {
    await prisma.document_affinity
      .upsert({
        where: {
          workspaceId_docIdA_docIdB: { workspaceId, docIdA, docIdB },
        },
        create: {
          workspaceId,
          docIdA,
          docIdB,
          weight,
          occurrences: 1,
          lastSeenAt: new Date(),
        },
        update: {
          weight: { increment: weight },
          occurrences: { increment: 1 },
          lastSeenAt: new Date(),
        },
      })
      .catch(() => null); // 학습 신호 하나 놓치는 건 치명적이지 않다 — 조용히 넘어간다.
  }
}

/** 명시적 동시선택 — workspace_documents.id(정수) 목록을 그대로 받는다. */
async function recordExplicitCoSelection({ workspaceId, workspaceDocIds }) {
  const docIds = await resolveDocIdStrings(workspaceDocIds).catch(() => []);
  await recordCoUsageByDocIdStrings({
    workspaceId,
    docIds,
    weight: EXPLICIT_WEIGHT,
  });
}

/** 다운로드까지 이어진 채팅 답변의 공동 인용 — 문자열 docId 목록(citation
 * 소스에서 바로 나오는 값)을 받는다. */
async function recordValidatedCitation({ workspaceId, docIds }) {
  await recordCoUsageByDocIdStrings({
    workspaceId,
    docIds,
    weight: VALIDATED_WEIGHT,
  });
}

/** anchorDocIds(이미 랭킹 상위인 문서들)를 기준으로, candidateDocIds 각각에
 * 대한 정규화된(0~1) 친화도 가산점을 돌려준다. 최소 발생 횟수 미달이거나
 * anchor와 아예 이력이 없으면 0.
 * @returns {Promise<Map<string, number>>}
 */
async function affinityBoostFor({
  workspaceId,
  anchorDocIds,
  candidateDocIds,
}) {
  const result = new Map(candidateDocIds.map((id) => [id, 0]));
  const anchors = [...new Set(anchorDocIds)].filter(Boolean);
  const candidates = [...new Set(candidateDocIds)].filter(
    (id) => !anchors.includes(id)
  );
  if (!workspaceId || !anchors.length || !candidates.length) return result;

  // 두 집합 사이에 걸리는 쌍만 조회 — anchor×candidate 전부를 OR로 묶는다.
  const pairFilters = [];
  for (const a of anchors) {
    for (const c of candidates) {
      const [docIdA, docIdB] = normalizePair(a, c);
      pairFilters.push({ docIdA, docIdB });
    }
  }
  if (!pairFilters.length) return result;

  const rows = await prisma.document_affinity
    .findMany({
      where: {
        workspaceId,
        occurrences: { gte: MIN_OCCURRENCES_TO_RANK },
        OR: pairFilters,
      },
    })
    .catch(() => []);

  // 감쇠 적용 후, 후보 문서별로 가장 강한 anchor와의 연계만 취한다(여러
  // anchor와 동시에 연계돼도 합산하지 않음 — 과도한 가중 누적 방지).
  const bestByCandidate = new Map();
  for (const row of rows) {
    const candidate = anchors.includes(row.docIdA) ? row.docIdB : row.docIdA;
    if (!candidates.includes(candidate)) continue;
    const decayed = row.weight * decayFactor(row.lastSeenAt);
    const normalized = Math.min(1, decayed / (EXPLICIT_WEIGHT * 3));
    if (
      !bestByCandidate.has(candidate) ||
      normalized > bestByCandidate.get(candidate)
    )
      bestByCandidate.set(candidate, normalized);
  }
  for (const [docId, score] of bestByCandidate) result.set(docId, score);
  return result;
}

/** 관리자 화면용 — 워크스페이스의 모든 연계 쌍을 weight 내림차순으로 돌려준다
 * (랭킹 반영 여부와 무관하게 전부 보여준다 — 임계치 미달 쌍도 "곧 반영될
 * 후보"로 확인할 수 있어야 한다).
 */
async function listForWorkspace({ workspaceId, limit = 200 }) {
  if (!workspaceId) return [];
  const rows = await prisma.document_affinity
    .findMany({
      where: { workspaceId },
      orderBy: { weight: "desc" },
      take: limit,
    })
    .catch(() => []);
  return rows.map((row) => ({
    ...row,
    decayedWeight: row.weight * decayFactor(row.lastSeenAt),
    belowRankThreshold: row.occurrences < MIN_OCCURRENCES_TO_RANK,
  }));
}

/** 관리자 화면용 — 특정 쌍 한 줄을 지운다. 다른 워크스페이스의 행을 id로
 * 잘못 지우지 못하도록 workspaceId로도 스코프를 건다. */
async function deletePair({ workspaceId, id }) {
  if (!workspaceId || !id) return false;
  return prisma.document_affinity
    .deleteMany({ where: { id: Number(id), workspaceId } })
    .then((r) => r.count > 0)
    .catch(() => false);
}

/** 관리자 화면용 — 워크스페이스의 연계 이력을 전부 초기화한다. */
async function resetForWorkspace({ workspaceId }) {
  if (!workspaceId) return 0;
  return prisma.document_affinity
    .deleteMany({ where: { workspaceId } })
    .then((r) => r.count)
    .catch(() => 0);
}

module.exports = {
  recordExplicitCoSelection,
  recordValidatedCitation,
  affinityBoostFor,
  resolveDocIdStrings,
  listForWorkspace,
  deletePair,
  resetForWorkspace,
  decayFactor,
  EXPLICIT_WEIGHT,
  VALIDATED_WEIGHT,
  MIN_OCCURRENCES_TO_RANK,
};
