// [auto-docu 내부생성자료] 초안(§06)·전사문서작성tool(§07) 결과를 다운로드
// 하는 순간, 그 markdown을 아카이브에도 자동으로 넣는다 — "만들어진 자료가
// 다시 양질의 원자재가 되는" 순환. 단, 곧바로 검색에 쓰이면 위험하므로:
//
//   POST /workspace/:slug/archive-generated   multipart: file(.md) + title + kind
//
// - 전용 업무분류("내부생성자료")로 "제안" 상태만 만든다(절대 자동 확정 안 함).
// - 검색 쪼는 쪽(PGVector.performSimilaritySearch)이
//   resolveUnapprovedGeneratedDocIds()로 이 상태의 문서를 항상 제외한다 —
//   분류 검수에서 사람이 "확인"을 눌러야만(=confirmed) 검색에 포함된다.
// - 파일명은 문서 제목 그대로 쓴다(호출부가 이미 그렇게 이름 붙여 보냄).
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { handleFileUpload } = require("../utils/files/multer");
const {
  parseAndArchiveUpload,
} = require("../utils/files/parseAndArchiveUpload");
const { DocumentClassification } = require("../models/documentClassification");
const { buildGeneratedMeta } = require("../utils/classification/generatedMeta");
const {
  GENERATED_WORK_TYPE,
} = require("../utils/classification/generatedDocs");

const DOC_TYPE_BY_KIND = {
  draft: "초안",
  ppt_draft: "PPT 초안(세부 내용)",
  docregen: "전사문서작성tool 결과",
};

function generatedArchiveEndpoints(app) {
  if (!app) return;

  app.post(
    "/workspace/:slug/archive-generated",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceSlug,
      handleFileUpload,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        if (!request.file) throw new Error("업로드된 파일이 없습니다.");
        const { kind = "", sourceDocIds = "" } = reqBody(request);
        const docType = DOC_TYPE_BY_KIND[kind] || "생성문서";

        const { title, contentHash, pageContent } = await parseAndArchiveUpload({
          workspace,
          originalname: request.file.originalname,
          // classification을 안 넘긴다 — 그냥 임베딩만 하고, 분류는 아래에서
          // "제안" 상태로만 직접 만든다(확정 아님 — 검색 게이트가 여길 본다).
          userId: response.locals?.user?.id,
        });

        if (contentHash) {
          // 원본 문서(인용/추가 선택)에서 사업부·분야를 물려받고, 원본 파일명과
          // 핵심 키워드를 태그로 남긴다 — LLM 호출 없음.
          let parsedSources = [];
          try {
            const v = JSON.parse(sourceDocIds || "[]");
            if (Array.isArray(v)) parsedSources = v;
          } catch {}
          const meta = await buildGeneratedMeta({
            workspaceId: workspace.id,
            sourceDocIds: parsedSources,
            docType,
            title,
            markdown: pageContent || "",
          }).catch(() => null);
          await DocumentClassification.upsertProposal({
            contentHash,
            workType: GENERATED_WORK_TYPE,
            docType,
            businessUnit: meta?.businessUnit,
            domain: meta?.domain,
            tags: meta?.tags?.length ? meta.tags : ["AI생성", docType],
            rationale:
              "다운로드 시점에 자동으로 아카이빙된 생성 문서 — 분류 검수에서 확인(승인)해야 검색에 사용됩니다.",
            proposedBy: "system:generated-doc",
            sampleTitle: title,
          });
        }

        return response.status(200).json({ success: true, title, contentHash });
      } catch (e) {
        console.error("POST /workspace/:slug/archive-generated", e);
        return response.status(500).json({
          success: false,
          error: e.message || "아카이빙 중 오류가 발생했습니다.",
        });
      }
    }
  );
}

module.exports = { generatedArchiveEndpoints };
