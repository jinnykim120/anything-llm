// [auto-docu 내부생성자료] AI가 만든 초안/전사문서작성tool 결과물을 다운로드
// 시점에 자동으로 아카이브에 넣을 때 쓰는 전용 분류값 — 검색이 이 값을 보고
// "아직 승인 안 된 생성 자료는 검색에서 제외"하는 좁은 게이트로 쓴다.
//
// 이 파일이 하는 일은 딱 하나: "workType == 내부생성자료 인데 아직 분류가
// confirmed가 아닌 문서"의 doc_id 목록을 돌려주는 것. 다른 모든 문서(일반
// 업로드 등)의 기본 검색 동작(항상 전체 검색, 조건 안 걸면 필터 없음)은 전혀
// 건드리지 않는다 — 이 목록에 없으면 아무 영향이 없다.
const prisma = require("../prisma");
const { safeJsonParse } = require("../http");

const GENERATED_WORK_TYPE = "내부생성자료";

/** @returns {Promise<string[]>} 검색에서 빼야 할 doc_id들. */
async function resolveUnapprovedGeneratedDocIds() {
  const pending = await prisma.document_classifications
    .findMany({
      where: { workType: GENERATED_WORK_TYPE, status: { not: "confirmed" } },
      select: { contentHash: true },
    })
    .catch(() => []);
  if (!pending.length) return [];
  const pendingHashes = new Set(pending.map((c) => c.contentHash));

  const wds = await prisma.workspace_documents
    .findMany({ select: { docId: true, metadata: true } })
    .catch(() => []);
  return wds
    .filter((wd) =>
      pendingHashes.has(safeJsonParse(wd.metadata, {})?.content_hash)
    )
    .map((wd) => wd.docId)
    .filter(Boolean);
}

module.exports = { resolveUnapprovedGeneratedDocIds, GENERATED_WORK_TYPE };
