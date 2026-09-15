// [auto-docu 전사문서작성tool] 정기 문서 갱신 작성 — 작년(기준) 문서의 구조를
// 뼈대로, 신규 기준/가이던스에 맞춰 아카이브 전체에서 근거를 찾아 절별로
// 다시 채워 넣는다.
//
// 흐름: 기준 문서 읽기 → 목차 추출(§outline) → 신구 비교(§diff, LLM 1회)
// → 절마다: keep=작년 내용 그대로 / update·new=아카이브 검색 + 근거 기반 작성.
//
// 근거가 부족한 부분은 draft.js의 "추가 확인 필요" 원칙과 동일하게, 새로
// 지어내지 않고 본문에 "[자료 필요: ...]" 로 표시한다 — 이 마커는 프론트의
// linkifyCitationMarkers 와 같은 패턴으로 클릭 가능한 버튼이 된다.
const prisma = require("../prisma");
const { getVectorDbClass } = require("../helpers");

// ---------------------------------------------------------------------------
// 기준 문서 읽기
// ---------------------------------------------------------------------------

/** workspace_documents.id 로부터 원문(pageContent)과 블록(chunks)을 읽는다. */
async function loadBaseDocument(workspaceDocId) {
  // 지연 require — utils/files 는 모듈 로드 시점에 NODE_ENV 기준으로 저장
  // 경로를 계산해서, 이 파일을 최상단에서 require하면 NODE_ENV가 없는
  // 테스트 환경(jest 기본값 "test")에서 즉시 죽는다. 실제로 파일을 읽어야
  // 할 때만 불러온다.
  const { fileData } = require("../files");
  const row = await prisma.workspace_documents.findUnique({
    where: { id: Number(workspaceDocId) },
  });
  if (!row) throw new Error(`문서를 찾을 수 없습니다 (id=${workspaceDocId}).`);

  const rel = String(row.docpath).split(/[\\/]/).slice(-2).join("/");
  const doc = await fileData(rel);
  if (!doc) throw new Error(`문서 파일을 읽을 수 없습니다: ${row.docpath}`);

  let meta = {};
  try {
    meta = JSON.parse(row.metadata || "{}");
  } catch {
    meta = {};
  }
  let blocks = doc.blocks;
  if (typeof blocks === "string") {
    try {
      blocks = JSON.parse(blocks);
    } catch {
      blocks = [];
    }
  }

  return {
    title: meta.title || row.filename || "기준 문서",
    pageContent: String(doc.pageContent || ""),
    blocks: Array.isArray(blocks) ? blocks : [],
  };
}

/** 기준 문서를 여러 개 고른 경우 — 각각 읽어 배열로 반환한다. */
async function loadBaseDocuments(workspaceDocIds = []) {
  const ids = (
    Array.isArray(workspaceDocIds) ? workspaceDocIds : [workspaceDocIds]
  ).filter((id) => id !== null && id !== undefined);
  if (!ids.length) throw new Error("기준 문서를 선택해 주세요.");
  return Promise.all(ids.map((id) => loadBaseDocument(id)));
}

// ---------------------------------------------------------------------------
// 목차 추출
// ---------------------------------------------------------------------------

// 블록의 section_path 메타데이터가 이 비율 이상 채워져 있어야 그걸 목차로
// 믿는다 — docx 등 구조 인식이 약한 파일은 대부분 null이라 이 값을 못 넘긴다.
const MIN_SECTION_PATH_COVERAGE = 0.3;

/** section_path 메타데이터로 절을 나눈다. 커버리지가 낮으면 null(LLM 대안 사용 신호). */
function extractOutlineFromBlocks(blocks = []) {
  if (!Array.isArray(blocks) || !blocks.length) return null;
  const withPath = blocks.filter((b) => b?.section_path);
  if (withPath.length / blocks.length < MIN_SECTION_PATH_COVERAGE) return null;

  const order = [];
  const byPath = new Map();
  for (const b of blocks) {
    const path = b?.section_path;
    if (!path) continue;
    if (!byPath.has(path)) {
      const entry = { title: String(path).split(">").pop().trim(), lines: [] };
      byPath.set(path, entry);
      order.push(entry);
    }
    if (b.text) byPath.get(path).lines.push(b.text);
  }
  return order
    .map((s) => ({ title: s.title, content: s.lines.join("\n").trim() }))
    .filter((s) => s.content);
}

