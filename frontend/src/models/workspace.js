import { API_BASE, fullApiUrl } from "@/utils/constants";
import { baseHeaders, safeJsonParse } from "@/utils/request";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import WorkspaceThread from "@/models/workspaceThread";
import { v4 } from "uuid";
import { ABORT_STREAM_EVENT } from "@/utils/chat";

// [auto-docu v14 P4] The archive sidebar's scope filter is a per-viewer
// localStorage value; "전체"/absent = no filter.
function safeGetArchiveScope() {
  try {
    const s = localStorage.getItem("archive-scope");
    return s && s !== "전체" ? s : null;
  } catch {
    return null;
  }
}

// [auto-docu 내부생성자료] 저장 파일명으로 쓰기 위해 문서 제목에서 파일시스템
// 이 못 받는 문자(윈도우 금지문자 + 제어문자)만 제거한다 — 확장자는 호출부가
// 붙인다. 정규식에 제어문자 범위를 직접 넣으면 lint(no-control-regex)에
// 걸려서 문자 단위로 걸러낸다.
function sanitizeFilename(title = "") {
  const illegal = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  let cleaned = "";
  for (const ch of String(title || "")) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || illegal.has(ch)) {
      cleaned += " ";
    } else {
      cleaned += ch;
    }
  }
  return cleaned.replace(/\s+/g, " ").trim().slice(0, 120);
}

