const createFilesLib = require("../lib.js");

// All positioning assumes LAYOUT_16x9: 10 × 5.625 in.
const MARGIN_X = 0.7;
const CONTENT_W = 8.6; // 10 - 2 × MARGIN_X
const SLIDE_H = 5.625;

function isDarkColor(hexColor) {
  const hex = (hexColor || "FFFFFF").replace("#", "");
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

function addBranding(slide, bgColor) {
  const isDark = isDarkColor(bgColor);
  const textColor = isDark ? "FFFFFF" : "000000";
  const logo = createFilesLib.getLogo({
    forDarkBackground: isDark,
    format: "dataUri",
  });

  slide.addText("Created with", {
    x: 7.85,
    y: 5.06,
    w: 1.85,
    h: 0.12,
    fontSize: 5.5,
    color: textColor,
    transparency: 78,
    fontFace: "Calibri",
    align: "center",
    italic: true,
  });

  if (logo) {
    slide.addImage({
      data: logo,
      x: 8.025,
      y: 5.17,
      w: 1.5,
      h: 0.24,
      transparency: 78,
    });
  } else {
    slide.addText("AnythingLLM", {
      x: 7.85,
      y: 5.17,
      w: 1.85,
      h: 0.24,
      fontSize: 8,
      color: textColor,
      transparency: 78,
      fontFace: "Calibri",
      align: "center",
    });
  }
}

function addTopAccentBar(slide, pptx, theme) {
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: "100%",
    h: 0.05,
    fill: { color: theme.accentColor },
    line: { color: theme.accentColor },
  });
}

function addAccentUnderline(slide, pptx, x, y, color) {
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w: 1.5,
    h: 0.035,
    fill: { color },
    line: { color },
  });
}

function addSlideFooter(slide, pptx, theme, slideNumber, totalSlides) {
  slide.addShape(pptx.ShapeType.rect, {
    x: MARGIN_X,
    y: 5.0,
    w: CONTENT_W,
    h: 0.007,
    fill: { color: theme.footerLineColor },
    line: { color: theme.footerLineColor },
  });

  slide.addText(`${slideNumber}  /  ${totalSlides}`, {
    x: MARGIN_X,
    y: 5.07,
    w: 1.2,
    h: 0.25,
    fontSize: 8,
    color: theme.footerColor,
    fontFace: theme.fontBody,
    align: "left",
  });
}

function renderTitleSlide(
  slide,
  pptx,
  { title, author },
  theme,
  { branding = true } = {}
) {
  slide.background = { color: theme.titleSlideBackground };

  slide.addText(title || "Untitled", {
    x: 1.0,
    y: 1.3,
    w: 8.0,
    h: 1.4,
    fontSize: 36,
    bold: true,
    color: theme.titleSlideTitleColor,
    fontFace: theme.fontTitle,
    align: "center",
    valign: "bottom",
  });

  addAccentUnderline(slide, pptx, 4.25, 2.9, theme.titleSlideAccentColor);

  if (author) {
    slide.addText(author, {
      x: 1.5,
      y: 3.15,
      w: 7.0,
      h: 0.45,
      fontSize: 14,
      color: theme.titleSlideSubtitleColor,
      fontFace: theme.fontBody,
      align: "center",
      italic: true,
    });
  }

  // Bottom accent strip
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: SLIDE_H - 0.1,
    w: "100%",
    h: 0.1,
    fill: { color: theme.titleSlideAccentColor },
    line: { color: theme.titleSlideAccentColor },
  });

  if (branding) addBranding(slide, theme.titleSlideBackground);
}

function renderSectionSlide(
  slide,
  pptx,
  slideData,
  theme,
  slideNumber,
  totalSlides,
  { branding = true } = {}
) {
  slide.background = { color: theme.titleSlideBackground };

  slide.addText(slideData.title || "", {
    x: 1.0,
    y: 1.5,
    w: 8.0,
    h: 1.2,
    fontSize: 32,
    bold: true,
    color: theme.titleSlideTitleColor,
    fontFace: theme.fontTitle,
    align: "center",
    valign: "bottom",
  });

  addAccentUnderline(slide, pptx, 4.25, 2.9, theme.titleSlideAccentColor);

  if (slideData.subtitle) {
    slide.addText(slideData.subtitle, {
      x: 1.5,
      y: 3.1,
      w: 7.0,
      h: 0.5,
      fontSize: 16,
      color: theme.titleSlideSubtitleColor,
      fontFace: theme.fontBody,
      align: "center",
    });
  }

  const numColor = isDarkColor(theme.titleSlideBackground)
    ? "FFFFFF"
    : "000000";
  slide.addText(`${slideNumber}  /  ${totalSlides}`, {
    x: MARGIN_X,
    y: 5.1,
    w: 1.2,
    h: 0.25,
    fontSize: 8,
    color: numColor,
    transparency: 65,
    fontFace: theme.fontBody,
    align: "left",
  });

  if (branding) addBranding(slide, theme.titleSlideBackground);

  if (slideData.notes) slide.addNotes(slideData.notes);
}

