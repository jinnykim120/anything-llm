// [auto-docu PPT 레이아웃 다양화] 기본 content/section 외의 슬라이드 유형과,
// 글자가 넘치지 않게 크기를 맞추는 "적합도 점검" 로직.
//
//   layout: "content"  — 불릿 / 표 / 차트 (제목·불릿·표 글자 크기를 자동으로 맞춤)
//           "content2" — 짧은 불릿 5~8개를 2단으로
//           "stat"     — 핵심 수치 카드 1~4개   { stats:[{value,label,note?}], content? }
//           "compare"  — 2~3단 비교              { columns:[{heading, items[]}] }
//           "timeline" — 단계/일정 3~6개         { steps:[{label,text}] }
//           "quote"    — 인용/핵심 메시지        { quote, subtitle(출처) }
//           "agenda"   — 목차                    { content:[...] }
//
// 텍스트 폭은 렌더러 없이 근사한다(한글 전각 = 1em, 영문/숫자 ≈ 0.55em) —
// LibreOffice 등으로 실제 렌더링해 볼 수 없는 환경에서도 "넘칠 글자"를 코드로
// 미리 걸러 글자 크기를 줄이거나(fit*) 슬라이드를 나누도록(pptSpecPolish) 한다.
const {
  addTopAccentBar,
  addAccentUnderline,
  addSlideFooter,
  addChartContent,
} = require("../agents/aibitat/plugins/create-files/pptx/utils.js");

const MARGIN_X = 0.7;
const CONTENT_W = 8.6;
const FOOTER_Y = 5.0;

function widthEm(str) {
  let w = 0;
  for (const ch of String(str ?? "")) {
    if (ch === " ") w += 0.3;
    else w += ch.codePointAt(0) >= 0x1100 ? 1 : 0.55;
  }
  return w;
}

function countLines(text, fontSize, widthIn) {
  const perLine = widthIn / (fontSize / 72);
  return Math.max(1, Math.ceil(widthEm(text) / perLine));
}

/** 불릿 목록이 (widthIn × heightIn)에 들어가는 가장 큰 글자 크기. */
function fitBullets(
  items,
  widthIn,
  heightIn,
  sizes = [16, 15, 14, 13, 12, 11]
) {
  const textW = widthIn - 0.5; // 불릿 마커 + 텍스트 인셋
  for (const fs of sizes) {
    const lines = items.reduce((n, t) => n + countLines(t, fs, textW), 0);
    const h = lines * (fs / 72) * 1.3 + items.length * 0.11;
    if (h <= heightIn) return { fontSize: fs, fits: true };
  }
  return { fontSize: sizes[sizes.length - 1], fits: false };
}

/** 제목 글자 크기 — 한 줄에 들어가는 가장 큰 크기, 안 되면 16pt(2줄 허용). */
function fitTitle(title) {
  for (const fs of [24, 22, 20, 18]) {
    if (countLines(title, fs, CONTENT_W - 0.2) <= 1) return fs;
  }
  return 16;
}

/** 표가 들어가는 글자 크기와 행 높이. */
function fitTable(table, availH) {
  const headers = table?.headers || [];
  const rows = table?.rows || [];
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const colW = CONTENT_W / colCount - 0.16; // 셀 좌우 여백
  for (const fs of [12, 11, 10, 9]) {
    const rowLines = (r) =>
      Math.max(1, ...r.map((c) => countLines(c, fs, colW)));
    const all = headers.length ? [headers, ...rows] : rows;
    const h = all.reduce(
      (s, r) => s + rowLines(r) * (fs / 72) * 1.25 + 0.11,
      0
    );
    if (h <= availH) return { fontSize: fs, fits: true };
  }
  return { fontSize: 9, fits: false };
}

/** 공통 틀 — 배경·상단 바·제목·밑줄·푸터. 본문 시작 y와 높이를 돌려준다. */
function chrome(slide, pptx, slideData, theme, slideNumber, totalSlides) {
  slide.background = { color: theme.background };
  addTopAccentBar(slide, pptx, theme);
  let y = 0.4;
  if (slideData.title) {
    slide.addText(slideData.title, {
      x: MARGIN_X,
      y: 0.3,
      w: CONTENT_W,
      h: 0.65,
      fontSize: fitTitle(slideData.title),
      bold: true,
      color: theme.titleColor,
      fontFace: theme.fontTitle,
      valign: "bottom",
      fit: "shrink",
    });
    y = 1.0;
    if (slideData.subtitle && slideData.layout !== "quote") {
      slide.addText(slideData.subtitle, {
        x: MARGIN_X,
        y: 1.0,
        w: CONTENT_W,
        h: 0.3,
        fontSize: 13,
        color: theme.subtitleColor,
        fontFace: theme.fontBody,
      });
      y = 1.35;
    }
    addAccentUnderline(slide, pptx, MARGIN_X, y + 0.05, theme.accentColor);
    y += 0.25;
  }
  addSlideFooter(slide, pptx, theme, slideNumber, totalSlides);
  return { y, h: FOOTER_Y - y - 0.15 };
}

