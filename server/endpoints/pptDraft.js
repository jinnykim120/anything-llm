// [auto-docu PPT 생성 — Phase 1] 검색 답변(또는 전사문서작성tool의 폴더별
// 근거)을 바탕으로 PPT 슬라이드 스펙(JSON)을 생성하고, 그 스펙을 실제 .pptx
// 바이너리로 내려받는다. draft.js(문서 초안)와 같은 근거 원칙을 그대로
// 따른다 — 근거에 없는 수치·사실을 새로 만들지 않는다.
//
//   POST /workspace/:slug/ppt-draft
//     { sourceText, citations?, purpose, slideCount, instructions? }
//     -> { slideSpec, title, purpose, slideCount }
//
//   POST /doc-export/pptx   { slideSpec }
//     -> application/vnd...presentationml.presentation (워크스페이스 무관 순수 변환)
const { reqBody, safeJsonParse } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { getLLMProvider, stripThinkingFromText } = require("../utils/helpers");
const { renderPptx } = require("../utils/exporters/pptxRenderer");
const { COMPANY_GLOSSARY } = require("../utils/prompts/companyGlossary");
const { resolveOwnedArchiveDocs } = require("../utils/docRegen");

// [auto-docu 근거 문서 추가] draft.js와 같은 값 — 반기보고서급 대형 문서
// 하나가 슬라이드 생성 컨텍스트를 통째로 잡아먹지 않게.
const MAX_ARCHIVE_DOC_CHARS = 60000;

function archiveDocsBlock(docs = []) {
  if (!docs.length) return "";
  return docs
    .map(
      (d) =>
        `### ${d.title}\n${String(d.pageContent || "").slice(0, MAX_ARCHIVE_DOC_CHARS)}`
    )
    .join("\n\n");
}

// 목적별 슬라이드 흐름 — DraftPanel의 REPORT_TYPES와 같은 역할. "반복"이라고
// 표시된 항목은 slideCount에 맞춰 LLM이 필요한 만큼 늘리거나 줄인다.
const PPT_TEMPLATES = {
  analysis: {
    label: "내용 분석",
    desc: "자료를 구조적으로 분석해 핵심 내용을 정리합니다.",
    flow: ["표지", "개요", "핵심 발견사항(반복 가능)", "시사점", "결론"],
  },
  proposal: {
    label: "제안",
    desc: "문제 제기부터 제안 내용, 기대효과까지 설득력 있게 구성합니다.",
    flow: [
      "표지",
      "배경 및 문제 제기",
      "제안 내용(반복 가능)",
      "기대 효과",
      "실행 계획",
    ],
  },
  performance: {
    label: "성과보고",
    desc: "주요 성과와 지표를 중심으로 보고합니다.",
    flow: [
      "표지",
      "요약(Executive Summary)",
      "핵심 성과 지표",
      "세부 성과(반복 가능)",
      "이슈 및 리스크",
      "향후 계획",
    ],
  },
  status: {
    label: "현황보고",
    desc: "현재 상태와 진행 상황을 정리해 보고합니다.",
    flow: [
      "표지",
      "개요",
      "현황 요약",
      "세부 현황(반복 가능)",
      "쟁점 사항",
      "향후 일정",
    ],
  },
  data: {
    label: "데이터 분석",
    desc: "수치·통계 자료를 표와 함께 분석적으로 제시합니다.",
    flow: [
      "표지",
      "분석 개요",
      "주요 데이터(표 포함, 반복 가능)",
      "분석 결과",
      "시사점",
    ],
  },
};

const MIN_SLIDES = 4;
const MAX_SLIDES = 20;

// 불릿 밀도 한도 — utils.js의 실제 렌더링 상수로부터 역산한 값이다.
// 본문 텍스트박스 폭 CONTENT_W=8.6in에서 불릿 마커/들여쓰기(~0.3in)와
// pptxgenjs 기본 텍스트 인셋(좌우 ~0.2in)을 뺀 실사용 폭은 약 8.1in.
// 본문 fontSize=15pt → 1글자 폭 ≈ 15/72in(0.208in, 한글은 전각이라 em폭에
// 가깝게 렌더됨) → 8.1 / 0.208 ≈ 39자/줄. 여유를 두어 38자로 잡는다.
const MAX_BULLET_CHARS = 38;
const MAX_BULLETS_PER_SLIDE = 6;

function clampSlideCount(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 8;
  return Math.min(MAX_SLIDES, Math.max(MIN_SLIDES, Math.round(num)));
}

