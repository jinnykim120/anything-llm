const {
  getTheme,
} = require("../../../utils/agents/aibitat/plugins/create-files/pptx/themes.js");
const {
  fitBullets,
  fitTitle,
  fitTable,
  widthEm,
  renderRichSlide,
} = require("../../../utils/exporters/pptxLayouts");

describe("text fitting", () => {
  it("counts Hangul as full-width and ASCII narrower", () => {
    expect(widthEm("가나")).toBe(2);
    expect(widthEm("ab")).toBeCloseTo(1.1);
  });
  it("shrinks long titles and keeps short ones at 24pt", () => {
    expect(fitTitle("짧은 제목")).toBe(24);
    expect(fitTitle("가".repeat(40))).toBeLessThan(24);
  });
  it("picks a smaller bullet font for denser content and flags overflow", () => {
    const few = fitBullets(["하나", "둘"], 8.6, 3.4);
    const many = fitBullets(Array(6).fill("가".repeat(50)), 8.6, 3.4);
    expect(few.fontSize).toBeGreaterThan(many.fontSize);
    expect(fitBullets(Array(30).fill("가".repeat(40)), 8.6, 3.4).fits).toBe(
      false
    );
  });
  it("shrinks table text for long tables", () => {
    const rows = Array.from({ length: 8 }, () => [
      "항목",
      "가".repeat(20),
      "값",
    ]);
    expect(
      fitTable({ headers: ["a", "b", "c"], rows }, 3.4).fontSize
    ).toBeLessThanOrEqual(12);
  });
});

describe("renderRichSlide with every layout", () => {
  it("draws every layout, including incomplete rich slides, without throwing", () => {
    const theme = getTheme("corporate");
    const calls = [];
    const rec =
      (name) =>
      (...a) =>
        calls.push([name, a]);
    const pptx = {
      ShapeType: { rect: "rect", ellipse: "ellipse" },
      ChartType: { bar: "bar", line: "line", pie: "pie" },
    };
    const slides = [
      { layout: "agenda", title: "목차", content: ["a", "b"] },
      { layout: "section", title: "구간", subtitle: "요약" },
      {
        layout: "stat",
        title: "지표",
        stats: [{ value: "11.9조원", label: "매출", note: "+3%" }],
      },
      {
        layout: "compare",
        title: "비교",
        columns: [
          { heading: "A", items: ["x"] },
          { heading: "B", items: ["y"] },
        ],
      },
      {
        layout: "timeline",
        title: "일정",
        steps: [
          { label: "1Q", text: "a" },
          { label: "2Q", text: "b" },
          { label: "3Q", text: "c" },
        ],
      },
      { layout: "quote", title: "메시지", quote: "핵심", subtitle: "출처" },
      {
        layout: "content2",
        title: "2단",
        content: ["1", "2", "3", "4", "5"],
      },
      {
        layout: "content",
        title: "표",
        table: { headers: ["a", "b"], rows: [["1", "2"]] },
      },
      {
        layout: "content",
        title: "차트",
        chart: {
          type: "bar",
          categories: ["a", "b"],
          series: [{ name: "s", values: [1, 2] }],
        },
      },
      { layout: "stat", title: "필드 누락" },
    ];
    slides.forEach((sd, i) => {
      const slide = {
        addText: rec("text"),
        addShape: rec("shape"),
        addTable: rec("table"),
        addChart: rec("chart"),
        addNotes: rec("notes"),
      };
      expect(() =>
        renderRichSlide(slide, pptx, sd, theme, i + 1, slides.length)
      ).not.toThrow();
    });
    expect(calls.length).toBeGreaterThan(30);
  });
});
