// [auto-docu 우선 자료] 스레드에 고정한 "기존 아카이브 문서" 목록 —
// workspace_parsed_files(threadId)가 이미 하는 "새로 올린 파일을 스레드에
// 고정 + 매 답변마다 검색 없이 강제 포함(stream.js)"과 같은 원리를, 이미
// 아카이브에 있는 문서를 고정하는 경우에도 적용한다. 그 파일 쪽 메커니즘을
// 건드리지 않고 옆에 별도 테이블로 둔 이유는 프로젝트 메모(설계 판단)에
// 적어둠 — 기존 스톡 기능(스크랩한 링크 고정)을 건드릴 위험을 피하려는 것.
const prisma = require("../utils/prisma");

const ThreadPrioritySources = {
  add: async function ({ threadId, workspaceId, docId }) {
    try {
      // docId가 이 워크스페이스 소속인지 먼저 확인 — 아니면 다른
      // 워크스페이스의 문서 id를 넣어 몰래 고정시키는 경로가 생긴다.
      const doc = await prisma.workspace_documents.findFirst({
        where: { id: Number(docId), workspaceId: Number(workspaceId) },
        select: { id: true },
      });
      if (!doc) throw new Error("이 워크스페이스의 문서가 아닙니다.");

      const existing = await prisma.thread_priority_sources.findMany({
        where: { threadId: Number(threadId) },
        select: { docId: true },
      });
      const row = await prisma.thread_priority_sources.upsert({
        where: {
          threadId_docId: { threadId: Number(threadId), docId: Number(docId) },
        },
        update: {},
        create: {
          threadId: Number(threadId),
          workspaceId: Number(workspaceId),
          docId: Number(docId),
        },
      });
      // [auto-docu 문서 연계성 학습] 한 스레드에 여러 문서를 동시에 고정한
      // 건 명시적 판단 — 이미 고정돼 있던 문서들과 이번 문서를 짝지어
      // fire-and-forget으로 기록한다.
      const otherIds = existing
        .map((r) => r.docId)
        .filter((id) => id !== Number(docId));
      if (otherIds.length) {
        const {
          recordExplicitCoSelection,
        } = require("../utils/classification/documentAffinity");
        recordExplicitCoSelection({
          workspaceId: Number(workspaceId),
          workspaceDocIds: [Number(docId), ...otherIds],
        }).catch(() => null);
      }
      return { row, error: null };
    } catch (error) {
      console.error("ThreadPrioritySources.add failed:", error.message);
      return { row: null, error: error.message };
    }
  },

  where: async function (clause = {}) {
    try {
      return await prisma.thread_priority_sources.findMany({ where: clause });
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  delete: async function (clause = {}) {
    try {
      const result = await prisma.thread_priority_sources.deleteMany({
        where: clause,
      });
      return result.count > 0;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  /**
   * 스레드에 고정된 문서 목록을, 프론트 칩 목록에 쓸 수 있게 제목까지
   * 붙여서 돌려준다.
   */
  listWithTitles: async function ({ threadId, workspaceId }) {
    const rows = await this.where({
      threadId: Number(threadId),
      workspaceId: Number(workspaceId),
    });
    if (!rows.length) return [];
    const { loadBaseDocument } = require("../utils/docRegen");
    return await Promise.all(
      rows.map(async (row) => {
        const doc = await loadBaseDocument(row.docId).catch(() => null);
        return {
          id: row.id,
          docId: row.docId,
          title: doc?.title || `문서 #${row.docId}`,
        };
      })
    );
  },

  /**
   * stream.js가 매 답변마다 부르는 것 — RAG 없이, 고정된 문서 전문을
   * 그대로 돌려준다(pageContent + citation에 쓸 title). workspace_parsed_files의
   * getContextFiles와 같은 반환 모양({pageContent, ...metadata})을 맞춰서
   * stream.js 쪽 병합 로직을 그대로 재사용할 수 있게 한다.
   * @returns {Promise<Array<{pageContent:string, title:string, docSource:string}>>}
   */
  getContextDocuments: async function (workspace, thread = null) {
    try {
      if (!workspace || !thread) return [];
      const rows = await this.where({
        threadId: Number(thread.id),
        workspaceId: Number(workspace.id),
      });
      if (!rows.length) return [];

      const { loadBaseDocument } = require("../utils/docRegen");
      const docs = await Promise.all(
        rows.map((row) => loadBaseDocument(row.docId).catch(() => null))
      );
      return docs.filter(Boolean).map((doc) => ({
        pageContent: doc.pageContent || "",
        title: doc.title,
        docSource: "이 대화에서 우선 사용 중인 아카이브 문서.",
      }));
    } catch (error) {
      console.error(
        "ThreadPrioritySources.getContextDocuments failed:",
        error.message
      );
      return [];
    }
  },
};

module.exports = { ThreadPrioritySources };
