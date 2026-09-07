import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowLeft,
  CaretDown,
  FileText,
  GearSix,
  List,
  MagnifyingGlass,
  PencilSimple,
  Pulse,
  Plus,
  PushPin,
  Tag,
  Trash,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Workspace from "@/models/workspace";
import paths from "@/utils/paths";
import useLogo from "@/hooks/useLogo";
import showToast from "@/utils/toast";

const ARCHIVE_SCOPES = ["전체", "실적", "법규", "대외"];
const PINNED_THREADS_STORAGE_KEY = "archive-pinned-threads";

const MANAGEMENT_ITEMS = [
  {
    key: "documents",
    title: "문서함",
    description: "폴더별 원문과 추출·분류 상태를 확인합니다.",
    icon: FileText,
    href: (slug) => paths.workspace.library(slug),
  },
  {
    key: "classification",
    title: "분류 검수",
    description: "문서 종류와 분야를 확정하고 문서함에서 확인합니다.",
    icon: Tag,
    href: (slug) =>
      paths.settings.classification({ search: `workspace=${slug}` }),
  },
  {
    key: "query",
    title: "질의 환경",
    description: "검색 범위와 답변 환경을 관리합니다.",
    icon: GearSix,
    href: (slug) => paths.workspace.settings.chatSettings(slug),
  },
  {
    key: "status",
    title: "시스템 상태",
    description: "서버와 수집기의 동작 상태를 확인합니다.",
    icon: Pulse,
    href: (slug) => paths.settings.logs({ search: `workspace=${slug}` }),
  },
];

function threadDate(thread) {
  return new Date(
    thread?.lastUpdatedAt || thread?.updatedAt || thread?.createdAt || 0
  ).getTime();
}

function threadTitle(thread) {
  if (thread?.name === "Thread") return "새로운 채팅";
  return (
    thread?.name ||
    thread?.title ||
    thread?.slug?.replace(/[-_]/g, " ") ||
    "새 질의"
  );
}

export default function ArchiveSidebar({
  slug = "archive-full",
  view = "workspace",
  activeManagement = "overview",
}) {
  if (view === "management") {
    return (
      <ManagementSidebar slug={slug} activeManagement={activeManagement} />
    );
  }

  return <WorkspaceArchiveSidebar slug={slug} />;
}