// content 슬라이드의 불릿이 한 장에 담기 어려울 만큼 많으면("~기(1/2)" 식으로)
// 자동으로 여러 장에 나눠 담는다 — 프롬프트로만 유도하면 LLM이 못 지킬 수
// 있으므로 코드 단에서 강제하는 안전망. 개별 불릿 한 줄이 너무 긴 경우는
// (분할로 해결되지 않는 문제라) 여기서 다루지 않고 프롬프트 가이드로만 유도한다.
function splitOverflowingContentSlides(slides) {
  const result = [];
  let splitCount = 0;
  for (const slide of slides) {
    const bullets = Array.isArray(slide.content) ? slide.content : null;
    if (!bullets || bullets.length <= MAX_BULLETS_PER_SLIDE) {
      result.push(slide);
      continue;
    }
    const chunks = [];
    for (let i = 0; i < bullets.length; i += MAX_BULLETS_PER_SLIDE)
      chunks.push(bullets.slice(i, i + MAX_BULLETS_PER_SLIDE));
    chunks.forEach((chunk, idx) => {
      result.push({
        ...slide,
        title:
          chunks.length > 1
            ? `${slide.title || ""} (${idx + 1}/${chunks.length})`
            : slide.title,
        subtitle: idx === 0 ? slide.subtitle : undefined,
        content: chunk,
      });
    });
    splitCount += 1;
  }
  return { slides: result, splitCount };
}

function normalizeChart(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const type = ["bar", "line", "pie"].includes(raw.type) ? raw.type : "bar";
  const categories = Array.isArray(raw.categories)
    ? raw.categories.map((c) => String(c)).filter(Boolean)
    : [];
  const series = Array.isArray(raw.series)
    ? raw.series
        .filter((s) => s && Array.isArray(s.values))
        .map((s) => ({
          name: String(s.name || ""),
          values: s.values.map((v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : 0;
          }),
        }))
    : [];
  if (!categories.length || !series.length) return undefined;
  return { type, categories, series };
}

