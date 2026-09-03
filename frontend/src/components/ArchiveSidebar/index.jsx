import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ClockCounterClockwise,
  MagnifyingGlass,
  Plus,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Workspace from "@/models/workspace";
import paths from "@/utils/paths";
import useLogo from "@/hooks/useLogo";

function threadDate(thread) {
  return new Date(
    thread?.lastUpdatedAt || thread?.updatedAt || thread?.createdAt || 0
  ).getTime();
}

function threadTitle(thread) {
  return (
    thread?.name ||
    thread?.title ||
    thread?.slug?.replace(/[-_]/g, " ") ||
    "새 질의"
  );
}

export default function ArchiveSidebar({ slug = "archive-full" }) {
  const { logo } = useLogo();
  const location = useLocation();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState(null);
  const [threads, setThreads] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  const loadThreads = useCallback(async () => {
    setLoading(true);
    const [workspaceResult, threadResult] = await Promise.all([
      Workspace.bySlug(slug),
      Workspace.threads.all(slug),
    ]);
    setWorkspace(workspaceResult);
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
    window.addEventListener("archive-thread-created", handler);
    return () => window.removeEventListener("archive-thread-created", handler);
  }, [loadThreads]);

  const visibleThreads = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return threads;
    return threads.filter((thread) =>
      threadTitle(thread).toLowerCase().includes(normalized)
    );
  }, [query, threads]);

  async function createThread() {
    const { thread } = await Workspace.threads.new(slug);
    if (!thread?.slug) return;
    window.dispatchEvent(new Event("archive-thread-created"));
    navigate(paths.workspace.thread(slug, thread.slug));
  }

  const workspaceName = workspace?.name || "공정거래 아카이브";
  const isDefaultChat = location.pathname === paths.workspace.chat(slug);

  return (
    <aside className="relative z-20 flex h-full w-[276px] shrink-0 flex-col border-r border-slate-200 bg-white text-slate-900 light:border-slate-200 light:bg-white dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="flex items-center justify-between px-5 pb-5 pt-6">
        <Link to={paths.home()} aria-label="Archive QA 홈" className="block">
          {logo ? (
            <img src={logo} alt="Archive QA" className="h-7 w-auto" />
          ) : (
            <span className="text-sm font-semibold">Archive QA</span>
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
        <p className="mt-1 text-[11px] text-slate-500 light:text-slate-500 dark:text-zinc-500">
          문서 {workspace?.documents?.length || 232}개 · Default 검색
        </p>
      </div>

      <div className="mx-4 mt-7 flex items-center gap-2 text-slate-500 light:text-slate-500 dark:text-zinc-500">
        <ClockCounterClockwise size={16} />
        <div>
          <h2 className="text-sm font-semibold text-slate-800 light:text-slate-800 dark:text-zinc-200">
            질의 아카이브
          </h2>
          <p className="mt-0.5 text-[11px]">최근 질문과 답변</p>
        </div>
      </div>

      <div className="mx-4 mt-4 flex items-center rounded border border-slate-200 bg-slate-50 px-2.5 py-2 light:border-slate-200 light:bg-slate-50 dark:border-zinc-800 dark:bg-zinc-900">
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
        className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-4"
        aria-label="질의 기록"
      >
        <Link
          to={paths.workspace.chat(slug)}
          className={`mb-1 block rounded px-3 py-2.5 transition ${isDefaultChat ? "bg-blue-50 text-blue-700 light:bg-blue-50 light:text-blue-700 dark:bg-blue-950/40 dark:text-blue-300" : "text-slate-600 hover:bg-slate-50 light:text-slate-600 light:hover:bg-slate-50 dark:text-zinc-400 dark:hover:bg-zinc-900"}`}
        >
          <p className="truncate text-xs font-medium">새 질의 시작</p>
          <p className="mt-1 text-[10px] opacity-70">전체 문서에서 질문하기</p>
        </Link>
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
            <Link
              key={thread.slug}
              to={href}
              className={`mb-1 block rounded px-3 py-2.5 transition ${active ? "bg-blue-50 text-blue-700 light:bg-blue-50 light:text-blue-700 dark:bg-blue-950/40 dark:text-blue-300" : "text-slate-600 hover:bg-slate-50 light:text-slate-600 light:hover:bg-slate-50 dark:text-zinc-400 dark:hover:bg-zinc-900"}`}
            >
              <p className="truncate text-xs font-medium">
                {threadTitle(thread)}
              </p>
              <p className="mt-1 text-[10px] opacity-60">질의 기록</p>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-slate-200 p-4 light:border-slate-200 dark:border-zinc-800">
        <button
          type="button"
          onClick={createThread}
          className="mb-2 flex w-full items-center justify-center gap-2 rounded bg-blue-600 px-3 py-2.5 text-xs font-semibold text-white transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          <Plus size={16} weight="bold" /> + 새 질의
        </button>
        <Link
          to={`/workspace/${slug}/manage`}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-xs font-medium text-slate-500 transition hover:bg-slate-50 hover:text-slate-800 light:text-slate-500 light:hover:bg-slate-50 dark:text-zinc-500 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
        >
          <Wrench size={15} /> 관리
        </Link>
      </div>
    </aside>
  );
}
