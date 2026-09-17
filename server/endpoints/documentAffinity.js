// [auto-docu 문서 연계성 학습] 채팅 답변이 여러 문서를 같이 인용했고, 그
// 결과물이 실제로 다운로드까지 이어졌을 때만 그 문서 쌍을 "검증된 연계"로
// 기록한다 — 단순 공동인용(탐색적 질문 포함)은 기록하지 않는다는 원칙을
// 지키기 위해, 프론트가 다운로드 완료 시점에만 이 엔드포인트를 부른다.
//
//   POST /workspace/:slug/affinity/record-validated   { docIds: string[] }
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const {
  recordValidatedCitation,
} = require("../utils/classification/documentAffinity");

function documentAffinityEndpoints(app) {
  if (!app) return;

  app.post(
    "/workspace/:slug/affinity/record-validated",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const { docIds = [] } = reqBody(request);
        // 응답은 항상 200 — 이 기록은 학습용 부가 신호일 뿐, 실패해도
        // 사용자가 방금 완료한 다운로드에는 영향을 주면 안 된다.
        if (Array.isArray(docIds) && docIds.length > 1) {
          await recordValidatedCitation({
            workspaceId: workspace.id,
            docIds: docIds.filter((id) => typeof id === "string"),
          }).catch(() => null);
        }
        return response.status(200).json({ success: true });
      } catch (e) {
        console.error("POST /workspace/:slug/affinity/record-validated", e);
        return response.status(200).json({ success: false });
      }
    }
  );
}

module.exports = { documentAffinityEndpoints };