function renderContentSlide(
  slide,
  pptx,
  slideData,
  theme,
  slideNumber,
  totalSlides,
  { branding = true } = {}
) {
  slide.background = { color: theme.background };

  addTopAccentBar(slide, pptx, theme);

  let contentStartY = 0.4;

  if (slideData.title) {
    slide.addText(slideData.title, {
      x: MARGIN_X,
      y: 0.3,
      w: CONTENT_W,
      h: 0.65,
      fontSize: 24,
      bold: true,
      color: theme.titleColor,
      fontFace: theme.fontTitle,
      valign: "bottom",
    });
    contentStartY = 1.0;

    if (slideData.subtitle) {
      slide.addText(slideData.subtitle, {
        x: MARGIN_X,
        y: 1.0,
        w: CONTENT_W,
        h: 0.3,
        fontSize: 13,
        color: theme.subtitleColor,
        fontFace: theme.fontBody,
      });
      contentStartY = 1.35;
    }

    addAccentUnderline(
      slide,
      pptx,
      MARGIN_X,
      contentStartY + 0.05,
      theme.accentColor
    );
    contentStartY += 0.25;
  }

  const footerY = 5.0;
  const contentHeight = footerY - contentStartY - 0.15;

  if (slideData.chart) {
    addChartContent(
      slide,
      pptx,
      slideData.chart,
      theme,
      contentStartY,
      contentHeight
    );
  } else if (slideData.table) {
    addTableContent(slide, pptx, slideData.table, theme, contentStartY);
  } else {
    addBulletContent(
      slide,
      slideData.content,
      theme,
      contentStartY,
      contentHeight
    );
  }

  addSlideFooter(slide, pptx, theme, slideNumber, totalSlides);
  if (branding) addBranding(slide, theme.background);

  if (slideData.notes) slide.addNotes(slideData.notes);
}

function renderBlankSlide(
  slide,
  pptx,
  theme,
  slideNumber,
  totalSlides,
  { branding = true } = {}
) {
  slide.background = { color: theme.background };
  addSlideFooter(slide, pptx, theme, slideNumber, totalSlides);
  if (branding) addBranding(slide, theme.background);
}

function addBulletContent(slide, content, theme, startY, maxHeight) {
  if (!Array.isArray(content) || content.length === 0) return;

  const bulletPoints = content.map((text) => ({
    text,
    options: {
      fontSize: 15,
      color: theme.bodyColor,
      fontFace: theme.fontBody,
      bullet: { code: "25AA", color: theme.bulletColor },
      paraSpaceAfter: 10,
    },
  }));

  slide.addText(bulletPoints, {
    x: MARGIN_X,
    y: startY,
    w: CONTENT_W,
    h: maxHeight,
    valign: "top",
  });
}

function addTableContent(slide, pptx, tableData, theme, startY) {
  if (!tableData) return;

  const rows = [];

  if (tableData.headers?.length > 0) {
    rows.push(
      tableData.headers.map((header) => ({
        text: header,
        options: {
          bold: true,
          fontSize: 12,
          fontFace: theme.fontBody,
          color: theme.tableHeaderColor,
          fill: { color: theme.tableHeaderBg },
          align: "left",
          valign: "middle",
          margin: [4, 8, 4, 8],
        },
      }))
    );
  }

  if (tableData.rows?.length > 0) {
    tableData.rows.forEach((row, idx) => {
      rows.push(
        row.map((cell) => ({
          text: cell,
          options: {
            fontSize: 11,
            fontFace: theme.fontBody,
            color: theme.bodyColor,
            fill: {
              color: idx % 2 === 1 ? theme.tableAltRowBg : theme.background,
            },
            align: "left",
            valign: "middle",
            margin: [4, 8, 4, 8],
          },
        }))
      );
    });
  }

  if (rows.length === 0) return;

  const colCount = rows[0].length;
  slide.addTable(rows, {
    x: MARGIN_X,
    y: startY,
    w: CONTENT_W,
    colW: CONTENT_W / colCount,
    rowH: 0.4,
    border: { type: "solid", pt: 0.5, color: theme.tableBorderColor },
  });
}

