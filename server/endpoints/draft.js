// [auto-docu 목표 3] 문서 초안 작성 — 검색 답변(사실 근거)을 바탕으로
// 두 축의 선택을 조합해 초안을 생성한다.
//
//   POST /workspace/:slug/draft
//   { sourceText, citations?, dataScope, reportType, instructions? }
//
//   dataScope  "answer_only"      — 위 답변 내용에만 근거 (새 사실 추가 금지)
//              "answer_plus_web"  — 답변 + 최신 외부 검색 자료로 보강
//   reportType "basic"    — 목적/배경/현황만 정리
//              "analysis" — 위 + (answer_only: 시사점·검토의견·향후조치 /
//                                  answer_plus_web: 관련 동향·리스크)
//
// 규칙: answer_only 는 sourceText 에 담긴 사실만 근거로 삼고, 새로운 수치·
// 사실·인용을 만들지 않는다. answer_plus_web 은 추가로 웹 검색 결과를 근거로
// 허용하되, 어떤 문장이 외부 자료에서 왔는지 항상 구분해 표시한다.
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { getLLMProvider, stripThinkingFromText } = require("../utils/helpers");
const { webSearch } = require("../utils/webSearch");

const DATA_SCOPES = {
  answer_only: { label: "답변 내용만" },
  answer_plus_web: { label: "외부자료 보강" },
};

const REPORT_TYPES = {
  basic: { label: "기본보고서" },
  analysis: { label: "분석보고서" },
};

// 두 축은 서로 독립적이라, 보고서 형식은 공통 뼈대 + 조건별 추가 절로 구성한다.
const SECTION_GUIDANCE = {
  base: [
    "구조: 반드시 마크다운 소제목(##)으로 '## 목적', '## 배경', '## 주요 내용(현황)' 절을 이 순서로 만들고, 각 절 본문은 '-' 불릿 중심으로 작성.",
    "형식: 개조식(불릿) 중심, 핵심을 먼저 제시하는 두괄식.",
    "문체: 간결한 개조식 종결('~함', '~임', '~필요'). 군더더기 표현 배제.",
    "숫자·일정·기관명은 근거 자료에 있는 그대로만 사용.",
    "표로 정리하는 게 더 명확한 수치·비교 내용이 있으면 마크다운 표(| | |, 헤더 구분선 포함)로 작성.",
  ],
  analysisAnswerOnly: [
    "'## 주요 내용(현황)' 다음에 '## 시사점 및 검토의견', '## 향후 조치(건의)' 절을 이 순서로 추가.",
    "이 두 절은 오직 위 '사실 근거'(답변 내용) 안에서만 판단·추론하며, 근거에 없는 새로운 사실이나 외부 정보를 끌어와 채우지 않는다.",
  ],
  analysisAnswerPlusWeb: [
    "'## 주요 내용(현황)' 다음에 '## 관련 동향', '## 문제점 및 리스크' 절을 이 순서로 추가.",
    "이 두 절은 아래 '외부 검색 자료'에서 발견된 최신 동향·이슈를 적극 반영해, 앞으로의 방향성 판단에 도움이 되도록 작성.",
  ],
  webSources: [
    "'## 근거 출처' 절 바로 앞에 '## 외부 참고자료' 절을 두어, 아래 '외부 검색 자료' 목록의 제목과 URL을 그대로 나열.",
    "본문 중 외부 검색 자료에서 가져온 사실·주장에는 문장 끝에 '(외부 자료)'라고 표시해 내부 답변 근거와 구분한다.",
  ],
};

function buildGuidance(dataScope, reportType) {
  const guidance = [...SECTION_GUIDANCE.base];
  if (reportType === "analysis") {
    guidance.push(
      ...(dataScope === "answer_plus_web"
        ? SECTION_GUIDANCE.analysisAnswerPlusWeb
        : SECTION_GUIDANCE.analysisAnswerOnly)
    );
  }
  if (dataScope === "answer_plus_web")
    guidance.push(...SECTION_GUIDANCE.webSources);
  return guidance;
}

function comboLabel(dataScope, reportType) {
  return `${DATA_SCOPES[dataScope].label} · ${REPORT_TYPES[reportType].label}`;
}

