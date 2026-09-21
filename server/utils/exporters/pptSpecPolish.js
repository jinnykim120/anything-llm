// [auto-docu PPT 레이아웃 다양화] LLM이 만든 슬라이드 스펙을 결정적 규칙으로
// 다듬는다(LLM 호출 없음):
//   1) normalizeSlide      — 새 레이아웃(stat/compare/timeline/quote/agenda) 정제
//   2) tableToChart        — 숫자 위주의 작은 표는 차트로 (읽기 쉬움)
//   3) applyDensityRules   — 짧은 불릿 5~8개 → 2단, 넘치는 불릿/표는 나눠 담기
//   4) ensureAgenda        — 구분(section) 슬라이드가 2개 이상이면 목차 자동 삽입
// 순서: normalize → tableToChart → density → agenda (pptDraft.polishSlides).
const { fitBullets, fitTable, CONTENT_W } = require("./pptxLayouts");

const LAYOUTS = new Set([
  "section",
  "content",
  "stat",
  "compare",
  "timeline",
  "quote",
  "agenda",
]);

const BODY_H = 3.45; // 제목+밑줄 아래 본문 영역 높이(부제 없는 기본 슬라이드)
const MAX_TABLE_ROWS = 8;
const MAX_BULLETS_PER_SLIDE = 6;
const TWO_COL_MAX_BULLETS = 8;
const TWO_COL_MAX_CHARS = 28;

const str = (v) => (v == null ? "" : String(v).trim());
const strList = (arr) =>
  (Array.isArray(arr) ? arr : []).map(str).filter(Boolean);

// 데이터가 모자라 일반 content 로 되돌릴 때, 그 슬라이드가 가진 내용을 불릿으로
// 살려서 빈 슬라이드가 되지 않게 한다(예: 단계가 2개뿐인 타임라인 → 불릿 2개).
function richToBullets(s) {
  const out = [];
  (Array.isArray(s.stats) ? s.stats : []).forEach((x) => {
    if (x?.value && x?.label)
      out.push(
        `${str(x.label)}: ${str(x.value)}${x.note ? ` (${str(x.note)})` : ""}`
      );
  });
  (Array.isArray(s.columns) ? s.columns : []).forEach((c) => {
    strList(c?.items).forEach((it) =>
      out.push(c?.heading ? `${str(c.heading)}: ${it}` : it)
    );
  });
  (Array.isArray(s.steps) ? s.steps : []).forEach((x) => {
    if (x?.label)
      out.push(x.text ? `${str(x.label)}: ${str(x.text)}` : str(x.label));
  });
  return out;
}

function normalizeSlide(s) {
  const base = {
    layout: LAYOUTS.has(s.layout) ? s.layout : "content",
    title: str(s.title),
    subtitle: str(s.subtitle),
    content: Array.isArray(s.content) ? strList(s.content) : undefined,
    table:
      s.table && Array.isArray(s.table.headers) && Array.isArray(s.table.rows)
        ? s.table
        : undefined,
    chart: s.chart,
    notes: s.notes || undefined,
  };

  if (base.layout === "stat") {
    const stats = (Array.isArray(s.stats) ? s.stats : [])
      .map((x) => ({
        value: str(x?.value),
        label: str(x?.label),
        note: str(x?.note) || undefined,
      }))
      .filter((x) => x.value && x.label)
      .slice(0, 4);
    if (stats.length) base.stats = stats;
    else base.layout = "content";
  } else if (base.layout === "compare") {
    const columns = (Array.isArray(s.columns) ? s.columns : [])
      .map((c) => ({ heading: str(c?.heading), items: strList(c?.items) }))
      .filter((c) => c.heading && c.items.length)
      .slice(0, 3);
    if (columns.length >= 2) base.columns = columns;
    else base.layout = "content";
  } else if (base.layout === "timeline") {
    const steps = (Array.isArray(s.steps) ? s.steps : [])
      .map((x) => ({ label: str(x?.label), text: str(x?.text) }))
      .filter((x) => x.label)
      .slice(0, 6);
    if (steps.length >= 2) base.steps = steps;
    else base.layout = "content";
  } else if (base.layout === "quote") {
    const quote = str(s.quote);
    if (quote) base.quote = quote;
    else base.layout = "content";
  } else if (base.layout === "agenda") {
    if (!base.content?.length) base.layout = "content";
  }
  if (
    base.layout === "content" &&
    s.layout !== "content" &&
    s.layout !== "section"
  ) {
    // 되돌려진 슬라이드: 기존 불릿이 없으면 리치 데이터를 불릿으로.
    if (!base.content?.length && !base.table && !base.chart) {
      const bullets = richToBullets(s);
      if (bullets.length) base.content = bullets;
      else if (s.quote) base.content = [str(s.quote)];
    }
  }
  return base;
}

