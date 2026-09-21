const {
  normalizeSlide,
  parseNumeric,
  tableToChart,
  applyDensityRules,
  ensureAgenda,
  polishSlides,
} = require("../../../utils/exporters/pptSpecPolish");

describe("parseNumeric", () => {
  it("parses plain, comma, percent and negative-marker numbers", () => {
    expect(parseNumeric("1,234")).toEqual({ n: 1234, unit: "" });
    expect(parseNumeric("5.2%")).toEqual({ n: 5.2, unit: "%" });
    expect(parseNumeric("△3억원")).toEqual({ n: -3, unit: "억원" });
  });
  it("rejects dates, ranges and text", () => {
    expect(parseNumeric("2026-09-01")).toBeNull();
    expect(parseNumeric("증가")).toBeNull();
    expect(parseNumeric("3~5")).toBeNull();
  });
});

describe("normalizeSlide", () => {
  it("falls back to content when a rich layout lacks its data", () => {
    expect(normalizeSlide({ layout: "stat", title: "t" }).layout).toBe(
      "content"
    );
    expect(
      normalizeSlide({
        layout: "compare",
        columns: [{ heading: "a", items: ["x"] }],
      }).layout
    ).toBe("content");
    expect(
      normalizeSlide({ layout: "timeline", steps: [{ label: "a" }] }).layout
    ).toBe("content");
    expect(normalizeSlide({ layout: "weird" }).layout).toBe("content");
  });
  it("keeps well-formed rich slides and caps counts", () => {
    const stat = normalizeSlide({
      layout: "stat",
      stats: Array.from({ length: 6 }, (_, i) => ({
        value: `${i}`,
        label: `l${i}`,
      })),
    });
    expect(stat.layout).toBe("stat");
    expect(stat.stats).toHaveLength(4);
    const tl = normalizeSlide({
      layout: "timeline",
      steps: Array.from({ length: 8 }, (_, i) => ({
        label: `s${i}`,
        text: "x",
      })),
    });
    expect(tl.steps).toHaveLength(6);
  });
});

describe("tableToChart", () => {
  const table = (headers, rows, title = "") => ({
    title,
    table: { headers, rows },
  });
  it("turns a small numeric year table into a line chart", () => {
    const c = tableToChart(
      table(
        ["연도", "매출"],
        [
          ["2023", "11.08"],
          ["2024", "11.58"],
          ["2025", "11.96"],
        ]
      )
    );
    expect(c.type).toBe("line");
    expect(c.categories).toEqual(["2023", "2024", "2025"]);
    expect(c.series[0].values).toEqual([11.08, 11.58, 11.96]);
  });
  it("uses pie for a single-series share table and bar otherwise", () => {
    expect(
      tableToChart(
        table(
          ["사업부", "비중(%)"],
          [
            ["A", "62"],
            ["B", "38"],
          ],
          "사업부별 비중"
        )
      ).type
    ).toBe("pie");
    expect(
      tableToChart(
        table(
          ["팀", "건수"],
          [
            ["A", "5"],
            ["B", "8"],
          ]
        )
      ).type
    ).toBe("bar");
  });
  it("keeps text/mixed tables as tables", () => {
    expect(
      tableToChart(
        table(
          ["담당", "일정"],
          [
            ["김", "9월"],
            ["이", "10월"],
          ]
        )
      )
    ).toBeNull();
    expect(tableToChart(table(["항목", "값"], [["a", "1"]]))).toBeNull(); // 1 row
  });
  it("refuses series whose scales differ by more than 10x", () => {
    expect(
      tableToChart(
        table(
          ["연도", "매출(조)", "이익(억)"],
          [
            ["2023", "11", "4210"],
            ["2024", "12", "4880"],
          ]
        )
      )
    ).toBeNull();
  });
});

describe("applyDensityRules", () => {
  const bullets = (n, len = 8) =>
    Array.from({ length: n }, (_, i) => `항목${i}`.padEnd(len, "가"));
  it("moves 5-8 short bullets to two columns", () => {
    const { slides, twoCol } = applyDensityRules([
      { layout: "content", title: "t", content: bullets(7) },
    ]);
    expect(twoCol).toBe(1);
    expect(slides[0].layout).toBe("content2");
  });
  it("splits many long bullets across slides", () => {
    const { slides, split } = applyDensityRules([
      { layout: "content", title: "t", content: bullets(9, 40) },
    ]);
    expect(split).toBe(1);
    expect(slides.length).toBeGreaterThan(1);
    expect(slides[0].title).toMatch(/\(1\/\d\)/);
  });
  it("splits tables over 8 rows and repeats headers", () => {
    const rows = Array.from({ length: 10 }, (_, i) => [`r${i}`, `${i}`]);
    const { slides } = applyDensityRules([
      { layout: "content", title: "표", table: { headers: ["a", "b"], rows } },
    ]);
    expect(slides).toHaveLength(2);
    expect(slides.every((s) => s.table.headers.length === 2)).toBe(true);
    expect(slides[0].table.rows.length + slides[1].table.rows.length).toBe(10);
  });
  it("leaves already-small slides alone", () => {
    const s = { layout: "content", title: "t", content: bullets(3) };
    expect(applyDensityRules([s]).slides).toEqual([s]);
  });
});

describe("ensureAgenda", () => {
  const sec = (t) => ({ layout: "section", title: t });
  it("adds an agenda from 2+ section titles", () => {
    const { slides, added } = ensureAgenda([
      sec("개요"),
      { layout: "content", title: "x" },
      sec("계획"),
    ]);
    expect(added).toBe(true);
    expect(slides[0]).toMatchObject({
      layout: "agenda",
      content: ["개요", "계획"],
    });
  });
  it("does nothing with <2 sections, an existing agenda, or no room", () => {
    expect(ensureAgenda([sec("개요")]).added).toBe(false);
    expect(
      ensureAgenda([
        { layout: "agenda", title: "목차", content: ["a"] },
        sec("a"),
        sec("b"),
      ]).added
    ).toBe(false);
    expect(ensureAgenda([sec("a"), sec("b")], 2).added).toBe(false);
  });
});

describe("polishSlides", () => {
  it("runs the whole pipeline and reports notes", () => {
    const { slides, notes } = polishSlides([
      { layout: "section", title: "1부" },
      {
        layout: "content",
        title: "추이",
        table: {
          headers: ["연도", "값"],
          rows: [
            ["2023", "1"],
            ["2024", "2"],
            ["2025", "3"],
          ],
        },
      },
      { layout: "section", title: "2부" },
    ]);
    expect(slides[0].layout).toBe("agenda");
    expect(slides.find((s) => s.chart)).toBeTruthy();
    expect(notes.join(" ")).toMatch(/차트/);
    expect(notes.join(" ")).toMatch(/목차/);
  });
});