function stripJsonFence(text = "") {
  return String(text)
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/```\s*$/, "")
    .trim();
}

/**
 * LLM 경계 마커 방식의 목차 추출 — section_path 커버리지가 낮을 때 대안.
 * 모델에게 원문을 그대로 다시 쓰게 하지 않고, 각 절이 "이 구절로 시작한다"는
 * 표시만 받아 pageContent에서 직접 잘라낸다 — 원문이 그대로 보존된다.
 */
async function extractOutlineViaLLM({ pageContent, LLMConnector }) {
  const fallback = [
    { title: "본문", content: String(pageContent || "").trim() },
  ];
  if (!pageContent?.trim()) return fallback;

  const system = [
    "아래 문서를 의미 단위 절(section)로 나눈다.",
    "각 절마다 절 제목과, 그 절이 시작되는 원문 그대로의 첫 구절(공백 포함 10~20자, 줄바꿈 없이)을 순서대로 나열한다.",
    "원문을 요약하거나 표현을 바꾸지 말고 실제 문서에 있는 글자 그대로 옮겨써야 한다 — 이 구절로 원문에서 위치를 찾아낸다.",
    '출력은 JSON 배열만: [{"title": "...", "startsWith": "..."}]. 설명 없이 JSON만 출력.',
  ].join("\n");
  const user = `## 문서\n${pageContent.slice(0, 12000)}`;

  let textResponse;
  try {
    ({ textResponse } = await LLMConnector.getChatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.1 }
    ));
  } catch (e) {
    console.error("[docRegen] extractOutlineViaLLM failed:", e.message);
    return fallback;
  }

  let boundaries;
  try {
    boundaries = JSON.parse(stripJsonFence(textResponse));
  } catch {
    boundaries = null;
  }
  if (!Array.isArray(boundaries) || !boundaries.length) return fallback;

  const marks = boundaries
    .map((b) => ({
      title: String(b?.title || "").trim(),
      idx: pageContent.indexOf(String(b?.startsWith || "")),
    }))
    .filter((b) => b.title && b.idx !== -1)
    .sort((a, b) => a.idx - b.idx);
  if (!marks.length) return fallback;

  const sections = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].idx;
    const end = i + 1 < marks.length ? marks[i + 1].idx : pageContent.length;
    sections.push({
      title: marks[i].title,
      content: pageContent.slice(start, end).trim(),
    });
  }
  return sections.filter((s) => s.content).length
    ? sections.filter((s) => s.content)
    : fallback;
}

/** 메타데이터 기반 추출을 우선 시도하고, 커버리지가 낮으면 LLM 방식으로 대체한다. */
async function getOutline({ pageContent, blocks, LLMConnector }) {
  const fromMeta = extractOutlineFromBlocks(blocks);
  if (fromMeta && fromMeta.length) return fromMeta;
  return extractOutlineViaLLM({ pageContent, LLMConnector });
}

// ---------------------------------------------------------------------------
// 신구 비교 (작년 목차 vs 올해 신규 기준)
// ---------------------------------------------------------------------------

const PLAN_STATUSES = ["keep", "update", "new"];

/** 신구 비교 LLM 호출이 실패하거나 형식이 안 맞을 때의 안전한 기본값 — 전부 유지로 취급한다(잘못 지우는 것보다 안전). */
function fallbackPlan(outline = []) {
  return outline.map((s) => ({
    title: s.title,
    status: "keep",
    guidanceExcerpt: "",
    priorContent: s.content,
  }));
}

