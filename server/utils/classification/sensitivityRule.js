// [NEXUS] 민감도 규칙: 비밀번호로 잠긴 폴더에 있는 문서만 "confidential", 나머지는 전부 "general".
//
// 민감도는 문서가 어느 폴더에 있느냐로 정해진다 — 사람이 문서마다 고르는 값이 아니다.
//   - 새 문서의 AI 제안(upsertProposal)은 이 규칙으로 민감도를 정한다.
//   - 폴더를 잠그거나 잠금을 풀면 그 폴더 문서의 분류도 같이 맞춘다 (syncFolder).
//   - 이미 쌓인 기록은 scripts/apply-sensitivity-rule.js 로 한 번에 맞춘다 (syncAll).
// 사람이 분류 검수에서 직접 확정(confirm)한 값은 그 자리에서는 존중하지만, 다음 syncAll 때는 규칙으로 돌아간다.
const prisma = require("../prisma");
const { safeJsonParse } = require("../http");
const FolderAccess = require("../folderAccess");

const CONFIDENTIAL = "confidential";
const GENERAL = "general";

/** content_hash -> 그 문서가 놓인 폴더들(NFC), 그리고 잠긴 폴더 집합. */
async function loadLayout() {
  const [rows, locks] = await Promise.all([
    prisma.workspace_documents.findMany({
      select: { docpath: true, metadata: true },
    }),
    prisma.folder_locks.findMany({ select: { folder: true } }),
  ]);
  const locked = new Set(
    locks.map((l) => FolderAccess.folderOfDocpath(`${l.folder}/x`))
  );
  const foldersByHash = new Map();
  for (const r of rows) {
    const hash = safeJsonParse(r.metadata, {})?.content_hash;
    if (!hash) continue;
    if (!foldersByHash.has(hash)) foldersByHash.set(hash, new Set());
    foldersByHash.get(hash).add(FolderAccess.folderOfDocpath(r.docpath));
  }
  return { foldersByHash, locked };
}

/** 어느 한 사본이라도 잠긴 폴더에 있으면 confidential, 아니면(문서가 없어도) general. */
function targetFor(folders, locked) {
  if (folders) for (const f of folders) if (locked.has(f)) return CONFIDENTIAL;
  return GENERAL;
}

/** 새 분류 제안이 받을 민감도. */
async function sensitivityForHash(contentHash) {
  const { foldersByHash, locked } = await loadLayout();
  return targetFor(foldersByHash.get(contentHash), locked);
}

/**
 * 모든 분류 기록의 민감도를 규칙에 맞춘다.
 * @param {{dryRun?: boolean}} opts
 * @returns {Promise<{total:number, changed:number, toGeneral:number, toConfidential:number, orphanChanged:number}>}
 */
async function syncAll({ dryRun = false } = {}) {
  const [{ foldersByHash, locked }, rows] = await Promise.all([
    loadLayout(),
    prisma.document_classifications.findMany({
      select: { contentHash: true, sensitivity: true },
    }),
  ]);
  const toGeneral = [];
  const toConfidential = [];
  let orphanChanged = 0;
  for (const r of rows) {
    const target = targetFor(foldersByHash.get(r.contentHash), locked);
    if (r.sensitivity === target) continue;
    (target === GENERAL ? toGeneral : toConfidential).push(r.contentHash);
    if (!foldersByHash.has(r.contentHash)) orphanChanged += 1;
  }
  if (!dryRun) {
    if (toGeneral.length)
      await prisma.document_classifications.updateMany({
        where: { contentHash: { in: toGeneral } },
        data: { sensitivity: GENERAL },
      });
    if (toConfidential.length)
      await prisma.document_classifications.updateMany({
        where: { contentHash: { in: toConfidential } },
        data: { sensitivity: CONFIDENTIAL },
      });
  }
  return {
    total: rows.length,
    changed: toGeneral.length + toConfidential.length,
    toGeneral: toGeneral.length,
    toConfidential: toConfidential.length,
    orphanChanged,
  };
}

/** 폴더를 잠그거나 풀었을 때 그 폴더 문서의 분류를 맞춘다. */
async function syncFolder(folder) {
  const name = FolderAccess.normalizeFolderName(folder);
  if (!name) return { changed: 0 };
  const { foldersByHash, locked } = await loadLayout();
  const inFolder = [...foldersByHash.entries()]
    .filter(([, folders]) => folders.has(name))
    .map(([hash]) => hash);
  if (!inFolder.length) return { changed: 0 };
  const rows = await prisma.document_classifications.findMany({
    where: { contentHash: { in: inFolder } },
    select: { contentHash: true, sensitivity: true },
  });
  let changed = 0;
  for (const r of rows) {
    const target = targetFor(foldersByHash.get(r.contentHash), locked);
    if (r.sensitivity === target) continue;
    await prisma.document_classifications.update({
      where: { contentHash: r.contentHash },
      data: { sensitivity: target },
    });
    changed += 1;
  }
  return { changed };
}

module.exports = {
  CONFIDENTIAL,
  GENERAL,
  targetFor,
  sensitivityForHash,
  syncAll,
  syncFolder,
};
