// [auto-docu 문서 연계성 학습] 채팅 답변이 여러 문서를 같이 인용했고, 그
// 결과물이 실제로 다운로드까지 이어졌을 때만 그 문서 쌍을 "검증된 연계"로
// 기록한다 — 단순 공동인용(탐색적 질문 포함)은 기록하지 않는다는 원칙을
// 지키기 위해, 프론트가 다운로드 완료 시점에만 이 엔드포인트를 부른다.
//
//   POST   /workspace/:slug/affinity/record-validated   { docIds: string[] }
//
// 아래 세 개는 관리자 화면(admin UI)용 — 학습된 연계 이력을 확인/초기화한다.
//   GET    /workspace/:slug/affinity                    -> 목록
//   DELETE /workspace/:slug/affinity/:id                 -> 한 쌍만 삭제
//   DELETE /workspace/:slug/affinity                     -> 전체 초기화
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const prisma = require("../utils/prisma");
const {
  recordValidatedCitation,
  listForWorkspace,
  deletePair,
  resetForWorkspace,
} = require("../utils/classification/documentAffinity");

/** 목록 응답의 docIdA/docIdB(문자열 UUID)를 관리자가 알아볼 수 있는
 * 파일명으로 붙여준다. */
async function attachFilenames(workspaceId, rows) {
  const docIds = [
    ...new Set(rows.flatMap((r) => [r.docIdA, r.docIdB])),
  ].filter(Boolean);
  if (!docIds.length) return rows;

  const docs = await prisma.workspace_documents.findMany({
    where: { workspaceId, docId: { in: docIds } },
    select: { docId: true, filename: true },
  });
  const nameByDocId = new Map(docs.map((d) => [d.docId, d.filename]));
  return rows.map((r) => ({
    ...r,
    filenameA: nameByDocId.get(r.docIdA) || r.docIdA,
    filenameB: nameByDocId.get(r.docIdB) || r.docIdB,
  }));
}

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

  app.get(
    "/workspace/:slug/affinity",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const rows = await listForWorkspace({ workspaceId: workspace.id });
        const pairs = await attachFilenames(workspace.id, rows);
        return response.status(200).json({ success: true, pairs });
      } catch (e) {
        console.error("GET /workspace/:slug/affinity", e);
        return response
          .status(500)
          .json({ success: false, error: "연계 이력을 불러오지 못했습니다." });
      }
    }
  );

  app.delete(
    "/workspace/:slug/affinity/:id",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const removed = await deletePair({
          workspaceId: workspace.id,
          id: request.params.id,
        });
        return response.status(200).json({ success: removed });
      } catch (e) {
        console.error("DELETE /workspace/:slug/affinity/:id", e);
        return response
          .status(500)
          .json({ success: false, error: "삭제하지 못했습니다." });
      }
    }
  );

  app.delete(
    "/workspace/:slug/affinity",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const count = await resetForWorkspace({ workspaceId: workspace.id });
        return response.status(200).json({ success: true, count });
      } catch (e) {
        console.error("DELETE /workspace/:slug/affinity", e);
        return response
          .status(500)
          .json({ success: false, error: "초기화하지 못했습니다." });
      }
    }
  );
}

module.exports = { documentAffinityEndpoints };
