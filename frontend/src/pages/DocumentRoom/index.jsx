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
import DoclingToggle from "@/components/DoclingToggle";
import Workspace from "@/models/workspace";
import Classification from "@/models/classification";
import { API_BASE } from "@/utils/constants";
import { withClientParam } from "@/utils/nexusClient";
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

// 변환하면 재임베딩되면서 metadata.parse_path 가 "pptx-pdf/…" 로 바뀐다.
function isPdfConverted(document) {
  return String(safeMetadata(document?.metadata).parse_path || "").startsWith(
    "pptx-pdf"
  );
}

// 어떤 파서로 읽었는지. Docling 을 쓸 수 있는 형식(PDF, PPT 계열)만 표시하고
// HWP/DOCX/XLSX/MD 는 Docling 대상이 아니라 "na".
//   kind: "docling" | "docling-partial" | "basic" | "image" | "na"(대상 아님)
function parserInfo(document) {
  const ext = (filename(document).match(/.([a-z0-9]+)$/i) || [])[1] || "";
  if (!/^(pdf|pptx?|odp)$/i.test(ext))
    return { kind: "na", label: "대상 아님" };
  const pp = String(safeMetadata(document?.metadata).parse_path || "");
  if (pp.includes("docling-partial"))
    return { kind: "docling-partial", label: "Docling(일부)" };
  if (pp.includes("docling")) return { kind: "docling", label: "Docling" };
  if (pp === "image-only") return { kind: "image", label: "이미지 PDF" };
  return { kind: "basic", label: "기본 파서" };
}

const PARSER_BADGE_CLASS = {
  docling:
    "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  "docling-partial":
    "bg-violet-50 text-violet-500 dark:bg-violet-950/40 dark:text-violet-400",
  basic: "bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400",
  image: "bg-slate-100 text-slate-400 dark:bg-zinc-800 dark:text-zinc-500",
  na: "border border-slate-200 text-slate-400 dark:border-zinc-800 dark:text-zinc-600",
};

// 요약 바 칩 정의 — group 1: 대상/비대상, group 2: 대상 안의 적재 방식
const PARSER_CHIPS = [
  { key: "docling", group: 2, label: "Docling 적재" },
  { key: "docling-partial", group: 2, label: "일부만 Docling" },
  // Docling 으로 읽을 수 있는 형식(PDF·PPT)인데 기본 파서로 적재된 문서 —
  // "Docling으로 다시 읽기"의 주 대상이라 강조한다.
  {
    key: "basic",
    group: 2,
    label: "기본 파서로 적재 (Docling 가능 형식)",
    highlight: true,
  },
  { key: "image", group: 2, label: "이미지 PDF" },
];
const matchesParserFilter = (document, key) => {
  const kind = parserInfo(document).kind;
  return key === "target" ? kind !== "na" : kind === key;
};

