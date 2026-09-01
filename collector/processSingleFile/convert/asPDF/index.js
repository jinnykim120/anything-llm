const { trashFile } = require("../../../utils/files");
const PDFLoader = require("./PDFLoader");
const OCRLoader = require("../../../utils/OCRLoader");
const {
  linesToBlocks,
  pageTextToBlock,
  blocksToText,
  finalizeBlocksDoc,
} = require("../../../utils/blocks");
const { parseWithDocling } = require("../asDoclingDoc");

async function asPdf({
  fullFilePath = "",
  filename = "",
  options = {},
  metadata = {},
}) {
  console.log(`-- Working ${filename} --`);

  // [auto-docu P1a] Blocks carry page + bbox through the pipeline. Three ways to fill
  // them, best first:
  //   1. docling-serve (P1b) — section_path, block_type, precise bbox  [when configured]
  //   2. pdf.js (P1a)         — page + rough paragraph bbox            [default]
  //   3. OCR fallback         — page-level text, no bbox               [scanned/empty]
  let blocks = [];
  let parsePath = null;
  let doclingConfidence = null;
  let pdfInfo = null;

  // [auto-docu] Probe the text layer up front. docling + RapidOCR on CPU is
  // ~80s/page, so a digital PDF (real text layer) must be parsed with OCR OFF —
  // it costs nothing in quality and ~20x in speed. Only a scanned/image PDF
  // (no text layer) gets do_ocr. The loaded pages are reused by the fallback
  // path so the PDF is never read twice.
  const pdfLoader = new PDFLoader(fullFilePath, { splitPages: true });
  let pages = await pdfLoader.load();
  pdfInfo = pages[0]?.metadata?.pdf?.info || null;
  const textChars = pages.reduce(
    (n, p) => n + (p.pageContent?.trim().length || 0),
    0
  );
  const hasTextLayer = textChars > 200;

  const docling = await parseWithDocling(fullFilePath, {
    doOcr: !hasTextLayer,
  });
  if (docling.ok) {
    blocks = docling.blocks;
    parsePath = docling.parsePath || "docling";
    doclingConfidence = docling.confidence ?? null;
  } else {
    if (pages.length === 0 || !pages.some((p) => p.pageContent?.length)) {
      console.log(
        `[asPDF] No embedded text for ${filename}. Attempting OCR parse.`
      );
      const ocrPages = await new OCRLoader({
        targetLanguages: options?.ocr?.langList,
      }).ocrPDF(fullFilePath);
      blocks = ocrPages
        .filter((p) => p.pageContent?.length)
        .map((p, i) =>
          pageTextToBlock(p.pageContent, p.metadata?.loc?.pageNumber ?? i + 1)
        );
      parsePath = "ocr";
    } else {
      for (const page of pages) {
        console.log(
          `-- Parsing content from pg ${
            page.metadata?.loc?.pageNumber || "unknown"
          } --`
        );
        if (!page.pageContent?.length) continue;
        const pageNo = page.metadata?.loc?.pageNumber ?? null;
        const pageBlocks = linesToBlocks(page.lines, {
          page: pageNo,
          pageWidth: page.pageWidth,
          pageHeight: page.pageHeight,
        });
        // if line data was unavailable, degrade to one block per page (still page-anchored)
        blocks.push(
          ...(pageBlocks.length
            ? pageBlocks
            : [pageTextToBlock(page.pageContent, pageNo)])
        );
      }
      parsePath = "pdfjs";
    }
  }

  if (!blocks.length) {
    console.error(`[asPDF] Resulting text content was empty for ${filename}.`);
    if (!options.absolutePath) trashFile(fullFilePath);
    return {
      success: false,
      reason: `No text content found in ${filename}.`,
      documents: [],
    };
  }

  const content = blocksToText(blocks);
  const parseConfidence =
    doclingConfidence != null
      ? doclingConfidence
      : estimateConfidence(parsePath, blocks, content);

  return finalizeBlocksDoc({
    blocks,
    parsePath,
    parseConfidence,
    fullFilePath,
    filename,
    metadata,
    options,
    extra: {
      docAuthor: pdfInfo?.Creator,
      description: pdfInfo?.Title,
      docSource: "pdf file uploaded by the user.",
    },
  });
}

// Rough 0..1 signal for "how trustworthy is this parse" — drives the P1b re-parse
// queue later. pdfjs with real bboxes is solid; ocr and text-only are shakier.
function estimateConfidence(parsePath, blocks, content) {
  if (parsePath === "ocr") return 0.55;
  const withBbox = blocks.filter((b) => Array.isArray(b.bbox)).length;
  const ratio = blocks.length ? withBbox / blocks.length : 0;
  const density = content.length / Math.max(1, blocks.length);
  if (ratio > 0.8 && density > 40) return 0.85;
  if (ratio > 0.5) return 0.7;
  return 0.6;
}

module.exports = asPdf;
