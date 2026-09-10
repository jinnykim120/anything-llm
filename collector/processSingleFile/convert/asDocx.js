const mammoth = require("mammoth");
const htmlparser2 = require("htmlparser2");
const { getChildren, textContent } = require("domutils");
const { DocxLoader } = require("langchain/document_loaders/fs/docx");
const { trashFile } = require("../../utils/files");
const { plainTextToBlocks, finalizeBlocksDoc } = require("../../utils/blocks");
const { parseWithDocling } = require("./asDoclingDoc");

// [auto-docu v14 P3] DOCX.
//   1. docling-serve (when up) — richest: section_path + tables + bbox
//   2. mammoth -> HTML -> blocks — keeps headings (h1..h6 => section_path),
//      tables and lists WITHOUT needing Python. This is the default path now
//      (was LangChain's DocxLoader, which returns one flat text blob).
//   3. DocxLoader text — last-resort flat fallback.

const ZERO_WIDTH_RE = new RegExp("[\\u200B\\u200C\\uFEFF]", "g");
const clean = (s) =>
  String(s || "")
    .replace(ZERO_WIDTH_RE, "")
    .replace(/\s+/g, " ")
    .trim();

const mkBlock = (text, type, sectionPath, idx) => ({
  text: clean(text),
  page: null,
  bbox: null,
  anchor: `p:${idx}`,
  page_width: 0,
  page_height: 0,
  section_path: sectionPath || null,
  block_type: type,
});

/** Walk mammoth's HTML into location-free blocks with a heading-derived path. */
function htmlToBlocks(html) {
  const doc = htmlparser2.parseDocument(html);
  const blocks = [];
  const headingStack = []; // { level, text }

  const sectionPath = () => headingStack.map((h) => h.text).join(" > ") || null;

  const tableText = (node) => {
    const rows = [];
    const findRows = (n) => {
      for (const c of getChildren(n)) {
        if (c.type !== "tag") continue;
        if (c.name === "tr") {
          const cells = getChildren(c)
            .filter(
              (x) => x.type === "tag" && (x.name === "td" || x.name === "th")
            )
            .map((x) => clean(textContent(x)));
          if (cells.some(Boolean)) rows.push(cells.join(" | "));
        } else {
          findRows(c);
        }
      }
    };
    findRows(node);
    return rows.join("\n");
  };

  const visit = (node) => {
    for (const child of getChildren(node)) {
      if (child.type !== "tag") continue;
      const name = child.name.toLowerCase();
      const hMatch = /^h([1-6])$/.exec(name);
      if (hMatch) {
        const level = Number(hMatch[1]);
        const text = clean(textContent(child));
        if (!text) continue;
        while (headingStack.length && headingStack.at(-1).level >= level)
          headingStack.pop();
        headingStack.push({ level, text });
        blocks.push(mkBlock(text, "heading", sectionPath(), blocks.length));
      } else if (name === "table") {
        const t = tableText(child);
        if (t) blocks.push(mkBlock(t, "table", sectionPath(), blocks.length));
      } else if (name === "p") {
        const text = clean(textContent(child));
        if (text)
          blocks.push(mkBlock(text, "paragraph", sectionPath(), blocks.length));
      } else if (name === "ul" || name === "ol") {
        const items = (child.children || [])
          .filter((c) => c.type === "tag" && c.name === "li")
          .map((li) => clean(textContent(li)))
          .filter(Boolean);
        if (items.length)
          blocks.push(
            mkBlock(
              items.map((i) => `• ${i}`).join("\n"),
              "paragraph",
              sectionPath(),
              blocks.length
            )
          );
      } else {
        visit(child);
      }
    }
  };
  visit(doc);
  return blocks;
}

async function asDocX({
  fullFilePath = "",
  filename = "",
  options = {},
  metadata = {},
}) {
  console.log(`-- Working ${filename} --`);

  let blocks = [];
  let parsePath = null;
  let parseConfidence = null;

  const docling = await parseWithDocling(fullFilePath);
  if (docling.ok && docling.blocks?.length) {
    blocks = docling.blocks;
    parsePath = docling.parsePath || "docling";
    parseConfidence = docling.confidence ?? 0.9;
  } else {
    try {
      const { value: html } = await mammoth.convertToHtml({
        path: fullFilePath,
      });
      blocks = htmlToBlocks(html);
      parsePath = "docx-mammoth";
      parseConfidence = blocks.length ? 0.8 : 0;
    } catch (e) {
      console.error(`mammoth failed for ${filename}: ${e.message}`);
    }

    if (!blocks.length) {
      const docs = await new DocxLoader(fullFilePath).load().catch(() => []);
      const text = docs
        .map((d) => d.pageContent)
        .filter((t) => t && t.length)
        .join("\n\n");
      blocks = plainTextToBlocks(text);
      parsePath = "docx-text";
      parseConfidence = blocks.length ? 0.6 : 0;
    }
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