async function diffOutlineAgainstGuidance({
  outline,
  guidanceText,
  LLMConnector,
}) {
  if (!outline?.length) return [];

  const outlineList = outline.map((s, i) => `${i}. ${s.title}`).join("\n");
  const system = [
    "당신은 정기 보고서·제출서 갱신을 돕는 보조자입니다.",
    "작년(기준) 문서의 목차와, 올해 새로 생긴 기준/가이던스를 비교해 절마다",
    "다음 중 하나로 분류합니다:",
    "- keep: 올해도 그대로 유지해도 되는 절",
    "- update: 올해 기준으로 내용을 다시 채워야 하는 절",
    "- new: 작년 목차에는 없지만 올해 기준에서 새로 요구하는, 완전히 새로운 절",
    '출력은 JSON 배열만: [{"title":"...","status":"keep|update|new","guidanceExcerpt":"...","outlineIndex":n|null}]',
    "guidanceExcerpt는 그 절과 관련된 신규 기준 원문 그대로의 발췌(관련 내용이 없으면 빈 문자열).",
    "outlineIndex는 작년 목차에서 몇 번째 절에 해당하는지(0부터 시작하는 번호), 완전 신규 절이면 null.",
    "작년 목차의 절 순서를 그대로 따르고, 신규 절은 맨 뒤에 덧붙이십시오.",
    "설명 없이 JSON 배열만 출력하십시오.",
  ].join("\n");
  const user = [
    `## 작년 문서 목차\n${outlineList}`,
    `## 올해 신규 기준/가이던스\n${String(guidanceText).slice(0, 8000)}`,
  ].join("\n\n");

  let textResponse;
  try {
    ({ textResponse } = await LLMConnector.getChatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.1 }
    ));
  } catch (e) {
    console.error("[docRegen] diffOutlineAgainstGuidance failed:", e.message);
    return fallbackPlan(outline);
  }

  let plan;
  try {
    plan = JSON.parse(stripJsonFence(textResponse));
  } catch {
    plan = null;
  }
  if (!Array.isArray(plan) || !plan.length) return fallbackPlan(outline);

  return plan.map((p) => {
    const idx = Number.isInteger(p?.outlineIndex) ? p.outlineIndex : null;
    const status = PLAN_STATUSES.includes(p?.status) ? p.status : "update";
    const matched = idx !== null ? outline[idx] : null;
    return {
      title: String(p?.title || matched?.title || "새 절").trim(),
      status,
      guidanceExcerpt: String(p?.guidanceExcerpt || "").trim(),
      priorContent: matched?.content || "",
    };
  });
}

// ---------------------------------------------------------------------------
// 절 작성 — "[자료 필요: ...]" 마커
// ---------------------------------------------------------------------------

function needsMarker(description) {
  return `[자료 필요: ${description}]`;
}

const NEEDS_MARKER_RE = /\[자료 필요:\s*([^\]]+)\]/g;

/** 절 내용에 남아있는 "[자료 필요: ...]" 마커를 전부 뽑아낸다(중복 제거). */
function extractNeeds(content = "") {
  const needs = [];
  const seen = new Set();
  const re = new RegExp(NEEDS_MARKER_RE);
  let m;
  while ((m = re.exec(content))) {
    const desc = m[1].trim();
    if (!desc || seen.has(desc)) continue;
    seen.add(desc);
    needs.push(desc);
  }
  return needs;
}

async function writeSection({ section, contextTexts = [], LLMConnector }) {
  const system = [
    "당신은 정기 보고서·제출서 초안을 작성하는 보조자입니다.",
    "아래 '근거 자료'에 담긴 내용만을 근거로 이 절의 내용을 작성합니다.",
    "근거 자료에 없는 수치·사실·결론을 새로 만들어 내지 마십시오.",
    "일부 항목은 쓸 수 있지만 특정 부분의 근거가 부족하면, 그 부분에",
    "'[자료 필요: 어떤 자료가 필요한지 한 문장]' 형식으로 표시하고, 나머지는",
    "근거로 채울 수 있는 만큼 작성하십시오. 근거가 전혀 없으면 절 전체를",
    "이 마커 하나로 표시해도 됩니다.",
    "출력은 절 본문 내용만(마크다운). 절 제목(## 등 헤딩)은 다시 쓰지 마십시오.",
  ].join("\n");
  const user = [
    `## 절 제목\n${section.title}`,
    section.guidanceExcerpt
      ? `## 올해 신규 기준\n${section.guidanceExcerpt}`
      : "",
    section.priorContent
      ? `## 작년 절 내용 (참고용 — 구조·표현만 참고하고, 올해 사실 근거로는 쓰지 말 것)\n${section.priorContent}`
      : "",
    `## 근거 자료 (아카이브 검색 결과)\n${
      contextTexts.length
        ? contextTexts.join("\n\n---\n\n")
        : "(검색된 근거 없음)"
    }`,
  ]
    .filter(Boolean)
    .join("\n\n");

  let textResponse;
  try {
    ({ textResponse } = await LLMConnector.getChatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.2 }
    ));
  } catch (e) {
    console.error("[docRegen] writeSection failed:", e.message);
    const content = needsMarker(`생성 실패(${e.message}) — 다시 시도 필요`);
    return { content, needs: extractNeeds(content) };
  }

  const content =
    String(textResponse || "").trim() || needsMarker("이 절의 내용 전체");
  return { content, needs: extractNeeds(content) };
}

