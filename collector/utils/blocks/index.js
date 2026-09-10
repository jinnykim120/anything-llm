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

// [auto-docu v14 P3] A line set noticeably larger than the page's body text
// (and short) OR one that reads as a Korean structural marker (제N조, 1.2.1,
// Ⅲ.) is a heading. buildSectionPaths() later turns the run of heading blocks
// into each block's section_path.
const { isHeadingText } = require("./koStructure");
const HEADING_SIZE_RATIO = 1.14;
const HEADING_MAX_CHARS = 80;

/** The page's body font size — the size the most *characters* are set in. */
function bodyFontSize(lines) {
  const weight = new Map();
  for (const l of lines) {
    const s = Math.round(Number(l.size) || 0);
    if (!s) continue;
    weight.set(s, (weight.get(s) || 0) + (l.text?.length || 1));
  }
  if (!weight.size) return 0;
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Group a page's lines into paragraph/heading blocks by vertical gap + font size.
 * @param {{text:string, bbox:number[], size?:number}[]} lines  top-to-bottom
 * @param {{page:number, pageWidth:number, pageHeight:number}} ctx
 * @returns {object[]} blocks
 */
function linesToBlocks(
  lines = [],
  { page, pageWidth = 0, pageHeight = 0 } = {}
) {
  const valid = lines.filter((l) => l?.text?.trim() && Array.isArray(l.bbox));
  if (!valid.length) return [];

  const body = bodyFontSize(valid);
  const isBigLine = (l) =>
    body > 0 &&
    Number(l.size) > 0 &&
    l.size >= body * HEADING_SIZE_RATIO &&
    l.text.trim().length <= HEADING_MAX_CHARS &&
    !/[.。!?]\s*$/.test(l.text.trim());
  const isHeadingLine = (l) => isBigLine(l) || isHeadingText(l.text);

  const gaps = [];
  for (let i = 1; i < valid.length; i += 1) {
    gaps.push(valid[i].bbox[1] - valid[i - 1].bbox[3]);
  }
  const positive = gaps.filter((g) => g > 0);
  const minGap = positive.length ? Math.min(...positive) : 0;
  const maxGap = positive.length ? Math.max(...positive) : 0;
  const spread = maxGap - minGap;
  const gapThreshold =
    spread >= MIN_GAP_SPREAD ? minGap + spread * PARA_SPLIT_FRACTION : Infinity; // no real paragraph spacing on this page -> keep as one block

  // A heading line always starts (and ends) its own group.
  const groups = [[valid[0]]];
  for (let i = 1; i < valid.length; i += 1) {
    const startNew =
      gaps[i - 1] > gapThreshold ||
      isHeadingLine(valid[i]) ||
      isHeadingLine(valid[i - 1]);
    if (startNew) groups.push([valid[i]]);
    else groups[groups.length - 1].push(valid[i]);
  }

  return groups.map((g) => ({
    text: g
      .map((l) => l.text)
      .join("\n")
      .trim(),
    page,
    bbox: mergeBbox(g.map((l) => l.bbox)),
    page_width: pageWidth,
    page_height: pageHeight,
    section_path: null,
    block_type: g.length === 1 && isHeadingLine(g[0]) ? "heading" : "paragraph",
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

const crypto = require("crypto");

// [auto-docu P1a'] Keep the original file for types the citation viewer (P2) needs
// to render visually. Plain text / data files don't need it — the parsed text IS
// the document. Extension list, lowercase, no dot.
const KEEP_ORIGINAL_EXTS = new Set([
  "pdf",
  "docx",
  "doc",
  "pptx",
  "ppt",
  "xlsx",
  "xls",
  "hwp",
  "hwpx",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "tiff",
]);

/** Normalize text for a content hash that ignores whitespace/parser noise. */
function normalizeForHash(text) {
  return String(text || "")
    .replace(/<document_metadata>[\s\S]*?<\/document_metadata>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Copy the source file into storage/documents/originals/<slug>-<id>.<ext> so the
 * viewer can fetch it later. Returns the repo-relative path or null.
 */
function keepOriginal({ fullFilePath, id, slug, options }) {
  try {
    const fs = require("fs");
    const path = require("path");
    const { documentsFolder } = require("../files");
    const ext = path.extname(fullFilePath).replace(/^\./, "").toLowerCase();
    if (!KEEP_ORIGINAL_EXTS.has(ext)) return null;
    if (options?.parseOnly) return null; // direct uploads aren't in the library

    const dir = path.resolve(documentsFolder, "originals");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const dest = path.resolve(dir, `${slug}-${id}.${ext}`);
    fs.copyFileSync(fullFilePath, dest);
    return `originals/${slug}-${id}.${ext}`;
  } catch (e) {
    console.error("[keepOriginal] failed:", e.message);
    return null;
  }
}

/**
 * Shared tail for any converter that has produced `blocks`: assemble the document
 * record (with the flat pageContent kept for back-compat) and write it. Used by
 * asPDF / asDocx / (later) asOffice so the block plumbing lives in one place.
 */
function finalizeBlocksDoc({
  blocks,
  parsePath,
  parseConfidence,
  fullFilePath,
  filename,
  metadata = {},
  options = {},
  extra = {},
}) {
  const fs = require("fs");
  const { v4 } = require("uuid");
  const { default: slugify } = require("slugify");
  const { tokenizeString } = require("../tokenizer");
  const {
    createdDate,
    trashFile,
    writeToServerDocuments,
  } = require("../files");

  const content = blocksToText(blocks);
  const id = v4();
  const slug = slugify(filename);

  // [auto-docu P1a'] ingest-time metadata — cheap now, a full re-ingest later.
  let fileHash = null;
  try {
    fileHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(fullFilePath))
      .digest("hex");
  } catch {
    /* file may already be gone on retry */
  }
  const contentHash = crypto
    .createHash("sha256")
    .update(normalizeForHash(content))
    .digest("hex");
  const originalPath = keepOriginal({ fullFilePath, id, slug, options });
  // [auto-docu P3] a viewable PDF render of a non-PDF source (HWP→PDF via
  // LibreOffice). The citation viewer fetches this so HWP citations get the
  // same page + bbox highlight as native PDFs; the true original is still kept.
  const renderPath = extra.renderFilePath
    ? keepOriginal({
        fullFilePath: extra.renderFilePath,
        id,
        slug,
        options,
      })
    : null;

  const data = {
    id,
    url: "file://" + fullFilePath,
    title: metadata.title || extra.title || filename,
    docAuthor: metadata.docAuthor || extra.docAuthor || "no author found",
    description:
      metadata.description || extra.description || "No description found.",
    docSource:
      metadata.docSource || extra.docSource || "file uploaded by the user.",
    chunkSource: metadata.chunkSource || "",
    published: createdDate(fullFilePath),
    wordCount: content.split(" ").length,
    pageContent: content,
    blocks,
    parse_path: parsePath,
    parse_confidence: parseConfidence,
    file_hash: fileHash,
    content_hash: contentHash,
    original_path: originalPath, // repo-relative, or null for text/data files
    render_path: renderPath, // repo-relative PDF render, or null
    sensitivity: metadata.sensitivity || "unclassified", // conservative — treated as confidential until a human confirms otherwise
    token_count_estimate: tokenizeString(content),
  };

  const document = writeToServerDocuments({
    data,
    filename: `${slug}-${id}`,
    options: { parseOnly: options.parseOnly },
  });
  if (!options.absolutePath) trashFile(fullFilePath);
  console.log(
    `[SUCCESS]: ${filename} converted (${parsePath}, ${blocks.length} blocks${
      originalPath ? ", original kept" : ""
    }) & ready for embedding.\n`
  );
  return { success: true, reason: null, documents: [document] };
}

module.exports = {
  linesToBlocks,
  pageTextToBlock,
  plainTextToBlocks,
  blocksToText,
  mergeBbox,
  finalizeBlocksDoc,
  keepOriginal,
  normalizeForHash,
};
