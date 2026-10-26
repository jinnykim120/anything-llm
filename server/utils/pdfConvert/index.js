// [auto-docu] 문서함의 PPTX/PPT/ODP를 PDF로 변환해 다시 읽히는 기능.
//
// 왜: Docling 없이 올라간 PPTX는 officeparser 폴백(`pptx-text`)으로 처리돼
// 슬라이드 경계·쪽번호가 없고 한두 덩어리 텍스트가 된다. 같은 파일을
// LibreOffice로 PDF로 만들어 기존 PDF 파서(pdfjs/Docling)로 읽으면 슬라이드가
// 한 쪽씩 되어 쪽번호·좌표(bbox)가 생기고, 원문 보기(P2)도 그 PDF를 쓴다.
//
// 방식: 보관된 원본(original_path) → soffice → PDF → collector(/process)로
// 파싱(임시 결과 JSON은 읽고 바로 폐기) → 기존 문서 JSON의 본문/blocks만
// 갈아끼움(id·제목·폴더·해시 유지 → 분류 결과가 따라간다) → 해당 문서를
// 벡터에서 지우고 다시 임베딩.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  documentsPath,
  hotdirPath,
  normalizePath,
  isWithin,
  fileData,
  purgeSourceDocument,
  purgeVectorCache,
} = require("../files");

const CONVERTIBLE_EXTS = new Set(["pptx", "ppt", "odp"]);
const doclingStatus = () => require("../doclingControl").status();

function findSoffice() {
  const cands = [
    process.env.SOFFICE_BIN,
    "D:\\LibreOffice\\program\\soffice.com",
    "C:\\Program Files\\LibreOffice\\program\\soffice.com",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
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

/** srcPath(pptx 등) → 임시 폴더의 PDF 경로. 실패 시 throw. 호출자가 tmp 정리. */
function convertToPdf(srcPath, { timeoutMs = 240000 } = {}) {
  const soffice = findSoffice();
  if (!soffice)
    throw new Error("LibreOffice를 찾지 못했습니다(SOFFICE_BIN 확인).");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pdfconv-"));
  const ext = path.extname(srcPath).toLowerCase() || ".pptx";
  // 한글·특수문자 파일명이 soffice 인자에서 깨지지 않게 단순한 이름으로 복사.
  const input = path.join(tmp, `src${ext}`);
  fs.copyFileSync(srcPath, input);
  const r = spawnSync(
    soffice,
    [
      "--headless",
      "--norestore",
      "--nolockcheck",
      `-env:UserInstallation=${require("url").pathToFileURL(path.join(tmp, "prof")).href}`,
      "--convert-to",
      "pdf",
      "--outdir",
      tmp,
      input,
    ],
    { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }
  );
  const pdf = path.join(tmp, "src.pdf");
  if (!fs.existsSync(pdf)) {
    const why = (r.stderr || r.stdout || "").trim().split("\n").pop();
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`PDF 변환에 실패했습니다${why ? `: ${why}` : ""}`);
  }
  return { pdf, tmp };
}

let busy = false;

/**
 * @param {string} docpath - workspace_documents.docpath (예: custom-documents/x.json)
 * @returns {Promise<{docpath, pages, parsePath, workspaces, embedded}>}
 */
/**
 * Docling 이 일부 쪽을 읽지 못한 채("docling-partial") 끝나면 그 쪽의 내용이 통째로
 * 빠진다. 같은 PDF 를 이전 파서가 읽어 둔 블록(쪽번호가 같다)으로 빠진 쪽만 채운다.
 * 반환: { blocks, filledPages } — 채울 게 없으면 원본 그대로.
 */
function mergeMissingPages(freshBlocks = [], oldBlocks = []) {
  const have = new Set(
    freshBlocks.map((b) => b.page).filter((pg) => pg != null)
  );
  const fill = oldBlocks.filter((b) => b.page != null && !have.has(b.page));
  if (!fill.length) return { blocks: freshBlocks, filledPages: [] };
  const filledPages = [...new Set(fill.map((b) => b.page))].sort((a, b) => a - b);
  // 쪽 단위로 정렬(안정 정렬 — 같은 쪽 안의 순서와 쪽 없는 블록의 위치는 유지).
  const merged = [...freshBlocks, ...fill]
    .map((b, i) => ({ b, i }))
    .sort((x, y) => (x.b.page ?? 0) - (y.b.page ?? 0) || x.i - y.i)
    .map((x) => x.b);
  return { blocks: merged, filledPages };
}

// --- 재임베딩 복구 표식 -------------------------------------------------------
// 재임베딩은 "기존 벡터 삭제 → 새로 임베딩" 순서라, 그 사이에 프로세스가
// 죽으면(메모리 부족 등) 문서가 인덱스에서 사라진 채 남는다. 지우기 전에
// 표식을 남기고, 끝나면 지운다. 서버가 시작될 때 표식이 남아 있으면 이미
// 저장된 문서 JSON 으로 다시 넣는다(recoverPendingReembeds).
const PENDING_FILE = path.resolve(documentsPath, "..", "reembed-pending.json");
const readPending = () => {
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
  } catch {
    return [];
  }
};
const writePending = (list) => {
  try {
    if (!list.length) fs.rmSync(PENDING_FILE, { force: true });
    else fs.writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error("[pdfConvert] pending marker:", e.message);
  }
};
const pendingKey = (e) => `${e.workspaceId}|${e.docpath}`;
function markPending(entry) {
  const list = readPending().filter((e) => pendingKey(e) !== pendingKey(entry));
  list.push(entry);
  writePending(list);
}
function clearPending(entry) {
  writePending(readPending().filter((e) => pendingKey(e) !== pendingKey(entry)));
}

