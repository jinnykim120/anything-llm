// [auto-docu 내부생성자료] 자동 아카이빙되는 생성 문서에 붙일 분류 메타데이터를
// 만든다 — LLM 호출 없이(사용량 0):
//   - 사업부/분야: 생성에 쓴 원본 문서들의 분류에서 최빈값을 물려받는다.
//   - 태그: "원본:파일명"들 + 문서 제목/소제목/본문에서 뽑은 핵심 키워드.
// 결과는 여전히 "제안" 상태로만 저장된다(사람이 승인해야 검색에 반영).
const prisma = require("../prisma");
const { safeJsonParse } = require("../http");

const MAX_SOURCE_TAGS = 5;
const MAX_KEYWORDS = 8;

// 흔한 조사/어미 — 토큰 끝에서 한 번만 떼어낸다(형태소 분석기 없이 근사).
const JOSA = /(으로|에서|에게|까지|부터|처럼|보다|이다|하는|하고|했다|에는|에도|은|는|이|가|을|를|의|에|로|와|과|도|만)$/;
const STOPWORDS = new Set([
  "있는", "있다", "없는", "대한", "위한", "통해", "따라", "경우", "관련", "현재",
  "이번", "해당", "기준", "이상", "이하", "대비", "전체", "내용", "결과", "필요",
  "가능", "예정", "진행", "확인", "사항", "다음", "아래", "위와", "본문",
  "the", "and", "for", "with", "that", "this",
]);

function tokenize(text) {
  return String(text || "")
    .replace(/[#*_`>|\-–—()[\]{}<>"'“”‘’.,:;!?/\\=+~%]/g, " ")
    .split(/\s+/)
    .map((t) => {
      const stripped = t.length > 2 ? t.replace(JOSA, "") : t;
      return stripped.length >= 2 ? stripped : "";
    })
    .filter((t) => t && !/^\d+$/.test(t) && !STOPWORDS.has(t.toLowerCase()));
}

/**
 * 제목·소제목(가중치 3)과 본문(가중치 1)의 단어 빈도로 핵심 키워드를 고른다.
 * @returns {string[]}
 */
function extractKeywords({ title = "", markdown = "" }, limit = MAX_KEYWORDS) {
  const score = new Map();
  const add = (tokens, w) =>
    tokens.forEach((t) => score.set(t, (score.get(t) || 0) + w));
  add(tokenize(title), 3);
  const headings = [];
  const body = [];
  for (const line of String(markdown).split("\n")) {
    (/^\s{0,3}#{1,6}\s/.test(line) ? headings : body).push(line);
  }
  add(tokenize(headings.join(" ")), 3);
  add(tokenize(body.join(" ")), 1);
  return [...score.entries()]
    .filter(([, s]) => s >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values.filter(Boolean))
    counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  for (const [v, c] of counts) if (!best || c > best[1]) best = [v, c];
  return best ? best[0] : null;
}

/**
 * 원본 문서들(문자열 docId 또는 숫자 workspace_documents.id)을 찾아 파일명과
 * 분류(사업부/분야)를 모은다.
 */
async function resolveSources({ workspaceId, sourceDocIds = [] }) {
  const ids = [...new Set(Array.isArray(sourceDocIds) ? sourceDocIds : [])];
  const strIds = ids.filter((i) => typeof i === "string" && i);
  const numIds = ids.filter((i) => typeof i === "number" && Number.isFinite(i));
  if (!workspaceId || (!strIds.length && !numIds.length)) return [];

  const rows = await prisma.workspace_documents
    .findMany({
      where: {
        workspaceId: Number(workspaceId),
        OR: [
          ...(strIds.length ? [{ docId: { in: strIds } }] : []),
          ...(numIds.length ? [{ id: { in: numIds } }] : []),
        ],
      },
      select: { filename: true, metadata: true },
    })
    .catch(() => []);
  if (!rows.length) return [];

  const hashes = rows
    .map((r) => safeJsonParse(r.metadata, {})?.content_hash)
    .filter(Boolean);
  const cls = hashes.length
    ? await prisma.document_classifications
        .findMany({ where: { contentHash: { in: hashes } } })
        .catch(() => [])
    : [];
  const byHash = new Map(cls.map((c) => [c.contentHash, c]));
  return rows.map((r) => {
    const c = byHash.get(safeJsonParse(r.metadata, {})?.content_hash);
    const meta = safeJsonParse(r.metadata, {});
    // filename 은 저장용 "<이름>-<uuid>.json" — 사람이 읽는 원본 제목(폴더 경로 제외)을 우선.
    const readable = String(meta?.title || "").split("/").pop();
    return {
      filename: readable || r.filename.replace(/-[0-9a-f-]{36}\.json$/, ""),
      businessUnit: c?.businessUnit || null,
      domain: c?.domain || null,
    };
  });
}

/**
 * @returns {Promise<{businessUnit:string|null, domain:string|null, tags:string[]}>}
 */
async function buildGeneratedMeta({
  workspaceId,
  sourceDocIds,
  docType,
  title,
  markdown,
}) {
  const sources = await resolveSources({ workspaceId, sourceDocIds });
  const names = [
    ...new Set(sources.map((s) => s.filename).filter(Boolean)),
  ].slice(0, MAX_SOURCE_TAGS);
  const tags = [
    ...names.map((n) => `원본:${n}`),
    "AI생성",
    docType,
    ...extractKeywords({ title, markdown }),
  ].filter(Boolean);
  return {
    businessUnit: mostCommon(sources.map((s) => s.businessUnit)),
    domain: mostCommon(sources.map((s) => s.domain)),
    tags: [...new Set(tags)],
  };
}

module.exports = { buildGeneratedMeta, extractKeywords, mostCommon, tokenize };
