// [auto-docu P3] 한글(HWP/HWPX) 파서.
//   .hwp   → pyhwp `hwp5txt` 평문 → heading-aware 그룹핑. 빠르고(≈1s) 산문
//            품질이 좋다. bbox 없음 (D2: 비-PDF는 문단 앵커).
//   .hwpx  → 네이티브 OWPML (zip + regex on <hp:t>).
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
const { trashFile } = require("../../utils/files");
const { finalizeBlocksDoc } = require("../../utils/blocks");
const {
  groupLines,
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

// --- .hwpx → native OWPML (no bbox) --------------------------------------
async function hwpxViaOwpml(buf) {
  const zip = await JSZip.loadAsync(buf);
  const sections = Object.keys(zip.files)
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort();
  const lines = [];
  for (const name of sections) {
    let xml = await zip.files[name].async("string");
    xml = xml.replace(/<hp:secPr[\s\S]*?<\/hp:secPr>/g, "");
    for (const m of xml.matchAll(/<hp:p\b[^>]*>([\s\S]*?)<\/hp:p>/g)) {
      const t = [...m[1].matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)]
        .map((x) => decodeEntities(x[1].replace(/<[^>]+>/g, "")))
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      lines.push(t);
    }
  }
  return buildSectionPaths(groupLines(lines, mkBlock));
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
