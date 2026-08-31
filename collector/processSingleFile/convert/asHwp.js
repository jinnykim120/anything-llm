// [auto-docu P1c] 한글(HWP/HWPX) 파서.
//   .hwpx  → 네이티브 OWPML (zip + XML) 텍스트 추출 — 의존성 없음
//   .hwp   → pyhwp `hwp5txt` (docling venv) 평문 추출
// 두 경로 모두 줄 목록으로 정규화한 뒤 heading-aware 그룹핑 + 공유 KO 구조
// 후처리(조 단위 / 아웃라인 section_path)를 태운다. page·bbox 없음, anchor =
// 문단 인덱스 (D2: 비-PDF는 문단 앵커). 레이아웃 표는 텍스트로 흡수된다.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const JSZip = require("jszip");
const { trashFile } = require("../../utils/files");
const { finalizeBlocksDoc } = require("../../utils/blocks");
const {
  groupLines,
  buildSectionPaths,
} = require("../../utils/blocks/koStructure");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const VENV_SCRIPTS = path.join(REPO_ROOT, ".local-cache/docling-venv/Scripts");
const hwp5bin = (name) =>
  process.env[`${name.toUpperCase()}_BIN`] ||
  path.join(
    VENV_SCRIPTS,
    `${name}${process.platform === "win32" ? ".exe" : ""}`
  );

function decodeEntities(s = "") {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(parseInt(n, 16))
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function mkBlock(text, idx) {
  return {
    text: String(text)
      .replace(/[ \t]+/g, " ")
      .trim(),
    page: null,
    bbox: null,
    anchor: `p:${idx}`,
    page_width: 0,
    page_height: 0,
    section_path: null,
    block_type: "paragraph",
  };
}

/** .hwpx — one line per <hp:p>, text from its <hp:t> nodes (order preserved). */
async function hwpxLines(buf) {
  const zip = await JSZip.loadAsync(buf);
  const sections = Object.keys(zip.files)
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort();
  const lines = [];
  for (const name of sections) {
    let xml = await zip.files[name].async("string");
    xml = xml.replace(/<hp:secPr[\s\S]*?<\/hp:secPr>/g, ""); // page-setup noise
    // Non-greedy <hp:p>…</hp:p>: a nested paragraph (table cell) surfaces as its
    // own line — table structure is lost, every bit of text is kept.
    for (const m of xml.matchAll(/<hp:p\b[^>]*>([\s\S]*?)<\/hp:p>/g)) {
      const t = [...m[1].matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)]
        .map((x) => decodeEntities(x[1].replace(/<[^>]+>/g, "")))
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      lines.push(t); // keep blanks — they end a paragraph group
    }
  }
  return lines;
}

/** .hwp — pyhwp hwp5txt plain text, split to lines. */
function hwpLines(fullFilePath) {
  const res = spawnSync(hwp5bin("hwp5txt"), [fullFilePath], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  if (res.status !== 0 || !res.stdout?.trim()) {
    const why = (res.stderr || res.error?.message || "hwp5txt failed")
      .split("\n")
      .find((l) => l.trim());
    throw new Error(`hwp5txt: ${why || "no output"}`);
  }
  return res.stdout.split(/\r?\n/);
}

async function asHwp({
  fullFilePath = "",
  filename = "",
  options = {},
  metadata = {},
}) {
  console.log(`-- Working ${filename} --`);
  const ext = path.extname(filename).toLowerCase();

  let blocks = [];
  let parsePath = null;
  let parseConfidence = 0;
  let reason = null;

  try {
    const lines =
      ext === ".hwpx"
        ? await hwpxLines(fs.readFileSync(fullFilePath))
        : hwpLines(fullFilePath);
    blocks = buildSectionPaths(groupLines(lines, mkBlock));
    parsePath = ext === ".hwpx" ? "hwpx-owpml" : "hwp5txt";
    parseConfidence = blocks.length ? (ext === ".hwpx" ? 0.75 : 0.65) : 0;
  } catch (e) {
    reason = e.message;
  }

  if (!blocks.length) {
    console.error(`[asHwp] no text from ${filename}: ${reason || "unknown"}`);
    if (!options.absolutePath) trashFile(fullFilePath);
    return {
      success: false,
      reason:
        reason || `한글 문서에서 텍스트를 추출하지 못했습니다: ${filename}`,
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
    extra: { docSource: "hwp file uploaded by the user." },
  });
}

module.exports = asHwp;
