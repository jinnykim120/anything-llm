// [auto-docu P1b] Rich parse via a docling-serve instance (official Docling FastAPI,
// native Python 3.12 venv on this box — no Docker/WSL). When DOCLING_SERVE_URL points
// at a healthy instance this replaces the pdf.js path (P1a) with real section_path /
// block_type / table detection / precise bbox / scanned-PDF OCR — same `blocks` shape,
// so nothing downstream changes.
//
//   collector/.env:  DOCLING_SERVE_URL=http://127.0.0.1:5001

const fs = require("fs");
const path = require("path");

const DOCLING_URL = (process.env.DOCLING_SERVE_URL || "").replace(/\/+$/, "");
const HEALTH_TIMEOUT_MS = 2000;
const CONVERT_TIMEOUT_MS = Number(process.env.DOCLING_TIMEOUT_MS || 300000);
const RELEASE_MODELS_AFTER_PARSE =
  process.env.DOCLING_RELEASE_MODELS_AFTER_PARSE === "true";
let activeParses = 0;

// Manual controller + clearTimeout — AbortSignal.timeout() leaves a live timer
// that can surface as an unhandled rejection after a fast fetch resolves (crashes
// the collector under Node's strict unhandled-rejection default).
async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Cheap health probe so the parse router can decide P1a vs P1b per document. */
async function doclingAvailable() {
  if (!DOCLING_URL) return false;
  try {
    const res = await fetchWithTimeout(
      `${DOCLING_URL}/health`,
      {},
      HEALTH_TIMEOUT_MS
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Release Docling's large layout/OCR model cache when the collector is idle. */
async function releaseDoclingModels() {
  if (!RELEASE_MODELS_AFTER_PARSE || activeParses > 0) return;
  try {
    await fetchWithTimeout(
      `${DOCLING_URL}/v1/clear/converters`,
      {},
      HEALTH_TIMEOUT_MS * 5
    );
  } catch {
    // Model release is a memory optimization and must not fail document parsing.
  }
}

function tableToText(tbl) {
  const grid = tbl?.data?.grid;
  if (Array.isArray(grid) && grid.length) {
    return grid
      .map((row) =>
        row
          .map((c) =>
            String(c?.text ?? "")
              .replace(/\s+/g, " ")
              .trim()
          )
          .join(" | ")
      )
      .join("\n");
  }
  const cells = tbl?.data?.table_cells || [];
  return cells
    .map((c) => String(c?.text ?? "").trim())
    .filter(Boolean)
    .join(" | ");
}

// Korean government-document structure (법령 조 단위 · 예규/지침 아웃라인) lives in
// a shared module so the HWP/HWPX converter reuses it.
const { buildSectionPaths } = require("../../utils/blocks/koStructure");

function bboxFrom(prov, pageHeight) {
  if (!prov?.bbox) return null;
  const { l, t: top, r, b } = prov.bbox;
  const flip = prov.bbox.coord_origin === "BOTTOMLEFT" && pageHeight;
  const arr = flip ? [l, pageHeight - top, r, pageHeight - b] : [l, top, r, b];
  return arr.map((n) => Math.round(n * 100) / 100);
}

/** DoclingDocument (json_content) -> our parser-agnostic `blocks`. */
function doclingToBlocks(doc) {
  const pages = doc?.pages || {};
  const sizeOf = (n) => {
    const p = pages?.[n] ?? pages?.[String(n)];
    return { w: p?.size?.width || 0, h: p?.size?.height || 0 };
  };

  /** @type {{page:number|null, top:number, block:object}[]} */
  const items = [];
  const sectionStack = []; // [{level, text}]

  for (const t of doc?.texts || []) {
    const text = (t?.text || "").trim();
    if (!text) continue;
    const label = t?.label || "text";
    // Running page furniture repeats on every page — never content, and if it
    // carries a heading label it would reset the section stack mid-page.
    if (
      label === "page_header" ||
      label === "page_footer" ||
      label === "furniture"
    )
      continue;
    const prov = Array.isArray(t?.prov) ? t.prov[0] : null;
    const page = prov?.page_no ?? null;
    const { w, h } = sizeOf(page);
    const bbox = bboxFrom(prov, h);

    if (label === "section_header" || label === "title") {
      const level = Number(t?.level) || (label === "title" ? 0 : 1);
      while (
        sectionStack.length &&
        sectionStack[sectionStack.length - 1].level >= level
      )
        sectionStack.pop();
      sectionStack.push({ level, text });
    }

    items.push({
      page,
      top: bbox ? bbox[1] : prov?.bbox?.t ? 1e6 - prov.bbox.t : items.length,
      block: {
        text,
        page,
        bbox,
        page_width: w,
        page_height: h,
        section_path: sectionStack.map((s) => s.text).join(" > ") || null,
        block_type:
          label === "section_header" || label === "title"
            ? "heading"
            : label === "list_item"
            ? "list"
            : label === "picture" || label === "figure" || label === "caption"
            ? "figure"
            : "paragraph",
      },
    });
  }

  for (const tbl of doc?.tables || []) {
    const text = tableToText(tbl);
    if (!text) continue;
    const prov = Array.isArray(tbl?.prov) ? tbl.prov[0] : null;
    const page = prov?.page_no ?? null;
    const { w, h } = sizeOf(page);
    const bbox = bboxFrom(prov, h);
    items.push({
      page,
      top: bbox ? bbox[1] : items.length,
      block: {
        text,
        page,
        bbox,
        page_width: w,
        page_height: h,
        section_path: sectionStack.map((s) => s.text).join(" > ") || null,
        block_type: "table",
      },
    });
  }

  // reading order: by page, then top-to-bottom
  items.sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.top - b.top);

  // Docling often fragments a heading — line-wrap, or "1." split from its title,
  // or a single line broken into runs. Merge consecutive heading blocks on the
  // same page that are on the same line OR immediately below, then rebuild
  // section_path from the cleaned headings.
  const merged = [];
  for (const { block } of items) {
    const prev = merged[merged.length - 1];
    const both =
      prev &&
      prev.block_type === "heading" &&
      block.block_type === "heading" &&
      prev.page === block.page &&
      Array.isArray(prev.bbox) &&
      Array.isArray(block.bbox);
    const sameLine = both && Math.abs(block.bbox[1] - prev.bbox[1]) < 4;
    const lineWrap =
      both &&
      block.bbox[1] - prev.bbox[3] >= -4 &&
      block.bbox[1] - prev.bbox[3] < 6;
    if (sameLine || lineWrap) {
      prev.text = `${prev.text} ${block.text}`.replace(/\s+/g, " ").trim();
      prev.bbox = [
        Math.min(prev.bbox[0], block.bbox[0]),
        Math.min(prev.bbox[1], block.bbox[1]),
        Math.max(prev.bbox[2], block.bbox[2]),
        Math.max(prev.bbox[3], block.bbox[3]),
      ];
    } else {
      merged.push({ ...block });
    }
  }

  // 법령 조 단위 / 예규 아웃라인 / 일반 헤딩 스택 — 공유 모듈.
  return buildSectionPaths(merged);
}

// [auto-docu 페이지 분할] 큰 PDF(300쪽급)를 한 번에 보내면 이 PC(16GB, 여유
// 3~4GB)에서 레이아웃 모델이 메모리 부족으로 죽는 걸 실측했다(335쪽 문서,
// 단일 호출). docling-serve는 `page_range` 폼 필드를 지원하고(원본 페이지
// 번호가 그대로 유지됨 — page 29~30 요청 시 결과의 page_no도 29·30), 청킹 없이
// 같은 파일을 여러 번 보내 페이지 구간만 나누면 된다는 걸 확인했다(pdf-lib 같은
// 분할 라이브러리 불필요). 배치 크기는 4쪽 발췌 테스트(~33초/배치, 성공)를
// 근거로 보수적으로 잡는다 — OOM 재현 없이 안정적으로 끝내는 게 우선이다.
const PAGE_BATCH_THRESHOLD = Number(process.env.DOCLING_PAGE_BATCH_THRESHOLD || 20);
const PAGE_BATCH_SIZE = Number(process.env.DOCLING_PAGE_BATCH_SIZE || 10);

/** pdfjs(이미 pdf-parse 의존성에 번들)로 가볍게 쪽수만 센다 — docling 모델을 전혀 안 씀. */
async function getPdfPageCount(fullFilePath) {
  try {
    const pdfjs = await import(
      "pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js"
    );
    const data = new Uint8Array(fs.readFileSync(fullFilePath));
    const doc = await pdfjs.getDocument({ data }).promise;
    return doc.numPages;
  } catch (e) {
    return null; // 못 세면 배치 안 하고 기존 단일 호출 경로로(안전 기본값).
  }
}

/** docling-serve 한 번 호출 — 성공하면 원시 응답 json을 돌려준다(실패 시 throw). */
async function convertOnce(fullFilePath, { doOcr, pageRange } = {}) {
  const fd = new FormData();
  fd.append(
    "files",
    new Blob([fs.readFileSync(fullFilePath)]),
    path.basename(fullFilePath)
  );
  fd.append("to_formats", "json");
  // OCR is opt-in per call — digital PDFs pass doOcr:false (docling + RapidOCR
  // on CPU is ~80s/page). Non-PDF formats ignore it.
  fd.append("do_ocr", doOcr ? "true" : "false");
  fd.append("do_table_structure", "true");
  if (pageRange) {
    fd.append("page_range", String(pageRange[0]));
    fd.append("page_range", String(pageRange[1]));
  }

  const res = await fetchWithTimeout(
    `${DOCLING_URL}/v1/convert/file`,
    { method: "POST", body: fd },
    CONVERT_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`docling HTTP ${res.status}`);
  const json = await res.json();
  if (json?.status === "failure") throw new Error("docling failed to parse");
  return json;
}

function confidenceOf(json) {
  const raw = json?.confidence?.mean_score;
  return raw === null || raw === undefined || Number.isNaN(Number(raw))
    ? 0.9 // e.g. DOCX/PPTX — no layout model runs, so no score
    : Math.round(Number(raw) * 100) / 100;
}

/**
 * @returns {Promise<{ok:boolean, blocks?:object[], parsePath?:string, confidence?:number, reason?:string}>}
 */
async function parseWithDocling(fullFilePath, { doOcr = true } = {}) {
  if (!(await doclingAvailable()))
    return { ok: false, reason: "docling-serve unavailable" };
  activeParses += 1;
  try {
    const isPdf = /\.pdf$/i.test(fullFilePath);
    const pageCount = isPdf ? await getPdfPageCount(fullFilePath) : null;

    if (!pageCount || pageCount <= PAGE_BATCH_THRESHOLD) {
      const json = await convertOnce(fullFilePath, { doOcr });
      const blocks = doclingToBlocks(json?.document?.json_content);
      if (!blocks.length)
        return { ok: false, reason: "docling returned no content" };
      const partial = json?.status === "partial_success";
      return {
        ok: true,
        blocks,
        parsePath: partial ? "docling-partial" : "docling",
        confidence: partial
          ? Math.min(confidenceOf(json), 0.75)
          : confidenceOf(json),
      };
    }

    // 큰 PDF — 쪽 구간별로 순차 호출(동시에 여러 배치를 보내면 메모리 압박이
    // 다시 커져 OOM 재현 위험이 있어 일부러 병렬화하지 않는다).
    const blocks = [];
    let anyPartial = false;
    let confSum = 0;
    let confN = 0;
    let lastSectionPath = null;
    for (let start = 1; start <= pageCount; start += PAGE_BATCH_SIZE) {
      const end = Math.min(start + PAGE_BATCH_SIZE - 1, pageCount);
      let json;
      try {
        json = await convertOnce(fullFilePath, {
          doOcr,
          pageRange: [start, end],
        });
      } catch (e) {
        anyPartial = true; // 이 구간만 건너뛴다 — 문서 전체를 실패시키지 않음.
        continue;
      }
      const batchBlocks = doclingToBlocks(json?.document?.json_content);
      if (json?.status === "partial_success") anyPartial = true;
      if (batchBlocks.length) {
        confSum += confidenceOf(json);
        confN += 1;
      }
      // [auto-docu 페이지 분할] 배치 경계에서 섹션 제목을 잃는 문제 완화 —
      // doclingToBlocks 는 배치(=한 번의 docling 호출)마다 섹션 스택을 새로
      // 시작하므로, 이 배치의 첫 제목이 나오기 전 블록들은 section_path 가
      // 비어 있다. 이전 배치의 마지막 제목을 이어 붙인다(완벽하진 않지만 —
      // 배치 경계가 실제 절 경계와 우연히 겹치면 그래도 비게 된다 — 아예
      // 없는 것보다는 낫다).
      for (const b of batchBlocks) {
        if (!b.section_path && lastSectionPath) b.section_path = lastSectionPath;
        if (b.section_path) lastSectionPath = b.section_path;
      }
      blocks.push(...batchBlocks);
    }
    if (!blocks.length)
      return { ok: false, reason: "docling returned no content" };
    const confidence = confN
      ? Math.round((confSum / confN) * 100) / 100
      : 0.9;
    return {
      ok: true,
      blocks,
      parsePath: anyPartial ? "docling-partial" : "docling",
      confidence: anyPartial ? Math.min(confidence, 0.75) : confidence,
    };
  } catch (e) {
    return { ok: false, reason: `docling error: ${e.message}` };
  } finally {
    activeParses -= 1;
    await releaseDoclingModels();
  }
}

module.exports = { doclingAvailable, parseWithDocling, doclingToBlocks };
