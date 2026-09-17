// [auto-docu 자료 추출하기] parseAndArchiveUpload.js와 같은 앞부분(collector로
// 파싱)까지만 쓰고, Document.addDocuments()(임베딩/아카이브 등록)는 절대
// 호출하지 않는다 — 이 기능에서 올리는 파일은 "이번 추출 한 번"에만 쓰고
// 버리는 임시 자료이기 때문이다(사용자가 굳이 계속 보관하고 싶으면 기존
// "자료 업로드" 경로로 따로 올리면 됨 — 이 경로는 그 대체가 아니다).
const { CollectorApi } = require("../collectorApi");
const { fileData, purgeSourceDocument } = require("./index");

/**
 * @param {string} originalname - multer(handleFileUpload)가 hotdir에 놓은 파일명
 * @returns {Promise<{title:string, pageContent:string}>}
 */
async function parseUploadEphemeral(originalname) {
  const Collector = new CollectorApi();
  if (!(await Collector.online()))
    throw new Error("문서 처리 서비스가 응답하지 않습니다.");

  const { success, reason, documents } = await Collector.processDocument(
    originalname,
    {}
  );
  if (!success) throw new Error(reason || "파일 처리에 실패했습니다.");

  const location = documents?.[0]?.location;
  if (!location) throw new Error("처리된 문서 위치를 찾지 못했습니다.");

  try {
    const doc = await fileData(location);
    if (!doc) throw new Error("업로드한 파일을 읽지 못했습니다.");
    return {
      title: doc.title || originalname,
      pageContent: doc.pageContent || "",
    };
  } finally {
    // 임베딩(Document.addDocuments)을 거치지 않으므로, collector가 만들어둔
    // 처리 결과 JSON을 우리가 직접 치운다 — 안 그러면 아카이브에 없지만
    // storage/documents/에는 영원히 남는 고아 파일이 된다.
    await purgeSourceDocument(location).catch(() => {});
  }
}

module.exports = { parseUploadEphemeral };
