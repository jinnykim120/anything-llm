const { v4 } = require("uuid");
const {
  createdDate,
  trashFile,
  writeToServerDocuments,
} = require("../../../utils/files");
const { tokenizeString } = require("../../../utils/tokenizer");
const { default: slugify } = require("slugify");
const PDFLoader = require("./PDFLoader");
const OCRLoader = require("../../../utils/OCRLoader");
const {
  linesToBlocks,
  pageTextToBlock,
  blocksToText,
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
  let pdfInfo = null;

  const docling = await parseWithDocling(fullFilePath);
  if (docling.ok) {
    blocks = docling.blocks;
    parsePath = "docling";
  } else {
    const pdfLoader = new PDFLoader(fullFilePath, { splitPages: true });
    let pages = await pdfLoader.load();
    pdfInfo = pages[0]?.metadata?.pdf?.info || null;

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
  const parseConfidence = estimateConfidence(parsePath, blocks, content);

  const data = {
    id: v4(),
    url: "file://" + fullFilePath,
    title: metadata.title || filename,
    docAuthor: metadata.docAuthor || pdfInfo?.Creator || "no author found",
    description: metadata.description || pdfInfo?.Title || "No description found.",
    docSource: metadata.docSource || "pdf file uploaded by the user.",
    chunkSource: metadata.chunkSource || "",
    published: createdDate(fullFilePath),
    wordCount: content.split(" ").length,
    pageContent: content, // backward-compatible flat text
    blocks, // [auto-docu P1a] location-aware units for block-aware chunking
    parse_path: parsePath, // "docling" | "pdfjs" | "ocr"
    parse_confidence: parseConfidence,
    token_count_estimate: tokenizeString(content),
  };

  const document = writeToServerDocuments({
    data,
    filename: `${slugify(filename)}-${data.id}`,
    options: { parseOnly: options.parseOnly },
  });
  if (!options.absolutePath) trashFile(fullFilePath);
  console.log(
    `[SUCCESS]: ${filename} converted (${parsePath}, ${blocks.length} blocks) & ready for embedding.\n`
  );
  return { success: true, reason: null, documents: [document] };
}

// Rough 0..1 signal for "how trustworthy is this parse" — drives the P1b re-parse
// queue later. pdfjs with real bboxes is solid; ocr and text-only are shakier.
function estimateConfidence(parsePath, blocks, content) {
  if (parsePath === "docling") return 0.95;
  if (parsePath === "ocr") return 0.55;
  const withBbox = blocks.filter((b) => Array.isArray(b.bbox)).length;
  const ratio = blocks.length ? withBbox / blocks.length : 0;
  const density = content.length / Math.max(1, blocks.length);
  if (ratio > 0.8 && density > 40) return 0.85;
  if (ratio > 0.5) return 0.7;
  return 0.6;
}

module.exports = asPdf;
