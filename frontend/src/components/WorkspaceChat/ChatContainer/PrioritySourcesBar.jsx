import { useEffect, useMemo, useState } from "react";
import { CircleNotch, Plus, PushPin, X } from "@phosphor-icons/react";
import Modal, { ModalHeader, ModalBody } from "@/components/lib/Modal";
import Workspace from "@/models/workspace";
import showToast from "@/utils/toast";

// [auto-docu 우선 자료] 이 스레드에 "매 답변마다 검색 없이 강제로 포함"할
// 자료를 고정해두고, 항상 보이는 칩 목록으로 보여준다(첨부 메뉴처럼 클릭해야
// 보이는 게 아니라 — 사용자가 "빼먹지 않게 우선적으로 쓰인다"는 걸 계속
// 눈으로 확인할 수 있어야 한다는 요구사항 때문). 두 가지를 하나의 목록으로
// 합친다:
//   - 업로드한 파일 → 이미 있는 workspace_parsed_files(threadId) 메커니즘
//     그대로 재사용(Workspace.parseFile/getParsedFiles/deleteParsedFiles) —
//     stream.js가 이미 이걸 강제 포함 + 인용까지 처리한다.
//   - 아카이브에서 고른 기존 문서 → 새로 만든 thread_priority_sources
//     (Workspace.listPrioritySources/addPrioritySource/removePrioritySource).
export default function PrioritySourcesBar({ workspace, threadSlug }) {
  const [uploadedChips, setUploadedChips] = useState([]); // [{id, title}]
  const [archiveChips, setArchiveChips] = useState([]); // [{id, docId, title}]
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  async function refresh() {
    setLoading(true);
    const [parsed, priority] = await Promise.all([
      Workspace.getParsedFiles(workspace.slug, threadSlug),
      Workspace.listPrioritySources(workspace.slug, threadSlug),
    ]);
    setUploadedChips(
      (parsed?.files || []).map((f) => ({ id: f.id, title: f.title }))
    );
    setArchiveChips(priority?.sources || []);
    setLoading(false);
  }

  useEffect(() => {
    if (!threadSlug) {
      setUploadedChips([]);
      setArchiveChips([]);
      setLoading(false);
      return;
    }
    refresh();
  }, [workspace.slug, threadSlug]);

  async function removeUploaded(id) {
    const success = await Workspace.deleteParsedFiles(workspace.slug, [id]);
    if (!success) return showToast("제거에 실패했습니다.", "error");
    setUploadedChips((prev) => prev.filter((c) => c.id !== id));
  }

  async function removeArchive(id) {
    const res = await Workspace.removePrioritySource(workspace.slug, {
      threadSlug,
      id,
    });
    if (!res?.success) return showToast("제거에 실패했습니다.", "error");
    setArchiveChips((prev) => prev.filter((c) => c.id !== id));
  }

  if (!threadSlug) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-4 py-1.5 dark:border-zinc-800">
      <span className="flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-zinc-400">
        <PushPin size={12} weight="fill" /> 우선 사용 중:
      </span>
      {loading && (
        <CircleNotch size={12} className="animate-spin text-slate-400" />
      )}
      {!loading && !uploadedChips.length && !archiveChips.length && (
        <span className="text-[11px] text-slate-400 dark:text-zinc-600">
          없음
        </span>
      )}
      {uploadedChips.map((c) => (
        <span
          key={`u-${c.id}`}
          className="flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300"
        >
          {c.title}
          <button type="button" onClick={() => removeUploaded(c.id)}>
            <X size={10} />
          </button>
        </span>
      ))}
      {archiveChips.map((c) => (
        <span
          key={`a-${c.id}`}
          className="flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-300"
        >
          {c.title}
          <button type="button" onClick={() => removeArchive(c.id)}>
            <X size={10} />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => setShowAdd(true)}
        className="flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:border-blue-400 hover:text-blue-600 dark:border-zinc-700 dark:text-zinc-400"
      >
        <Plus size={10} /> 우선 자료 추가
      </button>
      {showAdd && (
        <AddPrioritySourceModal
          workspace={workspace}
          threadSlug={threadSlug}
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function AddPrioritySourceModal({ workspace, threadSlug, onClose, onAdded }) {
  const [mode, setMode] = useState(null); // "upload" | "archive"
  const [uploading, setUploading] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [docQuery, setDocQuery] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (mode !== "archive") return;
    Workspace.bySlug(workspace.slug).then((ws) => {
      setDocuments(Array.isArray(ws?.documents) ? ws.documents : []);
    });
  }, [mode, workspace.slug]);

  function docTitleOf(doc) {
    try {
      return JSON.parse(doc?.metadata || "{}").title || doc?.filename || "문서";
    } catch {
      return doc?.filename || "문서";
    }
  }

  const filteredDocuments = useMemo(() => {
    const q = docQuery.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((d) => docTitleOf(d).toLowerCase().includes(q));
  }, [documents, docQuery]);

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file, file.name);
    formData.append("threadSlug", threadSlug || null);
    const { response, data } = await Workspace.parseFile(
      workspace.slug,
      formData
    );
    setUploading(false);
    if (!response.ok) {
      showToast(data?.error || "업로드에 실패했습니다.", "error");
      return;
    }
    showToast("이 대화에 고정했습니다.", "success");
    onAdded();
  }

  async function handlePickArchiveDoc(doc) {
    setAdding(true);
    const res = await Workspace.addPrioritySource(workspace.slug, {
      threadSlug,
      docId: doc.id,
    });
    setAdding(false);
    if (res?.error) return showToast(res.error, "error");
    showToast("이 대화에 고정했습니다.", "success");
    onAdded();
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <ModalHeader
        title="우선 자료 추가"
        subtitle="이 대화의 모든 답변에서 검색 없이 항상 근거로 씁니다."
        onClose={onClose}
      />
      <ModalBody>
        {!mode && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setMode("upload")}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-left text-sm font-semibold text-zinc-100 transition hover:border-blue-400 light:border-slate-300 light:bg-white light:text-slate-800 light:hover:bg-blue-50"
            >
              업로드
            </button>
            <button
              type="button"
              onClick={() => setMode("archive")}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-left text-sm font-semibold text-zinc-100 transition hover:border-blue-400 light:border-slate-300 light:bg-white light:text-slate-800 light:hover:bg-blue-50"
            >
              아카이브에서 선택
            </button>
          </div>
        )}

        {mode === "upload" && (
          <div className="flex flex-col gap-2">
            <input
              type="file"
              onChange={handleUpload}
              disabled={uploading}
              className="text-xs text-slate-500 dark:text-zinc-400"
            />
            {uploading && (
              <span className="flex items-center gap-1 text-[11px] text-slate-500">
                <CircleNotch size={12} className="animate-spin" /> 업로드 중...
              </span>
            )}
          </div>
        )}

        {mode === "archive" && (
          <div className="flex flex-col gap-2">
            <input
              type="text"
              value={docQuery}
              onChange={(e) => setDocQuery(e.target.value)}
              placeholder="문서 이름으로 찾기"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-blue-400 light:border-slate-300 light:bg-white light:text-slate-900 light:placeholder:text-slate-400"
            />
            <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-700 light:border-slate-300">
              {filteredDocuments.length === 0 && (
                <p className="p-3 text-xs text-zinc-400 light:text-slate-500">
                  문서를 찾을 수 없습니다.
                </p>
              )}
              {filteredDocuments.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  disabled={adding}
                  onClick={() => handlePickArchiveDoc(doc)}
                  className="flex w-full items-center gap-2 border-b border-zinc-800 px-3 py-2 text-left text-sm text-zinc-100 last:border-b-0 hover:bg-zinc-800 light:border-slate-200 light:text-slate-900 light:hover:bg-blue-50"
                >
                  <span className="truncate">{docTitleOf(doc)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </ModalBody>
    </Modal>
  );
}