// "11조 803억", "1,234", "△5.2%", "-3" → 숫자와 단위. 해석 못 하면 null.
function parseNumeric(cell) {
  const t = str(cell);
  const m = t.match(
    /^([-+△▲]?)\s*(\d[\d,]*(?:\.\d+)?)\s*([%가-힣a-zA-Z]{0,6})$/
  );
  if (!m) return null;
  // 날짜·기간 단위(9월, 3일, 2분기…)는 값이 아니라 시점이다.
  if (/^(월|일|년|시|분|분기|주|차|기)$/.test(m[3])) return null;
  const n = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return {
    n: m[1] === "-" || m[1] === "△" || m[1] === "▲" ? -n : n,
    unit: m[3],
  };
}

const TIME_LABEL =
  /^(\d{2,4}\s*(년|\.|\/|-)?|\d{1,2}\s*월|[1-4]\s*(Q|분기)|Q[1-4]|[12]H|상반기|하반기|FY\s*\d+)/i;

/**
 * 숫자 위주의 작은 표(행 2~8, 계열 1~4)를 차트로 바꾼다. 조건에 안 맞으면 null.
 */
function tableToChart(slide) {
  const t = slide.table;
  if (!t || slide.chart || slide.content?.length) return null;
  const headers = t.headers || [];
  const rows = t.rows || [];
  if (rows.length < 2 || rows.length > 8) return null;
  const cols = headers.length;
  if (cols < 2 || cols > 5) return null;
  if (rows.some((r) => r.length !== cols)) return null;

  const parsed = rows.map((r) => r.slice(1).map(parseNumeric));
  if (parsed.some((r) => r.some((p) => p === null))) return null;
  if (rows.some((r) => !str(r[0]))) return null;
  // 열마다 단위가 하나로 통일돼 있어야 같은 축에 그릴 수 있다.
  for (let c = 0; c < cols - 1; c++) {
    const units = new Set(parsed.map((r) => r[c].unit));
    if (units.size > 1) return null;
  }
  // 열 사이 단위가 다르면(예: 억원 vs %) 한 차트에 못 담는다.
  const colUnits = headers.slice(1).map((_, c) => parsed[0][c].unit);
  if (new Set(colUnits).size > 1) return null;

  // 계열끼리 크기가 10배 넘게 다르면(예: 조원 vs 억원) 한 축에서 작은 쪽이 납작해진다.
  if (cols > 2) {
    const maxes = headers
      .slice(1)
      .map((_, c) => Math.max(...parsed.map((r) => Math.abs(r[c].n))));
    if (Math.max(...maxes) > 10 * Math.max(Math.min(...maxes), 1e-9))
      return null;
  }

  const categories = rows.map((r) => str(r[0]));
  const series = headers.slice(1).map((h, c) => {
    const unit = colUnits[c];
    return {
      name: unit && !str(h).includes(unit) ? `${str(h)}(${unit})` : str(h),
      values: parsed.map((r) => r[c].n),
    };
  });
  const allPositive = series.every((s) => s.values.every((v) => v >= 0));
  const looksShare = /비중|구성|비율|점유|share/i.test(
    `${slide.title} ${headers.join(" ")}`
  );
  let type = "bar";
  if (series.length === 1 && rows.length <= 6 && allPositive && looksShare)
    type = "pie";
  else if (rows.length >= 3 && categories.every((c) => TIME_LABEL.test(c)))
    type = "line";
  return { type, categories, series };
}

function splitBullets(slide, size) {
  const chunks = [];
  for (let i = 0; i < slide.content.length; i += size)
    chunks.push(slide.content.slice(i, i + size));
  return chunks.map((chunk, idx) => ({
    ...slide,
    title:
      chunks.length > 1
        ? `${slide.title} (${idx + 1}/${chunks.length})`
        : slide.title,
    subtitle: idx === 0 ? slide.subtitle : "",
    content: chunk,
  }));
}

/**
 * 밀도 규칙 — 반환: { slides, twoCol, split }
 *  - 짧은 불릿 5~8개 → content2(2단)
 *  - 불릿이 그래도 한 장에 안 들어가면(글자 수 기준) 나눠 담기
 *  - 표 행이 8개를 넘으면 머리글을 반복해 나눠 담기
 */
