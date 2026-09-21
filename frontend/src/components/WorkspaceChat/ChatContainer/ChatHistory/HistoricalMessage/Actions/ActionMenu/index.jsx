import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Trash,
  DotsThreeVertical,
  TreeView,
  FilePlus,
  CircleNotch,
} from "@phosphor-icons/react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Workspace from "@/models/workspace";
import Modal, { ModalHeader, ModalBody } from "@/components/lib/Modal";
import showToast from "@/utils/toast";

function ActionMenu({
  chatId,
  forkThread,
  isEditing,
  role,
  slug,
  isLastMessage,
  regenerateMessage,
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);
  const menuRef = useRef(null);

  const toggleMenu = () => setOpen(!open);

  const handleFork = () => {
    forkThread(chatId);
    setOpen(false);
  };

  const handleDelete = () => {
    window.dispatchEvent(
      new CustomEvent("delete-message", { detail: { chatId } })
    );
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  if (!chatId || isEditing || role === "user") return null;
  // [auto-docu 근거 문서 강제 포함] 답변이 어떤 문서를 놓쳤다고 판단됐을 때
  // 바로 이 자리에서 고쳐 다시 답변받게 한다 — regenerateMessage(chatId)와
  // 같은 조건(마지막 답변만)으로 제한한다.
  const canAddSource =
    isLastMessage && !!slug && typeof regenerateMessage === "function";

  return (
    <div className="mt-2 -ml-0.5 relative" ref={menuRef}>
      <button
        onClick={toggleMenu}
        className="border-none text-zinc-300 light:text-slate-500 transition-colors duration-200"
        data-tooltip-id="action-menu"
        data-tooltip-content={t("chat_window.more_actions")}
        aria-label={t("chat_window.more_actions")}
      >
        <DotsThreeVertical size={24} weight="bold" />
      </button>
      {open && (
        <div
          data-action-menu-open
          className="absolute -top-1 left-7 mt-1 border-[1.5px] border-white/40 rounded-lg bg-theme-action-menu-bg flex flex-col shadow-[0_4px_14px_rgba(0,0,0,0.25)] text-white z-99"
        >
          {canAddSource && (
            <button
              onClick={() => {
                setOpen(false);
                setShowAddSource(true);
              }}
              className="border-none rounded-t-lg flex items-center text-white gap-x-2 hover:bg-theme-action-menu-item-hover py-1.5 px-2 transition-colors duration-200 w-full text-left"
            >
              <FilePlus size={18} />
              <span className="text-sm whitespace-nowrap">
                근거 문서 추가하고 다시 답변
              </span>
            </button>
          )}
          <button
            onClick={handleFork}
            className={`border-none flex items-center text-white gap-x-2 hover:bg-theme-action-menu-item-hover py-1.5 px-2 transition-colors duration-200 w-full text-left ${canAddSource ? "" : "rounded-t-lg"}`}
          >
            <TreeView size={18} />
            <span className="text-sm">{t("chat_window.fork")}</span>
          </button>
          <button
            onClick={handleDelete}
            className="border-none flex rounded-b-lg items-center text-white gap-x-2 hover:bg-theme-action-menu-item-hover py-1.5 px-2 transition-colors duration-200 w-full text-left"
          >
            <Trash size={18} />
            <span className="text-sm">{t("chat_window.delete")}</span>
          </button>
        </div>
      )}
      {showAddSource && (
        <AddSourceModal
          slug={slug}
          onClose={() => setShowAddSource(false)}
          onAdded={() => {
            setShowAddSource(false);
            regenerateMessage(chatId);
          }}
        />
      )}
    </div>
  );
}

// [auto-docu 근거 문서 강제 포함] 이 스레드의 "우선 자료"(thread_priority_sources)
// 에 아카이브 문서를 고정한다 — 이미 있는 PrioritySourcesBar의 아카이브
// 선택 흐름과 같은 API를 쓴다. 여기서는 업로드 옵션 없이 아카이브 검색만
// 보여준다 — "검색이 놓친 문서를 바로 찍어서 다시 답변"이 목적이라 이미
// 아카이브에 있는 문서를 고르는 경우가 압도적이기 때문.
function AddSourceModal({ slug, onClose, onAdded }) {
  const { threadSlug = null } = useParams();
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    Workspace.bySlug(slug).then((ws) => {
      setDocuments(Array.isArray(ws?.documents) ? ws.documents : []);
      setLoading(false);
    });
  }, [slug]);

  function docTitleOf(doc) {
    try {
      return JSON.parse(doc?.metadata || "{}").title || doc?.filename || "문서";
    } catch {
      return doc?.filename || "문서";
    }
  }

  const filteredDocuments = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((d) => docTitleOf(d).toLowerCase().includes(q));
  }, [documents, query]);

  async function handlePick(doc) {
    setAdding(true);
    const res = await Workspace.addPrioritySource(slug, {
      threadSlug,
      docId: doc.id,
    });
    setAdding(false);
    if (res?.error) return showToast(res.error, "error");
    showToast("이 문서를 고정하고 답변을 다시 생성합니다.", "success");
    onAdded();
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="md">
      <ModalHeader
        title="근거 문서 추가하고 다시 답변"
        subtitle="아카이브에서 문서를 고르면 검색 없이 강제로 포함해 이 답변을 다시 생성합니다."
        onClose={onClose}
      />
      <ModalBody>
        <div className="flex flex-col gap-2">
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="문서 이름으로 찾기"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-blue-400 light:border-slate-300 light:bg-white light:text-slate-900 light:placeholder:text-slate-400"
          />
          <div className="max-h-64 overflow-y-auto rounded-lg border border-zinc-700 light:border-slate-300">
            {loading && (
              <p className="flex items-center gap-1 p-3 text-xs text-zinc-400 light:text-slate-500">
                <CircleNotch size={12} className="animate-spin" /> 불러오는
                중...
              </p>
            )}
            {!loading && filteredDocuments.length === 0 && (
              <p className="p-3 text-xs text-zinc-400 light:text-slate-500">
                문서를 찾을 수 없습니다.
              </p>
            )}
            {filteredDocuments.map((doc) => (
              <button
                key={doc.id}
                type="button"
                disabled={adding}
                onClick={() => handlePick(doc)}
                className="flex w-full items-center gap-2 border-b border-zinc-800 px-3 py-2 text-left text-sm text-zinc-100 last:border-b-0 hover:bg-zinc-800 disabled:opacity-50 light:border-slate-200 light:text-slate-900 light:hover:bg-blue-50"
              >
                <span className="truncate">{docTitleOf(doc)}</span>
              </button>
            ))}
          </div>
        </div>
      </ModalBody>
    </Modal>
  );
}

export default ActionMenu;
