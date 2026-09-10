// [auto-docu v14 P4] Resolve the archive-sidebar scope filter (전체/실적/법규/대외)
// to a doc_id allow-list for retrieval. The mapping scope -> doc_type lives in
// taxonomy.js; a document's doc_type comes from its classification row (keyed by
// content_hash, so it survives re-ingest and is shared across workspaces).
const prisma = require("../prisma");
const { safeJsonParse } = require("../http");
const { docTypesForScope, canonicalDocType } = require("./taxonomy");

/**
 * @param {{id:number}} workspace
 * @param {string|null} scope - "전체" | "실적" | "법규" | "대외"
 * @returns {Promise<string[]|null>} doc_ids to restrict search to, or null for no filter
 */
async function resolveScopeDocIds(workspace, scope) {
  const docTypes = docTypesForScope(scope);
  if (!docTypes || !workspace?.id) return null;
  const wanted = new Set(docTypes);

  // Match on the canonical doc_type so a classifier synonym (체크리스트→점검표,
  // 지침→행정규칙, …) still lands in the right scope.
  const cls = await prisma.document_classifications
    .findMany({ select: { contentHash: true, docType: true } })
    .catch(() => []);
  const hashes = new Set(
    cls
      .filter((c) => wanted.has(canonicalDocType(c.docType)))
      .map((c) => c.contentHash)
  );
  if (!hashes.size) return []; // scope chosen but nothing is classified into it

  const wds = await prisma.workspace_documents
    .findMany({
      where: { workspaceId: workspace.id },
      select: { docId: true, metadata: true },
    })
    .catch(() => []);
  return wds
    .filter((wd) => hashes.has(safeJsonParse(wd.metadata, {})?.content_hash))
    .map((wd) => wd.docId)
    .filter(Boolean);
}

module.exports = { resolveScopeDocIds };
