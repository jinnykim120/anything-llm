// [auto-docu 전사문서작성tool v2] Resolve one or more DocumentRoom folder
// picks ("전체" | "work:<workType>" | "unit:<workType>:<businessUnit>") to a
// doc_id allow-list for retrieval. This is the same shape of problem as
// scopeFilter.js's archive-sidebar scope (전체/실적/법규/대외), but keyed off
// the finer-grained DocumentRoom folder tree (workType → businessUnit)
// instead of the coarse doc_type buckets — for when a user has pre-gathered
// every reference material a drafting task needs into one or more specific
// folders and wants retrieval scoped to just those.
//
// Multiple picks are OR'd together (e.g. a whole workType plus one specific
// unit under a DIFFERENT workType both apply). Picking "전체" (or passing
// nothing) means no filter — search the whole archive.
const prisma = require("../prisma");
const { safeJsonParse } = require("../http");

function parseFolderKey(key) {
  if (key === "전체") return { all: true };
  if (typeof key !== "string") return null;
  if (key.startsWith("unit:")) {
    const [, workType, businessUnit] = key.split(":");
    if (!workType || !businessUnit) return null;
    return { workType, businessUnit };
  }
  if (key.startsWith("work:")) {
    const workType = key.slice("work:".length);
    if (!workType) return null;
    return { workType };
  }
  return null;
}

/**
 * @param {{id:number}} workspace
 * @param {string[]|string|null} folderKeys
 * @returns {Promise<string[]|null>} doc_ids to restrict search to, or null for no filter
 */
async function resolveFolderDocIds(workspace, folderKeys) {
  const keys = (Array.isArray(folderKeys) ? folderKeys : [folderKeys]).filter(
    Boolean
  );
  const picks = keys.map(parseFolderKey).filter(Boolean);
  if (!workspace?.id || !picks.length || picks.some((p) => p.all)) return null;

  const wds = await prisma.workspace_documents
    .findMany({
      where: { workspaceId: workspace.id },
      select: { docId: true, metadata: true },
    })
    .catch(() => []);
  const hashByDocId = new Map();
  for (const wd of wds) {
    const hash = safeJsonParse(wd.metadata, {})?.content_hash;
    if (hash && wd.docId) hashByDocId.set(wd.docId, hash);
  }
  if (!hashByDocId.size) return [];

  const cls = await prisma.document_classifications
    .findMany({
      where: { contentHash: { in: [...new Set(hashByDocId.values())] } },
      select: { contentHash: true, workType: true, businessUnit: true },
    })
    .catch(() => []);
  const clsByHash = new Map(cls.map((c) => [c.contentHash, c]));

  const matches = (workType, businessUnit) =>
    picks.some((pick) =>
      pick.businessUnit
        ? workType === pick.workType && businessUnit === pick.businessUnit
        : workType === pick.workType
    );

  const result = [];
  for (const [docId, hash] of hashByDocId) {
    const c = clsByHash.get(hash);
    const workType = c?.workType?.trim() || "미분류";
    const businessUnit = c?.businessUnit?.trim() || "미분류";
    if (matches(workType, businessUnit)) result.push(docId);
  }
  return result;
}

module.exports = { resolveFolderDocIds, parseFolderKey };
