// [auto-docu P2] Opens the ORIGINAL document for a citation and highlights the
// exact region a chunk came from. PDF → pdf.js render + bbox overlay; anything
// without a kept original (text/data files) → the chunk text, as before.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  FileText,
  WarningCircle,
  CaretLeft,
  CaretRight,
  Minus,
  Plus,
  ArrowsOutSimple,
} from "@phosphor-icons/react";
import { decode as HTMLDecode } from "he";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { omitChunkHeader } from "../../ChatHistory/Citation";
import { API_BASE } from "@/utils/constants";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * A chunk's `bbox` is a JSON string holding either a list of rects
 * `[[x0,y0,x1,y1], ...]` (current) or a single rect `[x0,y0,x1,y1]` (legacy).
 * Always returns an array of numeric rects (possibly empty).
 */
function parseRects(bbox) {
  if (!bbox) return [];
  try {
    const a = typeof bbox === "string" ? JSON.parse(bbox) : bbox;
    if (!Array.isArray(a) || a.length === 0) return [];
    const rects = Array.isArray(a[0]) ? a : [a];
    return rects
      .filter((r) => Array.isArray(r) && r.length === 4)
      .map((r) => r.map(Number));
  } catch {
    return [];
  }
}

/**
 * One PDF page rendered to canvas with any number of highlight rectangles.
 * `highlights` is `[{ box:[x0,y0,x1,y1], id }]`; rects whose id matches
 * `activeChunkId` are drawn solid, the rest are dimmed for context.
 */
function PdfPage({
  pdf,
  pageNumber,
  highlights = [],
  activeChunkId,
  active,
  zoom = 1,
}) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [viewport, setViewport] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const targetW = wrapRef.current?.parentElement?.clientWidth || 480;
      const s = Math.min(3, Math.max(0.4, (targetW * zoom) / base.width));
      const vp = page.getViewport({ scale: s });
      if (cancelled) return;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      canvas.width = vp.width;
      canvas.height = vp.height;
      setViewport({ w: base.width, h: base.height });
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber, zoom]);

  useEffect(() => {
    if (active && wrapRef.current)
      wrapRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [active, viewport, zoom]);

  return (
    <div
      ref={wrapRef}
      className="relative mx-auto my-2"
      style={{ width: `${Math.max(0.5, zoom) * 100}%` }}
    >
      <canvas
        ref={canvasRef}
        className="block w-full h-auto rounded shadow-sm"
      />
      {viewport &&
        highlights.map(({ box, id }, i) => {
          // box is in PDF points (scale 1); viewport.{w,h} are the page's point
          // size — so a plain %-of-page position tracks the canvas at any zoom.
          const isActive = !activeChunkId || id === activeChunkId;
          return (
            <div
              key={i}
              className={`absolute rounded-[2px] pointer-events-none ${
                isActive ? "animate-pulse" : ""
              }`}
              style={{
                left: `${(box[0] / viewport.w) * 100}%`,
                top: `${(box[1] / viewport.h) * 100}%`,
                width: `${((box[2] - box[0]) / viewport.w) * 100}%`,
                height: `${((box[3] - box[1]) / viewport.h) * 100}%`,
                background: isActive
                  ? "rgba(250, 204, 21, 0.28)"
                  : "rgba(148, 163, 184, 0.14)",
                border: isActive
                  ? "1.5px solid rgba(202, 138, 4, 0.9)"
                  : "1px solid rgba(148, 163, 184, 0.5)",
              }}
            />
          );
        })}
    </div>
  );
}