function WorkspaceArchiveSidebar({ slug }) {
  const { logo } = useLogo();
  const location = useLocation();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState(null);
  const [threads, setThreads] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [archiveScope, setArchiveScope] = useState(
    () => localStorage.getItem("archive-scope") || "전체"
  );
  const [searchMode, setSearchMode] = useState("default");
  const [openThreadMenu, setOpenThreadMenu] = useState(null);
  const [pinnedThreads, setPinnedThreads] = useState(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem(PINNED_THREADS_STORAGE_KEY) || "[]"
      );
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  });

  const loadThreads = useCallback(async () => {
    setLoading(true);
    const [workspaceResult, threadResult] = await Promise.all([
      Workspace.bySlug(slug),
      Workspace.threads.all(slug),
    ]);
    setWorkspace(workspaceResult);
    setSearchMode(workspaceResult?.vectorSearchMode || "default");
    setThreads(
      (threadResult?.threads || [])
        .slice()
        .sort((a, b) => threadDate(b) - threadDate(a))
    );
    setLoading(false);
  }, [slug]);

  useEffect(() => {
    loadThreads();
    const handler = () => loadThreads();
    const renameHandler = (event) => {
      const { threadSlug, newName } = event.detail || {};
      if (!threadSlug || !newName) return;
      setThreads((prev) =>
        prev.map((thread) =>
          thread.slug === threadSlug ? { ...thread, name: newName } : thread
        )
      );
    };
    const searchModeHandler = (event) => {
      setSearchMode(event.detail?.mode || "default");
    };
    window.addEventListener("archive-thread-created", handler);
    window.addEventListener("archive-documents-uploaded", handler);
    window.addEventListener("renameThread", renameHandler);
    window.addEventListener("archive-search-mode-changed", searchModeHandler);
    return () => {
      window.removeEventListener("archive-thread-created", handler);
      window.removeEventListener("archive-documents-uploaded", handler);
      window.removeEventListener("renameThread", renameHandler);
      window.removeEventListener(
        "archive-search-mode-changed",
        searchModeHandler
      );
    };
  }, [loadThreads]);

  const visibleThreads = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = !normalized
      ? threads
      : threads.filter((thread) =>
          threadTitle(thread).toLowerCase().includes(normalized)
        );
    return filtered.slice().sort((a, b) => {
      const aPinned = pinnedThreads.includes(a.slug) ? 1 : 0;
      const bPinned = pinnedThreads.includes(b.slug) ? 1 : 0;
      return bPinned - aPinned || threadDate(b) - threadDate(a);
    });
  }, [query, threads, pinnedThreads]);

  async function createThread() {
    const { thread } = await Workspace.threads.new(slug);
    if (!thread?.slug) return;
    window.dispatchEvent(new Event("archive-thread-created"));
    navigate(paths.workspace.thread(slug, thread.slug));
  }

  function changeArchiveScope(event) {
    const nextScope = event.target.value;
    setArchiveScope(nextScope);
    localStorage.setItem("archive-scope", nextScope);
    window.dispatchEvent(
      new CustomEvent("archive-scope-changed", {
        detail: { scope: nextScope },
      })
    );
  }

  function togglePinnedThread(threadSlug) {
    setPinnedThreads((previous) => {
      const next = previous.includes(threadSlug)
        ? previous.filter((slugValue) => slugValue !== threadSlug)
        : [...previous, threadSlug];
      localStorage.setItem(PINNED_THREADS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    setOpenThreadMenu(null);
  }

  async function renameThread(thread) {
    const name = window
      .prompt("질의 이름을 입력하세요.", threadTitle(thread))
      ?.trim();
    if (!name || name === threadTitle(thread)) {
      setOpenThreadMenu(null);
      return;
    }

    const { message } = await Workspace.threads.update(slug, thread.slug, {
      name,
    });
    if (message) {
      showToast(`질의 이름을 바꾸지 못했습니다. ${message}`, "error", {
        clear: true,
      });
      return;
    }
    setThreads((previous) =>
      previous.map((item) =>
        item.slug === thread.slug ? { ...item, name } : item
      )
    );
    setOpenThreadMenu(null);
  }

  async function deleteThread(thread) {
    if (
      !window.confirm(
        `“${threadTitle(thread)}” 질의를 삭제할까요? 기록과 답변이 함께 삭제됩니다.`
      )
    )
      return;

    const success = await Workspace.threads.delete(slug, thread.slug);
    if (!success) {
      showToast("질의를 삭제하지 못했습니다.", "error", { clear: true });
      return;
    }

    setThreads((previous) =>
      previous.filter((item) => item.slug !== thread.slug)
    );
    setPinnedThreads((previous) => {
      const next = previous.filter((slugValue) => slugValue !== thread.slug);
      localStorage.setItem(PINNED_THREADS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    setOpenThreadMenu(null);
    showToast("질의를 삭제했습니다.", "success", { clear: true });
    if (location.pathname === paths.workspace.thread(slug, thread.slug)) {
      navigate(paths.workspace.chat(slug));
    }
  }

  const workspaceName = "archiving data";
  const isDefaultChat = location.pathname === paths.workspace.chat(slug);

  return (
    <aside className="relative z-20 flex h-full w-[276px] shrink-0 flex-col border-r border-slate-200 bg-white text-slate-900 light:border-slate-200 light:bg-white dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="flex items-center justify-between px-5 pb-5 pt-6">
        <Link
          to={paths.home()}
          aria-label="Document Expansion LLM 홈"
          className="block"
        >
          {logo ? (
            <img
              src={logo}
              alt="Document Expansion LLM"
              className="h-7 w-auto"
            />
          ) : (
            <span className="text-sm font-semibold">
              Document Expansion LLM
            </span>
          )}
        </Link>
        <Link
          to={paths.workspace.chat(slug)}
          aria-label="현재 아카이브"
          className="rounded p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-blue-600 light:text-slate-400 light:hover:bg-slate-100 dark:text-zinc-500 dark:hover:bg-zinc-800"
        >
          <Archive size={18} weight={isDefaultChat ? "fill" : "regular"} />
        </Link>
      </div>

      <div className="px-5">
        <p className="truncate text-[13px] font-semibold text-slate-900 light:text-slate-900 dark:text-zinc-100">
          {workspaceName}
        </p>
        <label className="relative mt-3 block" htmlFor="archive-scope">
          <span className="sr-only">검색할 아카이브</span>
          <select
            id="archive-scope"
            value={archiveScope}
            onChange={changeArchiveScope}
            className="w-full appearance-none rounded border border-slate-200 bg-slate-50 px-3 py-2 pr-8 text-xs font-medium text-slate-700 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 light:border-slate-200 light:bg-slate-50 light:text-slate-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
          >
            {ARCHIVE_SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {scope}
              </option>
            ))}
          </select>
          <CaretDown
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-zinc-500"
          />
        </label>
        <p className="mt-2 text-[11px] text-slate-500 light:text-slate-500 dark:text-zinc-500">
          {archiveScope === "전체" ? "전체 문서" : `${archiveScope} 아카이브`} ·
          문서 {workspace?.documents?.length || 232}개 ·{" "}
          {searchMode === "rerank" ? "정밀 검색 · ONNX" : "기본 검색"}
        </p>
      </div>

      <section className="mx-4 mt-6 flex min-h-0 flex-1 flex-col border-t border-slate-200 pt-5 light:border-slate-200 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-sm font-semibold text-slate-800 light:text-slate-800 dark:text-zinc-200">
            기록
          </h2>
          <div className="relative flex shrink-0 items-center">
            <button
              type="button"
              onClick={createThread}
              className="inline-flex items-center gap-1.5 rounded border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-[11px] font-semibold text-blue-700 transition hover:border-blue-400 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500/30 light:border-blue-200 light:bg-blue-50 light:text-blue-700 dark:border-blue-900/70 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:border-blue-700 dark:hover:bg-blue-950/70"
              aria-label="새채팅 시작"
            >
              <Plus size={14} weight="bold" /> 새채팅
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center rounded border border-slate-200 bg-slate-50 px-2.5 py-2 light:border-slate-200 light:bg-slate-50 dark:border-zinc-800 dark:bg-zinc-900">
          <MagnifyingGlass
            size={15}
            className="mr-2 shrink-0 text-slate-400 dark:text-zinc-500"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="기록 검색"
            aria-label="기록 검색"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-slate-800 outline-none placeholder:text-slate-400 light:text-slate-800 dark:text-zinc-200 dark:placeholder:text-zinc-600"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="검색어 지우기"
              className="border-0 bg-transparent p-0 text-slate-400 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-200"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <nav
          className="mt-3 min-h-0 flex-1 overflow-y-auto pb-4"
          aria-label="기록"
        >
          {loading && (
            <p className="px-3 py-4 text-xs text-slate-400 dark:text-zinc-600">
              기록을 불러오는 중…
            </p>
          )}
          {!loading && visibleThreads.length === 0 && (
            <p className="px-3 py-4 text-xs leading-5 text-slate-400 dark:text-zinc-600">
              아직 저장된 질의가 없습니다.
            </p>
          )}
          {visibleThreads.map((thread) => {
            const href = paths.workspace.thread(slug, thread.slug);
            const active = location.pathname === href;
            return (
              <div
                key={thread.slug}
                className={`group relative mb-1 rounded transition ${active ? "bg-blue-50 text-blue-700 light:bg-blue-50 light:text-blue-700 dark:bg-blue-950/40 dark:text-blue-300" : "text-slate-600 hover:bg-slate-50 light:text-slate-600 light:hover:bg-slate-50 dark:text-zinc-400 dark:hover:bg-zinc-900"}`}
              >
                <Link to={href} className="block rounded px-3 py-2.5 pr-9">
                  <p className="truncate text-xs font-medium">
                    {threadTitle(thread)}
                  </p>
                  <p className="mt-1 flex items-center gap-1 text-[10px] opacity-60">
                    {pinnedThreads.includes(thread.slug) && (
                      <PushPin size={10} weight="fill" />
                    )}
                    기록
                  </p>
                </Link>
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpenThreadMenu((current) =>
                      current === thread.slug ? null : thread.slug
                    );
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 opacity-0 transition hover:bg-slate-200 hover:text-slate-700 group-hover:opacity-100 focus:opacity-100 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  aria-label={`${threadTitle(thread)} 메뉴`}
                  aria-expanded={openThreadMenu === thread.slug}
                >
                  <List size={16} weight="bold" />
                </button>
                {openThreadMenu === thread.slug && (
                  <ThreadActionsMenu
                    pinned={pinnedThreads.includes(thread.slug)}
                    onPin={() => togglePinnedThread(thread.slug)}
                    onRename={() => renameThread(thread)}
                    onDelete={() => deleteThread(thread)}
                  />
                )}
              </div>
            );
          })}
        </nav>
      </section>

      <div className="border-t border-slate-200 p-4 light:border-slate-200 dark:border-zinc-800">
        <Link
          to={`/workspace/${slug}/manage`}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-xs font-medium text-slate-500 transition hover:bg-slate-50 hover:text-slate-800 light:text-slate-500 light:hover:bg-slate-50 dark:text-zinc-500 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
        >
          <Wrench size={15} /> 관리
        </Link>
        <p className="mt-3 px-3 text-[9px] leading-4 text-slate-400 dark:text-zinc-600">
          정책지원팀이 자료 기반 업무의 효율화를 위해 설계했습니다.
        </p>
      </div>
    </aside>
  );
}

function ManagementSidebar({ slug, activeManagement }) {
  const { logo } = useLogo();

  return (
    <aside className="relative z-20 flex h-full w-[276px] shrink-0 flex-col border-r border-slate-200 bg-white text-slate-900 light:border-slate-200 light:bg-white dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="px-5 pb-5 pt-6">
        <Link
          to={paths.home()}
          aria-label="Document Expansion LLM 홈"
          className="block"
        >
          {logo ? (
            <img
              src={logo}
              alt="Document Expansion LLM"
              className="h-7 w-auto"
            />
          ) : (
            <span className="text-sm font-semibold">
              Document Expansion LLM
            </span>
          )}
        </Link>
        <div className="mt-7 border-b border-slate-200 pb-5 dark:border-zinc-800">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-600">
            Archive controls
          </p>
          <p className="mt-2 text-base font-semibold">관리</p>
          <p className="mt-1 text-[11px] leading-5 text-slate-500 dark:text-zinc-500">
            archiving data 운영 도구
          </p>
        </div>
      </div>

      <nav
        className="min-h-0 flex-1 overflow-y-auto px-4"
        aria-label="관리 메뉴"
      >
        <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-600">
          관리 메뉴
        </p>
        <div className="space-y-1">
          {MANAGEMENT_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = item.key === activeManagement;
            return (
              <Link
                key={item.key}
                to={item.href(slug)}
                className={`flex items-start gap-3 rounded-lg px-3 py-3 transition ${active ? "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"}`}
                aria-current={active ? "page" : undefined}
              >
                <Icon
                  size={17}
                  weight={active ? "fill" : "regular"}
                  className="mt-0.5 shrink-0"
                />
                <span className="min-w-0">
                  <span className="block text-xs font-semibold">
                    {item.title}
                  </span>
                  <span className="mt-1 block text-[10px] leading-4 opacity-70">
                    {item.description}
                  </span>
                </span>
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="border-t border-slate-200 p-4 dark:border-zinc-800">
        <Link
          to={paths.workspace.chat(slug)}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-50 hover:text-blue-700 dark:text-zinc-500 dark:hover:bg-zinc-900 dark:hover:text-blue-300"
        >
          <ArrowLeft size={16} /> 작업 화면으로 돌아가기
        </Link>
      </div>
    </aside>
  );
}

function ThreadActionsMenu({
  pinned,
  onPin,
  onRename,
  onDelete,
  align = "left",
}) {
  return (
    <div
      data-thread-menu="true"
      className={`absolute top-9 z-30 w-36 rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl light:border-slate-200 light:bg-white ${align === "right" ? "right-0" : "right-1"}`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={onPin}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[11px] text-zinc-300 transition hover:bg-zinc-800 hover:text-white light:text-slate-700 light:hover:bg-slate-100 light:hover:text-slate-900"
      >
        <PushPin size={14} weight={pinned ? "fill" : "regular"} />
        {pinned ? "고정 해제" : "고정"}
      </button>
      <button
        type="button"
        onClick={onRename}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[11px] text-zinc-300 transition hover:bg-zinc-800 hover:text-white light:text-slate-700 light:hover:bg-slate-100 light:hover:text-slate-900"
      >
        <PencilSimple size={14} /> 이름 변경
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[11px] text-red-300 transition hover:bg-red-950/40 hover:text-red-200 light:text-red-600 light:hover:bg-red-50"
      >
        <Trash size={14} /> 삭제
      </button>
    </div>
  );
}
