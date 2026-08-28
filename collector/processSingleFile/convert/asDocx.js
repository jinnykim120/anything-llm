const { DocxLoader } = require("langchain/document_loaders/fs/docx");
const { trashFile } = require("../../utils/files");
const {
  plainTextToBlocks,
  finalizeBlocksDoc,
} = require("../../utils/blocks");
const { parseWithDocling } = require("./asDoclingDoc");

async function asDocX({
  fullFilePath = "",
  filename = "",
  options = {},
  metadata = {},
}) {
  console.log(`-- Working ${filename} --`);

  // [auto-docu P1b] Prefer Docling — it gives section_path, block_type and table
  // structure for Word docs. Fall back to LangChain's text-only loader (blocks =
  // paragraph-indexed anchors) when docling-serve is unavailable.
  let blocks = [];
  let parsePath = null;
  let parseConfidence = null;

  const docling = await parseWithDocling(fullFilePath);
  if (docling.ok) {
    blocks = docling.blocks;
    parsePath = docling.parsePath || "docling";
    parseConfidence = docling.confidence ?? 0.9;
  } else {
    const docs = await new DocxLoader(fullFilePath).load();
    const text = docs
      .map((d) => d.pageContent)
      .filter((t) => t && t.length)
      .join("\n\n");
    blocks = plainTextToBlocks(text);
    parsePath = "docx-text";
    parseConfidence = blocks.length ? 0.7 : 0;
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
    extra: { docSource: "docx file uploaded by the user." },
  });
}

module.exports = asDocX;
