// [auto-docu 전사문서작성tool] 정기 문서 갱신 작성.
//
//   POST /workspace/:slug/doc-regen/stream           { title, baseDocIds, guidanceText }
//   POST /workspace/:slug/doc-regen/upload-guidance   multipart: file (+ classification JSON)
//
// stream 은 SSE — 절이 많은 문서는 절마다 검색+생성이 필요해 시간이
// 걸리므로, 절이 끝날 때마다 진행 상황을 흘려보낸다(stream-chat과 같은
// 패턴). upload-guidance 는 "올해 신규 기준" 파일을 업로드하면 그 자리에서
// 파싱해 아카이브에 추가(임베딩)하고, 기준 문서와 같은 분류로 확정해
// 같은 폴더에 놓은 뒤, 읽어낸 본문을 그대로 돌려준다.
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
const { CollectorApi } = require("../utils/collectorApi");
const { Document } = require("../models/documents");
const { DocumentClassification } = require("../models/documentClassification");
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
          guidanceText = "",
          folderKeys = null,
        } = reqBody(request);
        const ids = Array.isArray(baseDocIds) ? baseDocIds : [baseDocIds];
        if (!ids.filter(Boolean).length)
          throw new Error("기준 문서를 선택해 주세요.");
        if (!String(guidanceText).trim())
          throw new Error("신규 기준/가이던스 내용을 입력해 주세요.");

        const workspace = response.locals.workspace;
        const baseDocs = await loadBaseDocuments(ids);
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
          guidanceText: String(guidanceText).trim(),
          LLMConnector,
          title: String(title).trim() || baseDocs[0].title,
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
        const { originalname } = request.file;
        // multer 특성상 텍스트 필드는 파일 필드보다 앞서 append 돼야
        // request.body에 실린다 — 프론트에서 classification을 file보다
        // 먼저 append하는 이유.
        const { classification: classificationRaw = "{}" } = reqBody(request);
        const classification = safeJsonParse(classificationRaw, {});

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
        // 저장 경로를 계산한다(docRegen/index.js와 같은 이유).
        const { fileData } = require("../utils/files");
        const doc = await fileData(location);
        if (!doc) throw new Error("업로드한 파일을 읽지 못했습니다.");

        const {
          failedToEmbed = [],
          errors = [],
          embedded = [],
        } = await Document.addDocuments(
          workspace,
          [location],
          response.locals?.user?.id
        );
        if (failedToEmbed.length > 0)
          throw new Error(
            errors.join(" ") || "아카이브에 추가하지 못했습니다."
          );

        // content_hash 는 addDocuments가 임베딩하면서 계산해 workspace_documents
        // 행의 metadata에 써넣는다(원본 파일 자체는 안 건드림) — 업로드 직후
        // 읽은 doc.content_hash 는 pdf/hwp 외 파일 형식에서 비어 있을 수 있어
        // 여기서 임베딩된 행을 다시 조회해 확실한 값을 가져온다.
        const prisma = require("../utils/prisma");
        const embeddedRow = embedded.length
          ? await prisma.workspace_documents.findFirst({
              where: { workspaceId: workspace.id, docpath: embedded[0] },
            })
          : null;
        const embeddedMeta = embeddedRow
          ? JSON.parse(embeddedRow.metadata || "{}")
          : {};
        const contentHash =
          embeddedMeta.content_hash || doc.content_hash || null;

        // 기준 문서와 같은 분류(같은 폴더)로 바로 확정 — 이미 확정된 분류를
        // 그대로 물려받는 것이므로 검수 대기 없이 곧바로 "confirmed".
        if (
          contentHash &&
          classification &&
          Object.keys(classification).length > 0
        ) {
          await DocumentClassification.confirm({
            contentHash,
            ...classification,
            userId: response.locals?.user?.id ?? null,
          });
        }

        return response.status(200).json({
          title: doc.title || originalname,
          guidanceText: doc.pageContent || "",
          contentHash,
        });
      } catch (e) {
        console.error("POST /workspace/:slug/doc-regen/upload-guidance", e);
        return response
          .status(500)
          .json({ error: e.message || "파일 업로드 중 오류가 발생했습니다." });
      }
    }
  );
}

module.exports = { docRegenEndpoints };
