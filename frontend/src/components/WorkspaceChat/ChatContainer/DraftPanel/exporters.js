// [auto-docu 목표 3] 초안 내보내기. 지금은 HTML 만 동작하고, docx/xlsx 는
// 준비 중(버튼 비활성)이다.
//
// 기본값은 텍스트 위주의 수수한 스타일(피드백: "기존 게 더 좋다") — 색이
// 들어간 카드형 디자인은 사용자가 추가 요청란에 명시적으로 요청할 때만.
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

// 문서 유형(기본/분석)별 강조 색 — "디자인 요소" 요청이 있을 때만 쓰인다.
export const DRAFT_ACCENT = {
  basic: { accent: "#2563eb", accentSoft: "#eff6ff", accentDark: "#1e40af" },
  analysis: { accent: "#0f766e", accentSoft: "#f0fdfa", accentDark: "#115e59" },
};

function accentFor(reportType) {
  return DRAFT_ACCENT[reportType] || DRAFT_ACCENT.basic;
}

// 추가 요청 문구에 이 중 하나라도 있으면 색이 들어간 디자인 테마를 적용한다.
const DESIGN_KEYWORDS = [
  "디자인",
  "색상",
  "컬러",
  "칼라",
  "포인트컬러",
  "이쁘게",
  "예쁘게",
  "꾸며",
  "강조 박스",
  "비주얼",
  "화려하게",
  "표지",
];

/** 사용자의 추가 요청 문구에서 "디자인 요소를 넣어달라"는 의도를 감지한다. */
export function detectDesignRequest(instructions = "") {
  const s = String(instructions || "");
  return DESIGN_KEYWORDS.some((k) => s.includes(k));
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function safeFileName(name = "문서 초안") {
  return (
    String(name)
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, "_")
      .slice(0, 60) || "문서_초안"
  );
}

/** First "# " line of the (possibly user-edited) markdown, else a fallback. */
export function extractDraftTitle(markdown = "", fallback = "문서 초안") {
  const line = String(markdown)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("# "));
  if (!line) return fallback;
  return line.replace(/^#\s+/, "").trim() || fallback;
}

