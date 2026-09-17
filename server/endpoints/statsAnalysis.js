// [auto-docu 통계분석] HTML/문서 초안(draft.js)에서만 쓰는 "진짜 계산" 파이프
// 라인 — PPT 쪽은 이 기능의 가치가 낮다고 판단해 의도적으로 제외했다(사용자
// 결정, 3b/PPT 연결 없음).
//
// 4단계, 숫자를 만들어내는 건 오직 2단계(Python)뿐이다:
//   1. LLM #1 — 사용자 요청(+선택한 방법, 없으면 방법도 같이 고름) + 근거
//      텍스트/업로드 데이터에서 그 방법이 필요로 하는 {data, params}를
//      "있는 그대로" 뽑아낸다(추론/가공 없이 원문의 숫자만).
//   2. Python(run_analysis.py, server/utils/stats/) — 그 {data, params}로
//      scikit-learn/statsmodels/scipy 실제 계산.
//   3. LLM #2 — 실제 계산 결과 JSON을 근거로 서술(마크다운)을 쓴다. 이
//      LLM은 숫자를 다시 만들지 않고, 결과에 있는 숫자만 인용한다.
//   4. 결과는 draft.js의 /revise-block과 같은 모양({revised})으로 돌려줘서,
//      프론트가 이미 만들어둔 블록 패치 흐름을 그대로 재사용한다.
//
//   POST /workspace/:slug/stats/analyze
//     { instruction, method?("auto"|null이면 LLM이 고름), sourceText,
//       surroundingContext?, uploadedData? }
//     -> { revised, method, methodLabel, result }
const { reqBody, safeJsonParse } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { getLLMProvider, stripThinkingFromText } = require("../utils/helpers");
const { runAnalysis, METHOD_LABELS } = require("../utils/stats/runAnalysis");
const {
  METHOD_SCHEMAS,
  ALL_METHOD_KEYS,
} = require("../utils/stats/methodSchemas");

function extractJsonObject(text = "") {
  const cleaned = String(text)
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  return match ? match[0] : cleaned;
}

function uploadedDataBlock(uploadedData) {
  if (!uploadedData?.rows?.length) return "";
  const preview = uploadedData.rows.slice(0, 200);
  return `## 업로드된 추가 자료(${uploadedData.filename || "업로드 파일"}, ${uploadedData.rows.length}행 중 ${preview.length}행 표시)\n${JSON.stringify(preview)}`;
}