function lightenHex(hex, amount) {
  const h = (hex || "000000").replace("#", "");
  const r = parseInt(h.substr(0, 2), 16);
  const g = parseInt(h.substr(2, 2), 16);
  const b = parseInt(h.substr(4, 2), 16);
  const blend = (c) => Math.round(c + (255 - c) * amount);
  return [blend(r), blend(g), blend(b)]
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

// 테마별로 별도의 차트 팔레트를 추가하지 않고, 이미 있는 테마 토큰(강조색 ·
// 불릿색 · 표 헤더색 · 타이틀 슬라이드 강조색)을 그대로 계열 색상으로 재사용한다
// — 그래야 차트가 나머지 슬라이드와 같은 색으로 보이고, 테마 파일을 건드릴
// 필요도 없다. 다만 테마 중에는(예: corporate) 이 네 토큰이 실제로는 색 2개
// (금색·남색)뿐인 경우가 있어, 계열이 3개 이상인 차트(특히 파이)에서 인접
// 조각이 구분되지 않는다 — 그럴 땐 밝기를 섞은 변형색을 채워 넣어 계열마다
// 눈에 띄게 다른 색이 되도록 한다.
function chartColorsForTheme(theme, seriesCount = 4) {
  const base = [
    ...new Set(
      [
        theme.accentColor,
        theme.tableHeaderBg,
        theme.bulletColor,
        theme.titleSlideAccentColor,
      ].filter(Boolean)
    ),
  ];
  const palette = [...base];
  let i = 0;
  while (palette.length < Math.max(seriesCount, base.length)) {
    const src = base[i % base.length];
    const amount = 0.3 * (Math.floor(i / base.length) + 1);
    palette.push(lightenHex(src, Math.min(amount, 0.75)));
    i++;
  }
  return palette;
}

function addChartContent(slide, pptx, chartData, theme, startY, maxHeight) {
  if (
    !chartData ||
    !Array.isArray(chartData.series) ||
    !chartData.series.length
  )
    return;

  const chartTypeMap = {
    bar: pptx.ChartType.bar,
    line: pptx.ChartType.line,
    pie: pptx.ChartType.pie,
  };
  const chartType = chartTypeMap[chartData.type] || pptx.ChartType.bar;
  const categories = Array.isArray(chartData.categories)
    ? chartData.categories
    : [];
  const isPie = chartData.type === "pie";

  // pie는 계열 하나만 의미가 있다 — 여러 계열을 주면 첫 계열만 쓴다.
  const seriesForChart = isPie
    ? [
        {
          name: chartData.series[0]?.name || "",
          labels: categories,
          values: chartData.series[0]?.values || [],
        },
      ]
    : chartData.series.map((s) => ({
        name: s.name || "",
        labels: categories,
        values: Array.isArray(s.values) ? s.values : [],
      }));

  const seriesCount = isPie ? categories.length : seriesForChart.length;
  slide.addChart(chartType, seriesForChart, {
    x: MARGIN_X,
    y: startY,
    w: CONTENT_W,
    h: maxHeight,
    chartColors: chartColorsForTheme(theme, seriesCount),
    showLegend: isPie || seriesForChart.length > 1,
    legendPos: "b",
    legendColor: theme.bodyColor,
    showTitle: false,
    catAxisLabelColor: theme.bodyColor,
    valAxisLabelColor: theme.bodyColor,
    dataLabelColor: isPie ? "FFFFFF" : theme.bodyColor,
    ...(isPie ? { showPercent: true, showValue: false } : {}),
  });
}

module.exports = {
  isDarkColor,
  addBranding,
  addTopAccentBar,
  addAccentUnderline,
  addSlideFooter,
  renderTitleSlide,
  renderSectionSlide,
  renderContentSlide,
  renderBlankSlide,
  addBulletContent,
  addTableContent,
  addChartContent,
  chartColorsForTheme,
};
