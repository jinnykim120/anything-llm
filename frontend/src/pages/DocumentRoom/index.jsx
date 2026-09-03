import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CaretDown,
  CaretRight,
  File,
  FilePdf,
  Folder,
  FolderOpen,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { Link, useParams } from "react-router-dom";
import ArchiveSidebar from "@/components/ArchiveSidebar";
import Workspace from "@/models/workspace";
import { API_BASE } from "@/utils/constants";
import paths from "@/utils/paths";

function safeMetadata(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function filename(document) {
  return (
    document?.filename ||
    document?.docpath?.split(/[\\/]/).pop() ||
    "이름 없는 문서"
  );
}

function folderName(document) {
  const path = document?.docpath || "";
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length > 1 ? segments.slice(0, -1).join(" / ") : "미분류";
}

function typeLabel(document) {
  const extension = filename(document).split(".").pop()?.toLowerCase();
  return extension ? extension.toUpperCase() : "문서";
}

export default function DocumentRoom() {
  const { slug = "archive-full" } = useParams();
  const [workspace, setWorkspace] = useState(null);
  const [selected, setSelected] = useState(null);
  const [expanded, setExpanded] = useState({ "전체 문서": true });
  const [selectedFolder, setSelectedFolder] = useState("전체 문서");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Workspace.bySlug(slug).then((result) => {
      if (cancelled) return;
      setWorkspace(result);
      const first = result?.documents?.[0] || null;
      setSelected(first);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const documents = workspace?.documents || [];
  const folders = useMemo(() => {
    const map = new Map([["전체 문서", documents]]);
    for (const document of documents) {
      const folder = folderName(document);
      if (!map.has(folder)) map.set(folder, []);
      map.get(folder).push(document);
    }
    return [...map.entries()];
  }, [documents]);

  const filteredDocuments = useMemo(() => {
    const folderDocuments =
      selectedFolder === "전체 문서"
        ? documents
        : documents.filter(
            (document) => folderName(document) === selectedFolder
          );
    const normalized = query.trim().toLowerCase();
    if (!normalized) return folderDocuments;
    return folderDocuments.filter((document) =>
      `${filename(document)} ${folderName(document)}`
        .toLowerCase()
        .includes(normalized)
    );
  }, [documents, query, selectedFolder]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
      <ArchiveSidebar slug={slug} />
      <main className="min-w-0 flex-1 overflow-hidden">
        <div className="flex h-full flex-col px-6 py-8 lg:px-10 lg:py-10">
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 pb-6 dark:border-zinc-800">
            <div>
              <Link
                to={paths.workspace.manage(slug)}
                className="mb-4 inline-flex items-center gap-2 text-xs font-medium text-slate-500 hover:text-blue-600 dark:text-zinc-500 dark:hover:text-blue-300"
              >
                <ArrowLeft size={15} /> 관리로 돌아가기
              </Link>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
                Document room
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
                문서함
              </h1>
              <p className="mt-2 text-sm text-slate-500 dark:text-zinc-400">
                폴더를 선택하면 적재된 원문과 분류 상태를 확인할 수 있습니다.
              </p>
            </div>
            <div className="mt-8 flex items-center gap-2 rounded border border-slate-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
              <MagnifyingGlass
                size={15}
                className="text-slate-400 dark:text-zinc-500"
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="문서 검색"
                aria-label="문서 검색"
                className="w-44 border-0 bg-transparent p-0 text-xs outline-none placeholder:text-slate-400 dark:placeholder:text-zinc-600"
              />
            </div>
          </div>

          <div className="mt-6 grid min-h-0 flex-1 gap-5 lg:grid-cols-[230px_minmax(0,1fr)_320px]">
            <aside className="min-h-0 overflow-y-auto border border-slate-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-600">
                폴더
              </p>
              {folders.map(([folder, items]) => {
                const isOpen = expanded[folder];
                return (
                  <div key={folder} className="mb-1">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedFolder(folder);
                        setExpanded((prev) => ({
                          ...prev,
                          [folder]: !prev[folder],
                        }));
                      }}
                      className={`flex w-full items-center gap-1.5 rounded px-2 py-2 text-left text-xs font-medium hover:bg-slate-50 dark:hover:bg-zinc-800 ${selectedFolder === folder ? "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300" : "text-slate-700 dark:text-zinc-300"}`}
                    >
                      {isOpen ? (
                        <CaretDown size={13} />
                      ) : (
                        <CaretRight size={13} />
                      )}
                      {isOpen ? (
                        <FolderOpen size={15} className="text-blue-600" />
                      ) : (
                        <Folder
                          size={15}
                          className="text-slate-400 dark:text-zinc-500"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{folder}</span>
                      <span className="text-[10px] text-slate-400 dark:text-zinc-600">
                        {items.length}
                      </span>
                    </button>
                    {isOpen && folder !== "전체 문서" && (
                      <div className="ml-7 border-l border-slate-200 pl-2 dark:border-zinc-800">
                        {items.slice(0, 5).map((document) => (
                          <button
                            key={document.id || document.docpath}
                            type="button"
                            onClick={() => setSelected(document)}
                            className="block w-full truncate rounded px-2 py-1.5 text-left text-[11px] text-slate-500 hover:bg-slate-50 hover:text-blue-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-blue-300"
                          >
                            {filename(document)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </aside>

            <section className="min-h-0 overflow-y-auto border border-slate-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-zinc-800">
                <p className="text-xs font-semibold">
                  전체 문서{" "}
                  <span className="ml-1 font-normal text-slate-400 dark:text-zinc-600">
                    {filteredDocuments.length}
                  </span>
                </p>
                <span className="text-[11px] text-slate-400 dark:text-zinc-600">
                  최신 등록순
                </span>
              </div>
              {loading && (
                <p className="p-5 text-sm text-slate-400 dark:text-zinc-600">
                  문서 목록을 불러오는 중…
                </p>
              )}
              {!loading && filteredDocuments.length === 0 && (
                <p className="p-5 text-sm text-slate-400 dark:text-zinc-600">
                  표시할 문서가 없습니다.
                </p>
              )}
              {!loading &&
                filteredDocuments.map((document) => {
                  const active = selected?.id === document.id;
                  const Icon = typeLabel(document) === "PDF" ? FilePdf : File;
                  const metadata = safeMetadata(document.metadata);
                  return (
                    <button
                      key={document.id || document.docpath}
                      type="button"
                      onClick={() => setSelected(document)}
                      className={`flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left transition last:border-b-0 dark:border-zinc-800/80 ${active ? "bg-blue-50 dark:bg-blue-950/30" : "hover:bg-slate-50 dark:hover:bg-zinc-800/60"}`}
                    >
                      <Icon
                        size={19}
                        className={
                          active
                            ? "text-blue-600"
                            : "text-slate-400 dark:text-zinc-500"
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate text-xs font-medium ${active ? "text-blue-700 dark:text-blue-300" : "text-slate-700 dark:text-zinc-300"}`}
                        >
                          {filename(document)}
                        </span>
                        <span className="mt-1 block truncate text-[10px] text-slate-400 dark:text-zinc-600">
                          {folderName(document)} · {typeLabel(document)}
                          {metadata?.title &&
                          metadata.title !== filename(document)
                            ? ` · ${metadata.title}`
                            : ""}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-1 text-[10px] text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                        적재됨
                      </span>
                    </button>
                  );
                })}
            </section>

            <DocumentDetail document={selected} />
          </div>
        </div>
      </main>
    </div>
  );
}

function DocumentDetail({ document }) {
  const metadata = safeMetadata(document?.metadata);
  if (!document)
    return (
      <aside className="hidden border border-slate-200 bg-white p-5 lg:block dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-slate-400 dark:text-zinc-600">
          문서를 선택하면 상세 정보가 표시됩니다.
        </p>
      </aside>
    );
  const rawHref = document.id
    ? `${API_BASE}/document/raw/${document.id}`
    : null;
  return (
    <aside className="min-h-0 overflow-y-auto border border-slate-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-zinc-600">
        문서 상세
      </p>
      <h2 className="mt-3 break-words text-base font-semibold">
        {filename(document)}
      </h2>
      <dl className="mt-6 space-y-4 text-xs">
        <div>
          <dt className="text-slate-400 dark:text-zinc-600">폴더</dt>
          <dd className="mt-1 break-words text-slate-700 dark:text-zinc-300">
            {folderName(document)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400 dark:text-zinc-600">형식</dt>
          <dd className="mt-1 text-slate-700 dark:text-zinc-300">
            {typeLabel(document)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400 dark:text-zinc-600">분류 검수</dt>
          <dd className="mt-1 text-amber-700 dark:text-amber-300">
            {metadata?.classification?.status === "confirmed"
              ? "확정"
              : "검수 대기"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400 dark:text-zinc-600">원본 위치</dt>
          <dd className="mt-1 break-all text-slate-700 dark:text-zinc-300">
            {document.docpath || "-"}
          </dd>
        </div>
      </dl>
      {rawHref && (
        <a
          href={rawHref}
          target="_blank"
          rel="noreferrer"
          className="mt-8 inline-flex w-full items-center justify-center rounded border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-blue-500 hover:text-blue-600 dark:border-zinc-700 dark:text-zinc-200 dark:hover:border-blue-500 dark:hover:text-blue-300"
        >
          원본 열기
        </a>
      )}
      <div className="mt-8 border-t border-slate-200 pt-5 dark:border-zinc-800">
        <p className="text-[11px] font-semibold text-slate-500 dark:text-zinc-500">
          추출 메타데이터
        </p>
        <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-5 text-slate-500 dark:text-zinc-500">
          {JSON.stringify(metadata, null, 2)}
        </pre>
      </div>
    </aside>
  );
}
