// [auto-docu PPT 화면 편집 Phase 3b] 슬라이드 스펙(JSON) 안의 요소를 id로
// 찾아 텍스트만 바꿔 넣는다. 두 단계 granularity를 지원한다:
//   항목 단위: "2.bullet.1"(불릿 하나), "3.cell.1.2"(표 1행 2열), "1.header.0"
//   블록 단위: "2.content"(불릿 목록 전체), "3.table"(표 전체), "4.chart"(차트 전체)
// 차트는 표처럼 낱개 데이터 포인트 단위 편집은 지원하지 않는다 — 통째로
// 한 블록으로 취급한다(HTML 미리보기의 표를 블록 단위로만 편집 가능하게 한
// 것과 같은 이유: 데이터 포인트 하나하나에 안정적인 id를 매기기보다 전체를
// 텍스트로 직렬화해 주고받는 편이 훨씬 단순하다).
// DraftPanel(Phase 1)과 DocRegen 폴더 PPT(Phase 2) 양쪽의 PPT 미리보기에서
// 그대로 재사용한다.

/** 블록 단위 선택 시 LLM에 보낼 "현재 텍스트"를 만든다 — content는 불릿
 * 목록을 markdown 리스트로, table은 파이프(|) 구분 텍스트로 직렬화한다. */
export function blockTextFor(slide, kind) {
  if (kind === "content")
    return (slide.content || []).map((c) => `- ${c}`).join("\n");
  if (kind === "table") {
    const { headers = [], rows = [] } = slide.table || {};
    return [headers.join(" | "), ...rows.map((r) => r.join(" | "))].join("\n");
  }
  if (kind === "chart") {
    const { type = "bar", categories = [], series = [] } = slide.chart || {};
    const lines = [`유형: ${type}`, `항목: ${categories.join(" | ")}`];
    for (const s of series)
      lines.push(`${s.name || "계열"}: ${(s.values || []).join(" | ")}`);
    return lines.join("\n");
  }
  return "";
}

function parseContentBlock(text) {
  return String(text)
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function parseTableBlock(text) {
  const lines = String(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const [headerLine, ...rowLines] = lines;
  const headers = (headerLine || "").split("|").map((c) => c.trim());
  const rows = rowLines.map((l) => l.split("|").map((c) => c.trim()));
  return { headers, rows };
}

function parseChartBlock(text) {
  const lines = String(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let type = "bar";
  let categories = [];
  const series = [];
  for (const line of lines) {
    const sepIdx = line.indexOf(":");
    if (sepIdx === -1) continue;
    const key = line.slice(0, sepIdx).trim();
    const value = line.slice(sepIdx + 1).trim();
    if (key === "유형") {
      if (["bar", "line", "pie"].includes(value)) type = value;
    } else if (key === "항목") {
      categories = value
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
    } else if (key) {
      series.push({
        name: key,
        values: value.split("|").map((v) => {
          const n = Number(v.trim());
          return Number.isFinite(n) ? n : 0;
        }),
      });
    }
  }
  return { type, categories, series };
}

export function patchSlideSpec(slideSpec, id, revisedText) {
  const [slideIdxStr, kind, a, b] = id.split(".");
  const slideIdx = Number(slideIdxStr);
  const slides = slideSpec.slides.map((slide, i) => {
    if (i !== slideIdx) return slide;
    const next = { ...slide };
    if (kind === "title") next.title = revisedText;
    else if (kind === "content") next.content = parseContentBlock(revisedText);
    else if (kind === "bullet") {
      const content = [...(slide.content || [])];
      content[Number(a)] = revisedText;
      next.content = content;
    } else if (kind === "table") next.table = parseTableBlock(revisedText);
    else if (kind === "chart") next.chart = parseChartBlock(revisedText);
    else if (kind === "header") {
      const table = {
        ...slide.table,
        headers: [...(slide.table?.headers || [])],
      };
      table.headers[Number(a)] = revisedText;
      next.table = table;
    } else if (kind === "cell") {
      const table = {
        ...slide.table,
        rows: (slide.table?.rows || []).map((row) => [...row]),
      };
      table.rows[Number(a)][Number(b)] = revisedText;
      next.table = table;
    }
    return next;
  });
  return { ...slideSpec, slides };
}