function applyDensityRules(slides) {
  const out = [];
  let twoCol = 0;
  let split = 0;
  for (const s of slides) {
    if (
      s.layout === "content" &&
      s.table &&
      s.table.rows.length > MAX_TABLE_ROWS
    ) {
      const rows = s.table.rows;
      const parts = Math.ceil(rows.length / MAX_TABLE_ROWS);
      const per = Math.ceil(rows.length / parts);
      for (let p = 0; p < parts; p++)
        out.push({
          ...s,
          title: `${s.title} (${p + 1}/${parts})`,
          subtitle: p === 0 ? s.subtitle : "",
          table: { ...s.table, rows: rows.slice(p * per, (p + 1) * per) },
        });
      split += 1;
      continue;
    }
    if (
      s.layout === "content" &&
      s.table &&
      s.table.rows.length >= 2 &&
      !fitTable(s.table, BODY_H).fits
    ) {
      // 글자 수 때문에 표가 넘칠 것 같으면 반으로 나눈다.
      const rows = s.table.rows;
      const mid = Math.ceil(rows.length / 2);
      [rows.slice(0, mid), rows.slice(mid)].forEach((part, i) =>
        out.push({
          ...s,
          title: `${s.title} (${i + 1}/2)`,
          subtitle: i === 0 ? s.subtitle : "",
          table: { ...s.table, rows: part },
        })
      );
      split += 1;
      continue;
    }

    const bullets = s.content;
    const isBulletSlide =
      s.layout === "content" && !s.chart && !s.table && bullets?.length;
    if (!isBulletSlide) {
      out.push(s);
      continue;
    }
    const shortAll = bullets.every((b) => b.length <= TWO_COL_MAX_CHARS);
    if (
      bullets.length >= 5 &&
      bullets.length <= TWO_COL_MAX_BULLETS &&
      shortAll
    ) {
      out.push({ ...s, layout: "content2" });
      twoCol += 1;
      continue;
    }
    const fits = fitBullets(bullets, CONTENT_W, BODY_H).fits;
    if (bullets.length > MAX_BULLETS_PER_SLIDE || !fits) {
      const size = fits
        ? MAX_BULLETS_PER_SLIDE
        : Math.min(
            MAX_BULLETS_PER_SLIDE,
            Math.max(2, Math.ceil(bullets.length / 2))
          );
      const parts = splitBullets(s, size);
      out.push(...parts);
      if (parts.length > 1) split += 1;
      continue;
    }
    out.push(s);
  }
  return { slides: out, twoCol, split };
}

/** 구분 슬라이드가 2개 이상이면 그 제목들로 목차를 맨 앞에 넣는다. */
function ensureAgenda(slides, maxSlides = 20) {
  if (slides.some((s) => s.layout === "agenda"))
    return { slides, added: false };
  const sections = slides
    .filter((s) => s.layout === "section" && s.title)
    .map((s) => s.title);
  if (sections.length < 2 || slides.length >= maxSlides)
    return { slides, added: false };
  return {
    slides: [
      {
        layout: "agenda",
        title: "목차",
        subtitle: "",
        content: sections.slice(0, 8),
      },
      ...slides,
    ],
    added: true,
  };
}

const hasBody = (s) =>
  s.layout === "section" ||
  Boolean(
    s.content?.length ||
      s.table ||
      s.chart ||
      s.stats?.length ||
      s.columns?.length ||
      s.steps?.length ||
      s.quote
  );

/**
 * 전체 파이프라인. 반환: { slides, notes: string[] }  (notes = 사용자에게 보여줄 안내)
 */
function polishSlides(rawSlides, { maxSlides = 20 } = {}) {
  const notes = [];
  let slides = rawSlides.map(normalizeSlide);

  let chartCount = 0;
  slides = slides.map((s) => {
    if (s.layout !== "content" || !s.table) return s;
    const chart = tableToChart(s);
    if (!chart) return s;
    chartCount += 1;
    return { ...s, table: undefined, chart };
  });
  if (chartCount)
    notes.push(`숫자 위주 표 ${chartCount}건을 차트로 바꿨습니다`);

  const dense = applyDensityRules(slides);
  slides = dense.slides;
  if (dense.twoCol)
    notes.push(`짧은 불릿 ${dense.twoCol}장을 2단으로 배치했습니다`);
  if (dense.split)
    notes.push(`넘칠 수 있는 ${dense.split}장을 나눠 담았습니다`);

  // 안전장치: 본문이 하나도 없는 슬라이드(제목만 남은 것)는 빼서 빈 화면을 막는다.
  const nonEmpty = slides.filter(hasBody);
  if (nonEmpty.length !== slides.length && nonEmpty.length) {
    notes.push(
      `내용이 없는 슬라이드 ${slides.length - nonEmpty.length}장을 제외했습니다`
    );
    slides = nonEmpty;
  }

  const agenda = ensureAgenda(slides, maxSlides);
  slides = agenda.slides;
  if (agenda.added) notes.push("구분 슬라이드로 목차를 만들었습니다");

  return { slides, notes };
}

module.exports = {
  normalizeSlide,
  parseNumeric,
  tableToChart,
  applyDensityRules,
  ensureAgenda,
  polishSlides,
  LAYOUTS,
};
