// [NEXUS 문서 요약] 문서마다 한두 문장 요약을 만들어 문서함·검색 화면에서 내용을 바로
// 알 수 있게 한다. 요약은 content_hash 단위로 저장해 워크스페이스·재적재와 무관하게 공유한다.
//
// - 본문 앞 SOURCE_CHARS 자만 읽는다 (제목·개요가 앞에 오는 문서가 대부분이고, 비용이
//   글자 수에 비례하므로). 아주 긴 문서의 뒷부분은 요약에 반영되지 않는다.
// - 잠긴 폴더 문서는 백그라운드에서 만들지 않는다 — 비밀번호로 연 사람이 없는 상태로
//   내용을 LLM 에 보내지 않기 위해서다. 열 수 있는 사람이 요청하면(ensureSummary) 만든다.
const PQueue = require("p-queue").default;
const prisma = require("../prisma");
const { safeJsonParse } = require("../http");
const FolderAccess = require("../folderAccess");

const SOURCE_CHARS = 12000;
const MIN_SOURCE_CHARS = 80;
const MAX_SUMMARY_CHARS = 300;

const SYSTEM_PROMPT =
  "당신은 사내 문서 아카이브의 문서 소개 문구를 쓰는 도우미입니다. " +
  "주어진 문서를 읽고, 이용자가 어떤 문서인지 바로 알 수 있게 한국어로 2문장 이내(120자 안팎)로 요약하세요. " +
  "문서 종류와 핵심 내용을 담고, 수치와 고유명사는 문서에 있는 그대로 정확히 쓰세요. " +
  "문서에 없는 내용은 추측하지 말고, 머리말·따옴표·마크다운 없이 요약 문장만 출력하세요.";

function cleanSummary(raw = "") {
  let text = String(raw || "")
    .replace(/^\s*(요약|summary)\s*[:：]\s*/i, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > MAX_SUMMARY_CHARS)
    text = text.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd() + "…";
  return text;
}

/** 본문으로 요약 문장을 만든다. 호출 실패는 예외로 알린다. */
async function summarizeText({ title = "", text = "" }) {
  const { getLLMProvider } = require("../helpers");
  const llm = getLLMProvider();
  const body = String(text).slice(0, SOURCE_CHARS);
  const { textResponse } = await llm.getChatCompletion(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `[문서 제목] ${title || "(제목 없음)"}\n\n[문서 본문]\n${body}`,
      },
    ],
    { temperature: 0.2 }
  );
  const summary = cleanSummary(textResponse);
  if (!summary) throw new Error("요약 결과가 비어 있습니다.");
  return { summary, sourceChars: body.length };
}

function contentHashOf(row) {
  return safeJsonParse(row.metadata, {})?.content_hash || null;
}

/**
 * 요약이 아직 없는 문서(내용 해시 기준 1건씩). 잠긴 폴더 문서는 제외한다.
 * @returns {Promise<Array<{contentHash:string, docpath:string, title:string}>>}
 */
async function pendingDocuments({ limit = Infinity } = {}) {
  const [rows, done, locks] = await Promise.all([
    prisma.workspace_documents.findMany({
      select: { docpath: true, filename: true, metadata: true },
      orderBy: { id: "asc" },
    }),
    prisma.document_summaries.findMany({ select: { contentHash: true } }),
    prisma.folder_locks.findMany({ select: { folder: true } }),
  ]);
  const have = new Set(done.map((d) => d.contentHash));
  const locked = new Set(locks.map((l) => l.folder));
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const contentHash = contentHashOf(row);
    if (!contentHash || have.has(contentHash) || seen.has(contentHash))
      continue;
    if (locked.has(FolderAccess.folderOfDocpath(row.docpath))) continue;
    seen.add(contentHash);
    const meta = safeJsonParse(row.metadata, {});
    out.push({
      contentHash,
      docpath: row.docpath,
      title: meta.title || row.filename,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 문서 하나의 요약을 만들어 저장한다. 본문이 너무 짧으면 빈 요약으로 기록해 다시 시도하지 않는다. */
async function summarizeDocument({ contentHash, docpath, title }) {
  const { fileData } = require("../files");
  const doc = await fileData(
    String(docpath).replace(/\\/g, "/").split("/").slice(-2).join("/")
  );
  const text = String(doc?.pageContent || "");
  const model =
    process.env.CLAUDE_CLI_MODEL || process.env.LLM_PROVIDER || "unknown";
  if (text.trim().length < MIN_SOURCE_CHARS) {
    await prisma.document_summaries.upsert({
      where: { contentHash },
      update: { summary: "", sourceChars: text.length, model },
      create: { contentHash, summary: "", sourceChars: text.length, model },
    });
    return { contentHash, summary: "", skipped: true };
  }
  const { summary, sourceChars } = await summarizeText({
    title: title || doc?.title,
    text,
  });
  await prisma.document_summaries.upsert({
    where: { contentHash },
    update: { summary, sourceChars, model },
    create: { contentHash, summary, sourceChars, model },
  });
  return { contentHash, summary, sourceChars };
}

/**
 * 요약이 없는 문서를 최대 limit 건 만든다 (동시 concurrency 개). 한 건이 실패해도 나머지는 계속한다.
 * @returns {Promise<{total:number, done:number, failed:number, errors:string[]}>}
 */
async function runBatch({
  limit = 20,
  concurrency = 2,
  onProgress = null,
} = {}) {
  const todo = await pendingDocuments({ limit });
  const queue = new PQueue({ concurrency });
  const result = { total: todo.length, done: 0, failed: 0, errors: [] };
  await Promise.all(
    todo.map((doc) =>
      queue.add(async () => {
        try {
          await summarizeDocument(doc);
          result.done += 1;
        } catch (e) {
          result.failed += 1;
          if (result.errors.length < 5)
            result.errors.push(`${doc.title}: ${e.message}`);
        }
        onProgress?.({ ...result });
      })
    )
  );
  return result;
}

/** 열 수 있는 사람이 요청했을 때(요청 범위 안): 해당 문서 요약이 없으면 만든다. */
async function ensureSummary(contentHash) {
  const existing = await prisma.document_summaries.findUnique({
    where: { contentHash },
  });
  if (existing?.summary) return existing;
  const rows = await prisma.workspace_documents.findMany({
    select: { docpath: true, filename: true, metadata: true },
  });
  const row = rows.find((r) => contentHashOf(r) === contentHash);
  if (!row) throw new Error("문서를 찾을 수 없습니다.");
  if (!(await FolderAccess.canAccessDocpath(row.docpath)))
    throw new Error("잠긴 폴더의 문서입니다.");
  const meta = safeJsonParse(row.metadata, {});
  await summarizeDocument({
    contentHash,
    docpath: row.docpath,
    title: meta.title || row.filename,
  });
  return prisma.document_summaries.findUnique({ where: { contentHash } });
}

async function summariesByHash(hashes = []) {
  if (!hashes.length) return new Map();
  const rows = await prisma.document_summaries.findMany({
    where: { contentHash: { in: hashes } },
    select: { contentHash: true, summary: true },
  });
  return new Map(rows.map((r) => [r.contentHash, r.summary]));
}

module.exports = {
  SOURCE_CHARS,
  cleanSummary,
  summarizeText,
  pendingDocuments,
  summarizeDocument,
  runBatch,
  ensureSummary,
  summariesByHash,
};
