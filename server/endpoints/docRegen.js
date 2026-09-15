// [auto-docu 전사문서작성tool] 정기 문서 갱신 작성.
//
//   POST /workspace/:slug/doc-regen/stream           { title, baseDocIds|blankForm, guidanceText }
//   POST /workspace/:slug/doc-regen/upload-guidance   multipart: file (+ classification JSON)
//   POST /workspace/:slug/doc-regen/upload-template   multipart: file (+ classification JSON)
//
// stream 은 SSE — 절이 많은 문서는 절마다 검색+생성이 필요해 시간이
// 걸리므로, 절이 끝날 때마다 진행 상황을 흘려보낸다(stream-chat과 같은
// 패턴). baseDocIds(작년 기준 문서)와 blankForm(빈양식) 중 최소 하나는
// 있어야 하고, blankForm이 있으면 그게 구조의 원천으로 우선한다.
//
// upload-guidance/upload-template 둘 다 파일을 그 자리에서 파싱해 아카이브에
// 추가(임베딩)하고, 기준 문서와 같은 분류로 확정해 같은 폴더에 놓는다 — 차이는
// 반환 모양뿐(전자는 guidanceText 텍스트, 후자는 목차 추출용 pageContent+blocks).
const { reqBody, safeJsonParse } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { getLLMProvider } = require("../utils/helpers");
const { writeResponseChunk } = require("../utils/helpers/chat/responses");
const { handleFileUpload } = require("../utils/files/multer");
const {
  parseAndArchiveUpload,
} = require("../utils/files/parseAndArchiveUpload");
const { loadBaseDocuments, regenerateDocument } = require("../utils/docRegen");
const { resolveFolderDocIds } = require("../utils/classification/folderFilter");

function docRegenEndpoints(app) {
  if (!app) return;

  app.post(
    "/workspace/:slug/doc-regen/stream",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders();

      try {
        const {
          title = "",
          baseDocIds,
          blankForm = null,
          guidanceText = "",
          folderKeys = null,
        } = reqBody(request);
        const ids = (
          Array.isArray(baseDocIds) ? baseDocIds : [baseDocIds]
        ).filter(Boolean);
        const hasBlankForm = !!blankForm?.pageContent?.trim();
        if (!ids.length && !hasBlankForm)
          throw new Error("기준 문서를 선택하거나 빈양식을 올려주세요.");
        if (!String(guidanceText).trim())
          throw new Error("신규 기준/가이던스 내용을 입력해 주세요.");

        const workspace = response.locals.workspace;
        // 빈양식이 있으면 그게 구조의 원천이 되므로, 기준 문서는 선택
        // 사항이다 — 골랐어도 목차 추출에는 안 쓰인다(regenerateDocument).
        const baseDocs = ids.length ? await loadBaseDocuments(ids) : [];
        const LLMConnector = getLLMProvider({
          provider: workspace?.chatProvider,
          model: workspace?.chatModel,
        });
        // [auto-docu 전사문서작성tool v2] 사용자가 미리 자료를 모아둔 문서함
        // 폴더가 있으면 그 안에서만 근거를 찾는다 — 실패해도 전체 검색으로
        // 안전하게 이어간다(스코프 필터는 항상 선택 사항).
        const filterDocIds = await resolveFolderDocIds(
          workspace,
          folderKeys
        ).catch(() => null);

        for await (const event of regenerateDocument({
          workspace,
          baseDocs,
          blankForm: hasBlankForm ? blankForm : null,
          guidanceText: String(guidanceText).trim(),
          LLMConnector,
          title: String(title).trim() || baseDocs[0]?.title || blankForm?.title,
          filterDocIds,
        })) {
          writeResponseChunk(response, event);
        }
      } catch (e) {
        console.error("POST /workspace/:slug/doc-regen/stream", e);
        writeResponseChunk(response, { type: "error", error: e.message });
      }
      response.end();
    }
  );

  app.post(
    "/workspace/:slug/doc-regen/upload-guidance",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      validWorkspaceSlug,
      handleFileUpload,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        if (!request.file) throw new Error("업로드된 파일이 없습니다.");
        // multer 특성상 텍스트 필드는 파일 필드보다 앞서 append 돼야
        // request.body에 실린다 — 프론트에서 classification을 file보다
        // 먼저 append하는 이유.
        const { classification: classificationRaw = "{}" } = reqBody(request);
        const { title, pageContent, contentHash } = await parseAndArchiveUpload(
          {
            workspace,
            originalname: request.file.originalname,
            classification: safeJsonParse(classificationRaw, {}),
            userId: response.locals?.user?.id,
          }
        );

        return response
          .status(200)
          .json({ title, guidanceText: pageContent, contentHash });
      } catch (e) {
        console.error("POST /workspace/:slug/doc-regen/upload-guidance", e);
        return response
          .status(500)
          .json({ error: e.message || "파일 업로드 중 오류가 발생했습니다." });
      }
    }
  );

  app.post(
    "/workspace/:slug/doc-regen/upload-template",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      validWorkspaceSlug,
      handleFileUpload,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        if (!request.file) throw new Error("업로드된 파일이 없습니다.");
        const { classification: classificationRaw = "{}" } = reqBody(request);
        const { title, pageContent, blocks, contentHash } =
          await parseAndArchiveUpload({
            workspace,
            originalname: request.file.originalname,
            classification: safeJsonParse(classificationRaw, {}),
            userId: response.locals?.user?.id,
          });

        return response
          .status(200)
          .json({ title, pageContent, blocks, contentHash });
      } catch (e) {
        console.error("POST /workspace/:slug/doc-regen/upload-template", e);
        return response
          .status(500)
          .json({ error: e.message || "파일 업로드 중 오류가 발생했습니다." });
      }
    }
  );
}

module.exports = { docRegenEndpoints };
