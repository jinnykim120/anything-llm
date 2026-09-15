// [auto-docu] Shared "upload a file, parse it, embed it into the archive"
// core — used by the 전사문서작성tool guidance/template uploads and by the
// 내부생성자료 auto-archive endpoint. Pulled out of endpoints/docRegen.js so
// a third caller doesn't have to re-duplicate it a third time.
const { CollectorApi } = require("../collectorApi");
const { Document } = require("../../models/documents");
const {
  DocumentClassification,
} = require("../../models/documentClassification");

/**
 * 업로드된 파일을 파싱 → 아카이브에 추가(임베딩) → (classification이 주어졌으면)
 * 그 분류로 즉시 확정. classification을 안 넘기면 확정 단계는 건너뛰고 그냥
 * 임베딩만 한다 — 호출자가 별도로(예: upsertProposal로 "제안" 상태만) 분류를
 * 처리하고 싶을 때를 위해서다.
 * @returns {Promise<{title:string, pageContent:string, blocks:object[], contentHash:string|null, docId:string|null}>}
 */
async function parseAndArchiveUpload({
  workspace,
  originalname,
  classification = null,
  userId = null,
}) {
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

  // 지연 require — utils/files 는 모듈 로드 시점에 NODE_ENV 기준으로
  // 저장 경로를 계산한다(같은 이유의 지연 require가 docRegen/index.js에도 있음).
  const { fileData } = require("./index");
  const doc = await fileData(location);
  if (!doc) throw new Error("업로드한 파일을 읽지 못했습니다.");

  const {
    failedToEmbed = [],
    errors = [],
    embedded = [],
  } = await Document.addDocuments(workspace, [location], userId);
  if (failedToEmbed.length > 0)
    throw new Error(errors.join(" ") || "아카이브에 추가하지 못했습니다.");

  // content_hash 는 addDocuments가 임베딩하면서 계산해 workspace_documents
  // 행의 metadata에 써넣는다(원본 파일 자체는 안 건드림) — 업로드 직후
  // 읽은 doc.content_hash 는 pdf/hwp 외 파일 형식에서 비어 있을 수 있어
  // 여기서 임베딩된 행을 다시 조회해 확실한 값을 가져온다.
  const prisma = require("../prisma");
  const embeddedRow = embedded.length
    ? await prisma.workspace_documents.findFirst({
        where: { workspaceId: workspace.id, docpath: embedded[0] },
      })
    : null;
  const embeddedMeta = embeddedRow
    ? JSON.parse(embeddedRow.metadata || "{}")
    : {};
  const contentHash = embeddedMeta.content_hash || doc.content_hash || null;

  if (contentHash && classification && Object.keys(classification).length > 0) {
    await DocumentClassification.confirm({
      contentHash,
      ...classification,
      userId: userId ?? null,
    });
  }

  let blocks = doc.blocks;
  if (typeof blocks === "string") {
    try {
      blocks = JSON.parse(blocks);
    } catch {
      blocks = [];
    }
  }

  return {
    title: doc.title || originalname,
    pageContent: String(doc.pageContent || ""),
    blocks: Array.isArray(blocks) ? blocks : [],
    contentHash,
    // [auto-docu 빈양식 채우기 2단계] 원본 서식 그대로 다운로드할 때 이
    // docId로 원본 파일(word/document.xml 등)을 다시 찾아간다.
    docId: embeddedRow?.docId || null,
  };
}

module.exports = { parseAndArchiveUpload };
