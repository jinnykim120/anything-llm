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
import { Link, useParams, useSearchParams } from "react-router-dom";
import ArchiveSidebar from "@/components/ArchiveSidebar";
import Workspace from "@/models/workspace";
import Classification from "@/models/classification";
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
  const metadata = safeMetadata(document?.metadata);
  const source =
    metadata.title ||
    metadata.originalFilename ||
    metadata.originalname ||
    metadata.name ||
    metadata.docSource ||
    metadata.source;
  if (source) {
    const normalized = String(source).split(/[\\/]/).pop();
    return normalized.includes("://")
      ? normalized.split("://").pop()
      : normalized;
  }

  const storedName =
    document?.filename || document?.docpath?.split(/[\\/]/).pop();
  return storedName?.toLowerCase().endsWith(".json")
    ? storedName.slice(0, -5)
    : storedName || "이름 없는 문서";
}

function storageFolderName(document) {
  const path = document?.docpath || "";
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length > 1 ? segments.slice(0, -1).join(" / ") : "미분류";
}

function contentHash(document) {
  return safeMetadata(document?.metadata).content_hash || null;
}

function classificationFolder(document, classificationsByHash) {
  const classification = classificationsByHash.get(contentHash(document));
  if (classification?.docType?.trim()) return classification.docType.trim();
  return "미분류";
}

function classificationValue(document, classificationsByHash, key) {
  const classification = classificationsByHash.get(contentHash(document));
  return classification?.[key]?.trim() || "미분류";
}

function typeLabel(document) {
  const extension = filename(document).split(".").pop()?.toLowerCase();
  return extension ? extension.toUpperCase() : "문서";
}

