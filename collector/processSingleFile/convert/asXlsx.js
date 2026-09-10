const xlsx = require("node-xlsx").default;
const { trashFile } = require("../../utils/files");
const { finalizeBlocksDoc } = require("../../utils/blocks");

// [auto-docu v14 P3] XLSX / XLS.
//
// One workbook = one document (was: one document per sheet, which collided when
// Korean sheet names slugified to an empty string). Each sheet becomes a
// `block_type: "table"` block with `section_path` = the sheet name, and rides
// the shared finalizeBlocksDoc tail like every other converter — so it gets a
// content_hash, the kept original, and the splitter's repeat-the-header-on-split
// behaviour for oversized tables.

const cell = (c) =>
  c === null || c === undefined ? "" : String(c).replace(/\s+/g, " ").trim();

/**
 * Generic header-row detection — NO hardcoded column names. The header is the
 * first row with >= 2 non-empty cells; any single-cell rows above it are a
 * title/preamble. This is what virtually every real sheet looks like and it
 * can't misfire the way keyword matching did.
 * @param {string[][]} rows  trimmed cell strings
 * @returns {{headerIndex: number, preamble: string[]}}
 */
function detectHeader(rows) {
  const preamble = [];
  for (let i = 0; i < rows.length; i++) {
    const filled = rows[i].filter(Boolean);
    if (filled.length === 0) continue;
    if (filled.length >= 2) return { headerIndex: i, preamble };
    preamble.push(filled.join(" "));
  }
  return { headerIndex: 0, preamble: [] };
}

/** A sheet's 2D data -> a pipe table string (header + separator + rows). */
function sheetToPipeTable(data) {
  const rows = (Array.isArray(data) ? data : [])
    .map((r) => (Array.isArray(r) ? r.map(cell) : []))
    .filter((r) => r.some(Boolean));
  if (!rows.length) return { table: "", preamble: [] };

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => Array.from({ length: width }, (_, i) => r[i] || "");
  const line = (r) => pad(r).join(" | ");

  const { headerIndex, preamble } = detectHeader(rows);
  const header = line(rows[headerIndex]);
  const sep = Array(width).fill("---").join(" | ");
  const body = rows.filter((_, i) => i > headerIndex).map(line);

  return { table: [header, sep, ...body].join("\n"), preamble };
}

function processWorkbook(fullFilePath) {
  const sheets = xlsx.parse(fullFilePath);
  const blocks = [];
  const sheetNames = [];
  let anchor = 0;

  for (const sheet of sheets) {
    const name = String(sheet?.name || `Sheet${sheetNames.length + 1}`).trim();
    const { table, preamble } = sheetToPipeTable(sheet?.data);
    if (!table) continue;
    sheetNames.push(name);

    for (const p of preamble) {
      if (!p) continue;
      blocks.push({
        text: p,
        page: null,
        bbox: null,
        anchor: `sheet:${name}:p${anchor++}`,
        page_width: 0,
        page_height: 0,
        section_path: name,
        block_type: "paragraph",
      });
    }
    blocks.push({
      text: `${name}\n${table}`,
      page: null,
      bbox: null,
      anchor: `sheet:${name}:t${anchor++}`,
      page_width: 0,
      page_height: 0,
      section_path: name,
      block_type: "table",
    });
  }

  return { blocks, sheetNames };
}

async function asXlsx({
  fullFilePath = "",
  filename = "",
  options = {},
  metadata = {},
}) {
  console.log(`-- Working ${filename} --`);

  let blocks = [];
  let sheetNames = [];
  try {
    ({ blocks, sheetNames } = processWorkbook(fullFilePath));
  } catch (err) {
    console.error("Could not process xlsx file!", err);
    if (!options.absolutePath) trashFile(fullFilePath);
    return {
      success: false,
      reason: `Error processing ${filename}: ${err.message}`,
      documents: [],
    };
  }

  if (!blocks.length) {
    console.error(`No non-empty sheets found in ${filename}.`);
    if (!options.absolutePath) trashFile(fullFilePath);
    return {
      success: false,
      reason: `No non-empty sheets found in ${filename}.`,
      documents: [],
    };
  }

  const sheetList =
    sheetNames.length > 1
      ? ` (Sheets: ${sheetNames.join(", ")})`
      : ` (Sheet: ${sheetNames[0]})`;

  const result = finalizeBlocksDoc({
    blocks,
    parsePath: "xlsx",
    parseConfidence: 0.8,
    fullFilePath,
    filename,
    metadata,
    options,
    extra: {
      title: `${filename}${sheetList}`,
      description: `Spreadsheet: ${filename} — ${sheetNames.length} sheet(s).`,
      docSource: "an xlsx file uploaded by the user.",
    },
  });

  return result;
}

module.exports = asXlsx;
