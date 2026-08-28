// [auto-docu P1b seam] Rich parse via a docling-serve instance (official Docling
// FastAPI). Not wired up yet on this machine (no Docker / Python <=3.13). When
// DOCLING_SERVE_URL points at a healthy instance this replaces the pdf.js path
// (P1a) with real section_path / block_type / precise bbox — same `blocks` shape,
// so nothing downstream changes.
//
// Enable later:  DOCLING_SERVE_URL=http://127.0.0.1:5001  in collector/.env

const fs = require("fs");
const path = require("path");

const DOCLING_URL = process.env.DOCLING_SERVE_URL || "";
const HEALTH_TIMEOUT_MS = 1500;
const CONVERT_TIMEOUT_MS = Number(process.env.DOCLING_TIMEOUT_MS || 180000);

/** Cheap health probe so asPDF/asOffice can decide P1a vs P1b per document. */
async function doclingAvailable() {
  if (!DOCLING_URL) return false;
  try {
    const ac = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
    const res = await fetch(`${DOCLING_URL}/health`, { signal: ac });
    return res.ok;
  } catch {
    return false;
  }
}

/** DoclingDocument JSON -> our block shape. */
function doclingToBlocks(doc) {
  const out = [];
  const texts = Array.isArray(doc?.texts) ? doc.texts : [];
  // page size lookup
  const pages = doc?.pages || {};
  const sizeOf = (pageNo) => {
    const p = pages?.[pageNo] || pages?.[String(pageNo)];
    return { w: p?.size?.width || 0, h: p?.size?.height || 0 };
  };
  let sectionStack = [];
  for (const t of texts) {
    const label = t?.label || "text";
    const text = (t?.text || "").trim();
    if (!text) continue;
    const prov = Array.isArray(t?.prov) && t.prov[0] ? t.prov[0] : null;
    const page = prov?.page_no ?? null;
    // Docling bbox: {l,t,r,b} with origin BOTTOMLEFT or TOPLEFT (coord_origin)
    let bbox = null;
    if (prov?.bbox) {
      const { l, t: top, r, b } = prov.bbox;
      const { h } = sizeOf(page);
      bbox =
        prov.bbox.coord_origin === "BOTTOMLEFT" && h
          ? [l, h - top, r, h - b].map((n) => Math.round(n * 100) / 100)
          : [l, top, r, b].map((n) => Math.round(n * 100) / 100);
    }
    if (label === "section_header" || label === "title") {
      sectionStack = [text];
    }
    const { w, h } = sizeOf(page);
    out.push({
      text,
      page,
      bbox,
      page_width: w,
      page_height: h,
      section_path: sectionStack.length ? sectionStack.join(" > ") : null,
      block_type:
        label === "section_header" || label === "title"
          ? "heading"
          : label === "table"
            ? "table"
            : label === "picture" || label === "figure"
              ? "figure"
              : "paragraph",
    });
  }
  return out;
}

/**
 * @returns {Promise<{ok: boolean, blocks?: object[], parsePath?: string, reason?: string}>}
 */
async function parseWithDocling(fullFilePath) {
  if (!(await doclingAvailable()))
    return { ok: false, reason: "docling-serve not configured/healthy" };
  try {
    const fd = new FormData();
    const buf = fs.readFileSync(fullFilePath);
    fd.append("files", new Blob([buf]), path.basename(fullFilePath));
    fd.append("to_formats", "json");
    const res = await fetch(`${DOCLING_URL}/v1/convert/file`, {
      method: "POST",
      body: fd,
      signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `docling ${res.status}` };
    const json = await res.json();
    const doc =
      json?.document?.json_content ||
      json?.document ||
      json?.[0]?.document ||
      null;
    const blocks = doclingToBlocks(doc);
    if (!blocks.length) return { ok: false, reason: "docling returned no text" };
    return { ok: true, blocks, parsePath: "docling" };
  } catch (e) {
    return { ok: false, reason: `docling error: ${e.message}` };
  }
}

module.exports = { doclingAvailable, parseWithDocling, doclingToBlocks };
