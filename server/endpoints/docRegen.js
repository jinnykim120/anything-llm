// [auto-docu 전사문서작성tool] 정기 문서 갱신 작성 — SSE 스트리밍 엔드포인트.
// 절이 많은 문서는 절마다 검색+생성이 필요해 시간이 걸리므로, 절이 끝날
// 때마다 진행 상황을 흘려보낸다(chat의 stream-chat과 같은 패턴).
//
//   POST /workspace/:slug/doc-regen/stream
//   { title, baseDocId, guidanceText }
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { getLLMProvider } = require("../utils/helpers");
const { writeResponseChunk } = require("../utils/helpers/chat/responses");
const { loadBaseDocument, regenerateDocument } = require("../utils/docRegen");

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
        const { title = "", baseDocId, guidanceText = "" } = reqBody(request);
        if (!baseDocId) throw new Error("기준 문서를 선택해 주세요.");
        if (!String(guidanceText).trim())
          throw new Error("신규 기준/가이던스 내용을 입력해 주세요.");

        const workspace = response.locals.workspace;
        const baseDoc = await loadBaseDocument(baseDocId);
        const LLMConnector = getLLMProvider({
          provider: workspace?.chatProvider,
          model: workspace?.chatModel,
        });

        for await (const event of regenerateDocument({
          workspace,
          baseDoc,
          guidanceText: String(guidanceText).trim(),
          LLMConnector,
          title: String(title).trim() || baseDoc.title,
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
}

module.exports = { docRegenEndpoints };
