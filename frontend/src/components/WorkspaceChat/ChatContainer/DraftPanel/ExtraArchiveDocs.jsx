// [auto-docu 문서/PPT 근거 문서 추가] 보고서·PPT 만들기 화면에서 아카이브 문서를 직접
// 고르는 버튼+칩 목록과 선택 모달. index.jsx 에서 분리.
import { useEffect, useMemo, useState } from "react";
import { X, FolderOpen } from "@phosphor-icons/react";
import Workspace from "@/models/workspace";
import Modal, { ModalHeader, ModalBody } from "@/components/lib/Modal";

// [auto-docu 문서/PPT 근거 문서 추가] 생성 전 초기 화면과 작성중 화면 양쪽에
// 그대로 꽂아 쓰는 버튼+칩 목록. 생성 전이면 목록에 더하기만 하고, 작성중
// 화면이면(DraftPanel의 confirmExtraArchiveDocs가) 고른 즉시 다시 생성한다 —
// 이 컴포넌트 자체는 그 차이를 몰라도 된다.
export function ExtraArchiveDocsRow({ docs, onOpenPicker, onRemove }) {
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={onOpenPicker}
        className="flex w-fit items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-500 hover:border-blue-400 hover:text-blue-600 dark:border-zinc-700 dark:text-zinc-400"
      >
        <FolderOpen size={12} /> 아카이브에서 추가 자료 선택
      </button>
      {docs.length > 0 && (
        <div className="flex flex-col gap-1">
          {docs.map((d) => (
            <span
              key={d.id}
              className="flex items-center gap-1.5 text-[11px] text-violet-600 dark:text-violet-400"
            >
              {d.title}
              <button
                type="button"
                onClick={() => onRemove(d.id)}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// [auto-docu 통계분석] 아카이브 문서 다중 선택 — PrioritySourcesBar의
// 아카이브-선택 화면과 같은 검색+목록 패턴이지만, 체크박스로 여러 개를
// 한 번에 고르고 "선택 완료"를 눌러야 확정된다(우선 자료는 하나씩 바로
// 반영되지만, 이건 통계 분석 요청 하나에 여러 문서를 함께 쓰는 경우가
// 많아 다중 선택이 더 자연스럽다).
export function ArchiveDocPickerModal({
  workspace,
  alreadyPicked,
  onClose,
  onConfirm,
}) {
  const [documents, setDocuments] = useState([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set());

  useEffect(() => {
    Workspace.bySlug(workspace.slug).then((ws) => {
      setDocuments(Array.isArray(ws?.documents) ? ws.documents : []);
    });
  }, [workspace.slug]);

  function docTitleOf(doc) {
    try {
      return JSON.parse(doc?.metadata || "{}").title || doc?.filename || "문서";
    } catch {
      return doc?.filename || "문서";
    }
  }

  const alreadyPickedIds = useMemo(
    () => new Set(alreadyPicked.map((d) => d.id)),
    [alreadyPicked]
  );

  const filteredDocuments = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? documents.filter((d) => docTitleOf(d).toLowerCase().includes(q))
      : documents;
    return list.filter((d) => !alreadyPickedIds.has(d.id));
  }, [documents, query, alreadyPickedIds]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleConfirm() {
    const docs = documents
      .filter((d) => selected.has(d.id))
      .map((d) => ({ id: d.id, title: docTitleOf(d) }));
    onConfirm(docs);
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <ModalHeader
        title="아카이브에서 선택"
        subtitle="이번 분석에만 근거 자료로 쓰입니다(별도로 다시 저장되지 않습니다)."
        onClose={onClose}
      />
      <ModalBody>
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
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
              <label
                key={doc.id}
                className="flex w-full cursor-pointer items-center gap-2 border-b border-zinc-800 px-3 py-2 text-left text-sm text-zinc-100 last:border-b-0 hover:bg-zinc-800 light:border-slate-200 light:text-slate-900 light:hover:bg-blue-50"
              >
                <input
                  type="checkbox"
                  checked={selected.has(doc.id)}
                  onChange={() => toggle(doc.id)}
                />
                <span className="truncate">{docTitleOf(doc)}</span>
              </label>
            ))}
          </div>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={handleConfirm}
            className="flex w-fit items-center gap-1.5 self-end rounded-md bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            선택 완료{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
        </div>
      </ModalBody>
    </Modal>
  );
}