const Workspace = {
  workspaceOrderStorageKey: "anythingllm-workspace-order",
  /** The maximum percentage of the context window that can be used for attachments */
  maxContextWindowLimit: 0.8,

  new: async function (data = {}) {
    const { workspace, message } = await fetch(`${API_BASE}/workspace/new`, {
      method: "POST",
      body: JSON.stringify(data),
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => {
        return { workspace: null, message: e.message };
      });

    return { workspace, message };
  },
  update: async function (slug, data = {}) {
    const { workspace, message } = await fetch(
      `${API_BASE}/workspace/${slug}/update`,
      {
        method: "POST",
        body: JSON.stringify(data),
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch((e) => {
        return { workspace: null, message: e.message };
      });

    return { workspace, message };
  },
  modifyEmbeddings: async function (slug, changes = {}) {
    const { workspace, message } = await fetch(
      `${API_BASE}/workspace/${slug}/update-embeddings`,
      {
        method: "POST",
        body: JSON.stringify(changes), // contains 'adds' and 'removes' keys that are arrays of filepaths
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch((e) => {
        return { workspace: null, message: e.message };
      });

    return { workspace, message };
  },
  removeQueuedEmbedding: async function (slug, filename) {
    return fetch(`${API_BASE}/workspace/${slug}/embed-queue`, {
      method: "DELETE",
      body: JSON.stringify({ filename }),
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch(() => ({ success: false }));
  },
  chatHistory: async function (slug) {
    const history = await fetch(`${API_BASE}/workspace/${slug}/chats`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((res) => res.history || [])
      .catch(() => []);
    return history;
  },
  /**
   * Export a workspace or thread's chat as a server-generated branded PDF.
   * @param {string} slug - Workspace slug
   * @param {string|null} threadSlug - Thread slug, or null for the default workspace chat
   * @returns {Promise<Blob|null>} The PDF blob, or null on failure
   */
  exportChatsToType: async function (slug, threadSlug = null, type = "pdf") {
    return await fetch(`${API_BASE}/export-chat/${type}`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ workspaceSlug: slug, threadSlug }),
    })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to export chat.");
        return res.blob();
      })
      .catch(() => null);
  },
  updateChatFeedback: async function (chatId, slug, feedback) {
    const result = await fetch(
      `${API_BASE}/workspace/${slug}/chat-feedback/${chatId}`,
      {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ feedback }),
      }
    )
      .then((res) => res.ok)
      .catch(() => false);
    return result;
  },

  deleteChats: async function (slug = "", chatIds = []) {
    return await fetch(`${API_BASE}/workspace/${slug}/delete-chats`, {
      method: "DELETE",
      headers: baseHeaders(),
      body: JSON.stringify({ chatIds }),
    })
      .then((res) => {
        if (res.ok) return true;
        throw new Error("Failed to delete chats.");
      })
      .catch((e) => {
        console.log(e);
        return false;
      });
  },
  deleteEditedChats: async function (slug = "", threadSlug = "", startingId) {
    if (!!threadSlug)
      return this.threads._deleteEditedChats(slug, threadSlug, startingId);
    return this._deleteEditedChats(slug, startingId);
  },
  updateChat: async function (
    slug = "",
    threadSlug = "",
    chatId,
    newText,
    role = "assistant"
  ) {
    if (!!threadSlug)
      return this.threads._updateChat(slug, threadSlug, chatId, newText, role);
    return this._updateChat(slug, chatId, newText, role);
  },
  multiplexStream: async function ({
    workspaceSlug,
    threadSlug = null,
    prompt,
    chatHandler,
    attachments = [],
    webSearch = false,
  }) {
    if (!!threadSlug)
      return this.threads.streamChat(
        { workspaceSlug, threadSlug },
        prompt,
        chatHandler,
        attachments,
        webSearch
      );
    return this.streamChat(
      { slug: workspaceSlug },
      prompt,
      chatHandler,
      attachments,
      webSearch
    );
  },
  streamChat: async function (
    { slug },
    message,
    handleChat,
    attachments = [],
    webSearch = false
  ) {
    const ctrl = new AbortController();

    // Listen for the ABORT_STREAM_EVENT key to be emitted by the client
    // to early abort the streaming response. On abort we send a special `stopGeneration`
    // event to be handled which resets the UI for us to be able to send another message.
    // The backend response abort handling is done in each LLM's handleStreamResponse.
    const onAbortStream = () => {
      ctrl.abort();
      handleChat({ id: v4(), type: "stopGeneration" });
    };
    window.addEventListener(ABORT_STREAM_EVENT, onAbortStream);

    try {
      await fetchEventSource(`${API_BASE}/workspace/${slug}/stream-chat`, {
        method: "POST",
        // [auto-docu v14 P4] archive sidebar scope filter (전체/실적/법규/대외)
        // [auto-docu 외부검색] per-message "내부+외부 자료" toggle
        body: JSON.stringify({
          message,
          attachments,
          scope: safeGetArchiveScope(),
          webSearch,
        }),
        headers: baseHeaders(),
        signal: ctrl.signal,
        openWhenHidden: true,
        async onopen(response) {
          if (response.ok) {
            return; // everything's good
          } else if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 429
          ) {
            handleChat({
              id: v4(),
              type: "abort",
              textResponse: null,
              sources: [],
              close: true,
              error: `An error occurred while streaming response. Code ${response.status}`,
            });
            ctrl.abort();
            throw new Error("Invalid Status code response.");
          } else {
            handleChat({
              id: v4(),
              type: "abort",
              textResponse: null,
              sources: [],
              close: true,
              error: `An error occurred while streaming response. Unknown Error.`,
            });
            ctrl.abort();
            throw new Error("Unknown error");
          }
        },
        async onmessage(msg) {
          const chatResult = safeJsonParse(msg.data, null);
          if (chatResult) handleChat(chatResult);
        },
        onerror(err) {
          handleChat({
            id: v4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: `An error occurred while streaming response. ${err.message}`,
          });
          ctrl.abort();
          throw new Error();
        },
      });
    } finally {
      window.removeEventListener(ABORT_STREAM_EVENT, onAbortStream);
    }
  },
  all: async function () {
    const workspaces = await fetch(`${API_BASE}/workspaces`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((res) => res.workspaces || [])
      .catch(() => []);

    return workspaces;
  },
  bySlug: async function (slug = "") {
    const workspace = await fetch(`${API_BASE}/workspace/${slug}`, {
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((res) => res.workspace)
      .catch(() => null);
    return workspace;
  },
  delete: async function (slug) {
    const result = await fetch(`${API_BASE}/workspace/${slug}`, {
      method: "DELETE",
      headers: baseHeaders(),
    })
      .then((res) => res.ok)
      .catch(() => false);

    return result;
  },
  wipeVectorDb: async function (slug) {
    return await fetch(`${API_BASE}/workspace/${slug}/reset-vector-db`, {
      method: "DELETE",
      headers: baseHeaders(),
    })
      .then((res) => res.ok)
      .catch(() => false);
  },
  // [auto-docu 목표 3] Generate a document draft from a chat answer.
  // dataScope: "answer_only" | "answer_plus_web" — 답변만 근거로 할지, 최신
  // 외부 검색 자료로 보강할지. reportType: "basic" | "analysis" — 내용을
  // 정리만 할지, 시사점/동향·리스크 같은 분석 절을 덧붙일지.
  generateDraft: async function (
    slug,
    {
      sourceText,
      citations = [],
      dataScope,
      reportType,
      instructions = "",
      archiveDocIds = [],
    }
  ) {
    return await fetch(`${API_BASE}/workspace/${slug}/draft`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        sourceText,
        citations,
        dataScope,
        reportType,
        instructions,
        archiveDocIds,
      }),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },
  // [auto-docu 화면 편집 Phase 3a] 미리보기에서 클릭한 블록 하나만 대화로
  // 스코프 잡아 다시 쓴다 — 문서 전체를 재생성하지 않는다.
  reviseDraftBlock: async function (
    slug,
    { blockMarkdown, instruction, surroundingContext = "" }
  ) {
    return await fetch(`${API_BASE}/workspace/${slug}/draft/revise-block`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ blockMarkdown, instruction, surroundingContext }),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },
  // [auto-docu 통계분석] HTML/문서 초안 전용 — 실제 scikit-learn/statsmodels
  // 계산을 거친 서술을 받는다. method가 없거나 "auto"면 서버가 목적에 맞는
  // 방법을 골라 result.method로 알려준다. reviseDraftBlock과 같은 모양
  // ({revised})으로 와서 같은 블록 패치 흐름을 그대로 재사용할 수 있다.
  runStatsAnalysis: async function (
    slug,
    {
      instruction,
      method = null,
      sourceText,
      surroundingContext = "",
      uploadedData = null,
      archiveDocIds = [],
    }
  ) {
    return await fetch(`${API_BASE}/workspace/${slug}/stats/analyze`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        instruction,
        method,
        sourceText,
        surroundingContext,
        uploadedData,
        archiveDocIds,
      }),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },
  // [auto-docu 우선 자료] 이미 아카이브에 있는 문서를 이 스레드에 고정 —
  // 새로 올리는 파일은 기존 parseFile({threadSlug})로 이미 스레드에
  // 고정되므로(그 결과가 매 답변마다 강제 포함됨), 이 3개는 "이미 아카이브에
  // 있는 문서를 고정"하는 절반만 담당한다.
  listPrioritySources: async function (slug, threadSlug) {
    const url = new URL(`${fullApiUrl()}/workspace/${slug}/priority-sources`);
    if (threadSlug) url.searchParams.set("threadSlug", threadSlug);
    return await fetch(url, { method: "GET", headers: baseHeaders() })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },
  addPrioritySource: async function (slug, { threadSlug, docId }) {
    return await fetch(`${API_BASE}/workspace/${slug}/priority-sources`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ threadSlug, docId }),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },
  removePrioritySource: async function (slug, { threadSlug, id }) {
    return await fetch(`${API_BASE}/workspace/${slug}/priority-sources/${id}`, {
      method: "DELETE",
      headers: baseHeaders(),
      body: JSON.stringify({ threadSlug }),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },
  // [auto-docu 자료 추출하기] 파일 하나를 그 자리에서 파싱만 하고(아카이브에
  // 저장하지 않음) 본문을 돌려준다 — 이번 추출 1회용 임시 자료.
  uploadExtractFile: async function (slug, file) {
    const fd = new FormData();
    fd.append("file", file);
    return await fetch(`${API_BASE}/workspace/${slug}/extract-data/upload`, {
      method: "POST",
      body: fd,
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },
  // [auto-docu 자료 추출하기] 업로드된 자료/아카이브에서 고른 폴더를
  // RAG 없이 전부(exhaustive) 훑어 요청한 항목을 뽑는다.
  // [auto-docu 호출량] 실행 전에 최대 LLM 호출 횟수를 미리 계산해 받는다.
  estimateExtract: async function (
    slug,
    { folderKeys = [], archiveDocIds = [], uploadedChars = [] }
  ) {
    return await fetch(`${API_BASE}/workspace/${slug}/extract-data/estimate`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ folderKeys, archiveDocIds, uploadedChars }),
    })
      .then((res) => res.json())
      .catch(() => null);
  },
  runExtractData: async function (
    slug,
    { fields, uploadedDocs = [], folderKeys = [], archiveDocIds = [] }
  ) {
    return await fetch(`${API_BASE}/workspace/${slug}/extract-data/run`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        fields,
        uploadedDocs,
        folderKeys,
        archiveDocIds,
      }),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },
  // [auto-docu 전사문서작성tool] 정기 문서 갱신 작성 — 작년(기준) 문서 +
  // 신규 기준/가이던스로 절별 재작성을 스트리밍한다. onEvent(evt)는
  // {type: "outline_start"|"outline"|"plan"|"section_start"|"section_done"|"done"|"error", ...}
  // 형태의 이벤트를 절이 끝날 때마다 받는다. 반환된 controller.abort()로
  // 화면을 나갈 때 스트림을 중단할 수 있다.
  docRegenStream: function (
    slug,
    { title, baseDocIds, blankForm, guidanceText, folderKeys },
    onEvent
  ) {
    const ctrl = new AbortController();
    const run = fetchEventSource(
      `${API_BASE}/workspace/${slug}/doc-regen/stream`,
      {
        method: "POST",
        body: JSON.stringify({
          title,
          baseDocIds,
          blankForm,
          guidanceText,
          folderKeys,
        }),
        headers: baseHeaders(),
        signal: ctrl.signal,
        openWhenHidden: true,
        async onopen(response) {
          if (!response.ok)
            throw new Error(
              `문서 생성 요청이 실패했습니다 (${response.status}).`
            );
        },
        async onmessage(msg) {
          const event = safeJsonParse(msg.data, null);
          if (event) onEvent(event);
        },
        onerror(err) {
          onEvent({
            type: "error",
            error: err.message || "연결이 끊겼습니다.",
          });
          ctrl.abort();
          throw err;
        },
      }
    ).catch((err) => {
      if (err?.name !== "AbortError")
        onEvent({ type: "error", error: err.message || "알 수 없는 오류" });
    });
    return { controller: ctrl, done: run };
  },
  // [auto-docu 전사문서작성tool] 올해 신규 기준/가이던스 파일을 업로드 —
  // 그 자리에서 파싱해 아카이브에 추가(임베딩)하고, 기준 문서와 같은
  // 분류(classification)로 확정해 같은 폴더에 놓은 뒤, 읽어낸 본문을
  // 그대로 돌려준다. classification 필드는 파일보다 먼저 append해야
  // multer가 request.body에 실어준다.
  docRegenUploadGuidance: async function (slug, file, classification = {}) {
    const fd = new FormData();
    fd.append("classification", JSON.stringify(classification || {}));
    fd.append("file", file);
    return await fetch(
      `${API_BASE}/workspace/${slug}/doc-regen/upload-guidance`,
      {
        method: "POST",
        body: fd,
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },
  // [auto-docu 전사문서작성tool v2] 빈양식 파일을 업로드 — upload-guidance와
  // 같은 방식으로 그 자리에서 파싱해 아카이브에 추가하지만, 반환값은
  // {title, pageContent, blocks, contentHash} — 목차 추출(regenerateDocument의
  // blankForm)에 그대로 쓸 수 있는 모양이다.
  docRegenUploadTemplate: async function (slug, file, classification = {}) {
    const fd = new FormData();
    fd.append("classification", JSON.stringify(classification || {}));
    fd.append("file", file);
    return await fetch(
      `${API_BASE}/workspace/${slug}/doc-regen/upload-template`,
      {
        method: "POST",
        body: fd,
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },
  // [auto-docu 내부생성자료] 초안(§06)/전사문서작성tool(§07) 결과를 다운로드
  // 하는 순간 markdown을 아카이브에도 같이 넣는다 — "내부생성자료" 폴더로
  // "제안" 상태만 만들고 절대 자동 확정하지 않는다(분류 검수에서 확인해야
  // 검색에 쓰임). 다운로드 자체를 막지 않는 백그라운드 동작이라 실패해도
  // 조용히 넘어간다 — 호출부에서 await 없이 fire-and-forget으로 쓴다.
  archiveGenerated: async function (slug, { title, markdown, kind }) {
    try {
      const filename = `${sanitizeFilename(title) || "생성문서"}.md`;
      const fd = new FormData();
      fd.append("kind", kind || "");
      fd.append(
        "file",
        new Blob([markdown || ""], { type: "text/markdown" }),
        filename
      );
      const res = await fetch(
        `${API_BASE}/workspace/${slug}/archive-generated`,
        { method: "POST", body: fd, headers: baseHeaders() }
      );
      return await res.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  // [auto-docu 문서 연계성 학습] 채팅 답변이 여러 문서를 같이 인용했고, 그
  // 결과물이 실제로 다운로드까지 이어졌을 때만 부른다 — 단순 인용만으로는
  // 절대 호출하지 않는다(자기강화 편향 방지). 실패해도 조용히 넘어간다.
  recordValidatedAffinity: async function (slug, { docIds }) {
    try {
      await fetch(`${API_BASE}/workspace/${slug}/affinity/record-validated`, {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ docIds }),
      });
    } catch {
      // 부가 신호일 뿐 — 실패해도 사용자에게 보여줄 필요 없음.
    }
  },
  // [auto-docu 문서 연계성 학습 admin] 학습된 연계 이력을 확인/초기화하는
  // 관리자 화면용 — 조회·삭제 전부 admin/manager 권한이 필요하다(서버에서
  // 강제).
  listAffinity: async function (slug) {
    try {
      const res = await fetch(`${API_BASE}/workspace/${slug}/affinity`, {
        method: "GET",
        headers: baseHeaders(),
      });
      const data = await res.json();
      return { pairs: data?.pairs || [], error: data?.error };
    } catch (e) {
      return { pairs: [], error: e.message };
    }
  },
  deleteAffinityPair: async function (slug, id) {
    try {
      const res = await fetch(`${API_BASE}/workspace/${slug}/affinity/${id}`, {
        method: "DELETE",
        headers: baseHeaders(),
      });
      return await res.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  resetAffinity: async function (slug) {
    try {
      const res = await fetch(`${API_BASE}/workspace/${slug}/affinity`, {
        method: "DELETE",
        headers: baseHeaders(),
      });
      return await res.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  // [auto-docu 다른 파일 형태 다운로드] 초안/전사문서작성tool 결과를 HTML
  // 대신 실제 .docx 파일로 — 서버가 markdown을 진짜 워드 문서로 변환해
  // 바이너리로 돌려주고, 여기서 HTML 다운로드와 같은 방식(Blob + 임시
  // <a download>)으로 저장한다. 워크스페이스와 무관한 순수 변환이라 slug가
  // 필요 없다.
  downloadAsDocx: async function ({ title, markdown }) {
    const res = await fetch(`${API_BASE}/doc-export/docx`, {
      method: "POST",
      body: JSON.stringify({ title, markdown }),
      headers: baseHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return {
        success: false,
        error: body?.error || "DOCX 변환에 실패했습니다.",
      };
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizeFilename(title) || "문서"}.docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { success: true };
  },
  // [auto-docu XLSX 내보내기] downloadAsDocx와 같은 방식 — markdown 속 표를
  // 실제 엑셀 셀로 변환해 받는다. 자료 추출하기의 "문서 × 필드" 표처럼
  // 수치를 그대로 엑셀에서 다시 다루고 싶을 때가 핵심 용도.
  downloadAsXlsx: async function ({ title, markdown, extraSheets = [] }) {
    const res = await fetch(`${API_BASE}/doc-export/xlsx`, {
      method: "POST",
      body: JSON.stringify({ title, markdown, extraSheets }),
      headers: baseHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return {
        success: false,
        error: body?.error || "XLSX 변환에 실패했습니다.",
      };
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizeFilename(title) || "문서"}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { success: true };
  },
  // [auto-docu PPT 생성 Phase 1] 답변 내용을 근거로 PPT 슬라이드 스펙(JSON)을
  // 생성한다. purpose: "analysis"|"proposal"|"performance"|"status"|"data".
  generatePptDraft: async function (
    slug,
    {
      sourceText,
      citations = [],
      purpose,
      slideCount = 8,
      instructions = "",
      archiveDocIds = [],
    }
  ) {
    return await fetch(`${API_BASE}/workspace/${slug}/ppt-draft`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        sourceText,
        citations,
        purpose,
        slideCount,
        instructions,
        archiveDocIds,
      }),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },
  // [auto-docu PPT 생성 Phase 2] 지정한 문서함 폴더의 자료를 근거로 PPT
  // 슬라이드 스펙을 생성한다 — generatePptDraft와 같은 반환 모양이지만
  // 근거는 채팅 답변 대신 folderKeys로 지정한 문서함 폴더에서 가져온다.
  generateFolderPptDraft: async function (
    slug,
    { folderKeys = [], purpose, slideCount = 8, instructions = "", title = "" }
  ) {
    return await fetch(`${API_BASE}/workspace/${slug}/doc-regen/ppt-draft`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        folderKeys,
        purpose,
        slideCount,
        instructions,
        title,
      }),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },
  // [auto-docu PPT 생성 Phase 1] 슬라이드 스펙을 실제 .pptx 파일로 내려받는다
  // — downloadAsDocx와 같은 방식(Blob + 임시 <a download>).
  downloadAsPptx: async function ({ slideSpec }) {
    const res = await fetch(`${API_BASE}/doc-export/pptx`, {
      method: "POST",
      body: JSON.stringify({ slideSpec }),
      headers: baseHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return {
        success: false,
        error: body?.error || "PPTX 변환에 실패했습니다.",
      };
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizeFilename(slideSpec?.title) || "프레젠테이션"}.pptx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { success: true };
  },
  // [auto-docu 빈양식 채우기 2단계] 원본 서식(.docx)에 채워진 절 내용을
  // 그대로 삽입해 다시 내려받는다 — DOCX만 가능(HWP는 지원 안 함, 서버가
  // 명확한 에러로 알려준다).
  downloadFilledTemplate: async function (slug, { docId, sections, title }) {
    const res = await fetch(
      `${API_BASE}/workspace/${slug}/doc-regen/download-filled-template`,
      {
        method: "POST",
        body: JSON.stringify({ docId, sections }),
        headers: baseHeaders(),
      }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return {
        success: false,
        error: body?.error || "원본 서식 채우기에 실패했습니다.",
      };
    }
    const inserted = res.headers.get("X-Fill-Inserted");
    const total = res.headers.get("X-Fill-Total");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizeFilename(title) || "빈양식"}(채움).docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { success: true, inserted: Number(inserted), total: Number(total) };
  },
  uploadFile: async function (slug, formData) {
    const response = await fetch(`${API_BASE}/workspace/${slug}/upload`, {
      method: "POST",
      body: formData,
      headers: baseHeaders(),
    });

    const data = await response.json();
    return { response, data };
  },
  deleteDocuments: async function (slug, documentLocations = []) {
    return await fetch(
      `${API_BASE}/workspace/${slug}/remove-and-unembed-bulk`,
      {
        method: "DELETE",
        body: JSON.stringify({ documentLocations }),
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },
  parseFile: async function (slug, formData) {
    const response = await fetch(`${API_BASE}/workspace/${slug}/parse`, {
      method: "POST",
      body: formData,
      headers: baseHeaders(),
    });

    const data = await response.json();
    return { response, data };
  },

  getParsedFiles: async function (slug, threadSlug = null) {
    const basePath = new URL(`${fullApiUrl()}/workspace/${slug}/parsed-files`);
    if (threadSlug) basePath.searchParams.set("threadSlug", threadSlug);
    const response = await fetch(basePath, {
      method: "GET",
      headers: baseHeaders(),
    });

    const data = await response.json();
    return data;
  },
  uploadLink: async function (slug, link) {
    const response = await fetch(`${API_BASE}/workspace/${slug}/upload-link`, {
      method: "POST",
      body: JSON.stringify({ link }),
      headers: baseHeaders(),
    });

    const data = await response.json();
    return { response, data };
  },

  getSuggestedMessages: async function (slug) {
    return await fetch(`${API_BASE}/workspace/${slug}/suggested-messages`, {
      method: "GET",
      cache: "no-cache",
      headers: baseHeaders(),
    })
      .then((res) => {
        if (!res.ok) throw new Error("Could not fetch suggested messages.");
        return res.json();
      })
      .then((res) => res.suggestedMessages)
      .catch((e) => {
        console.error(e);
        return null;
      });
  },
  setSuggestedMessages: async function (slug, messages) {
    return fetch(`${API_BASE}/workspace/${slug}/suggested-messages`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ messages }),
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(
            res.statusText || "Error setting suggested messages."
          );
        }
        return { success: true, ...res.json() };
      })
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
  setPinForDocument: async function (slug, docPath, pinStatus) {
    return fetch(`${API_BASE}/workspace/${slug}/update-pin`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ docPath, pinStatus }),
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(
            res.statusText || "Error setting pin status for document."
          );
        }
        return true;
      })
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
  ttsMessage: async function (slug, chatId) {
    return await fetch(`${API_BASE}/workspace/${slug}/tts/${chatId}`, {
      method: "GET",
      cache: "no-cache",
      headers: baseHeaders(),
    })
      .then((res) => {
        if (res.ok && res.status !== 204) return res.blob();
        throw new Error("Failed to fetch TTS.");
      })
      .then((blob) => (blob ? URL.createObjectURL(blob) : null))
      .catch(() => {
        return null;
      });
  },
  _updateChat: async function (slug = "", chatId, newText, role = "assistant") {
    return await fetch(`${API_BASE}/workspace/${slug}/update-chat`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ chatId, newText, role }),
    })
      .then((res) => {
        if (res.ok) return true;
        throw new Error("Failed to update chat.");
      })
      .catch((e) => {
        console.log(e);
        return false;
      });
  },
  _deleteEditedChats: async function (slug = "", startingId) {
    return await fetch(`${API_BASE}/workspace/${slug}/delete-edited-chats`, {
      method: "DELETE",
      headers: baseHeaders(),
      body: JSON.stringify({ startingId }),
    })
      .then((res) => {
        if (res.ok) return true;
        throw new Error("Failed to delete chats.");
      })
      .catch((e) => {
        console.log(e);
        return false;
      });
  },
  deleteChat: async (chatId) => {
    return await fetch(`${API_BASE}/workspace/workspace-chats/${chatId}`, {
      method: "PUT",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
  forkThread: async function (slug = "", threadSlug = null, chatId = null) {
    return await fetch(`${API_BASE}/workspace/${slug}/thread/fork`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ threadSlug, chatId }),
    })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fork thread.");
        return res.json();
      })
      .then((data) => data.newThreadSlug)
      .catch((e) => {
        console.error("Error forking thread:", e);
        return null;
      });
  },
  /**
   * Uploads and embeds a single file in a single call into a workspace
   * @param {string} slug - workspace slug
   * @param {FormData} formData
   * @returns {Promise<{response: {ok: boolean}, data: {success: boolean, error: string|null, document: {id: string, location:string}|null}}>}
   */
  uploadAndEmbedFile: async function (slug, formData) {
    const response = await fetch(
      `${API_BASE}/workspace/${slug}/upload-and-embed`,
      {
        method: "POST",
        body: formData,
        headers: baseHeaders(),
      }
    );

    const data = await response.json();
    return { response, data };
  },

  deleteParsedFiles: async function (slug, fileIds = []) {
    const response = await fetch(
      `${API_BASE}/workspace/${slug}/delete-parsed-files`,
      {
        method: "DELETE",
        headers: baseHeaders(),
        body: JSON.stringify({ fileIds }),
      }
    );
    return response.ok;
  },

  embedParsedFile: async function (slug, fileId) {
    const response = await fetch(
      `${API_BASE}/workspace/${slug}/embed-parsed-file/${fileId}`,
      {
        method: "POST",
        headers: baseHeaders(),
      }
    );

    const data = await response.json();
    return { response, data };
  },

  /**
   * Deletes and un-embeds a single file in a single call from a workspace
   * @param {string} slug - workspace slug
   * @param {string} documentLocation - location of file eg: custom-documents/my-file-uuid.json
   * @returns {Promise<boolean>}
   */
  deleteAndUnembedFile: async function (slug, documentLocation) {
    const response = await fetch(
      `${API_BASE}/workspace/${slug}/remove-and-unembed`,
      {
        method: "DELETE",
        body: JSON.stringify({ documentLocation }),
        headers: baseHeaders(),
      }
    );
    return response.ok;
  },

  /**
   * Reorders workspaces in the UI via localstorage on client side.
   * @param {string[]} workspaceIds - array of workspace ids to reorder
   * @returns {boolean}
   */
  storeWorkspaceOrder: function (workspaceIds = []) {
    try {
      localStorage.setItem(
        this.workspaceOrderStorageKey,
        JSON.stringify(workspaceIds)
      );
      return true;
    } catch (error) {
      console.error("Error reordering workspaces:", error);
      return false;
    }
  },

  /**
   * Orders workspaces based on the order preference stored in localstorage
   * @param {Array} workspaces - array of workspace JSON objects
   * @returns {Array} - ordered workspaces
   */
  orderWorkspaces: function (workspaces = []) {
    const workspaceOrderPreference =
      safeJsonParse(localStorage.getItem(this.workspaceOrderStorageKey)) || [];
    if (workspaceOrderPreference.length === 0) return workspaces;
    const orderedWorkspaces = Array.from(workspaces);
    orderedWorkspaces.sort(
      (a, b) =>
        workspaceOrderPreference.indexOf(a.id) -
        workspaceOrderPreference.indexOf(b.id)
    );
    return orderedWorkspaces;
  },

  /**
   * Searches for workspaces and threads
   * @param {string} searchTerm
   * @returns {Promise<{workspaces: [{slug: string, name: string}], threads: [{slug: string, name: string, workspace: {slug: string, name: string}}]}}>}
   */
  searchWorkspaceOrThread: async function (searchTerm) {
    const response = await fetch(`${API_BASE}/workspace/search`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ searchTerm }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { workspaces: [], threads: [] };
      });
    return response;
  },

  /**
   * Checks if the agent command is available for a workspace
   * by checking if the workspace's agent provider supports native tool calling.
   *
   * This can be model specific or enabled via ENV flag.
   * @param {string} slug - workspace slug
   * @returns {Promise<{showAgentCommand: boolean}>}
   */
  agentCommandAvailable: async function (slug = null) {
    if (!slug) return { showAgentCommand: true };
    return await fetch(
      `${API_BASE}/workspace/${slug}/is-agent-command-available`,
      { headers: baseHeaders() }
    )
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { showAgentCommand: true };
      });
  },

  threads: WorkspaceThread,
};

export default Workspace;
