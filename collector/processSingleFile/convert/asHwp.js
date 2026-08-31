// [auto-docu P3] 한글(HWP/HWPX) 파서.
//   .hwp   → `hwp-hwpx-parser` (pure Python, Apache-2.0) 로 본문 + 표(마크다운)
//            를 읽기 순서대로 뽑는다. 레이아웃용 표는 셀을 펼쳐 문단으로,
//            진짜 데이터 그리드는 표 블록으로.
//   .hwpx  → OWPML 트리 워크 (jszip + htmlparser2). hwp-hwpx-parser 는 폼처럼
//            전체가 표 하나인 문서(공적서)를 20k자 표 한 덩어리로 만들어서,
//            셀 안까지 재귀하는 자체 워커를 쓴다.
//   두 경로 모두 공유 KO 구조 후처리(조 단위 / 아웃라인 section_path)를 태운다.
//   bbox 없음 (D2: 비-PDF는 문단 앵커).
//
//   HWP_RENDER=1 이면 .hwp를 `hwp5odt` → LibreOffice ODT→PDF → docling으로
//   돌려 page/bbox/표구조를 얻는다. 렌더 PDF가 크게 불어나 docling CPU 파싱이
//   5분+ 걸려 배치엔 부적합 — 기본 끔. (같이 DOCLING_TIMEOUT_MS=900000)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const JSZip = require("jszip");
const htmlparser2 = require("htmlparser2");
const { getChildren, textContent, getElementsByTagName } = require("domutils");
const { trashFile } = require("../../utils/files");
const { finalizeBlocksDoc } = require("../../utils/blocks");
const {
  groupLines,
  buildSectionPaths,
} = require("../../utils/blocks/koStructure");
const { parseWithDocling } = require("./asDoclingDoc");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const VENV = path.join(REPO_ROOT, ".local-cache/docling-venv/Scripts");
const EXE = process.platform === "win32" ? ".exe" : "";
const bin = (name, envKey) =>
  process.env[envKey] || path.join(VENV, `${name}${EXE}`);
const HWP_EXTRACT_PY = path.join(__dirname, "../../utils/hwp/hwp_extract.py");