function citationLines(citations = []) {
  if (!Array.isArray(citations) || citations.length === 0)
    return "(제공된 출처 없음)";
  const seen = new Set();
  const lines = [];
  for (const c of citations) {
    // link:// 소스(웹 검색 결과)는 "외부 참고자료" 절에서 별도로 다루므로 여기 목록에서는 제외.
    if (
      typeof c?.chunkSource === "string" &&
      c.chunkSource.startsWith("link://")
    )
      continue;
    const title =
      c?.title ||
      c?.metadata?.title ||
      c?.chunkSource ||
      c?.docSource ||
      "제목 미상";
    const loc =
      c?.metadata?.section_path ||
      c?.section_path ||
      (c?.metadata?.page_number ? `${c.metadata.page_number}쪽` : "") ||
      c?.chunkSource ||
      "";
    const key = `${title}|${loc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(loc ? `- ${title} (${loc})` : `- ${title}`);
    if (lines.length >= 20) break;
  }
  return lines.length ? lines.join("\n") : "(제공된 출처 없음)";
}

// citations 중 이미 채팅 답변이 "내부 + 외부 자료" 모드로 가져온 웹 결과가
// 있으면(link:// 소스) 재사용한다 — 같은 자료를 또 검색해 낭비하지 않는다.
function existingWebSources(citations = []) {
  if (!Array.isArray(citations)) return [];
  return citations
    .filter(
      (c) =>
        typeof c?.chunkSource === "string" &&
        c.chunkSource.startsWith("link://")
    )
    .map((c) => ({
      title: c.title || "제목 미상",
      link: c.chunkSource.slice("link://".length),
      snippet: c.text || "",
    }));
}

function mergeWebSources(existing = [], fresh = [], cap = 8) {
  const seen = new Set();
  const out = [];
  for (const item of [...existing, ...fresh]) {
    const key = (item.link || "").split("#")[0];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

// [auto-docu 후속질문] condenseFollowupQuery 와 같은 패턴 — 답변 내용을 바탕으로
// 보고서에 필요한 검색어를 뽑아내는 짧은 LLM 호출 하나.
async function deriveDraftSearchQueries({
  sourceText,
  instructions,
  LLMConnector,
}) {
  const system = [
    "아래 보고서 초안 내용을 바탕으로, 최신 동향·규제·리스크를 파악하는 데",
    "도움이 될 웹 검색어를 1~3개 만든다.",
    "각 검색어는 한 줄에 하나씩, 설명이나 번호 없이 검색어 자체만 적는다.",
    "이미 답변에 있는 내용을 그대로 반복하지 말고, 답변에 없는 최신 정보를",
    "찾는 데 도움이 되는 검색어로 만든다.",
  ].join("\n");
  const user = [
    `## 보고서 근거 내용\n${String(sourceText).slice(0, 4000)}`,
    instructions ? `## 사용자 추가 요청\n${instructions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const { textResponse } = await LLMConnector.getChatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.2 }
    );
    return String(textResponse || "")
      .split("\n")
      .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 3);
  } catch (e) {
    console.error(
      "[deriveDraftSearchQueries] failed, skipping fresh web search:",
      e.message
    );
    return [];
  }
}

async function gatherWebSources({
  sourceText,
  instructions,
  citations,
  LLMConnector,
}) {
  const reused = existingWebSources(citations);
  const queries = await deriveDraftSearchQueries({
    sourceText,
    instructions,
    LLMConnector,
  });
  const fetched = [];
  for (const query of queries) {
    try {
      const results = await webSearch(query, { limit: 4 });
      fetched.push(...results);
    } catch (e) {
      console.error(
        "[gatherWebSources] webSearch failed for query:",
        query,
        e.message
      );
    }
  }
  return mergeWebSources(reused, fetched);
}

function webSourcesBlock(items = []) {
  if (!items.length) return "(외부 검색 결과 없음 — 위 답변 내용만으로 작성)";
  return items
    .map((r, i) => `[외부${i}]: ${r.title}\n${r.snippet}\nURL: ${r.link}`)
    .join("\n\n");
}

function buildMessages({
  sourceText,
  citations,
  dataScope,
  reportType,
  instructions,
  webSources,
}) {
  const guidance = buildGuidance(dataScope, reportType);
  const label = comboLabel(dataScope, reportType);
  const system = [
    "당신은 한국의 공공·기업 정책지원 실무자를 돕는 문서 작성 보조자입니다.",
    dataScope === "answer_plus_web"
      ? "아래 '사실 근거'와 '외부 검색 자료'에 담긴 내용만을 근거로 문서를 작성합니다."
      : "아래 '사실 근거'에 담긴 내용만을 근거로 문서를 작성합니다.",
    dataScope === "answer_plus_web"
      ? "사실 근거와 외부 검색 자료에 없는 수치, 날짜, 기관명, 인용, 결론을 새로 만들어 내지 마십시오."
      : "사실 근거에 없는 수치, 날짜, 기관명, 인용, 결론을 새로 만들어 내지 마십시오.",
    "이메일 주소, 전화번호, 담당자명 등 개인·계정 정보는 사실 근거에 실제로",
    "적혀 있는 경우에만 사용하고, 없으면 '추가 확인 필요'로만 표시하십시오.",
    "이 시스템(운영 환경)의 사용자·개발자 계정 정보를 절대 언급하지 마십시오.",
    "근거가 부족한 부분은 추측하지 말고 '추가 확인 필요'로 표시합니다.",
    "표현을 다듬고 구조를 갖추되, 사실 자체는 바꾸지 않습니다.",
    "출력은 한국어 Markdown. 첫 줄은 '# 제목' 형식의 제목 한 줄.",
    "작성 지침에 나열된 절 제목은 반드시 '##' 마크다운 헤딩으로 표시하십시오.",
    "'□', '▶' 같은 기호나 굵은 글씨로 절 제목을 대신하지 마십시오 — 렌더러가",
    "'##' 헤딩만 서식을 입히므로, 다른 표기는 문서에서 밋밋하게 보입니다.",
  ].join("\n");

  const user = [
    `## 작성 유형\n${label}`,
    `## 작성 지침\n${guidance.map((g) => `- ${g}`).join("\n")}`,
    instructions
      ? `## 사용자 추가 요청\n${instructions}`
      : "## 사용자 추가 요청\n(없음 — 기본 지침에 따라 작성)",
    `## 사실 근거 (검색 답변 결과)\n${sourceText}`,
    dataScope === "answer_plus_web"
      ? `## 외부 검색 자료\n${webSourcesBlock(webSources)}`
      : "",
    `## 근거 출처 목록\n${citationLines(citations)}`,
    [
      "## 지시",
      dataScope === "answer_plus_web"
        ? "위 '사실 근거'와 '외부 검색 자료'의 내용을 위 작성 유형과"
        : "위 '사실 근거'의 내용을 위 작성 유형과",
      "지침, 사용자 추가 요청에 맞추어 완성된 문서 초안으로 작성하십시오.",
      "문서 마지막에 '## 근거 출처' 절을 두어 위 출처 목록을 정리해 주십시오.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function extractTitle(markdown = "", fallback = "문서 초안") {
  const line = String(markdown)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("# "));
  if (!line) return fallback;
  return line.replace(/^#\s+/, "").trim() || fallback;
}

function draftEndpoints(app) {
  if (!app) return;

  app.post(
    "/workspace/:slug/draft",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const {
          sourceText = "",
          citations = [],
          dataScope = "answer_only",
          reportType = "basic",
          instructions = "",
        } = reqBody(request);

        if (!String(sourceText).trim())
          return response
            .status(400)
            .json({ error: "초안의 근거가 될 답변 내용이 없습니다." });
        if (!DATA_SCOPES[dataScope])
          return response
            .status(400)
            .json({ error: `알 수 없는 자료 범위입니다: ${dataScope}` });
        if (!REPORT_TYPES[reportType])
          return response
            .status(400)
            .json({ error: `알 수 없는 문서 유형입니다: ${reportType}` });

        const LLMConnector = getLLMProvider({
          provider: workspace?.chatProvider,
          model: workspace?.chatModel,
        });

        const trimmedInstructions = String(instructions || "").trim();
        const trimmedSourceText = String(sourceText).trim();

        const webSources =
          dataScope === "answer_plus_web"
            ? await gatherWebSources({
                sourceText: trimmedSourceText,
                instructions: trimmedInstructions,
                citations,
                LLMConnector,
              })
            : [];

        const messages = buildMessages({
          sourceText: trimmedSourceText,
          citations,
          dataScope,
          reportType,
          instructions: trimmedInstructions,
          webSources,
        });

        const { textResponse, metrics } = await LLMConnector.getChatCompletion(
          messages,
          { temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp }
        );

        const draft = stripThinkingFromText(String(textResponse || "")).trim();
        if (!draft)
          return response.status(500).json({
            error: "초안 생성 결과가 비어 있습니다. 다시 시도해 주세요.",
          });

        return response.status(200).json({
          draft,
          title: extractTitle(
            draft,
            `${comboLabel(dataScope, reportType)} 초안`
          ),
          dataScope,
          reportType,
          externalSourcesUsed: webSources.length,
          metrics: metrics || {},
        });
      } catch (e) {
        console.error("POST /workspace/:slug/draft", e);
        return response
          .status(e.code === "RATE_LIMITED" ? 429 : 500)
          .json({ error: e.message || "초안 생성 중 오류가 발생했습니다." });
      }
    }
  );
}

module.exports = {
  draftEndpoints,
  // exported for unit tests — pure helpers, no Express/DB involved.
  DATA_SCOPES,
  REPORT_TYPES,
  buildGuidance,
  comboLabel,
  citationLines,
  existingWebSources,
  mergeWebSources,
  webSourcesBlock,
  deriveDraftSearchQueries,
  gatherWebSources,
  buildMessages,
  extractTitle,
};
