// [auto-docu P3] 한글(HWP/HWPX) 파서.
//   .hwp   → pyhwp `hwp5txt` 평문 → heading-aware 그룹핑. 빠르고(≈1s) 산문
//            품질이 좋다. 데이터 표는 `<표>`로 표시되어 빠짐. bbox 없음.
//   .hwpx  → 네이티브 OWPML 트리 워크 (zip + htmlparser2/domutils): 문단은
//            문단으로, 데이터 그리드는 표 블록으로, 레이아웃용 표는 셀 안으로
//            재귀해서 펼침. 임베드 이미지의 "그림입니다…" alt-text 제거.
//
//   HWP_RENDER=1 이면 .hwp를 `hwp5odt` → LibreOffice ODT→PDF → docling으로
//   돌려 page/bbox/표구조를 얻는다. LibreOffice 내장 HWP 필터는 옛 3.0
//   포맷만 읽으므로 hwp5odt로 ODT를 먼저 만들어야 하고, 렌더 PDF가
//   20~30페이지로 불어나 docling CPU 파싱이 5분+ 걸린다 — 배치엔 부적합해
//   기본은 끔. 개별 중요 문서에만. (같이: DOCLING_TIMEOUT_MS=900000)
//
// 모든 경로가 공유 KO 구조 후처리(조 단위 / 아웃라인 section_path)를 태운다.
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
  markHeadings,
  buildSectionPaths,
} = require("../../utils/blocks/koStructure");
const { parseWithDocling } = require("./asDoclingDoc");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const VENV_SCRIPTS = path.join(REPO_ROOT, ".local-cache/docling-venv/Scripts");
const EXE = process.platform === "win32" ? ".exe" : "";
const hwp5bin = (name) =>
  process.env[`${name.toUpperCase()}_BIN`] ||
  path.join(VENV_SCRIPTS, `${name}${EXE}`);

/** The LibreOffice headless binary (soffice.com — console variant), or null. */
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

function run(bin, args, timeout = 120000) {
  return spawnSync(bin, args, {
    encoding: "utf-8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
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

// --- .hwp → ODT → PDF → docling (best: page + bbox) ------------------------
async function hwpViaRender(hwpPath) {
  if (!SOFFICE) throw new Error("LibreOffice not found");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hwp-"));
  const odt = run(
    hwp5bin("hwp5odt"),
    ["--output", path.join(tmp, "d.odt"), hwpPath],
    120000
  );
  if (!fs.existsSync(path.join(tmp, "d.odt")))
    throw new Error(`hwp5odt: ${(odt.stderr || "no odt").split("\n")[0]}`);
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
  return {
    blocks: d.blocks,
    parsePath: "hwp-libreoffice",
    conf: d.confidence,
    pdf,
    tmp,
  };
}

// --- .hwp → hwp5txt (fallback: prose only, no bbox) -----------------------
function hwpViaText(hwpPath) {
  const res = run(hwp5bin("hwp5txt"), [hwpPath], 120000);
  if (res.status !== 0 || !res.stdout?.trim())
    throw new Error(
      `hwp5txt: ${(res.stderr || res.error?.message || "no output")
        .split("\n")
        .find((l) => l.trim())}`
    );
  return buildSectionPaths(groupLines(res.stdout.split(/\r?\n/), mkBlock));
}

// --- .hwpx → native OWPML tree walk (paragraphs + tables, no bbox) --------
// OWPML nests tables/images inside a run: <hp:p><hp:run><hp:t>|<hp:tbl>…. Walk
// runs so text and tables come out as separate ordered blocks.
// zero-width joiner/space/BOM + the "그림입니다. 원본 그림의 …" alt-text HWP
// stamps on every embedded image.
const IMG_ALT_RE = /그림입니다\.\s*원본 그림의[^\n]*(pixel[)\s]*)?/g;
const ZERO_WIDTH_RE = new RegExp("[\\u200B\\u200C\\uFEFF]", "g");
const clean = (s) =>
  String(s)
    .replace(ZERO_WIDTH_RE, "")
    .replace(IMG_ALT_RE, "")
    .replace(/\s+/g, " ")
    .trim();
const cellText = (tc) => clean(textContent(tc));

/**
 * A HWP table is either a real data grid or a layout container (HWP wraps
 * whole sections in a 1-2 cell table for indentation). Grid → one table block;
 * container → recurse so each cell's paragraphs/sub-tables come out normally.
 */
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
    flushPara(out, ctx);
    return;
  }

  flushPara(out, ctx);
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
        break; // reached only via handleTable's recursion, which passes the tc
      case "hp:p":
        flushPara(out, ctx);
        walkOwpml(child, out, ctx);
        flushPara(out, ctx);
        break;
      default:
        walkOwpml(child, out, ctx);
    }
  }
}

function flushPara(out, ctx) {
  const t = clean(ctx.buf.join(""));
  if (t) out.push(mkBlock(t, out.length));
  ctx.buf = [];
}

async function hwpxViaOwpml(buf) {
  const zip = await JSZip.loadAsync(buf);
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
    flushPara(blocks, ctx);
  }
  return buildSectionPaths(markHeadings(blocks));
}

async function asHwp({
  fullFilePath = "",
  filename = "",
  options = {},
  metadata = {},
}) {
  console.log(`-- Working ${filename} --`);
  const ext = path.extname(filename).toLowerCase();

  // .hwp — opt-in render path (HWP_RENDER=1) for real page/bbox; slow.
  if (ext === ".hwp" && process.env.HWP_RENDER) {
    let rendered = null;
    try {
      rendered = await hwpViaRender(fullFilePath);
    } catch (e) {
      console.error(`[asHwp] render path failed (${e.message}); using hwp5txt`);
    }
    if (rendered) {
      try {
        return finalizeBlocksDoc({
          blocks: rendered.blocks,
          parsePath: rendered.parsePath,
          parseConfidence: rendered.conf ?? 0.85,
          fullFilePath, // keep the .hwp as the true original
          filename,
          metadata,
          options,
          extra: {
            docSource: "hwp file uploaded by the user.",
            renderFilePath: rendered.pdf, // viewer renders this
          },
        });
      } finally {
        try {
          fs.rmSync(rendered.tmp, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }

  // Native fallback (.hwp text, or .hwpx).
  let blocks = [];
  let parsePath = null;
  let reason = null;
  try {
    blocks =
      ext === ".hwpx"
        ? await hwpxViaOwpml(fs.readFileSync(fullFilePath))
        : hwpViaText(fullFilePath);
    parsePath = ext === ".hwpx" ? "hwpx-owpml" : "hwp5txt";
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
    parseConfidence: parsePath === "hwpx-owpml" ? 0.7 : 0.6,
    fullFilePath,
    filename,
    metadata,
    options,
    extra: { docSource: "hwp file uploaded by the user." },
  });
}

module.exports = asHwp;