function bulletRuns(items, theme, fontSize) {
  return items.map((text) => ({
    text,
    options: {
      fontSize,
      color: theme.bodyColor,
      fontFace: theme.fontBody,
      bullet: { code: "25AA", color: theme.bulletColor },
      paraSpaceAfter: 8,
    },
  }));
}

function renderBullets(slide, items, theme, x, y, w, h) {
  if (!items?.length) return;
  const { fontSize } = fitBullets(items, w, h);
  slide.addText(bulletRuns(items, theme, fontSize), {
    x,
    y,
    w,
    h,
    valign: "top",
  });
}

function renderTable(slide, pptx, table, theme, y, h) {
  const headers = table.headers || [];
  const bodyRows = table.rows || [];
  const { fontSize } = fitTable(table, h);
  const margin = [3, 8, 3, 8];
  const rows = [];
  if (headers.length)
    rows.push(
      headers.map((text) => ({
        text,
        options: {
          bold: true,
          fontSize,
          fontFace: theme.fontBody,
          color: theme.tableHeaderColor,
          fill: { color: theme.tableHeaderBg },
          align: "left",
          valign: "middle",
          margin,
        },
      }))
    );
  bodyRows.forEach((row, idx) =>
    rows.push(
      row.map((text) => ({
        text,
        options: {
          fontSize,
          fontFace: theme.fontBody,
          color: theme.bodyColor,
          fill: {
            color: idx % 2 === 1 ? theme.tableAltRowBg : theme.background,
          },
          align: "left",
          valign: "middle",
          margin,
        },
      }))
    )
  );
  if (!rows.length) return;
  const colCount = rows[0].length;
  slide.addTable(rows, {
    x: MARGIN_X,
    y,
    w: CONTENT_W,
    colW: CONTENT_W / colCount,
    rowH: Math.min(0.4, h / rows.length),
    border: { type: "solid", pt: 0.5, color: theme.tableBorderColor },
  });
}

function statFontSize(value, innerW) {
  // 카드 안쪽 폭에 한 줄로 들어가는 가장 큰 크기(최대 40pt).
  for (const fs of [40, 36, 32, 28, 24, 20, 16]) {
    if (widthEm(value) * (fs / 72) <= innerW * 0.92) return fs;
  }
  return 14;
}

function renderStat(slide, pptx, d, theme, y, h) {
  const stats = d.stats.slice(0, 4);
  const extra = Array.isArray(d.content) && d.content.length ? d.content : [];
  const gap = 0.25;
  const cardW = (CONTENT_W - gap * (stats.length - 1)) / stats.length;
  const cardH = extra.length ? Math.min(2.1, h * 0.62) : Math.min(2.6, h * 0.8);
  const cardY = y + (extra.length ? 0.05 : (h - cardH) / 2 - 0.1);
  stats.forEach((s, i) => {
    const x = MARGIN_X + i * (cardW + gap);
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y: cardY,
      w: cardW,
      h: cardH,
      fill: { color: theme.tableAltRowBg },
      line: { color: theme.tableBorderColor, width: 0.75 },
    });
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y: cardY,
      w: 0.06,
      h: cardH,
      fill: { color: theme.accentColor },
      line: { color: theme.accentColor },
    });
    slide.addText(s.value, {
      x: x + 0.12,
      y: cardY + 0.15,
      w: cardW - 0.2,
      h: cardH * 0.5,
      fontSize: statFontSize(s.value, cardW - 0.3),
      bold: true,
      color: theme.accentColor,
      fontFace: theme.fontTitle,
      align: "center",
      valign: "middle",
      fit: "shrink",
    });
    slide.addText(s.label, {
      x: x + 0.12,
      y: cardY + cardH * 0.55,
      w: cardW - 0.2,
      h: cardH * 0.22,
      fontSize: 13,
      bold: true,
      color: theme.titleColor,
      fontFace: theme.fontBody,
      align: "center",
      valign: "middle",
      fit: "shrink",
    });
    if (s.note)
      slide.addText(s.note, {
        x: x + 0.12,
        y: cardY + cardH * 0.77,
        w: cardW - 0.2,
        h: cardH * 0.2,
        fontSize: 10,
        color: theme.subtitleColor,
        fontFace: theme.fontBody,
        align: "center",
        valign: "top",
        fit: "shrink",
      });
  });
  if (extra.length) {
    const by = cardY + cardH + 0.2;
    renderBullets(slide, extra, theme, MARGIN_X, by, CONTENT_W, y + h - by);
  }
}

