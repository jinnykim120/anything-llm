const fs = require("fs");
const path = require("path");
const {
  purgeVectorCache,
  purgeSourceDocument,
  normalizePath,
  isWithin,
  documentsPath,
} = require(".");
const { Document } = require("../../models/documents");
const { Workspace } = require("../../models/workspace");

async function purgeDocument(filename = null) {
  if (!filename || !normalizePath(filename)) return;

  await purgeVectorCache(filename);
  await purgeSourceDocument(filename);
  const workspaces = await Workspace.where();
  for (const workspace of workspaces) {
    await Document.removeDocuments(workspace, [filename]);
  }
  return;
}

/**
 * Purge a folder and all its contents. This will also remove all vector-cache files and workspace document associations
 * for the documents within the folder.
 * @notice This function is not recursive. It only purges the contents of the specified folder.
 * @notice You cannot purge the `custom-documents` folder.
 * @param {string} folderName - The name/path of the folder to purge.
 * @returns {Promise<void>}
 */
async function purgeFolder(folderName = null) {
  if (!folderName) return;
  // 한글 폴더 이름은 디스크에는 분해형(NFD), 문서 경로에는 조합형(NFC)으로 저장돼 있을 수
  // 있다 — 눈에는 같아도 문자열 비교로는 다르므로 NFC 로 맞춰 비교하고, 디스크 작업은
  // 디스크에 실제로 있는 이름으로 한다.
  const wanted = normalizePath(folderName).normalize("NFC");
  const onDisk = fs
    .readdirSync(documentsPath)
    .map((folder) => {
      // Filter out any results which are not folders or
      // are the protected custom-documents folder.
      if (folder === "custom-documents") return null;
      const subfolderPath = path.resolve(documentsPath, folder);
      if (!fs.lstatSync(subfolderPath).isDirectory()) return null;
      return folder;
    })
    .filter((subFolder) => !!subFolder)
    .find((folder) => folder.normalize("NFC") === wanted);

  if (!onDisk) return;
  const subFolderPath = path.resolve(documentsPath, onDisk);
  if (!fs.existsSync(subFolderPath) || !isWithin(documentsPath, subFolderPath))
    return;

  // 워크스페이스 문서 연결을 풀 때 docpath 가 조합형/분해형 어느 쪽으로 저장돼 있어도
  // 맞도록 두 표기를 모두 넘긴다.
  const filenames = fs
    .readdirSync(subFolderPath)
    .flatMap((file) => [
      `${wanted}/${file}`,
      `${wanted.normalize("NFD")}/${file}`,
    ])
    .filter((v, i, a) => a.indexOf(v) === i);
  const workspaces = await Workspace.where();

  const purgePromises = [];
  // Remove associated Vector-cache files
  for (const filename of filenames) {
    const rmVectorCache = () =>
      new Promise((resolve) =>
        purgeVectorCache(filename).then(() => resolve(true))
      );
    purgePromises.push(rmVectorCache);
  }

  // Remove workspace document associations
  for (const workspace of workspaces) {
    const rmWorkspaceDoc = () =>
      new Promise((resolve) =>
        Document.removeDocuments(workspace, filenames).then(() => resolve(true))
      );
    purgePromises.push(rmWorkspaceDoc);
  }

  await Promise.all(purgePromises.flat().map((f) => f()));
  fs.rmSync(subFolderPath, { recursive: true }); // Delete target document-folder and source files.

  return;
}

module.exports = {
  purgeDocument,
  purgeFolder,
};
