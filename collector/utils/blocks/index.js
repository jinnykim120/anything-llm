// [auto-docu P1a] Turn a parser's per-page output into "blocks" — the parser-agnostic
// unit that carries location metadata through the pipeline. P1a fills these from pdf.js
// (page + rough bbox); P1b (Docling) fills the same shape with section_path / block_type
// / precise bbox. Downstream (server chunker, citation viewer) only reads the shape.
//
// block = {
//   text, page (1-indexed),
//   bbox: [x0,y0,x1,y1] | null   // PDF points, top-left origin
//   page_width, page_height,     // so the frontend can scale to its render
//   section_path: string | null, // P1a: null
//   block_type: "paragraph" | "page" | "heading" | "table" | "figure",
// }

// A vertical gap between lines is a paragraph break when it sits in the upper
// part of the [smallest gap .. largest gap] range for the page. Robust to font
// size (works off the page's own spacing) and to pages with no paragraph
// structure (then min≈max, threshold≈min, nothing splits).
const PARA_SPLIT_FRACTION = 0.4;
const MIN_GAP_SPREAD = 3; // points; below this the page has no real para spacing

function mergeBbox(boxes) {
  const b = boxes.filter(Boolean);
  if (!b.length) return null;
  return [
    Math.min(...b.map((x) => x[0])),
    Math.min(...b.map((x) => x[1])),
    Math.max(...b.map((x) => x[2])),
    Math.max(...b.map((x) => x[3])),
  ].map((n) => Math.round(n * 100) / 100);
}

/**
 * Group a page's lines into paragraph blocks by vertical gap.
 * @param {{text:string, bbox:number[]}[]} lines  ordered top-to-bottom
 * @param {{page:number, pageWidth:number, pageHeight:number}} ctx
 * @returns {object[]} blocks
 */
function linesToBlocks(lines = [], { page, pageWidth = 0, pageHeight = 0 } = {}) {
  const valid = lines.filter((l) => l?.text?.trim() && Array.isArray(l.bbox));
  if (!valid.length) return [];

  const gaps = [];
  for (let i = 1; i < valid.length; i += 1) {
    gaps.push(valid[i].bbox[1] - valid[i - 1].bbox[3]);
  }
  const positive = gaps.filter((g) => g > 0);
  const minGap = positive.length ? Math.min(...positive) : 0;
  const maxGap = positive.length ? Math.max(...positive) : 0;
  const spread = maxGap - minGap;
  const gapThreshold =
    spread >= MIN_GAP_SPREAD
      ? minGap + spread * PARA_SPLIT_FRACTION
      : Infinity; // no real paragraph spacing on this page -> keep as one block

  const groups = [[valid[0]]];
  for (let i = 1; i < valid.length; i += 1) {
    if (gaps[i - 1] > gapThreshold) groups.push([valid[i]]);
    else groups[groups.length - 1].push(valid[i]);
  }

  return groups.map((g) => ({
    text: g.map((l) => l.text).join("\n").trim(),
    page,
    bbox: mergeBbox(g.map((l) => l.bbox)),
    page_width: pageWidth,
    page_height: pageHeight,
    section_path: null,
    block_type: "paragraph",
  }));
}

/**
 * Fallback: one block per page with no bbox (OCR output, or a parser that only
 * gives page text). Still page-anchored so citations can jump to the page.
 */
function pageTextToBlock(text, page) {
  return {
    text: String(text || "").trim(),
    page: page ?? null,
    bbox: null,
    page_width: 0,
    page_height: 0,
    section_path: null,
    block_type: "page",
  };
}

/**
 * Non-PDF text (docx/xlsx/etc): split on blank lines into paragraph-indexed blocks.
 * No page, no bbox — anchor is the paragraph index (D2: non-PDF = paragraph jump).
 */
function plainTextToBlocks(text) {
  const paras = String(text || "")
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paras.map((p, idx) => ({
    text: p,
    page: null,
    bbox: null,
    anchor: `p:${idx}`,
    page_width: 0,
    page_height: 0,
    section_path: null,
    block_type: "paragraph",
  }));
}

/** Total text of a block list, joined for the backward-compatible pageContent string. */
function blocksToText(blocks = []) {
  return blocks
    .map((b) => b.text)
    .filter(Boolean)
    .join("\n\n");
}

module.exports = {
  linesToBlocks,
  pageTextToBlock,
  plainTextToBlocks,
  blocksToText,
  mergeBbox,
};