// 기본 테마 — 수수한 흑백 위주, 텍스트가 중심.
const PLAIN_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    max-width: 820px;
    margin: 48px auto;
    padding: 0 24px;
    font-family: "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.75;
    color: #1a1a1a;
    background: #fff;
  }
  h1 { font-size: 1.7em; border-bottom: 2px solid #222; padding-bottom: .3em; margin: 0 0 .8em; }
  h2 { font-size: 1.3em; margin: 1.8em 0 .6em; border-left: 4px solid #2563eb; padding-left: .5em; }
  h3 { font-size: 1.1em; margin: 1.4em 0 .5em; }
  p { margin: .6em 0; }
  ul, ol { margin: .6em 0; padding-left: 1.4em; }
  li { margin: .25em 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .95em; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; }
  th { background: #f1f5f9; }
  blockquote { margin: 1em 0; padding: .4em 1em; border-left: 3px solid #94a3b8; color: #475569; }
  code { background: #f1f5f9; padding: .1em .35em; border-radius: 3px; font-size: .9em; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 2em 0; }
  .doc-meta { color: #64748b; font-size: .85em; margin-bottom: 2.4em; }
  @media print { body { margin: 0; } }
`;

// 디자인 테마 — 색 포인트 카드형. "디자인 요소" 요청이 있을 때만.
function designedCss({ accent, accentSoft, accentDark }) {
  return `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    max-width: 860px;
    margin: 0 auto 64px;
    padding: 0 28px;
    font-family: "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.75;
    color: #1e293b;
    background: #fff;
  }
  .doc-cover {
    margin: 0 -28px 2em;
    padding: 34px 28px 26px;
    background: linear-gradient(135deg, ${accent}, ${accentDark});
    color: #fff;
    border-radius: 0 0 18px 18px;
  }
  .doc-cover .doc-kicker {
    display: inline-flex;
    align-items: center;
    gap: .4em;
    font-size: .72em;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
    background: rgba(255,255,255,.18);
    padding: .3em .8em;
    border-radius: 999px;
  }
  .doc-cover h1 {
    margin: .5em 0 .2em;
    font-size: 1.65em;
    font-weight: 800;
    line-height: 1.35;
    border: none;
    padding: 0;
    color: #fff;
  }
  .doc-cover .doc-meta {
    margin: 0;
    font-size: .82em;
    color: rgba(255,255,255,.85);
  }
  .doc-body h1 { display: none; } /* 표지에서 이미 제목을 보여줌 */
  h2 {
    font-size: 1.22em;
    font-weight: 700;
    margin: 1.9em 0 .7em;
    padding: .5em .8em;
    background: ${accentSoft};
    border-left: 5px solid ${accent};
    border-radius: 6px;
    color: ${accentDark};
  }
  h3 {
    font-size: 1.05em;
    font-weight: 700;
    margin: 1.4em 0 .5em;
    color: ${accentDark};
  }
  h3::before { content: "▸ "; color: ${accent}; }
  p { margin: .6em 0; }
  ul, ol { margin: .6em 0; padding-left: 1.5em; }
  li { margin: .3em 0; }
  li::marker { color: ${accent}; }
  strong { color: ${accentDark}; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .92em; overflow: hidden; border-radius: 8px; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; }
  th { background: ${accent}; color: #fff; font-weight: 600; }
  tbody tr:nth-child(even) { background: ${accentSoft}; }
  blockquote {
    margin: 1.2em 0;
    padding: .7em 1.1em;
    background: ${accentSoft};
    border-left: 4px solid ${accent};
    border-radius: 6px;
    color: #334155;
  }
  code { background: #f1f5f9; padding: .1em .35em; border-radius: 3px; font-size: .9em; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 2em 0; }
  .doc-footer {
    margin-top: 3em;
    padding-top: 1em;
    border-top: 2px solid ${accentSoft};
    color: #94a3b8;
    font-size: .78em;
    text-align: center;
  }
  @media print { .doc-cover { border-radius: 0; margin: 0 -28px 2em; } }
`;
}

/** Render just the draft body HTML (for the in-panel preview). */
export function draftBodyHtml(markdown = "") {
  return md.render(markdown || "");
}

// [auto-docu 화면 편집 Phase 3a] 미리보기의 각 블록(문단/소제목/목록/표 등)에
// data-block-id를 매겨, 클릭한 블록만 스코프로 잡아 대화로 수정할 수 있게
// 한다. 두 단계 granularity: level-0(최상위) 블록은 항상 하나의 단위이고,
// 그 블록이 목록(bullet/ordered list)이면 각 항목(list_item)에도 별도
// id("b3.item0" 형태)를 매겨 "항목 하나만" 선택할 수도 있게 한다 — 표는
// td/th 토큰에 markdown-it이 소스 line map을 안 주기 때문에(행은 준다)
// level-0(표 전체) 단위로만 남겨둔다. 문단/소제목은 원래 하위 항목이 없어
// 단일 단계 그대로.
export function draftBodyHtmlBlocks(markdown = "") {
  const src = markdown || "";
  const tokens = md.parse(src, {});
  const lines = src.split("\n");
  const blocks = [];
  let blockIndex = 0;
  let currentListBlockId = null;
  let itemIndex = 0;

  for (const token of tokens) {
    if (token.level === 0) {
      if (token.type.endsWith("_open") || token.type === "hr") {
        const id = `b${blockIndex++}`;
        token.attrSet("data-block-id", id);
        if (token.map) {
          const [start, end] = token.map;
          blocks.push({
            id,
            source: lines.slice(start, end).join("\n"),
            startLine: start,
            endLine: end,
          });
        }
        currentListBlockId =
          token.type === "bullet_list_open" ||
          token.type === "ordered_list_open"
            ? id
            : null;
        itemIndex = 0;
      } else if (token.type.endsWith("_close")) {
        currentListBlockId = null;
      }
      continue;
    }
    if (currentListBlockId && token.type === "list_item_open" && token.map) {
      const itemId = `${currentListBlockId}.item${itemIndex++}`;
      token.attrSet("data-block-id", itemId);
      const [start, end] = token.map;
      blocks.push({
        id: itemId,
        source: lines.slice(start, end).join("\n"),
        startLine: start,
        endLine: end,
      });
    }
  }

  const html = md.renderer.render(tokens, md.options, {});
  return { html, blocks };
}

/**
 * Build a standalone, self-contained HTML document string from the draft
 * markdown. `designed: true` switches to the colored cover+theme variant —
 * default is the plain, text-first layout.
 */
export function draftToHtml({
  markdown = "",
  title = "문서 초안",
  modeLabel = "",
  reportType = "basic",
  designed = false,
}) {
  const body = md.render(markdown || "");
  const stamp = new Date().toLocaleString("ko-KR");
  const resolvedTitle = extractDraftTitle(markdown, title);

  if (!designed) {
    return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(resolvedTitle)}</title>
<style>${PLAIN_CSS}</style>
</head>
<body>
<div class="doc-meta">${escapeHtml(modeLabel)}${modeLabel ? " · " : ""}생성: ${escapeHtml(stamp)} · NEXUS</div>
${body}
</body>
</html>`;
  }

  const { accent, accentSoft, accentDark } = accentFor(reportType);
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(resolvedTitle)}</title>
<style>${designedCss({ accent, accentSoft, accentDark })}</style>
</head>
<body>
<div class="doc-cover">
  <span class="doc-kicker">${escapeHtml(modeLabel || "문서 초안")}</span>
  <h1>${escapeHtml(resolvedTitle)}</h1>
  <p class="doc-meta">생성: ${escapeHtml(stamp)} · NEXUS</p>
</div>
<div class="doc-body">
${body}
</div>
<div class="doc-footer">NEXUS · 정책지원팀 문서 초안 도우미</div>
</body>
</html>`;
}

/** Trigger a browser download of the draft as an .html file. */
export function downloadDraftHtml({
  markdown,
  title,
  modeLabel,
  reportType,
  designed,
}) {
  const html = draftToHtml({
    markdown,
    title,
    modeLabel,
    reportType,
    designed,
  });
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFileName(extractDraftTitle(markdown, title))}_${todayStamp()}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// [auto-docu 내부생성자료] PPT를 내려받을 때 아카이브에 넣는 건 .pptx 파일이 아니라,
// 그 직전까지 만들어 둔 슬라이드 세부 내용(글씨)이다 — 제목/부제/불릿/표/그래프
// 수치/발표자 노트까지 빠짐없이 마크다운 텍스트로 풀어 검색·재활용할 수 있게 한다.
export function slideSpecToMarkdown(slideSpec) {
  const slides = slideSpec?.slides || [];
  const CHART_LABEL = { bar: "막대", line: "선", pie: "원형" };
  const blocks = slides.map((s, i) => {
    const parts = [`## ${i + 1}. ${s.title || "(제목 없음)"}`];
    if (s.subtitle) parts.push(s.subtitle);
    if (Array.isArray(s.content) && s.content.length)
      parts.push(s.content.map((c) => `- ${c}`).join("\n"));
    if (s.table?.headers?.length) {
      parts.push(
        [
          `| ${s.table.headers.join(" | ")} |`,
          `| ${s.table.headers.map(() => "---").join(" | ")} |`,
          ...(s.table.rows || []).map((r) => `| ${r.join(" | ")} |`),
        ].join("\n")
      );
    }
    if (s.chart?.categories?.length && s.chart?.series?.length) {
      parts.push(
        [
          `(${CHART_LABEL[s.chart.type] || ""} 그래프 데이터)`,
          `| 항목 | ${s.chart.series.map((x) => x.name || "값").join(" | ")} |`,
          `| --- | ${s.chart.series.map(() => "---").join(" | ")} |`,
          ...s.chart.categories.map(
            (c, idx) =>
              `| ${c} | ${s.chart.series.map((x) => x.values?.[idx] ?? "").join(" | ")} |`
          ),
        ].join("\n")
      );
    }
    if (s.notes) parts.push(`> 발표자 노트: ${s.notes}`);
    return parts.join("\n\n");
  });
  return `# ${slideSpec?.title || "PPT 초안"}\n\n${blocks.join("\n\n")}`;
}