// PPT 계열만 PDF 변환 대상 (서버도 같은 확장자만 허용).
function isConvertible(document) {
  return /.(pptx?|odp)$/i.test(filename(document) || "");
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
  const [converting, setConverting] = useState(null); // { done, total, current }
  const [onlyUnconverted, setOnlyUnconverted] = useState(false);
  const [parserFilter, setParserFilter] = useState(null); // PARSER_CHIPS key
  const [showParserGuide, setShowParserGuide] = useState(false);

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
    if (onlyUnconverted)
      folderDocuments = folderDocuments.filter(
        (document) => isConvertible(document) && !isPdfConverted(document)
      );
    if (parserFilter)
      folderDocuments = folderDocuments.filter((document) =>
        matchesParserFilter(document, parserFilter)
      );
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
  }, [
    classificationsByHash,
    documents,
    parserFilter,
    onlyUnconverted,
    query,
    selectedFolder,
  ]);

  useEffect(() => {
    setSelectedHashes(new Set());
  }, [parserFilter, onlyUnconverted, selectedFolder, query]);

  const parserCounts = useMemo(() => {
    const counts = {};
    for (const chip of PARSER_CHIPS)
      counts[chip.key] = documents.filter((d) =>
        matchesParserFilter(d, chip.key)
      ).length;
    return counts;
  }, [documents]);

  const unconvertedCount = useMemo(
    () =>
      documents.filter((d) => isConvertible(d) && !isPdfConverted(d)).length,
    [documents]
  );

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

  // 현재 보이는 목록(폴더·검색·칩 필터 적용 후) 기준 전체 선택/해제.
  // 다른 필터에서 이미 고른 문서는 건드리지 않는다.
  const visibleHashes = filteredDocuments.map(contentHash).filter(Boolean);
  const selectedVisibleCount = visibleHashes.filter((h) =>
    selectedHashes.has(h)
  ).length;
  const allVisibleSelected =
    visibleHashes.length > 0 && selectedVisibleCount === visibleHashes.length;

  function toggleSelectAllVisible() {
    setSelectedHashes((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleHashes.forEach((h) => next.delete(h));
      else visibleHashes.forEach((h) => next.add(h));
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

  // 문서를 하나씩 순서대로 변환한다 — 서버가 동시 변환을 막고, LibreOffice +
  // 재임베딩이라 문서당 10~30초 걸린다.
  // Docling 으로 다시 읽기 대상: PDF/PPT 중 Docling 으로 안 읽힌 것(기본 파서·일부).
  // 이미지 PDF 는 텍스트 층이 없어 Docling 으로도 한글 OCR 이 약해 제외한다.
  const canReparse = (document) =>
    ["basic", "docling-partial"].includes(parserInfo(document).kind);

  async function reparseWithDocling(targets) {
    const list = targets.filter(canReparse);
    if (!list.length)
      return window.alert(
        "Docling으로 다시 읽을 문서가 없습니다(이미 Docling으로 읽었거나 대상이 아닙니다)."
      );
    const status = await Workspace.doclingStatus();
    if (!status?.running)
      return window.alert(
        "Docling이 꺼져 있습니다. 위쪽의 Docling 켜기 버튼으로 먼저 켠 뒤 다시 시도해 주세요."
      );
    if (
      !window.confirm(
        `${list.length}개 문서를 Docling으로 다시 읽고 재임베딩합니다. 문서당 수 분이 걸릴 수 있으며, 도중에 Docling이 실패하면 그 문서는 기존 내용을 그대로 둡니다. 진행할까요?`
      )
    )
      return;
    const failed = [];
    for (let i = 0; i < list.length; i++) {
      setConverting({
        done: i,
        total: list.length,
        current: filename(list[i]),
        mode: "docling",
      });
      const res = await Workspace.reparseWithDocling(list[i].docpath);
      if (!res?.success)
        failed.push(`${filename(list[i])}: ${res?.error || "알 수 없는 오류"}`);
    }
    setConverting(null);
    setSelected(null);
    await reloadDocuments();
    window.alert(
      failed.length
        ? `${list.length - failed.length}개 완료, ${failed.length}개 실패\n\n${failed.join("\n")}`
        : `${list.length}개 문서를 Docling으로 다시 읽었습니다.`
    );
  }

  async function convertToPdf(targets) {
    const list = targets.filter(isConvertible);
    if (!list.length) return window.alert("PPT/PPTX 문서를 선택해 주세요.");
    if (
      !window.confirm(
        `${list.length}개 문서를 PDF로 변환해 다시 읽습니다. 문서당 10~30초 걸리며, 쪽(슬라이드) 단위로 다시 인덱싱됩니다. 진행할까요?`
      )
    )
      return;
    const failed = [];
    for (let i = 0; i < list.length; i++) {
      setConverting({ done: i, total: list.length, current: filename(list[i]) });
      const res = await Workspace.convertDocumentToPdf(list[i].docpath);
      if (!res?.success)
        failed.push(`${filename(list[i])}: ${res?.error || "알 수 없는 오류"}`);
    }
    setConverting(null);
    setSelected(null);
    await reloadDocuments();
    window.alert(
      failed.length
        ? `${list.length - failed.length}개 완료, ${failed.length}개 실패\n\n${failed.join("\n")}`
        : `${list.length}개 문서를 PDF로 변환해 다시 읽었습니다.`
    );
  }

  const selectedReparsable = documents.filter(
    (document) => selectedHashes.has(contentHash(document)) && canReparse(document)
  );

  const selectedConvertible = documents.filter(
    (document) =>
      selectedHashes.has(contentHash(document)) && isConvertible(document)
  );

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
              <p className="text-xs font-semibold text-blue-600">
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
            <DoclingToggle compact className="mt-2" />
          </div>

          <div className="mt-6 grid min-h-0 flex-1 gap-5 lg:grid-cols-[230px_minmax(0,1fr)_320px]">
            <aside className="min-h-0 overflow-y-auto border border-slate-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <p className="px-2 pb-2 text-[11px] font-semibold text-slate-400 dark:text-zinc-600">
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
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold text-slate-600 dark:text-zinc-300">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            selectedVisibleCount > 0 && !allVisibleSelected;
                      }}
                      onChange={toggleSelectAllVisible}
                      disabled={visibleHashes.length === 0}
                      aria-label="보이는 문서 전체 선택"
                    />
                    전체 선택
                  </label>
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
                      {selectedReparsable.length > 0 && (
                        <button
                          type="button"
                          onClick={() => reparseWithDocling(selectedReparsable)}
                          disabled={!!converting}
                          className="rounded border border-violet-600 px-2 py-1 text-[11px] font-semibold text-violet-700 disabled:opacity-50 dark:border-violet-400 dark:text-violet-300"
                        >
                          {converting?.mode === "docling"
                            ? `Docling 처리 중 ${converting.done + 1}/${converting.total}…`
                            : `${selectedReparsable.length}개 Docling으로 다시 읽기`}
                        </button>
                      )}
                      {selectedConvertible.length > 0 && (
                        <button
                          type="button"
                          onClick={() => convertToPdf(selectedConvertible)}
                          disabled={!!converting}
                          className="rounded border border-blue-600 px-2 py-1 text-[11px] font-semibold text-blue-600 disabled:opacity-50 dark:border-blue-400 dark:text-blue-300"
                        >
                          {converting && converting.mode !== "docling"
                            ? `변환 중 ${converting.done + 1}/${converting.total}…`
                            : `${selectedConvertible.length}개 PDF로 변환`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {(unconvertedCount > 0 || onlyUnconverted) && (
                    <button
                      type="button"
                      onClick={() => setOnlyUnconverted((v) => !v)}
                      className={`rounded border px-2 py-1 text-[11px] font-semibold transition ${onlyUnconverted ? "border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300" : "border-slate-300 text-slate-600 hover:border-amber-500 dark:border-zinc-700 dark:text-zinc-300"}`}
                    >
                      PPT 미변환만 보기 ({unconvertedCount})
                    </button>
                  )}
                  <span className="text-[11px] text-slate-400 dark:text-zinc-600">
                    최신 등록순
                  </span>
                </div>
              </div>
              <div className="border-b border-slate-200 px-4 py-3 dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {[2].map((group) => (
                    <div
                      key={group}
                      className="flex flex-wrap items-center gap-1.5"
                    >
                      <span className="text-[10px] font-semibold text-slate-400 dark:text-zinc-600">
                        Docling 적재 현황
                      </span>
                      {PARSER_CHIPS.filter((c) => c.group === group).map(
                        (chip) => {
                          const active = parserFilter === chip.key;
                          return (
                            <button
                              key={chip.key}
                              type="button"
                              onClick={() =>
                                setParserFilter(active ? null : chip.key)
                              }
                              className={`rounded-full border px-2 py-1 text-[11px] font-semibold transition ${active ? "border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300" : chip.highlight && parserCounts[chip.key] > 0 ? "border-amber-400 bg-amber-50 text-amber-800 hover:border-amber-500 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300" : "border-slate-200 text-slate-600 hover:border-violet-400 dark:border-zinc-700 dark:text-zinc-300"}`}
                            >
                              {chip.label}{" "}
                              <span className="font-normal">
                                {parserCounts[chip.key]}
                              </span>
                            </button>
                          );
                        }
                      )}
                    </div>
                  ))}
                  {["basic", "docling-partial"].includes(parserFilter) &&
                    filteredDocuments.some(canReparse) && (
                      <button
                        type="button"
                        onClick={() =>
                          reparseWithDocling(filteredDocuments.filter(canReparse))
                        }
                        disabled={!!converting}
                        className="rounded bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50"
                      >
                        {converting?.mode === "docling"
                          ? `Docling 처리 중 ${converting.done + 1}/${converting.total}…`
                          : `표시된 ${filteredDocuments.filter(canReparse).length}개 모두 Docling으로 다시 읽기`}
                      </button>
                    )}
                  <button
                    type="button"
                    onClick={() => setShowParserGuide((v) => !v)}
                    className="ml-auto rounded-full border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-500 hover:border-violet-400 dark:border-zinc-700 dark:text-zinc-400"
                    aria-expanded={showParserGuide}
                  >
                    ? 표식 안내
                  </button>
                </div>
                {showParserGuide && (
                  <div className="mt-3 space-y-2 rounded border border-slate-200 bg-slate-50 p-3 text-[11px] leading-5 text-slate-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
                    <p className="font-semibold text-slate-700 dark:text-zinc-200">
                      Docling으로 읽을 수 있는 형식(PDF·PPT/PPTX/ODP)을 실제로
                      무엇으로 읽었나
                    </p>
                    <p className="text-slate-500 dark:text-zinc-500">
                      HWP·DOCX·XLSX·MD는 전용 파서가 있어 Docling 대상이
                      아닙니다. 목록에 흐린 &quot;대상 아님&quot; 표식이 붙고 아래
                      칩에는 포함되지 않습니다. 조치할 것이 없습니다.
                    </p>
                    <p>
                      <span className={`mr-1 rounded-full px-1.5 py-0.5 font-semibold ${PARSER_BADGE_CLASS.docling}`}>Docling</span>
                      Docling으로 읽음. 표 구조·소제목이 살아 있어 가장
                      정확합니다.
                    </p>
                    <p>
                      <span className={`mr-1 rounded-full px-1.5 py-0.5 font-semibold ${PARSER_BADGE_CLASS["docling-partial"]}`}>Docling(일부)</span>
                      큰 문서를 읽다 일부 구간만 실패해 그 부분은 기본 파서로
                      읽음. Docling을 켜고 다시 읽으면 나아질 수 있습니다.
                    </p>
                    <p>
                      <span className={`mr-1 rounded-full px-1.5 py-0.5 font-semibold ${PARSER_BADGE_CLASS.basic}`}>기본 파서</span>
                      Docling 없이 읽음(적재 때 꺼져 있었거나 실패). 글은
                      읽히지만 표 구조는 약합니다. 이 칩으로 걸러 전체 선택한 뒤
                      Docling을 켜고 &quot;Docling으로 다시 읽기&quot;를
                      누르세요.
                    </p>
                    <p>
                      <span className={`mr-1 rounded-full px-1.5 py-0.5 font-semibold ${PARSER_BADGE_CLASS.image}`}>이미지 PDF</span>
                      텍스트 층이 없는 스캔본. Docling으로도 한글 OCR이 약해
                      본문이 비어 있습니다(향후 비전 처리 대상).
                    </p>
                    <p className="pt-1 text-slate-500 dark:text-zinc-500">
                      Docling은 <b>적재할 때만</b> 쓰입니다. 적재가 끝난 문서는
                      Docling을 꺼도 검색 결과가 그대로입니다. 칩을 누르면 해당
                      문서만 걸러 보이고, 다시 누르면 해제됩니다.
                    </p>
                  </div>
                )}
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
                      {parserInfo(document) && (
                        <span
                          className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${PARSER_BADGE_CLASS[parserInfo(document).kind]}`}
                          title="이 문서를 읽을 때 사용한 파서"
                        >
                          {parserInfo(document).label}
                        </span>
                      )}
                      {isConvertible(document) &&
                        (isPdfConverted(document) ? (
                          <span className="shrink-0 rounded-full bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                            PDF 변환됨
                          </span>
                        ) : (
                          <span className="shrink-0 rounded-full bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                            PDF 미변환
                          </span>
                        ))}
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
              converting={converting}
              onConvert={(document) => convertToPdf([document])}
              onReparse={(document) => reparseWithDocling([document])}
              canReparse={selected ? canReparse(selected) : false}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

function DocumentDetail({
  document,
  classification,
  converting,
  onConvert,
  onReparse,
  canReparse,
}) {
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
    ? withClientParam(`${API_BASE}/document/raw/${document.docId}`)
    : null;
  return (
    <aside className="min-h-0 overflow-y-auto border border-slate-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-[11px] font-semibold text-slate-400 dark:text-zinc-600">
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
        {parserInfo(document) && (
          <div>
            <dt className="text-slate-400 dark:text-zinc-600">읽은 파서</dt>
            <dd className="mt-1 text-slate-700 dark:text-zinc-300">
              {parserInfo(document).label}
              {safeMetadata(document.metadata).parse_path && (
                <span className="ml-1 text-[10px] text-slate-400 dark:text-zinc-600">
                  ({safeMetadata(document.metadata).parse_path})
                </span>
              )}
            </dd>
          </div>
        )}
        {isConvertible(document) && (
          <div>
            <dt className="text-slate-400 dark:text-zinc-600">PDF 변환</dt>
            <dd
              className={`mt-1 font-semibold ${isPdfConverted(document) ? "text-blue-700 dark:text-blue-300" : "text-amber-700 dark:text-amber-300"}`}
            >
              {isPdfConverted(document)
                ? "변환됨 (쪽 단위로 읽는 중)"
                : "미변환 (텍스트만 추출됨)"}
            </dd>
          </div>
        )}
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
      {canReparse && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => onReparse(document)}
            disabled={!!converting}
            className="inline-flex w-full items-center justify-center rounded bg-violet-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:opacity-50"
          >
            {converting?.mode === "docling"
              ? `Docling 처리 중… (${converting.done + 1}/${converting.total})`
              : "Docling으로 다시 읽기"}
          </button>
          <p className="mt-1.5 text-[10px] leading-4 text-slate-400 dark:text-zinc-600">
            Docling을 켠 상태에서 이 문서를 다시 읽어 표·구조를 살립니다.
            Docling으로 읽지 못하면 기존 내용은 그대로 둡니다.
          </p>
        </div>
      )}
      {isConvertible(document) && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => onConvert(document)}
            disabled={!!converting}
            className="inline-flex w-full items-center justify-center rounded bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {converting && converting.mode !== "docling"
              ? `변환 중… (${converting.done + 1}/${converting.total})`
              : isPdfConverted(document)
                ? "PDF로 다시 변환"
                : "PDF로 변환해 다시 읽기"}
          </button>
          <p className="mt-1.5 text-[10px] leading-4 text-slate-400 dark:text-zinc-600">
            슬라이드를 쪽 단위로 다시 읽어 쪽 인용·원문 위치 표시가 가능해집니다. 10~30초 걸립니다.
          </p>
        </div>
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