/** 서버 시작 시: 재임베딩 도중 끊긴 문서를 인덱스에 되돌린다. */
async function recoverPendingReembeds() {
  const list = readPending();
  if (!list.length) return { recovered: 0 };
  const { Document } = require("../../models/documents");
  const { Workspace } = require("../../models/workspace");
  let recovered = 0;
  for (const e of list) {
    try {
      const ws = await Workspace.get({ id: e.workspaceId });
      if (!ws) {
        clearPending(e);
        continue;
      }
      const stillThere = await Document.get({
        docpath: e.docpath,
        workspaceId: ws.id,
      });
      if (!stillThere) {
        await Document.addDocuments(ws, [e.docpath], e.userId ?? null, {
          allowDuplicates: true,
          orgUnit: e.orgUnit || null,
        });
        recovered++;
        console.log(`[pdfConvert] 재임베딩 복구: ${e.docpath}`);
      }
      clearPending(e);
    } catch (err) {
      console.error("[pdfConvert] recover failed:", e.docpath, err.message);
    }
  }
  return { recovered };
}

async function convertDocumentToPdf(
  docpath,
  { userId = null, requireDocling = false, beforeReembed = null } = {}
) {
  const { CollectorApi } = require("../collectorApi");
  const { Document } = require("../../models/documents");
  const { Workspace } = require("../../models/workspace");

  if (busy)
    throw new Error("다른 PDF 변환이 진행 중입니다. 잠시 후 다시 시도해 주세요.");
  busy = true;
  let tmp = null;
  let hotFile = null;
  let tempLocation = null;
  try {
    const parsed = await fileData(docpath);
    if (!parsed) throw new Error("문서를 찾지 못했습니다.");
    const rel = parsed.original_path;
    if (!rel)
      throw new Error("이 문서는 원본 파일이 보관돼 있지 않아 변환할 수 없습니다.");
    const ext = path.extname(rel).replace(/^\./, "").toLowerCase();
    const isPdf = ext === "pdf";
    if (!isPdf && !CONVERTIBLE_EXTS.has(ext))
      throw new Error(
        `PDF 또는 PPT/PPTX/ODP 문서만 다시 읽을 수 있습니다(현재: .${ext}).`
      );
    // "Docling으로 다시 읽기" 는 Docling 이 꺼져 있으면 기본 파서로 같은 결과를
    // 또 만들 뿐이라 시작 전에 막는다.
    if (requireDocling && !(await doclingStatus()).running)
      throw new Error("Docling이 꺼져 있습니다. 먼저 Docling을 켜 주세요.");

    const originalsRoot = path.resolve(documentsPath, "originals");
    const srcPath = path.resolve(documentsPath, normalizePath(rel));
    if (!isWithin(originalsRoot, srcPath) || !fs.existsSync(srcPath))
      throw new Error("원본 파일을 찾지 못했습니다.");

    const collector = new CollectorApi();
    if (!(await collector.online()))
      throw new Error("문서 처리 서비스가 응답하지 않습니다.");

    // PDF 는 변환 없이 보관된 원본을 그대로, PPT 계열은 PDF 로 만들어서 읽는다.
    let pdfToRead = srcPath;
    if (!isPdf) {
      const conv = convertToPdf(srcPath);
      tmp = conv.tmp;
      pdfToRead = conv.pdf;
    }

    // collector 는 hotdir 의 파일명을 받아 처리한다.
    const hotName = `pdfconv-${Date.now()}.pdf`;
    hotFile = path.join(hotdirPath, hotName);
    fs.copyFileSync(pdfToRead, hotFile);

    const res = await collector.processDocument(hotName, {});
    if (!res?.success || !res.documents?.[0]?.location)
      throw new Error(res?.reason || "변환한 PDF를 읽지 못했습니다.");
    tempLocation = res.documents[0].location;
    const fresh = await fileData(tempLocation);
    if (!fresh?.blocks?.length || !String(fresh.pageContent || "").trim())
      throw new Error("변환한 PDF에서 텍스트를 추출하지 못했습니다.");
    if (!fresh.original_path)
      throw new Error("변환한 PDF의 보관본을 만들지 못했습니다.");
    // Docling 으로 읽히지 않았으면(중간 실패 → 기본 파서) 기존 결과를 덮어쓰지
    // 않는다 — 같은 품질을 다시 만들거나 더 나빠지는 걸 막는다.
    if (requireDocling && !String(fresh.parse_path || "").includes("docling")) {
      if (isPdf) fs.rmSync(path.resolve(documentsPath, normalizePath(fresh.original_path)), { force: true });
      throw new Error(
        `Docling으로 읽지 못해 기본 파서(${fresh.parse_path})로 처리됐습니다. 기존 내용은 그대로 두었습니다. 메모리 여유를 확인하고 다시 시도해 주세요.`
      );
    }

    // 기존 레코드에 본문만 갈아끼운다 — id/제목/폴더/해시는 그대로.
    const targetFile = path.resolve(documentsPath, normalizePath(docpath));
    if (!isWithin(path.resolve(documentsPath), targetFile))
      throw new Error("잘못된 문서 경로입니다.");
    // PDF 는 쪽번호가 원본과 같으므로, Docling 이 놓친 쪽은 이전 블록으로 채워 내용이
    // 줄어들지 않게 한다. (PPT 는 변환 PDF 라 쪽 대응이 달라 병합하지 않는다.)
    let nextBlocks = fresh.blocks;
    let nextContent = fresh.pageContent;
    let filledPages = [];
    if (isPdf && Array.isArray(parsed.blocks)) {
      const m = mergeMissingPages(fresh.blocks, parsed.blocks);
      if (m.filledPages.length) {
        const { blocksToText } = require("../../../collector/utils/blocks");
        nextBlocks = m.blocks;
        nextContent = blocksToText(nextBlocks);
        filledPages = m.filledPages;
      }
    }
    const ratio = fresh.pageContent?.length
      ? nextContent.length / fresh.pageContent.length
      : 1;
    const updated = {
      ...parsed,
      pageContent: nextContent,
      blocks: nextBlocks,
      wordCount: nextContent.split(" ").length,
      token_count_estimate: Math.round(
        (fresh.token_count_estimate || 0) * ratio
      ),
      ...(filledPages.length ? { fallback_filled_pages: filledPages } : {}),
      parse_path: isPdf ? fresh.parse_path : `pptx-pdf/${fresh.parse_path}`,
      parse_confidence: fresh.parse_confidence,
      // 원문 보기(/document/raw)는 render_path 를 우선해서 쪽/bbox 하이라이트를 쓴다.
      // PDF 는 원본 자체가 PDF 라 render_path 를 그대로 둔다(수집기가 만든 사본은 폐기).
      render_path: isPdf ? parsed.render_path || null : fresh.original_path,
    };
    if (isPdf)
      fs.rmSync(
        path.resolve(documentsPath, normalizePath(fresh.original_path)),
        { force: true }
      );
    fs.writeFileSync(targetFile, JSON.stringify(updated, null, 4), "utf-8");

    // 파싱이 끝났으니 호출자가 메모리를 풀 기회를 준다(예: Docling 끄기).
    // 이 PC 에서는 Docling 이 떠 있는 채로 임베딩하면 프로세스가 죽은 적이 있다.
    if (typeof beforeReembed === "function") {
      try {
        await beforeReembed();
      } catch (e) {
        console.error("[pdfConvert] beforeReembed:", e.message);
      }
    }

    // 이 문서를 담은 모든 작업공간에서 벡터를 지우고 다시 임베딩.
    const rows = await Document.where({ docpath });
    await purgeVectorCache(docpath).catch(() => {});
    let embedded = 0;
    const workspaces = [];
    for (const row of rows) {
      const ws = await Workspace.get({ id: row.workspaceId });
      if (!ws) continue;
      const entry = {
        workspaceId: ws.id,
        docpath,
        userId,
        orgUnit: row.uploadedByOrgUnit || null,
      };
      markPending(entry); // 지우기 전에 표식 — 도중에 죽어도 서버 시작 때 복구
      await Document.removeDocuments(ws, [docpath], userId);
      const out = await Document.addDocuments(ws, [docpath], userId, {
        allowDuplicates: true,
        orgUnit: entry.orgUnit,
      });
      if (out?.embedded?.length) clearPending(entry);
      embedded += out?.embedded?.length || 0;
      workspaces.push(ws.slug);
    }

    const pages = new Set(
      nextBlocks.map((b) => b.page).filter((pg) => pg != null)
    ).size;
    return {
      docpath,
      pages,
      parsePath: updated.parse_path,
      filledPages: filledPages.length,
      workspaces,
      embedded,
    };
  } finally {
    busy = false;
    if (tempLocation) await purgeSourceDocument(tempLocation).catch(() => {});
    if (hotFile) fs.rmSync(hotFile, { force: true });
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = {
  convertDocumentToPdf,
  convertToPdf,
  recoverPendingReembeds,
  mergeMissingPages,
  CONVERTIBLE_EXTS,
};
