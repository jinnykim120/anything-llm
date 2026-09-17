// [auto-docu 우선 자료] 스레드에 "기존 아카이브 문서"를 고정한다 — 새로
// 올리는 파일은 이미 있는 POST /workspace/:slug/parse { threadSlug }를
// 그대로 쓰면 된다(그 결과가 이미 매 답변마다 강제 포함+인용까지 됨).
// 이 파일은 그 절반(아카이브에서 고른 기존 문서를 고정하는 경우)만 담당.
//
//   GET    /workspace/:slug/priority-sources?threadSlug=...
//     -> { sources: [{id, docId, title}] }
//   POST   /workspace/:slug/priority-sources   { threadSlug, docId }
//     -> { success, sources }
//   DELETE /workspace/:slug/priority-sources/:id   { threadSlug }
//     -> { success }
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { WorkspaceThread } = require("../models/workspaceThread");
const { ThreadPrioritySources } = require("../models/threadPrioritySources");

async function resolveThread(workspace, threadSlug) {
  if (!threadSlug) throw new Error("threadSlug가 필요합니다.");
  const thread = await WorkspaceThread.get({
    slug: String(threadSlug),
    workspace_id: workspace.id,
  });
  if (!thread) throw new Error("대화(스레드)를 찾을 수 없습니다.");
  return thread;
}

function threadPrioritySourcesEndpoints(app) {
  if (!app) return;

  app.get(
    "/workspace/:slug/priority-sources",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const thread = await resolveThread(workspace, request.query.threadSlug);
        const sources = await ThreadPrioritySources.listWithTitles({
          threadId: thread.id,
          workspaceId: workspace.id,
        });
        return response.status(200).json({ sources });
      } catch (e) {
        console.error("GET /workspace/:slug/priority-sources", e);
        return response.status(400).json({ error: e.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/priority-sources",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const { threadSlug, docId } = reqBody(request);
        if (!docId) throw new Error("docId가 필요합니다.");
        const thread = await resolveThread(workspace, threadSlug);

        const { error } = await ThreadPrioritySources.add({
          threadId: thread.id,
          workspaceId: workspace.id,
          docId,
        });
        if (error) throw new Error(error);

        const sources = await ThreadPrioritySources.listWithTitles({
          threadId: thread.id,
          workspaceId: workspace.id,
        });
        return response.status(200).json({ success: true, sources });
      } catch (e) {
        console.error("POST /workspace/:slug/priority-sources", e);
        return response.status(400).json({ error: e.message });
      }
    }
  );

  app.delete(
    "/workspace/:slug/priority-sources/:id",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const { threadSlug } = reqBody(request);
        const thread = await resolveThread(workspace, threadSlug);

        const success = await ThreadPrioritySources.delete({
          id: Number(request.params.id),
          threadId: thread.id,
          workspaceId: workspace.id,
        });
        return response.status(success ? 200 : 404).json({ success });
      } catch (e) {
        console.error("DELETE /workspace/:slug/priority-sources/:id", e);
        return response.status(400).json({ error: e.message });
      }
    }
  );
}

module.exports = { threadPrioritySourcesEndpoints };