export default function SourceViewer({ source, initialChunkId, onClose }) {
  const [pdf, setPdf] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | pdf | text | error
  const [activeChunkId, setActiveChunkId] = useState(
    initialChunkId ?? source?.chunks?.[0]?.id
  );
  const [currentPage, setCurrentPage] = useState(() => {
    const initialChunk =
      source?.chunks?.find((chunk) => chunk.id === initialChunkId) ??
      source?.chunks?.[0];
    return Number(initialChunk?.page) || 1;
  });
  const [zoom, setZoom] = useState(1);

  const rawUrl =
    source?.doc_id && source?.has_original
      ? `${API_BASE}/document/raw/${source.doc_id}`
      : null;

  useEffect(() => {
    let cancelled = false;
    if (!rawUrl) {
      setStatus("text");
      return;
    }
    setStatus("loading");
    (async () => {
      try {
        const res = await fetch(rawUrl);
        if (!res.ok) throw new Error(String(res.status));
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("pdf")) {
          if (!cancelled) setStatus("text"); // docx/xlsx/etc — no in-browser render yet
          return;
        }
        const buf = await res.arrayBuffer();
        const doc = await pdfjsLib.getDocument({ data: buf }).promise;
        if (!cancelled) {
          setPdf(doc);
          setStatus("pdf");
        }
      } catch {
        if (!cancelled) setStatus("text");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rawUrl]);

  // group highlight rects by page for the PDF view
  const pages = useMemo(() => {
    const byPage = new Map();
    for (const c of source?.chunks || []) {
      const p = Number(c.page) || 0;
      if (!p) continue;
      if (!byPage.has(p)) byPage.set(p, []);
      for (const box of parseRects(c.bbox))
        byPage.get(p).push({ box, id: c.id });
    }
    return [...byPage.entries()].sort((a, b) => a[0] - b[0]);
  }, [source]);

  const activeChunk = (source?.chunks || []).find(
    (c) => c.id === activeChunkId
  );
  const activePage = Number(activeChunk?.page) || pages[0]?.[0] || 1;
  const activeSection = (activeChunk?.section_path || "").trim();
  const pageCount = Math.max(
    pdf?.numPages || 1,
    pages[pages.length - 1]?.[0] || 1
  );
  const displayPage = Math.min(Math.max(currentPage, 1), pageCount);
  const visibleHighlights =
    pages.find(([pageNo]) => pageNo === displayPage)?.[1] || [];

  function selectPage(page) {
    const nextPage = Math.min(Math.max(page, 1), pageCount);
    setCurrentPage(nextPage);
    const chunkOnPage = (source?.chunks || []).find(
      (chunk) => Number(chunk.page) === nextPage
    );
    if (chunkOnPage) setActiveChunkId(chunkOnPage.id);
  }

  return (
    <div
      className="ml-4 w-[520px] max-w-[46vw] bg-zinc-900 light:bg-white light:border-2 light:border-slate-300 md:rounded-[16px] flex flex-col overflow-hidden mt-[72px]"
      style={{ maxHeight: "calc(100% - 88px)" }}
    >
      <div className="flex items-start justify-between gap-2 p-4 border-b border-zinc-800 light:border-slate-200">
        <div className="flex items-start gap-2 min-w-0">
          <FileText
            size={18}
            className="text-white/70 light:text-slate-500 flex-shrink-0 mt-[2px]"
          />
          <div className="min-w-0">
            <p className="font-medium text-sm text-white light:text-slate-900 truncate">
              {source?.title}
            </p>
            <div className="flex items-center gap-2 mt-[2px] text-[11px] text-zinc-400 light:text-slate-500">
              {source?.parse_path && <span>{source.parse_path}</span>}
              {activePage > 0 && <span>p.{activePage}</span>}
              {source?.sensitivity && source.sensitivity !== "unclassified" && (
                <span className="text-amber-500">{source.sensitivity}</span>
              )}
            </div>
            {activeSection && (
              <p className="mt-[3px] text-[11px] text-amber-500/90 leading-[15px] break-words">
                {activeSection}
              </p>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          type="button"
          className="text-white/60 light:text-slate-400 hover:text-white light:hover:text-slate-900 bg-transparent border-none cursor-pointer flex-shrink-0"
        >
          <X size={16} weight="bold" />
        </button>
      </div>

      {/* chunk chips — jump between the cited passages */}
      {(source?.chunks?.length || 0) > 1 && (
        <div className="flex flex-wrap gap-1 px-4 py-2 border-b border-zinc-800 light:border-slate-200">
          {source.chunks.map((c, i) => {
            const leaf = (c.section_path || "").split(">").pop().trim();
            const label = c.page
              ? `p.${c.page}${leaf ? ` · ${leaf}` : ""}`
              : leaf || `#${i + 1}`;
            return (
              <button
                key={c.id}
                type="button"
                title={c.section_path || undefined}
                onClick={() => {
                  setActiveChunkId(c.id);
                  if (c.page) setCurrentPage(Number(c.page));
                }}
                className={`text-[11px] px-2 py-[2px] rounded-full border max-w-full truncate ${
                  c.id === activeChunkId
                    ? "border-amber-500 text-amber-500"
                    : "border-zinc-700 light:border-slate-300 text-zinc-400 light:text-slate-500"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {status === "pdf" && pdf && (
        <>
          <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-zinc-800 light:border-slate-200 text-[11px] text-zinc-400 light:text-slate-500">
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="이전 페이지"
                title="이전 페이지"
                disabled={displayPage <= 1}
                onClick={() => selectPage(displayPage - 1)}
                className="rounded p-1 text-zinc-300 light:text-slate-600 hover:bg-white/10 light:hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <CaretLeft size={14} weight="bold" />
              </button>
              <span className="min-w-[54px] text-center tabular-nums">
                p. {displayPage} / {pageCount}
              </span>
              <button
                type="button"
                aria-label="다음 페이지"
                title="다음 페이지"
                disabled={displayPage >= pageCount}
                onClick={() => selectPage(displayPage + 1)}
                className="rounded p-1 text-zinc-300 light:text-slate-600 hover:bg-white/10 light:hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <CaretRight size={14} weight="bold" />
              </button>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="축소"
                title="축소"
                disabled={zoom <= 0.75}
                onClick={() => setZoom((value) => Math.max(0.75, value - 0.1))}
                className="rounded p-1 text-zinc-300 light:text-slate-600 hover:bg-white/10 light:hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Minus size={14} weight="bold" />
              </button>
              <span className="min-w-[42px] text-center tabular-nums">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                aria-label="확대"
                title="확대"
                disabled={zoom >= 2}
                onClick={() => setZoom((value) => Math.min(2, value + 0.1))}
                className="rounded p-1 text-zinc-300 light:text-slate-600 hover:bg-white/10 light:hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Plus size={14} weight="bold" />
              </button>
              <button
                type="button"
                aria-label="폭에 맞추기"
                title="폭에 맞추기"
                onClick={() => setZoom(1)}
                className="ml-1 rounded p-1 text-zinc-300 light:text-slate-600 hover:bg-white/10 light:hover:bg-slate-100"
              >
                <ArrowsOutSimple size={14} weight="bold" />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1 px-4 py-1.5 text-[10px] text-zinc-500 light:text-slate-400">
            <span className="h-2 w-2 rounded-sm border border-amber-600 bg-yellow-300/40" />
            현재 인용 위치
          </div>
        </>
      )}

      <div className="flex-1 overflow-y-auto no-scroll p-3">
        {status === "loading" && (
          <p className="text-sm text-zinc-400 light:text-slate-500 p-4">
            원본을 불러오는 중…
          </p>
        )}

        {status === "pdf" && pdf && (
          <PdfPage
            pdf={pdf}
            pageNumber={displayPage || activePage}
            highlights={visibleHighlights}
            activeChunkId={activeChunkId}
            active
            zoom={zoom}
          />
        )}

        {status === "text" && (
          <div className="p-2 space-y-3">
            {source?.doc_id && (
              <p className="flex items-center gap-1 text-[11px] text-zinc-500 light:text-slate-400">
                <WarningCircle size={13} /> 이 형식은 아직 원본 미리보기를
                지원하지 않습니다 — 인용 텍스트를 표시합니다.
              </p>
            )}
            {(source?.chunks || []).map((c, idx) => (
              <div
                key={c.id || idx}
                className="text-sm text-zinc-100 light:text-slate-900"
              >
                {c.section_path && (
                  <p className="text-[11px] text-zinc-500 light:text-slate-400 mb-1">
                    {c.section_path}
                    {c.page ? ` · p.${c.page}` : ""}
                  </p>
                )}
                <p className="whitespace-pre-line">
                  {HTMLDecode(omitChunkHeader(c.text || ""))}
                </p>
                {idx !== source.chunks.length - 1 && (
                  <hr className="border-zinc-800 light:border-slate-200 mt-3" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