function renderCompare(slide, pptx, d, theme, y, h) {
  const cols = d.columns.slice(0, 3);
  const gap = 0.3;
  const colW = (CONTENT_W - gap * (cols.length - 1)) / cols.length;
  // 박스 높이를 내용에 맞춘다(최소 2.2in, 최대 본문 높이).
  const need = Math.max(
    ...cols.map((c) => {
      const lines = c.items.reduce(
        (n, t) => n + countLines(t, 15, colW - 0.7),
        0
      );
      return 0.5 + 0.3 + lines * 0.3 + c.items.length * 0.11;
    })
  );
  h = Math.min(h, Math.max(2.2, need));
  cols.forEach((c, i) => {
    const x = MARGIN_X + i * (colW + gap);
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y,
      w: colW,
      h: 0.5,
      fill: { color: theme.tableHeaderBg },
      line: { color: theme.tableHeaderBg },
    });
    slide.addText(c.heading, {
      x: x + 0.1,
      y,
      w: colW - 0.2,
      h: 0.5,
      fontSize: 14,
      bold: true,
      color: theme.tableHeaderColor,
      fontFace: theme.fontTitle,
      valign: "middle",
      align: "center",
      fit: "shrink",
    });
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y: y + 0.5,
      w: colW,
      h: h - 0.5,
      fill: { color: theme.background },
      line: { color: theme.tableBorderColor, width: 0.75 },
    });
    renderBullets(
      slide,
      c.items,
      theme,
      x + 0.1,
      y + 0.62,
      colW - 0.2,
      h - 0.74
    );
  });
}

function renderTimeline(slide, pptx, d, theme, y, h) {
  const steps = d.steps.slice(0, 6);
  const n = steps.length;
  const slotW = CONTENT_W / n;
  const lineY = y + h * 0.42;
  slide.addShape(pptx.ShapeType.rect, {
    x: MARGIN_X + slotW / 2,
    y: lineY - 0.015,
    w: slotW * (n - 1),
    h: 0.03,
    fill: { color: theme.tableBorderColor },
    line: { color: theme.tableBorderColor },
  });
  steps.forEach((s, i) => {
    const cx = MARGIN_X + slotW * i + slotW / 2;
    slide.addText(s.label, {
      x: cx - slotW / 2 + 0.05,
      y: lineY - 0.85,
      w: slotW - 0.1,
      h: 0.55,
      fontSize: n > 4 ? 12 : 14,
      bold: true,
      color: theme.titleColor,
      fontFace: theme.fontTitle,
      align: "center",
      valign: "bottom",
      fit: "shrink",
    });
    slide.addShape(pptx.ShapeType.ellipse, {
      x: cx - 0.2,
      y: lineY - 0.2,
      w: 0.4,
      h: 0.4,
      fill: { color: theme.accentColor },
      line: { color: theme.background, width: 1.5 },
    });
    slide.addText(String(i + 1), {
      x: cx - 0.2,
      y: lineY - 0.2,
      w: 0.4,
      h: 0.4,
      fontSize: 12,
      bold: true,
      color: "FFFFFF",
      align: "center",
      valign: "middle",
      fontFace: theme.fontBody,
    });
    const boxH = y + h - (lineY + 0.35);
    const fs = fitBullets(
      [s.text || ""],
      slotW - 0.1,
      boxH,
      [13, 12, 11, 10]
    ).fontSize;
    slide.addText(s.text || "", {
      x: cx - slotW / 2 + 0.05,
      y: lineY + 0.35,
      w: slotW - 0.1,
      h: boxH,
      fontSize: fs,
      color: theme.bodyColor,
      fontFace: theme.fontBody,
      align: "center",
      valign: "top",
      fit: "shrink",
    });
  });
}

