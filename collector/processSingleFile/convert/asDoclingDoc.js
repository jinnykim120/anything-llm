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

function tableToText(tbl) {
  const grid = tbl?.data?.grid;
  if (Array.isArray(grid) && grid.length) {
    return grid
      .map((row) =>
        row.map((c) => String(c?.text ?? "").replace(/\s+/g, " ").trim()).join(" | ")
      )
      .join("\n");
  }
  const cells = tbl?.data?.table_cells || [];
  return cells.map((c) => String(c?.text ?? "").trim()).filter(Boolean).join(" | ");
}

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
    const prov = Array.isArray(t?.prov) ? t.prov[0] : null;
    const page = prov?.page_no ?? null;
    const { w, h } = sizeOf(page);
    const bbox = bboxFrom(prov, h);

    if (label === "section_header" || label === "title") {
      const level = Number(t?.level) || (label === "title" ? 0 : 1);
      while (sectionStack.length && sectionStack[sectionStack.length - 1].level >= level)
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
      both && block.bbox[1] - prev.bbox[3] >= -4 && block.bbox[1] - prev.bbox[3] < 6;
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

  const stack = [];
  for (const b of merged) {
    if (b.block_type === "heading") {
      // shallow heuristic: shorter / all-caps-ish headings are higher level
      const level = b.text.length <= 24 ? 1 : 2;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: b.text });
    }
    b.section_path = stack.map((s) => s.text).join(" > ") || null;
  }
  return merged;
}

/**
 * @returns {Promise<{ok:boolean, blocks?:object[], parsePath?:string, confidence?:number, reason?:string}>}
 */
async function parseWithDocling(fullFilePath) {
  if (!(await doclingAvailable()))
    return { ok: false, reason: "docling-serve unavailable" };
  try {
    const fd = new FormData();
    fd.append(
      "files",
      new Blob([fs.readFileSync(fullFilePath)]),
      path.basename(fullFilePath)
    );
    fd.append("to_formats", "json");
    fd.append("do_ocr", "true");
    fd.append("do_table_structure", "true");

    const res = await fetchWithTimeout(
      `${DOCLING_URL}/v1/convert/file`,
      { method: "POST", body: fd },
      CONVERT_TIMEOUT_MS
    );
    if (!res.ok) return { ok: false, reason: `docling HTTP ${res.status}` };

    const json = await res.json();
    if (json?.status === "failure")
      return { ok: false, reason: "docling failed to parse" };

    const doc = json?.document?.json_content;
    const blocks = doclingToBlocks(doc);
    if (!blocks.length) return { ok: false, reason: "docling returned no content" };

    const raw = json?.confidence?.mean_score;
    const conf =
      raw === null || raw === undefined || Number.isNaN(Number(raw))
        ? 0.9 // e.g. DOCX/PPTX — no layout model runs, so no score
        : Math.round(Number(raw) * 100) / 100;
    const partial = json?.status === "partial_success";
    return {
      ok: true,
      blocks,
      parsePath: partial ? "docling-partial" : "docling",
      confidence: partial ? Math.min(conf, 0.75) : conf,
    };
  } catch (e) {
    return { ok: false, reason: `docling error: ${e.message}` };
  }
}

module.exports = { doclingAvailable, parseWithDocling, doclingToBlocks };