// 1단계: 방법(선택 안 했으면 후보 중 골라야 함) + 근거 텍스트/데이터에서
// {method, data, params}를 뽑는다.
function buildExtractMessages({
  instruction,
  method,
  sourceText,
  uploadedData,
}) {
  const isAuto = !method || method === "auto";
  const schemaList = (isAuto ? ALL_METHOD_KEYS : [method])
    .map(
      (k) =>
        `### ${k} (${METHOD_SCHEMAS[k].label})\n${METHOD_SCHEMAS[k].schema}`
    )
    .join("\n\n");

  const system = [
    "당신은 통계 분석 요청에서 실제 계산에 쓸 파라미터를 뽑아내는 보조자입니다.",
    "아래 '근거 자료'에 실제로 나와 있는 숫자만 사용하십시오 — 근거에 없는",
    "수치를 지어내지 마십시오. 근거에 필요한 숫자가 부족하면 data/params를",
    '채우지 말고 대신 최상위에 "missing_data": "어떤 자료가 더 필요한지 설명"을 넣으십시오.',
    isAuto
      ? '아래 방법 목록 중 사용자 목적에 가장 적합한 것을 하나 골라 "method" 키에 넣으십시오.'
      : `분석 방법은 이미 "${method}"(${METHOD_SCHEMAS[method]?.label})로 정해져 있습니다 — "method" 키에 그대로 넣으십시오.`,
    "반드시 아래 JSON 형식으로만 응답하십시오. 설명, 코드펜스 없이 JSON 객체 하나만:",
    `{"method": "...", "data": {...}, "params": {...}}`,
    "또는 자료가 부족하면:",
    `{"missing_data": "..."}`,
    "",
    "방법별 data/params 모양:",
    schemaList,
  ].join("\n");

  const user = [
    `## 사용자 요청\n${instruction}`,
    `## 근거 자료(문서 초안/답변 내용)\n${String(sourceText || "").slice(0, 6000)}`,
    uploadedDataBlock(uploadedData),
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// 3단계: 실제 계산 결과(result)를 근거로 서술을 쓴다.
function buildNarrativeMessages({
  instruction,
  methodLabel,
  result,
  surroundingContext,
}) {
  const system = [
    "당신은 통계 분석 결과를 한국어 보고서 문단으로 서술하는 보조자입니다.",
    "아래 '실제 계산 결과' JSON에 있는 숫자만 인용하십시오 — 새로운 수치를",
    "만들거나 반올림 외의 방식으로 바꾸지 마십시오. 이 결과는 이미 실제",
    "통계 계산(scikit-learn/statsmodels/scipy)을 거친 값입니다.",
    "통계적 유의성(p-value 등)이 있으면 그 의미를 일반 독자가 이해할 수",
    "있게 짧게 설명하십시오(예: 'p<0.05로 통계적으로 유의미함').",
    "결과는 마크다운 텍스트만 출력하십시오. 설명, 따옴표, 코드펜스 없이.",
    "형식은 기존 문서 톤에 맞춰 소제목(###) + 문단 또는 불릿으로 구성하십시오.",
  ].join("\n");

  const user = [
    surroundingContext ? `## 문서 맥락(참고용)\n${surroundingContext}` : "",
    `## 분석 방법\n${methodLabel}`,
    `## 사용자 요청\n${instruction}`,
    `## 실제 계산 결과(JSON)\n${JSON.stringify(result)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function cleanNarrative(text = "") {
  return String(text)
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

// draft.js/pptDraft.js와 같은 재사용 패턴 — 엔드포인트 핸들러와 분리해
// 단독으로도 부를 수 있게(테스트, 다른 호출부 재사용 대비) 한다.
async function runStatsPipeline({
  instruction,
  method,
  sourceText,
  surroundingContext = "",
  uploadedData = null,
  LLMConnector,
  temperature,
}) {
  if (!String(instruction || "").trim())
    throw new Error("어떤 분석을 하고 싶은지 요청 내용을 입력해 주세요.");
  if (method && method !== "auto" && !METHOD_SCHEMAS[method])
    throw new Error(`알 수 없는 분석 방법입니다: ${method}`);

  const extractMessages = buildExtractMessages({
    instruction: String(instruction).trim(),
    method,
    sourceText,
    uploadedData,
  });
  const extractRes = await LLMConnector.getChatCompletion(extractMessages, {
    temperature: temperature ?? LLMConnector.defaultTemp,
  });
  const extracted = safeJsonParse(
    extractJsonObject(
      stripThinkingFromText(String(extractRes.textResponse || ""))
    ),
    null
  );
  if (!extracted)
    throw new Error("분석 파라미터를 해석하지 못했습니다. 다시 시도해 주세요.");
  if (extracted.missing_data)
    throw new Error(
      `분석에 필요한 자료가 부족합니다: ${extracted.missing_data}`
    );

  const resolvedMethod = extracted.method;
  if (!METHOD_SCHEMAS[resolvedMethod])
    throw new Error(`분석 방법을 판단하지 못했습니다: ${resolvedMethod}`);

  const analysis = await runAnalysis({
    method: resolvedMethod,
    data: extracted.data || {},
    params: extracted.params || {},
  });
  if (!analysis.ok)
    throw new Error(`통계 계산에 실패했습니다: ${analysis.error}`);

  const narrativeMessages = buildNarrativeMessages({
    instruction: String(instruction).trim(),
    methodLabel: METHOD_LABELS[resolvedMethod],
    result: analysis.result,
    surroundingContext: String(surroundingContext || "").slice(0, 2000),
  });
  const narrativeRes = await LLMConnector.getChatCompletion(narrativeMessages, {
    temperature: temperature ?? LLMConnector.defaultTemp,
  });
  const revised = cleanNarrative(
    stripThinkingFromText(String(narrativeRes.textResponse || ""))
  );
  if (!revised)
    throw new Error("분석 서술 결과가 비어 있습니다. 다시 시도해 주세요.");

  return {
    revised,
    method: resolvedMethod,
    methodLabel: METHOD_LABELS[resolvedMethod],
    result: analysis.result,
  };
}

function statsAnalysisEndpoints(app) {
  if (!app) return;

  app.post(
    "/workspace/:slug/stats/analyze",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const {
          instruction = "",
          method = null,
          sourceText = "",
          surroundingContext = "",
          uploadedData = null,
        } = reqBody(request);

        const LLMConnector = getLLMProvider({
          provider: workspace?.chatProvider,
          model: workspace?.chatModel,
        });

        const out = await runStatsPipeline({
          instruction,
          method,
          sourceText,
          surroundingContext,
          uploadedData,
          LLMConnector,
          temperature: workspace?.openAiTemp,
        });

        return response.status(200).json(out);
      } catch (e) {
        console.error("POST /workspace/:slug/stats/analyze", e);
        return response
          .status(e.code === "RATE_LIMITED" ? 429 : 500)
          .json({ error: e.message || "통계 분석 중 오류가 발생했습니다." });
      }
    }
  );
}

module.exports = {
  statsAnalysisEndpoints,
  runStatsPipeline,
  buildExtractMessages,
  buildNarrativeMessages,
};
