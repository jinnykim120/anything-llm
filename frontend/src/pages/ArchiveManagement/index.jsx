import {
  ArrowLeft,
  CaretDown,
  ChartLineUp,
  FileText,
  GearSix,
  Pulse,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import ArchiveSidebar from "@/components/ArchiveSidebar";
import Workspace from "@/models/workspace";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";

const ARCHIVE_SCOPES = ["전체", "실적", "법규", "대외"];
const SEARCH_MODES = [
  {
    value: "default",
    label: "기본 검색",
    description: "빠르게 관련 문서를 찾습니다.",
  },
  {
    value: "rerank",
    label: "정밀 검색 · ONNX",
    description: "다국어 ONNX 재랭커로 결과 순서를 한 번 더 다듬습니다.",
  },
];

const MANAGEMENT_ITEMS = [
  {
    title: "문서함",
    description: "폴더별 문서, 추출 텍스트, 분류 상태를 확인합니다.",
    icon: FileText,
    href: (slug) => paths.workspace.library(slug),
    action: "문서함 열기",
  },
  {
    title: "질의 환경",
    description: "검색 범위와 답변에 사용하는 작업공간 설정을 관리합니다.",
    icon: GearSix,
    href: (slug) => paths.workspace.settings.chatSettings(slug),
    action: "환경 열기",
  },
  {
    title: "시스템 상태",
    description: "서버와 수집기의 최근 동작을 확인할 수 있습니다.",
    icon: Pulse,
    href: paths.settings.logs,
    action: "상태 확인",
  },
];

export default function ArchiveManagement() {
  const { slug = "archive-full" } = useParams();
  const [workspace, setWorkspace] = useState(null);
  const [archiveScope, setArchiveScope] = useState(
    () => localStorage.getItem("archive-scope") || "전체"
  );
  const [searchMode, setSearchMode] = useState("default");
  const [savingMode, setSavingMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Workspace.bySlug(slug).then((result) => {
      if (cancelled) return;
      setWorkspace(result);
      setSearchMode(result?.vectorSearchMode || "default");
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

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

  async function changeSearchMode(event) {
    const nextMode = event.target.value;
    const previousMode = searchMode;
    setSearchMode(nextMode);
    setSavingMode(true);
    const result = await Workspace.update(slug, {
      vectorSearchMode: nextMode,
    });
    setSavingMode(false);
    if (!result?.workspace || result?.message) {
      setSearchMode(previousMode);
      showToast(
        result?.message || "운영 모드를 저장하지 못했습니다.",
        "error",
        { clear: true }
      );
      return;
    }
    setWorkspace(result.workspace);
    window.dispatchEvent(
      new CustomEvent("archive-search-mode-changed", {
        detail: { mode: nextMode },
      })
    );
  }

  const selectedMode =
    SEARCH_MODES.find((mode) => mode.value === searchMode) || SEARCH_MODES[0];
  const documentCount = workspace?.documents?.length || 232;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
      <ArchiveSidebar
        slug={slug}
        view="management"
        activeManagement="overview"
      />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-8 lg:px-12 lg:py-12">
          <Link
            to={paths.workspace.chat(slug)}
            className="inline-flex items-center gap-2 text-xs font-medium text-slate-500 transition hover:text-blue-600 dark:text-zinc-500 dark:hover:text-blue-300"
          >
            <ArrowLeft size={15} /> 작업 화면으로 돌아가기
          </Link>
          <div className="mt-8 border-b border-slate-200 pb-7 dark:border-zinc-800">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
              Archive controls
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
              관리
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-500 dark:text-zinc-400">
              문서와 질의 환경, 시스템 상태를 이곳에서 확인합니다.
            </p>
          </div>
          <section className="mt-8 grid gap-4 md:grid-cols-3">
            {MANAGEMENT_ITEMS.map((item) => {
              const Icon = item.icon;
              const href = item.href(slug);
              return (
                <Link
                  key={item.title}
                  to={href}
                  className="group flex min-h-[210px] flex-col border border-slate-200 bg-white p-5 transition hover:-translate-y-0.5 hover:border-blue-400 hover:shadow-[0_12px_30px_rgba(15,98,254,0.08)] dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-blue-700"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-300">
                    <Icon size={20} weight="bold" />
                  </div>
                  <h2 className="mt-7 text-lg font-semibold">{item.title}</h2>
                  <p className="mt-2 flex-1 text-sm leading-6 text-slate-500 dark:text-zinc-400">
                    {item.description}
                  </p>
                  <span className="mt-5 inline-flex items-center gap-1 text-xs font-semibold text-blue-600 transition group-hover:gap-2 dark:text-blue-300">
                    {item.action} →
                  </span>
                </Link>
              );
            })}
          </section>
          <section className="mt-10 grid gap-4 md:grid-cols-2">
            <div className="border border-slate-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <ChartLineUp size={18} className="text-blue-600" /> 검색 범위
                </div>
                <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                  적용 중
                </span>
              </div>
              <label
                className="relative mt-4 block"
                htmlFor="management-archive-scope"
              >
                <span className="sr-only">검색 범위 선택</span>
                <select
                  id="management-archive-scope"
                  value={archiveScope}
                  onChange={changeArchiveScope}
                  className="w-full appearance-none rounded border border-slate-200 bg-slate-50 px-3 py-2.5 pr-9 text-sm text-slate-700 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                >
                  {ARCHIVE_SCOPES.map((scope) => (
                    <option key={scope} value={scope}>
                      {scope === "전체" ? "전체 아카이브" : `${scope} 아카이브`}
                    </option>
                  ))}
                </select>
                <CaretDown
                  size={15}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-zinc-500"
                />
              </label>
              <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-zinc-500">
                {archiveScope === "전체"
                  ? "전체 문서"
                  : `${archiveScope} 아카이브`}{" "}
                · 문서 {documentCount}개
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-zinc-500">
                이 선택값은 작업 화면의 검색·업로드 범위와 즉시 동기화됩니다.
              </p>
            </div>
            <div className="border border-slate-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Pulse size={18} className="text-emerald-600" /> 운영 모드
                </div>
                <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                  {savingMode ? "저장 중…" : "저장됨"}
                </span>
              </div>
              <label
                className="relative mt-4 block"
                htmlFor="management-search-mode"
              >
                <span className="sr-only">운영 모드 선택</span>
                <select
                  id="management-search-mode"
                  value={searchMode}
                  onChange={changeSearchMode}
                  disabled={savingMode}
                  className="w-full appearance-none rounded border border-slate-200 bg-slate-50 px-3 py-2.5 pr-9 text-sm text-slate-700 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:cursor-wait disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                >
                  {SEARCH_MODES.map((mode) => (
                    <option key={mode.value} value={mode.value}>
                      {mode.label}
                    </option>
                  ))}
                </select>
                <CaretDown
                  size={15}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-zinc-500"
                />
              </label>
              <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-zinc-500">
                {selectedMode.description}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-zinc-500">
                문서 파싱은 현재 Docling 수동 실행 정책을 유지합니다.
              </p>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