export default function DocumentRoom() {
  const { slug = "archive-full" } = useParams();
  const [searchParams] = useSearchParams();
  const requestedWork = searchParams.get("work")?.trim() || "";
  const requestedUnit = searchParams.get("unit")?.trim() || "";
  const requestedHash = searchParams.get("hash")?.trim() || "";
  const [workspace, setWorkspace] = useState(null);
  const [classifications, setClassifications] = useState([]);
  const [selected, setSelected] = useState(null);
  const [expanded, setExpanded] = useState(() => ({ "전체 문서": true }));
  const [selectedFolder, setSelectedFolder] = useState("전체 문서");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedHashes, setSelectedHashes] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);

  async function reloadDocuments() {
    setLoading(true);
    const result = await Workspace.bySlug(slug);
    setWorkspace(result);
    const classificationResult = await Classification.documents();
    setClassifications(classificationResult || []);
    setSelected(
      (result?.documents || []).find(
        (document) => contentHash(document) === requestedHash
      ) ||
        result?.documents?.[0] ||
        null
    );
    setSelectedHashes(new Set());
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([Workspace.bySlug(slug), Classification.documents()]).then(
      ([result, classificationResult]) => {
        if (cancelled) return;
        setWorkspace(result);
        setClassifications(classificationResult || []);
        const workspaceDocuments = result?.documents || [];
        const linked = requestedHash
          ? workspaceDocuments.find(
              (document) => contentHash(document) === requestedHash
            )
          : null;
        setSelected(linked || workspaceDocuments[0] || null);
        const requestedFolder = requestedWork
          ? requestedUnit
            ? `unit:${requestedWork}:${requestedUnit}`
            : `work:${requestedWork}`
          : "전체 문서";
        setSelectedFolder(requestedFolder);
        if (requestedWork) {
          setExpanded((previous) => ({
            ...previous,
            [`work:${requestedWork}`]: true,
          }));
        }
        setLoading(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [requestedHash, requestedUnit, requestedWork, slug]);

  const documents = workspace?.documents || [];
  const classificationsByHash = useMemo(
    () =>
      new Map(
        classifications
          .filter((item) => item?.contentHash && item.classification)
          .map((item) => [item.contentHash, item.classification])
      ),
    [classifications]
  );
  // Document room folder tree: 업무 분류 → 사업부까지만 (종류는 폴더에 없음).
  const folderTree = useMemo(() => {
    const workTypes = new Map();
    for (const document of documents) {
      const workType = classificationValue(
        document,
        classificationsByHash,
        "workType"
      );
      const businessUnit = classificationValue(
        document,
        classificationsByHash,
        "businessUnit"
      );
      if (!workTypes.has(workType)) workTypes.set(workType, new Map());
      const units = workTypes.get(workType);
      if (!units.has(businessUnit)) units.set(businessUnit, []);
      units.get(businessUnit).push(document);
    }
    return [...workTypes.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "ko"))
      .map(([workType, units]) => ({
        workType,
        key: `work:${workType}`,
        items: [...units.values()].flat(),
        units: [...units.entries()]
          .sort(([a], [b]) => a.localeCompare(b, "ko"))
          .map(([businessUnit, items]) => ({
            businessUnit,
            key: `unit:${workType}:${businessUnit}`,
            items,
          })),
      }));
  }, [classificationsByHash, documents]);

  const filteredDocuments = useMemo(() => {
    let folderDocuments = documents;
    if (selectedFolder.startsWith("work:")) {
      const workType = selectedFolder.slice("work:".length);
      folderDocuments = documents.filter(
        (document) =>
          classificationValue(document, classificationsByHash, "workType") ===
          workType
      );
    } else if (selectedFolder.startsWith("unit:")) {
      const [, workType, businessUnit] = selectedFolder.split(":");
      folderDocuments = documents.filter(
        (document) =>
          classificationValue(document, classificationsByHash, "workType") ===
            workType &&
          classificationValue(
            document,
            classificationsByHash,
            "businessUnit"
          ) === businessUnit
      );
    }
    const normalized = query.trim().toLowerCase();
    if (!normalized) return folderDocuments;
    return folderDocuments.filter((document) =>
      `${filename(document)} ${classificationFolder(
        document,
        classificationsByHash
      )} ${storageFolderName(document)}`
        .toLowerCase()
        .includes(normalized)
    );
  }, [classificationsByHash, documents, query, selectedFolder]);

  const selectedClassification = selected
    ? classificationsByHash.get(contentHash(selected)) || null
    : null;

  function toggleSelected(document) {
    const hash = contentHash(document);
    if (!hash) return;
    setSelectedHashes((current) => {
      const next = new Set(current);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

  async function deleteSelected() {
    if (!selectedHashes.size) return;
    if (
      !window.confirm(
        `${selectedHashes.size}개 문서를 모든 작업공간에서 삭제할까요?`
      )
    )
      return;
    setDeleting(true);
    const locations = documents
      .filter((document) => selectedHashes.has(contentHash(document)))
      .map((document) => document.docpath)
      .filter(Boolean);
    const result = await Workspace.deleteDocuments(slug, locations);
    setDeleting(false);
    if (result?.error) return window.alert(`삭제 실패: ${result.error}`);
    setSelectedHashes(new Set());
    setSelected(null);
    await reloadDocuments();
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
      <ArchiveSidebar
        slug={slug}
        view="management"
        activeManagement="documents"
      />
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
                분류 폴더
              </p>
              <button
                type="button"
                onClick={() => setSelectedFolder("전체 문서")}
                className={`mb-1 flex w-full items-center gap-1.5 rounded px-2 py-2 text-left text-xs font-medium hover:bg-slate-50 dark:hover:bg-zinc-800 ${selectedFolder === "전체 문서" ? "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300" : "text-slate-700 dark:text-zinc-300"}`}
              >
                <FolderOpen size={15} className="text-blue-600" />
                <span className="min-w-0 flex-1 truncate">전체 문서</span>
                <span className="text-[10px] text-slate-400 dark:text-zinc-600">
                  {documents.length}
                </span>
              </button>
              {folderTree.map((work) => {
                const workOpen = expanded[work.key];
                return (
                  <div key={work.key} className="mb-1 ml-1">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedFolder(work.key);
                        setExpanded((prev) => ({
                          ...prev,
                          [work.key]: !prev[work.key],
                        }));
                      }}
                      className={`flex w-full items-center gap-1.5 rounded px-2 py-2 text-left text-xs font-medium hover:bg-slate-50 dark:hover:bg-zinc-800 ${selectedFolder === work.key ? "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300" : "text-slate-700 dark:text-zinc-300"}`}
                    >
                      {workOpen ? (
                        <CaretDown size={13} />
                      ) : (
                        <CaretRight size={13} />
                      )}
                      {workOpen ? (
                        <FolderOpen size={15} className="text-blue-600" />
                      ) : (
                        <Folder
                          size={15}
                          className="text-slate-400 dark:text-zinc-500"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {work.workType}
                      </span>
                      <span className="text-[10px] text-slate-400 dark:text-zinc-600">
                        {work.items.length}
                      </span>
                    </button>
                    {workOpen && (
                      <div className="ml-5 border-l border-slate-200 pl-2 dark:border-zinc-800">
                        {work.units.map((unit) => (
                          <button
                            key={unit.key}
                            type="button"
                            onClick={() => setSelectedFolder(unit.key)}
                            className={`mb-1 flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[11px] hover:bg-slate-50 dark:hover:bg-zinc-800 ${selectedFolder === unit.key ? "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300" : "text-slate-500 dark:text-zinc-500"}`}
                          >
                            <Folder size={14} />
                            <span className="min-w-0 flex-1 truncate">
                              {unit.businessUnit}
                            </span>
                            <span className="text-[10px] text-slate-400 dark:text-zinc-600">
                              {unit.items.length}
                            </span>
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
                <div className="flex items-center gap-3">
                  <p className="text-xs font-semibold">
                    {selectedFolder}{" "}
                    <span className="ml-1 font-normal text-slate-400 dark:text-zinc-600">
                      {filteredDocuments.length}
                    </span>
                  </p>
                  {selectedHashes.size > 0 && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={deleteSelected}
                        disabled={deleting}
                        className="rounded bg-red-600 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                      >
                        {deleting
                          ? "삭제 중…"
                          : `${selectedHashes.size}개 삭제`}
                      </button>
                    </div>
                  )}
                </div>
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
                    <div
                      key={document.id || document.docpath}
                      className={`flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left transition last:border-b-0 dark:border-zinc-800/80 ${active ? "bg-blue-50 dark:bg-blue-950/30" : "hover:bg-slate-50 dark:hover:bg-zinc-800/60"}`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedHashes.has(contentHash(document))}
                        onChange={() => toggleSelected(document)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`${filename(document)} 선택`}
                      />
                      <Icon
                        size={19}
                        className={
                          active
                            ? "text-blue-600"
                            : "text-slate-400 dark:text-zinc-500"
                        }
                      />
                      <button
                        type="button"
                        onClick={() => setSelected(document)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span
                          className={`block truncate text-xs font-medium ${active ? "text-blue-700 dark:text-blue-300" : "text-slate-700 dark:text-zinc-300"}`}
                        >
                          {filename(document)}
                        </span>
                        <span className="mt-1 block truncate text-[10px] text-slate-400 dark:text-zinc-600">
                          {classificationFolder(
                            document,
                            classificationsByHash
                          )}{" "}
                          · {typeLabel(document)}
                          {metadata?.title &&
                          metadata.title !== filename(document)
                            ? ` · ${metadata.title}`
                            : ""}
                        </span>
                      </button>
                      <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-1 text-[10px] text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                        적재됨
                      </span>
                    </div>
                  );
                })}
            </section>

            <DocumentDetail
              document={selected}
              classification={selectedClassification}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

function DocumentDetail({ document, classification }) {
  const metadata = safeMetadata(document?.metadata);
  if (!document)
    return (
      <aside className="hidden border border-slate-200 bg-white p-5 lg:block dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-slate-400 dark:text-zinc-600">
          문서를 선택하면 상세 정보가 표시됩니다.
        </p>
      </aside>
    );
  const rawHref = document.docId
    ? `${API_BASE}/document/raw/${document.docId}`
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
            {classificationFolder(
              document,
              new Map([[contentHash(document), classification]])
            )}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400 dark:text-zinc-600">분류 종류</dt>
          <dd className="mt-1 break-words text-slate-700 dark:text-zinc-300">
            {classification?.docType || "미분류"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400 dark:text-zinc-600">분야</dt>
          <dd className="mt-1 break-words text-slate-700 dark:text-zinc-300">
            {classification?.domain || "-"}
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
            {classification?.status === "confirmed" ? "확정" : "검수 대기"}
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