function renderQuote(slide, pptx, d, theme, y, h) {
  slide.addShape(pptx.ShapeType.rect, {
    x: MARGIN_X,
    y: y + 0.1,
    w: 0.08,
    h: h - 0.7,
    fill: { color: theme.accentColor },
    line: { color: theme.accentColor },
  });
  const size = widthEm(d.quote) > 60 ? 18 : widthEm(d.quote) > 36 ? 22 : 26;
  slide.addText(d.quote, {
    x: MARGIN_X + 0.35,
    y: y + 0.1,
    w: CONTENT_W - 0.4,
    h: h - 0.7,
    fontSize: size,
    italic: true,
    color: theme.titleColor,
    fontFace: theme.fontTitle,
    valign: "middle",
    fit: "shrink",
  });
  if (d.subtitle)
    slide.addText(`— ${d.subtitle}`, {
      x: MARGIN_X + 0.35,
      y: y + h - 0.5,
      w: CONTENT_W - 0.4,
      h: 0.4,
      fontSize: 13,
      color: theme.subtitleColor,
      fontFace: theme.fontBody,
      align: "right",
    });
}

function renderAgenda(slide, pptx, d, theme, y, h) {
  const items = (d.content || []).slice(0, 8);
  const rowH = Math.min(0.55, h / items.length);
  items.forEach((text, i) => {
    const ry = y + 0.05 + i * rowH;
    slide.addShape(pptx.ShapeType.rect, {
      x: MARGIN_X,
      y: ry + (rowH - 0.36) / 2,
      w: 0.36,
      h: 0.36,
      fill: { color: theme.accentColor },
      line: { color: theme.accentColor },
    });
    slide.addText(String(i + 1), {
      x: MARGIN_X,
      y: ry + (rowH - 0.36) / 2,
      w: 0.36,
      h: 0.36,
      fontSize: 13,
      bold: true,
      color: "FFFFFF",
      align: "center",
      valign: "middle",
      fontFace: theme.fontBody,
    });
    slide.addText(text, {
      x: MARGIN_X + 0.55,
      y: ry,
      w: CONTENT_W - 0.55,
      h: rowH,
      fontSize: 18,
      color: theme.bodyColor,
      fontFace: theme.fontBody,
      valign: "middle",
      fit: "shrink",
    });
  });
}

/**
 * content/content2/stat/compare/timeline/quote/agenda 슬라이드를 그린다.
 * (section 은 기존 렌더러가 그대로 담당)
 */
function renderRichSlide(
  slide,
  pptx,
  slideData,
  theme,
  slideNumber,
  totalSlides
) {
  // 필드가 빠진 옛/부분 스펙은 기본 content 로 그린다(렌더러가 죽지 않게).
  const REQUIRED = {
    stat: "stats",
    compare: "columns",
    timeline: "steps",
    quote: "quote",
  };
  const needed = REQUIRED[slideData.layout];
  if (needed && !slideData[needed])
    slideData = { ...slideData, layout: "content" };
  const { y, h } = chrome(
    slide,
    pptx,
    slideData,
    theme,
    slideNumber,
    totalSlides
  );
  switch (slideData.layout) {
    case "stat":
      renderStat(slide, pptx, slideData, theme, y, h);
      break;
    case "compare":
      renderCompare(slide, pptx, slideData, theme, y, h);
      break;
    case "timeline":
      renderTimeline(slide, pptx, slideData, theme, y, h);
      break;
    case "quote":
      renderQuote(slide, pptx, slideData, theme, y, h);
      break;
    case "agenda":
      renderAgenda(slide, pptx, slideData, theme, y, h);
      break;
    case "content2": {
      const items = slideData.content || [];
      const half = Math.ceil(items.length / 2);
      const colW = (CONTENT_W - 0.3) / 2;
      renderBullets(slide, items.slice(0, half), theme, MARGIN_X, y, colW, h);
      renderBullets(
        slide,
        items.slice(half),
        theme,
        MARGIN_X + colW + 0.3,
        y,
        colW,
        h
      );
      break;
    }
    default:
      if (slideData.chart)
        addChartContent(slide, pptx, slideData.chart, theme, y, h);
      else if (slideData.table)
        renderTable(slide, pptx, slideData.table, theme, y, h);
      else
        renderBullets(
          slide,
          slideData.content,
          theme,
          MARGIN_X,
          y,
          CONTENT_W,
          h
        );
  }
  if (slideData.notes) slide.addNotes(slideData.notes);
}

module.exports = {
  renderRichSlide,
  widthEm,
  countLines,
  fitBullets,
  fitTitle,
  fitTable,
  BODY_H: FOOTER_Y - 1.3 - 0.15, // 부제 없는 제목 슬라이드 기준 본문 높이
  CONTENT_W,
};
