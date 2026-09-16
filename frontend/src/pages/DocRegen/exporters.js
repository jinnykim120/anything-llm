// [auto-docu 전사문서작성tool] 결과 문서 렌더링 + 내보내기.
// DraftPanel/exporters.js와 같은 원리(자체 markdown-it 인스턴스, 텍스트
// 위주 테마) — 이 기능은 디자인 테마 선택 없이 항상 같은 수수한 스타일.
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

// 본문에 남아있는 "[자료 필요: ...]" 마커를 클릭 가능한 버튼으로 바꾼다 —
// Citation/index.jsx의 linkifyCitationMarkers와 같은 패턴.
const NEEDS_MARKER_RE = /\[자료 필요:\s*([^\]]+)\]/g;

function escapeAttr(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function linkifyNeedsMarkers(html = "") {
  return html.replace(
    NEEDS_MARKER_RE,
    (_m, desc) =>
      `<button type="button" class="needs-ref" data-need="${escapeAttr(desc.trim())}">[자료 필요: ${desc}]</button>`
  );
}

/** Render the result markdown to HTML (for the in-page preview). */
export function resultBodyHtml(markdown = "") {
  return md.render(markdown || "");
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

function safeFileName(name = "문서") {
  return (
    String(name)
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, "_")
      .slice(0, 60) || "문서"
  );
}

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
  h2 { font-size: 1.3em; margin: 1.8em 0 .6em; border-left: 4px solid #7c3aed; padding-left: .5em; }
  p { margin: .6em 0; }
  ul, ol { margin: .6em 0; padding-left: 1.4em; }
  li { margin: .25em 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .95em; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; }
  th { background: #f1f5f9; }
  .doc-meta { color: #64748b; font-size: .85em; margin-bottom: 2.4em; }
  .needs { color: #b45309; font-weight: 600; }
  @media print { body { margin: 0; } }
`;

/** Standalone HTML document for the generated draft — plain theme only. */
export function docRegenToHtml({ markdown = "", title = "문서 초안" }) {
  // "[자료 필요: ...]" 는 다운로드된 파일에서도 강조되도록 <mark class="needs">로.
  const highlighted = String(markdown).replace(
    NEEDS_MARKER_RE,
    (_m, desc) => `**[자료 필요: ${desc}]**`
  );
  const body = md
    .render(highlighted)
    .replace(
      /<strong>\[자료 필요: ([^\]]+)\]<\/strong>/g,
      '<mark class="needs">[자료 필요: $1]</mark>'
    );
  const stamp = new Date().toLocaleString("ko-KR");
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${PLAIN_CSS}</style>
</head>
<body>
<div class="doc-meta">전사문서작성tool · 생성: ${escapeHtml(stamp)} · Recode</div>
${body}
</body>
</html>`;
}

export function downloadDocRegenHtml({ markdown, title }) {
  const html = docRegenToHtml({ markdown, title });
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFileName(title)}_${todayStamp()}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * "자료요청서" — 문서 전체에서 [자료 필요]로 표시된 항목을 절별로 모아,
 * 그 근거(신규 기준 발췌)와 참고용 과거 내용을 함께 담은 요청 문서.
 * 관계 부서에 그대로 보낼 수 있게 만든다.
 */
export function buildRequestSheetHtml({ title = "문서", sections = [] }) {
  const withNeeds = sections.filter((s) => (s.needs || []).length > 0);
  const stamp = new Date().toLocaleString("ko-KR");

  if (!withNeeds.length) {
    return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8" /><title>${escapeHtml(title)} — 자료요청서</title>
<style>${PLAIN_CSS}</style></head>
<body><div class="doc-meta">생성: ${escapeHtml(stamp)}</div>
<h1>${escapeHtml(title)} — 자료요청서</h1>
<p>부족한 자료가 없습니다. 모든 절이 아카이브 근거로 채워졌습니다.</p>
</body></html>`;
  }

  const items = withNeeds
    .map((s) => {
      const needsList = s.needs
        .map((n) => `<li>${escapeHtml(n)}</li>`)
        .join("");
      const guidance = s.guidanceExcerpt
        ? `<p><b>근거(신규 기준 발췌):</b><br/>${escapeHtml(s.guidanceExcerpt)}</p>`
        : "";
      const prior = s.priorContent
        ? `<p><b>과거(작년) 참고자료:</b><br/><span style="white-space:pre-line">${escapeHtml(s.priorContent.slice(0, 1500))}</span></p>`
        : "<p><b>과거 참고자료:</b> 없음(완전 신규 항목)</p>";
      return `<section style="margin-bottom:2em; padding-bottom:1.4em; border-bottom:1px solid #e2e8f0;">
        <h2>${escapeHtml(s.title)}</h2>
        <p><b>요청 항목:</b></p>
        <ul>${needsList}</ul>
        ${guidance}
        ${prior}
      </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — 자료요청서</title>
<style>${PLAIN_CSS}</style>
</head>
<body>
<div class="doc-meta">전사문서작성tool · 생성: ${escapeHtml(stamp)}</div>
<h1>${escapeHtml(title)} — 자료요청서</h1>
<p>아래 항목은 아카이브에 근거가 부족해 채우지 못했습니다. 관계 부서에 요청해 주세요.</p>
${items}
</body>
</html>`;
}

export function downloadRequestSheet({ title, sections }) {
  const html = buildRequestSheetHtml({ title, sections });
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFileName(title)}_자료요청서_${todayStamp()}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
