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

// --- Korean legal / regulatory structure ------------------------------------
// Statutes, 시행령·시행규칙, 고시·예규·지침 are organised 편 > 장 > 절 > 관 > 조.
// The layout model reliably tags 장/절 as headings but NOT the 조 lines
// ("제7조(상품대금 감액의 금지) ① …") — those open an ordinary text/list block —
// so without help a citation can't say which article it came from. Detect them.
const KO_UNIT_LEVEL = { 편: 1, 장: 2, 절: 3, 관: 4 };
const KO_CONTAINER_RE = /^제\s*\d+\s*(편|장|절|관)(?:\s|의|$)/;
const KO_ARTICLE_RE = /^(제\s*\d+\s*조(?:\s*의\s*\d+)?)\s*\(([^)]{1,80})\)/;
const KO_FOOTER_RE = /^법제처\s+\d+\s+국가법령정보센터$/;
// "headings" the layout model emits that are really annotations, not sections.
const KO_HEADING_JUNK_RE =
  /^(\[[^\]]*\]|<[^>]*>|\d{4}\s*\.\s*\d+\s*\.\s*\d+\s*\.?\s*>?)$/;

/** Classify a block's leading text as a Korean legal structural marker. */
function koStructOf(rawText) {
  const s = String(rawText || "")
    .replace(/\s+/g, " ")
    .trim();
  const c = s.match(KO_CONTAINER_RE);
  if (c) return { level: KO_UNIT_LEVEL[c[1]], label: s.slice(0, 60).trim() };
  if (/^부칙(\s|<|$)/.test(s)) return { level: 2, label: "부칙" };
  const a = s.match(KO_ARTICLE_RE);
  if (a) {
    const after = s.slice(a[0].length).trim();
    // A run of "제N조(제목) 제M조(제목) …" is a table-of-contents line, not an
    // article body. (An in-text reference like "제20조부터 제26조까지" is a body —
    // it has no parenthesised article title right after the 조 number.)
    if (/^제\s*\d+\s*조(?:\s*의\s*\d+)?\s*\(/.test(after)) return { toc: true };
    return {
      article: true,
      level: 5,
      label: `${a[1].replace(/\s+/g, "")}(${a[2].replace(/\s+/g, " ").trim()})`,
      hasBody: after.length > 0,
    };
  }
  return null;
}

// --- Outline-numbered headings ---------------------------------------------
// 예규·지침·고시·가이드라인 use "I. / Ⅱ. / 1. / 1.1. / 1.2.1." outlines. The layout
// model tags them as headings but gives no depth, so a length heuristic
// flattens the hierarchy. Derive the depth from the number itself.
const OUTLINE_ROMAN_RE = /^([IVXLC]{1,5}|[Ⅰ-Ⅻ])\.\s+\S/;
const OUTLINE_NUM_RE = /^(\d{1,2}(?:\.\d{1,2}){0,4})\.?\s+\S/;
const OUTLINE_KO_ORD_RE = /^([가-힣])\.\s+\S/; // 가. 나. 다.

/** Heading depth from an outline number, or null if the text isn't one. */
function outlineLevel(rawText) {
  const s = String(rawText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (OUTLINE_ROMAN_RE.test(s)) return 1;
  const n = s.match(OUTLINE_NUM_RE);
  if (n) return 1 + n[1].split(".").length; // "1."→2, "1.1."→3, "1.2.1."→4
  if (OUTLINE_KO_ORD_RE.test(s)) return 6;
  return null;
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

  // Rebuild section_path. A Korean legal document (>= 3 real article bodies)
  // gets a 편/장/절/관/조-aware hierarchy; anything else keeps the generic
  // heading stack. Both drop annotation "headings" (<개정 …>, [본조신설 …]).
  const structs = merged.map((b) => koStructOf(b.text));
  const koLegal = structs.filter((k) => k?.article && k.hasBody).length >= 3;

  if (koLegal) {
    const stack = [];
    const cleaned = [];
    let seenBody = false; // past the table of contents?
    for (let i = 0; i < merged.length; i += 1) {
      const b = merged[i];
      const s = b.text.replace(/\s+/g, " ").trim();
      if (KO_FOOTER_RE.test(s)) continue; // running footer — pure noise
      const k = structs[i];
      if (k?.toc) {
        if (b.block_type === "heading") b.block_type = "paragraph";
      } else if (k && (!k.article || k.hasBody)) {
        while (stack.length && stack[stack.length - 1].level >= k.level)
          stack.pop();
        stack.push({ level: k.level, text: k.label });
        if (k.article) {
          b.block_type = "heading";
          seenBody = true;
        }
      } else if (b.block_type === "heading" && KO_HEADING_JUNK_RE.test(s)) {
        b.block_type = "paragraph"; // annotation, not a section
      } else if (!seenBody) {
        // ToC entries + page boilerplate ahead of the first article — the stack
        // still holds ToC chapter headers that don't apply here.
        b.section_path = null;
        cleaned.push(b);
        continue;
      }
      b.section_path = stack.map((x) => x.text).join(" > ") || null;
      cleaned.push(b);
    }
    return cleaned;
  }

  const stack = [];
  const anyOutline = merged.some(
    (b) => b.block_type === "heading" && outlineLevel(b.text) != null
  );
  for (const b of merged) {
    if (b.block_type === "heading") {
      const t = b.text.replace(/\s+/g, " ").trim();
      if (KO_HEADING_JUNK_RE.test(t)) {
        b.block_type = "paragraph";
      } else {
        // Prefer the outline number's own depth; fall back to a length heuristic
        // (a doc with an outline still has a non-numbered title/appendix).
        const level =
          outlineLevel(t) ?? (anyOutline ? 1 : b.text.length <= 24 ? 1 : 2);
        const num = t.match(OUTLINE_NUM_RE)?.[1] ?? null;
        // Numbered headings pop by number prefix ("2.1" clears a stale "1"),
        // since intermediate levels ("2.") are often missing from the parse;
        // everything else pops by level.
        while (stack.length) {
          const top = stack[stack.length - 1];
          if (num && top.num) {
            if (num !== top.num && `${num}.`.startsWith(`${top.num}.`)) break;
          } else if (top.level < level) {
            break;
          }
          stack.pop();
        }
        stack.push({ level, text: b.text, num });
      }
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
    if (!blocks.length)
      return { ok: false, reason: "docling returned no content" };

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