// ---------------------------------------------------------------------------
// 조립
// ---------------------------------------------------------------------------

function assembleMarkdown({ title, sections }) {
  const body = sections
    .map((s) => `## ${s.title}\n\n${s.content}`)
    .join("\n\n");
  return `# ${title}\n\n${body}`.trim();
}

// ---------------------------------------------------------------------------
// 전체 파이프라인 — 진행 상황을 이벤트로 흘려보내는 async generator.
// endpoints/docRegen.js 가 이걸 그대로 SSE 청크로 씀.
// ---------------------------------------------------------------------------

async function* regenerateDocument({
  workspace,
  baseDocs,
  guidanceText,
  LLMConnector,
  title,
  // [auto-docu 전사문서작성tool v2] 사용자가 미리 모아둔 문서함 폴더로 근거
  // 검색 범위를 좁힌다 — resolveFolderDocIds(endpoints/docRegen.js)가 만든
  // doc_id 허용목록. null = 아카이브 전체에서 검색(기존 동작 그대로).
  filterDocIds = null,
}) {
  yield { type: "outline_start" };
  // 기준 문서를 여러 개 고른 경우 — 문서별로 목차를 뽑아 이어붙인다. 절
  // 제목이 서로 겹칠 일은 거의 없고, 겹쳐도 각 절은 독립적으로 처리되니
  // 문제 없다.
  const perDocOutlines = await Promise.all(
    baseDocs.map((doc) =>
      getOutline({
        pageContent: doc.pageContent,
        blocks: doc.blocks,
        LLMConnector,
      })
    )
  );
  const outline = perDocOutlines.flat();
  yield { type: "outline", outline: outline.map((s) => s.title) };

  const plan = await diffOutlineAgainstGuidance({
    outline,
    guidanceText,
    LLMConnector,
  });
  yield {
    type: "plan",
    plan: plan.map((p) => ({ title: p.title, status: p.status })),
  };

  const VectorDb = getVectorDbClass();
  const results = [];
  for (let i = 0; i < plan.length; i++) {
    const section = plan[i];
    yield {
      type: "section_start",
      index: i,
      title: section.title,
      status: section.status,
    };

    let result;
    if (section.status === "keep") {
      const content =
        section.priorContent || needsMarker("작년 내용 없음 — 확인 필요");
      result = {
        ...section,
        content,
        needs: extractNeeds(content),
        sources: [],
      };
    } else {
      const query =
        `${section.title} ${section.guidanceExcerpt}`.trim().slice(0, 300) ||
        section.title;
      const search = await VectorDb.performSimilaritySearch({
        namespace: workspace.slug,
        input: query,
        LLMConnector,
        topN: 6,
        filterDocIds,
      }).catch((e) => {
        console.error("[docRegen] section search failed:", e.message);
        return { contextTexts: [], sources: [] };
      });
      const written = await writeSection({
        section,
        contextTexts: search.contextTexts || [],
        LLMConnector,
      });
      result = {
        ...section,
        content: written.content,
        needs: written.needs,
        sources: search.sources || [],
      };
    }
    results.push(result);
    yield { type: "section_done", index: i, section: result };
  }

  const markdown = assembleMarkdown({ title, sections: results });
  yield { type: "done", title, sections: results, markdown };
}

module.exports = {
  loadBaseDocument,
  loadBaseDocuments,
  extractOutlineFromBlocks,
  extractOutlineViaLLM,
  getOutline,
  diffOutlineAgainstGuidance,
  needsMarker,
  extractNeeds,
  writeSection,
  assembleMarkdown,
  regenerateDocument,
  MIN_SECTION_PATH_COVERAGE,
};
