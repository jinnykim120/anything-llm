// [auto-docu 목표 3] 초안 내보내기. 지금은 HTML 만 동작하고, docx/xlsx 는
// 준비 중(버튼 비활성)이다.
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

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

const PRINT_CSS = `
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

/** Render just the draft body HTML (for the in-panel preview). */
export function draftBodyHtml(markdown = "") {
  return md.render(markdown || "");
}

/**
 * Build a standalone, self-contained HTML document string from the draft markdown.
 */
export function draftToHtml({
  markdown = "",
  title = "문서 초안",
  modeLabel = "",
}) {
  const body = md.render(markdown || "");
  const stamp = new Date().toLocaleString("ko-KR");
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<div class="doc-meta">${escapeHtml(modeLabel)}${modeLabel ? " · " : ""}생성: ${escapeHtml(stamp)} · Document Expansion LLM</div>
${body}
</body>
</html>`;
}

/** Trigger a browser download of the draft as an .html file. */
export function downloadDraftHtml({ markdown, title, modeLabel }) {
  const html = draftToHtml({ markdown, title, modeLabel });
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