/** The LibreOffice headless binary (soffice.com), or null. */
function findSoffice() {
  const cands = [
    process.env.SOFFICE_BIN,
    "D:\\LibreOffice\\program\\soffice.com",
    "C:\\Program Files\\LibreOffice\\program\\soffice.com",
    "/usr/bin/soffice",
    "soffice",
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (!c.includes(path.sep) || fs.existsSync(c)) return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
const SOFFICE = findSoffice();

function run(cmd, args, timeout = 120000) {
  return spawnSync(cmd, args, {
    encoding: "utf-8",
    timeout,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
}

const IMG_ALT_RE =
  /(그림입니다\.\s*)?원본 그림의\s*(이름|크기)[^\n|]*?(pixel\s*)?(?=원본 그림의|[|\n]|$)/g;
const ZERO_WIDTH_RE = new RegExp("[\\u200B\\u200C\\uFEFF]", "g");
const clean = (s) =>
  String(s)
    .replace(ZERO_WIDTH_RE, "")
    .replace(IMG_ALT_RE, "")
    .replace(/\s+/g, " ")
    .trim();

function mkBlock(text, idx) {
  return {
    text: clean(text),
    page: null,
    bbox: null,
    anchor: `p:${idx}`,
    page_width: 0,
    page_height: 0,
    section_path: null,
    block_type: "paragraph",
  };
}

// --- .hwp : hwp-hwpx-parser markdown text → blocks -------------------------
const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l) => /^\s*\|[\s|:-]+\|\s*$/.test(l);
const rowCells = (l) =>
  l
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/**
 * hwp-hwpx-parser renders every HWP table as markdown. A grid of short cells is
 * a real data table; a table with a paragraph-sized cell is HWP layout — drop
 * the pipes and let the cell text flow.
 */
function hwpMarkdownToBlocks(text) {
  const items = []; // {kind:"line"|"table", text}
  let tbl = [];
  const emitTbl = () => {
    const rows = tbl.filter((l) => !isSep(l));
    tbl = [];
    if (!rows.length) return;
    const grid = rows.map((r) => rowCells(r).filter(Boolean));
    const bigCell = grid.some((r) => r.some((c) => c.length > 400));
    if (!bigCell && rows.length >= 2 && grid.some((r) => r.length >= 2)) {
      items.push({
        kind: "table",
        text: grid.map((r) => r.join(" | ")).join("\n"),
      });
    } else {
      for (const r of grid)
        for (const c of r) items.push({ kind: "line", text: c });
    }
  };
  for (const l of text.split(/\r?\n/)) {
    if (isRow(l)) {
      tbl.push(l);
      continue;
    }
    emitTbl();
    items.push({ kind: "line", text: l });
  }
  emitTbl();
  return assemble(items);
}

/** items[] (ordered line/table) → blocks: line runs through groupLines. */
function assemble(items) {
  const blocks = [];
  let lineRun = [];
  const flush = () => {
    for (const b of groupLines(lineRun, mkBlock)) blocks.push(b);
    lineRun = [];
  };
  for (const it of items) {
    if (it.kind === "line") lineRun.push(it.text);
    else {
      flush();
      const b = mkBlock(it.text, blocks.length);
      b.block_type = "table";
      blocks.push(b);
    }
  }
  flush();
  blocks.forEach((b, i) => (b.anchor = `p:${i}`));
  return buildSectionPaths(blocks);
}

function extractHwpText(file) {
  const res = run(
    bin("python", "HWP_PYTHON_BIN"),
    [HWP_EXTRACT_PY, file],
    90000
  );
  if (res.status !== 0 || !res.stdout?.trim()) {
    const why = (res.stderr || res.error?.message || "no output")
      .split("\n")
      .find((l) => l.trim());
    throw new Error(`hwp-hwpx-parser: ${why || "failed"}`);
  }
  return res.stdout;
}

// --- .hwpx : OWPML tree walk ---------------------------------------------
const cellText = (tc) => clean(textContent(tc));

function handleTable(tbl, out, ctx) {
  const rows = getChildren(tbl)
    .filter((c) => c.name === "hp:tr")
    .map((tr) => getChildren(tr).filter((c) => c.name === "hp:tc"));
  const cells = rows.flat();
  if (!cells.length) return;
  const isContainer = cells.some(
    (tc) =>
      getElementsByTagName("hp:tbl", tc, true).length > 0 ||
      getElementsByTagName("hp:p", tc, true).length > 2 ||
      cellText(tc).length > 300
  );
  if (isContainer) {
    for (const row of rows) for (const tc of row) walkOwpml(tc, out, ctx);
    flushOwpml(out, ctx);
    return;
  }
  flushOwpml(out, ctx);
  const grid = Math.max(...rows.map((r) => r.length)) >= 2 && rows.length >= 2;
  const text = rows
    .map((r) =>
      r
        .map(cellText)
        .filter(Boolean)
        .join(grid ? " | " : " ")
    )
    .filter(Boolean)
    .join("\n");
  if (text) {
    const b = mkBlock(text, out.length);
    if (grid) b.block_type = "table";
    out.push(b);
  }
}

function walkOwpml(node, out, ctx) {
  for (const child of getChildren(node)) {
    if (child.type === "text") {
      ctx.buf.push(child.data);
      continue;
    }
    if (child.type !== "tag") continue;
    switch (child.name) {
      case "hp:t":
        ctx.buf.push(textContent(child));
        break;
      case "hp:tab":
      case "hp:lineBreak":
        ctx.buf.push(" ");
        break;
      case "hp:tbl":
        handleTable(child, out, ctx);
        break;
      case "hp:tr":
      case "hp:tc":
        break;
      case "hp:p":
        flushOwpml(out, ctx);
        walkOwpml(child, out, ctx);
        flushOwpml(out, ctx);
        break;
      default:
        walkOwpml(child, out, ctx);
    }
  }
}

function flushOwpml(out, ctx) {
  const t = clean(ctx.buf.join(""));
  if (t) out.push(mkBlock(t, out.length));
  ctx.buf = [];
}

async function hwpxToBlocks(fullFilePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(fullFilePath));
  const sections = Object.keys(zip.files)
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort();
  const blocks = [];
  for (const name of sections) {
    const xml = (await zip.files[name].async("string")).replace(
      /<hp:secPr[\s\S]*?<\/hp:secPr>/g,
      ""
    );
    const ctx = { buf: [] };
    walkOwpml(htmlparser2.parseDocument(xml, { xmlMode: true }), blocks, ctx);
    flushOwpml(blocks, ctx);
  }
  blocks.forEach((b, i) => (b.anchor = `p:${i}`));
  return buildSectionPaths(blocks);
}

// --- .hwp → ODT → PDF → docling (opt-in HWP_RENDER; page + bbox) ----------
async function hwpViaRender(hwpPath) {
  if (!SOFFICE) throw new Error("LibreOffice not found");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hwp-"));
  run(bin("hwp5odt", "HWP5ODT_BIN"), [
    "--output",
    path.join(tmp, "d.odt"),
    hwpPath,
  ]);
  if (!fs.existsSync(path.join(tmp, "d.odt")))
    throw new Error("hwp5odt produced no odt");
  const lo = run(
    SOFFICE,
    [
      "--headless",
      "--norestore",
      "--nolockcheck",
      `-env:UserInstallation=file:///${tmp.replace(/\\/g, "/")}/prof`,
      "--convert-to",
      "pdf",
      "--outdir",
      tmp,
      path.join(tmp, "d.odt"),
    ],
    240000
  );
  const pdf = path.join(tmp, "d.pdf");
  if (!fs.existsSync(pdf))
    throw new Error(
      `soffice: ${(lo.stderr || lo.stdout || "no pdf").split("\n").pop()}`
    );
  const d = await parseWithDocling(pdf);
  if (!d.ok || !d.blocks?.length)
    throw new Error(d.reason || "docling returned nothing");
  return { blocks: d.blocks, conf: d.confidence, pdf, tmp };
}

async function asHwp({
  fullFilePath = "",
  filename = "",
  options = {},
  metadata = {},
}) {
  console.log(`-- Working ${filename} --`);
  const ext = path.extname(filename).toLowerCase();

  if (ext === ".hwp" && process.env.HWP_RENDER) {
    let r = null;
    try {
      r = await hwpViaRender(fullFilePath);
    } catch (e) {
      console.error(`[asHwp] render path failed (${e.message}); falling back`);
    }
    if (r) {
      try {
        return finalizeBlocksDoc({
          blocks: r.blocks,
          parsePath: "hwp-libreoffice",
          parseConfidence: r.conf ?? 0.85,
          fullFilePath,
          filename,
          metadata,
          options,
          extra: {
            docSource: "hwp file uploaded by the user.",
            renderFilePath: r.pdf,
          },
        });
      } finally {
        try {
          fs.rmSync(r.tmp, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }

  let blocks = [];
  let reason = null;
  try {
    blocks =
      ext === ".hwpx"
        ? await hwpxToBlocks(fullFilePath)
        : hwpMarkdownToBlocks(extractHwpText(fullFilePath));
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
    parsePath: ext === ".hwpx" ? "hwpx-owpml" : "hwp-parser",
    parseConfidence: 0.75,
    fullFilePath,
    filename,
    metadata,
    options,
    extra: { docSource: "hwp file uploaded by the user." },
  });
}

module.exports = asHwp;
