// [auto-docu 목표 3] 문서 초안 작성 — 검색 답변(사실 근거)을 바탕으로
// 유형(보고용 / 대외기관용)과 추가 요청을 조합해 풍부한 초안을 생성한다.
//
//   POST /workspace/:slug/draft   { sourceText, citations?, mode, instructions? }
//
// 규칙: sourceText 에 담긴 사실만 근거로 삼고, 새로운 수치·사실·인용을 만들지
// 않는다. LLM 은 문체·구성·표현만 확장한다.
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { getLLMProvider, stripThinkingFromText } = require("../utils/helpers");

const DRAFT_MODES = {
  report: {
    label: "보고용 (사내 보고)",
    guidance: [
      "형식: 개조식(불릿) 중심, 핵심을 먼저 제시하는 두괄식.",
      "구조: 반드시 마크다운 소제목(##)으로 '## 목적', '## 배경', '## 주요 내용(현황)', '## 시사점·검토의견', '## 향후 조치(건의)' 순서의 절을 만들고, 각 절 본문은 '-' 불릿으로 작성.",
      "문체: 간결한 개조식 종결(‘~함’, ‘~임’, ‘~필요’). 군더더기 표현 배제.",
      "숫자·일정·기관명은 근거 자료에 있는 그대로만 사용.",
      "표로 정리하는 게 더 명확한 수치·비교 내용이 있으면 마크다운 표(| | |, 헤더 구분선 포함)로 작성.",
    ],
  },
  external: {
    label: "대외기관용 (외부 발송)",
    guidance: [
      "형식: 공문서 형식.",
      "구조: 반드시 마크다운 소제목(##)으로 '## 1. 인사 및 배경', '## 2. 요청·안내 사항', '## 3. 근거 및 붙임' 절을 만들고, 각 절 본문은 문단 또는 '-' 불릿으로 작성.",
      "문체: 정중한 경어체(‘~드립니다’, ‘~주시기 바랍니다’), 두괄식.",
      "주장·요청에는 근거와 출처를 함께 명시.",
    ],
  },
};

function citationLines(citations = []) {
  if (!Array.isArray(citations) || citations.length === 0)
    return "(제공된 출처 없음)";
  const seen = new Set();
  const lines = [];
  for (const c of citations) {
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
  return lines.join("\n");
}

function buildMessages({ sourceText, citations, mode, instructions }) {
  const modeDef = DRAFT_MODES[mode];
  const system = [
    "당신은 한국의 공공·기업 정책지원 실무자를 돕는 문서 작성 보조자입니다.",
    "아래 '사실 근거'에 담긴 내용만을 근거로 문서를 작성합니다.",
    "사실 근거에 없는 수치, 날짜, 기관명, 인용, 결론을 새로 만들어 내지 마십시오.",
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
    `## 작성 유형\n${modeDef.label}`,
    `## 작성 지침\n${modeDef.guidance.map((g) => `- ${g}`).join("\n")}`,
    instructions
      ? `## 사용자 추가 요청\n${instructions}`
      : "## 사용자 추가 요청\n(없음 — 기본 지침에 따라 작성)",
    `## 사실 근거 (검색 답변 결과)\n${sourceText}`,
    `## 근거 출처 목록\n${citationLines(citations)}`,
    [
      "## 지시",
      "위 '사실 근거'의 내용을 위 작성 유형과 지침, 사용자 추가 요청에 맞추어",
      "완성된 문서 초안으로 작성하십시오. 문서 마지막에 '## 근거 출처' 절을 두어",
      "위 출처 목록을 정리해 주십시오.",
    ].join("\n"),
  ].join("\n\n");

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
          mode = "report",
          instructions = "",
        } = reqBody(request);

        if (!String(sourceText).trim())
          return response
            .status(400)
            .json({ error: "초안의 근거가 될 답변 내용이 없습니다." });
        if (!DRAFT_MODES[mode])
          return response
            .status(400)
            .json({ error: `알 수 없는 작성 유형입니다: ${mode}` });

        const LLMConnector = getLLMProvider({
          provider: workspace?.chatProvider,
          model: workspace?.chatModel,
        });

        const messages = buildMessages({
          sourceText: String(sourceText).trim(),
          citations,
          mode,
          instructions: String(instructions || "").trim(),
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
          title: extractTitle(draft, `${DRAFT_MODES[mode].label} 초안`),
          mode,
          metrics: metrics || {},
        });
      } catch (e) {
        console.error("POST /workspace/:slug/draft", e);
        return response
          .status(500)
          .json({ error: e.message || "초안 생성 중 오류가 발생했습니다." });
      }
    }
  );
}

module.exports = { draftEndpoints };