// draft.js의 citationLines와 동일한 원리 — 근거 출처를 프롬프트에 넣어준다.
function citationLines(citations = []) {
  if (!Array.isArray(citations) || citations.length === 0)
    return "(제공된 출처 없음)";
  const seen = new Set();
  const lines = [];
  for (const c of citations) {
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

const SLIDE_SPEC_SCHEMA_HINT = `{
  "title": "전체 프레젠테이션 제목",
  "slides": [
    {
      "layout": "section" | "content",
      "title": "슬라이드 제목",
      "subtitle": "부제(section 레이아웃에서만, 선택)",
      "content": ["불릿 문장1", "불릿 문장2"],
      "table": { "headers": ["열1","열2"], "rows": [["a","b"]] },
      "chart": {
        "type": "bar" | "line" | "pie",
        "categories": ["항목1","항목2","항목3"],
        "series": [{ "name": "계열명", "values": [1.2, 3.4, 5.6] }]
      },
      "notes": "발표자 노트(선택)"
    }
  ]
}`;

function buildMessages({
  sourceText,
  citations,
  purpose,
  slideCount,
  instructions,
  archiveDocs = [],
}) {
  const template = PPT_TEMPLATES[purpose];
  const hasArchiveDocs = archiveDocs.length > 0;
  const system = [
    "당신은 한국의 공공·기업 정책지원 실무자를 돕는 PPT 초안 작성 보조자입니다.",
    "아래 '사실 근거'에 담긴 내용만을 근거로 슬라이드 내용을 작성합니다.",
    hasArchiveDocs
      ? "'추가 아카이브 자료'가 있으면 사실 근거와 동등한 근거로 취급해 반영합니다."
      : "",
    hasArchiveDocs
      ? "사실 근거와 추가 아카이브 자료에 없는 수치, 날짜, 기관명, 인용, 결론을 새로 만들어 내지 마십시오."
      : "사실 근거에 없는 수치, 날짜, 기관명, 인용, 결론을 새로 만들어 내지 마십시오.",
    "근거가 부족한 부분은 추측하지 말고 해당 불릿에 '(추가 확인 필요)'라고 표시하십시오.",
    "이메일 주소, 전화번호, 담당자명 등 개인·계정 정보는 사실 근거에 실제로",
    "적혀 있는 경우에만 사용하고, 없으면 다루지 않습니다.",
    "이 시스템(운영 환경)의 사용자·개발자 계정 정보를 절대 언급하지 마십시오.",
    "",
    "반드시 아래 JSON 스키마 형식으로만 응답하십시오. 다른 설명, 코드펜스, 텍스트 없이 JSON 객체 하나만 출력합니다.",
    SLIDE_SPEC_SCHEMA_HINT,
    "",
    "규칙:",
    "- slides 배열의 첫 항목은 표지 다음에 오는 첫 내용 슬라이드입니다(표지 자체는 만들지 않음 — 렌더러가 title로 별도 생성).",
    `- layout은 구분/전환 슬라이드는 "section", 실제 내용 슬라이드는 "content"를 씁니다.`,
    "- content 슬라이드는 content(불릿) / table / chart 중 하나만 채웁니다(여러 개를 동시에 채우지 않음).",
    "- 2~3개 항목·시기를 2~4개 지표로 비교하는 숫자 데이터는 table보다 chart를 우선 사용하십시오:",
    '  같은 항목들을 여러 시점에서 추세로 보여주면 "line", 항목 간 크기를 비교하면 "bar",',
    '  전체 대비 구성비를 보여주면(계열 1개, 합이 의미 있는 경우) "pie"를 씁니다.',
    "- 행이 많거나(5행 초과), 텍스트와 숫자가 섞여 있거나(예: 담당자/일정 등 조회용 표),",
    "  비교할 계열이 4개를 넘는 데이터는 chart 대신 table을 씁니다 — 그런 데이터는 차트로 그리면 오히려 읽기 어렵습니다.",
    `- 불릿은 최대 ${MAX_BULLETS_PER_SLIDE}개까지만 씁니다. 한 불릿은 ${MAX_BULLET_CHARS}자 이내로 간결하게 써서 슬라이드에서 한 줄에 들어가도록 하십시오(더 많은 내용은 슬라이드를 나눠 담으십시오).`,
    "- 불릿 문장은 개조식('~함', '~임')으로 간결하게 씁니다.",
    `- 전체 슬라이드 수는 ${slideCount}장에 최대한 맞춥니다(표지 제외).`,
  ]
    .filter(Boolean)
    .join("\n") + `\n\n${COMPANY_GLOSSARY}`;

  const user = [
    `## 문서 목적\n${template.label} — ${template.desc}`,
    `## 슬라이드 흐름 가이드\n${template.flow.map((f) => `- ${f}`).join("\n")}`,
    `## 요청 슬라이드 수\n${slideCount}장 (표지 제외)`,
    instructions
      ? `## 사용자 추가 요청\n${instructions}`
      : "## 사용자 추가 요청\n(없음 — 기본 흐름에 따라 작성)",
    `## 사실 근거\n${sourceText}`,
    hasArchiveDocs
      ? `## 추가 아카이브 자료\n${archiveDocsBlock(archiveDocs)}`
      : "",
    `## 근거 출처 목록\n${citationLines(citations)}`,
    hasArchiveDocs
      ? "## 지시\n위 사실 근거와 추가 아카이브 자료를 목적과 슬라이드 흐름 가이드에 맞춰 JSON 슬라이드 스펙으로 작성하십시오."
      : "## 지시\n위 사실 근거를 목적과 슬라이드 흐름 가이드에 맞춰 JSON 슬라이드 스펙으로 작성하십시오.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function extractJsonObject(text = "") {
  const cleaned = String(text)
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  return match ? match[0] : cleaned;
}

// 슬라이드 스펙 생성 — draft.js/doc-regen.js 양쪽에서 재사용하는 공용 함수.
// LLM 호출 + JSON 파싱 + 정제까지 한 번에 하고, 실패하면 사람이 읽을 수 있는
// 에러를 throw한다(호출부에서 잡아서 응답 형태로 변환).
async function generateSlideSpec({
  sourceText,
  citations = [],
  purpose,
  slideCount,
  instructions = "",
  archiveDocs = [],
  LLMConnector,
  temperature,
  titleOverride,
}) {
  if (!String(sourceText || "").trim())
    throw new Error("PPT의 근거가 될 내용이 없습니다.");
  if (!PPT_TEMPLATES[purpose])
    throw new Error(`알 수 없는 문서 목적입니다: ${purpose}`);

  const clampedCount = clampSlideCount(slideCount);
  const messages = buildMessages({
    sourceText: String(sourceText).trim(),
    citations,
    purpose,
    slideCount: clampedCount,
    instructions: String(instructions || "").trim(),
    archiveDocs,
  });

  const { textResponse } = await LLMConnector.getChatCompletion(messages, {
    temperature: temperature ?? LLMConnector.defaultTemp,
  });

  const cleaned = stripThinkingFromText(String(textResponse || ""));
  const parsed = safeJsonParse(extractJsonObject(cleaned), null);
  if (!parsed || !Array.isArray(parsed.slides) || !parsed.slides.length)
    throw new Error(
      "PPT 슬라이드 생성 결과를 해석하지 못했습니다. 다시 시도해 주세요."
    );

  const mappedSlides = parsed.slides.map((s) => ({
    layout: s.layout === "section" ? "section" : "content",
    title: s.title || "",
    subtitle: s.subtitle || "",
    content: Array.isArray(s.content) ? s.content.filter(Boolean) : undefined,
    table:
      s.table && Array.isArray(s.table.headers) && Array.isArray(s.table.rows)
        ? s.table
        : undefined,
    chart: normalizeChart(s.chart),
    notes: s.notes || undefined,
  }));

  const { slides: splitSlides, splitCount } =
    splitOverflowingContentSlides(mappedSlides);

  const finalSlides = splitSlides.slice(0, MAX_SLIDES);
  const truncated = splitSlides.length > finalSlides.length;

  let warning;
  if (splitCount > 0 && truncated) {
    warning = `불릿이 많은 슬라이드 ${splitCount}장을 여러 장으로 나눴고, 그 결과 최대 슬라이드 수(${MAX_SLIDES}장)를 넘어 일부 내용이 제외되었습니다. 가독성을 위해 슬라이드 수 우선순위를 낮췄습니다.`;
  } else if (splitCount > 0) {
    warning = `불릿이 많은 슬라이드 ${splitCount}장을 가독성을 위해 여러 장으로 나눠 총 ${finalSlides.length}장이 되었습니다(요청: ${clampedCount}장).`;
  } else if (truncated) {
    warning = `생성된 슬라이드가 최대 슬라이드 수(${MAX_SLIDES}장)를 넘어 일부가 제외되었습니다.`;
  }

  return {
    title: String(
      titleOverride || parsed.title || `${PPT_TEMPLATES[purpose].label} 초안`
    ).slice(0, 200),
    theme: "corporate",
    slides: finalSlides,
    ...(warning ? { warning } : {}),
  };
}

function pptDraftEndpoints(app) {
  if (!app) return;

  app.post(
    "/workspace/:slug/ppt-draft",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const {
          sourceText = "",
          citations = [],
          purpose = "analysis",
          slideCount = 8,
          instructions = "",
          archiveDocIds = [],
        } = reqBody(request);

        if (!String(sourceText).trim())
          return response
            .status(400)
            .json({ error: "PPT의 근거가 될 내용이 없습니다." });
        if (!PPT_TEMPLATES[purpose])
          return response
            .status(400)
            .json({ error: `알 수 없는 문서 목적입니다: ${purpose}` });

        const LLMConnector = getLLMProvider({
          provider: workspace?.chatProvider,
          model: workspace?.chatModel,
        });

        const archiveDocs = await resolveOwnedArchiveDocs({
          workspaceId: workspace.id,
          docIds: archiveDocIds,
        });

        const slideSpec = await generateSlideSpec({
          sourceText,
          citations,
          purpose,
          slideCount,
          instructions,
          archiveDocs,
          LLMConnector,
          temperature: workspace?.openAiTemp,
        });

        return response.status(200).json({
          slideSpec,
          title: slideSpec.title,
          purpose,
          slideCount: slideSpec.slides.length,
          warning: slideSpec.warning,
          archiveDocsUsed: archiveDocs.length,
        });
      } catch (e) {
        console.error("POST /workspace/:slug/ppt-draft", e);
        return response
          .status(e.code === "RATE_LIMITED" ? 429 : 500)
          .json({ error: e.message || "PPT 생성 중 오류가 발생했습니다." });
      }
    }
  );

  app.post(
    "/doc-export/pptx",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const { slideSpec } = reqBody(request);
        if (
          !slideSpec ||
          !Array.isArray(slideSpec.slides) ||
          !slideSpec.slides.length
        )
          throw new Error("내려받을 슬라이드 내용이 없습니다.");

        const buffer = await renderPptx(slideSpec);
        const filename =
          `${String(slideSpec.title || "프레젠테이션").trim() || "프레젠테이션"}.pptx`.slice(
            0,
            150
          );

        response.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        );
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="download.pptx"; filename*=UTF-8''${encodeURIComponent(filename)}`
        );
        response.status(200).send(buffer);
      } catch (e) {
        console.error("POST /doc-export/pptx", e);
        response
          .status(500)
          .json({ error: e.message || "PPTX 변환 중 오류가 발생했습니다." });
      }
    }
  );
}

module.exports = {
  pptDraftEndpoints,
  PPT_TEMPLATES,
  clampSlideCount,
  buildMessages,
  archiveDocsBlock,
  extractJsonObject,
  generateSlideSpec,
  splitOverflowingContentSlides,
  normalizeChart,
};
