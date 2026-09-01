const { trashFile } = require("../../utils/files");
const { plainTextToBlocks, finalizeBlocksDoc } = require("../../utils/blocks");
const { parseWithDocling } = require("./asDoclingDoc");
const officeParser = require("officeparser");
const path = require("path");

// [auto-docu P1b] PPTX / ODP / ODT.
//
// The old path was officeparser → one flat blob, and PowerPoint decks came out
// with every line duplicated (master + slide) and no slide boundaries. Docling
// parses these with per-slide page numbers and table structure, so prefer it;
// fall back to officeparser (paragraph-indexed anchors) when docling-serve is
// down.
async function asOffice({
  fullFilePath = "",
  filename = "",
  options = {},
  metadata = {},
}) {
  console.log(`-- Working ${filename} --`);
  const ext = path.extname(filename).toLowerCase().replace(".", "") || "office";

  let blocks = [];
  let parsePath = null;
  let parseConfidence = null;

  // These formats carry no PDF-style text layer to probe, so OCR is off — a
  // scanned/image-only slide is a Gemini-vision job later, not RapidOCR here.
  const docling = await parseWithDocling(fullFilePath, { doOcr: false });
  if (docling.ok && docling.blocks?.length) {
    blocks = dedupeConsecutive(docling.blocks);
    parsePath = docling.parsePath || "docling";
    parseConfidence = docling.confidence ?? 0.9;
  } else {
    let text = "";
    try {
      text = await officeParser.parseOfficeAsync(fullFilePath);
    } catch (e) {
      console.error(`officeparser failed for ${filename}:`, e.message);
    }
    blocks = plainTextToBlocks(dedupeLines(text));
    parsePath = `${ext}-text`;
    parseConfidence = blocks.length ? 0.6 : 0;
  }

  if (!blocks.length) {
    console.error(`Resulting text content was empty for ${filename}.`);
    if (!options.absolutePath) trashFile(fullFilePath);
    return {
      success: false,
      reason: `No text content found in ${filename}.`,
      documents: [],
    };
  }

  return finalizeBlocksDoc({
    blocks,
    parsePath,
    parseConfidence,
    fullFilePath,
    filename,
    metadata,
    options,
    extra: { docSource: `${ext} file uploaded by the user.` },
  });
}

/** Drop a block whose (trimmed) text equals the previous block's. */
function dedupeConsecutive(blocks = []) {
  const out = [];
  let prev = null;
  for (const b of blocks) {
    const t = String(b.text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (t && t === prev) continue;
    prev = t;
    out.push(b);
  }
  return out;
}

/** officeparser repeats every PowerPoint line (master + slide) — collapse runs. */
function dedupeLines(text = "") {
  const seen = [];
  let prev = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (t && t === prev) continue;
    prev = t;
    seen.push(raw);
  }
  return seen.join("\n");
}

module.exports = asOffice;
