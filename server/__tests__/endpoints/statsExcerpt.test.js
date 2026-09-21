const { excerptRelevant } = require("../../endpoints/statsAnalysis");

describe("excerptRelevant", () => {
  it("returns short text untouched", () => {
    expect(excerptRelevant("짧은 문서", "매출")).toBe("짧은 문서");
  });

  it("keeps a table buried past the cap instead of only the head", () => {
    const filler = "가나다라마바사 ".repeat(20000); // ~140K chars, no keywords
    const table = "분기별 매출액 1분기 2,900,000 2분기 3,100,000 (단위: 백만원)";
    const text = `표지 제목\n${filler}${table}${filler}`;
    const out = excerptRelevant(text, "분기별 매출 예측", 20000);
    expect(out.length).toBeLessThanOrEqual(20000 + 100);
    expect(out).toContain("2,900,000");
    expect(out.startsWith("표지 제목")).toBe(true);
  });

  it("preserves document order of picked windows", () => {
    const a = "매출 AAA ".padEnd(1500, "x");
    const b = "매출 BBB ".padEnd(1500, "y");
    const filler = "z".repeat(60000);
    const out = excerptRelevant(`${filler}${a}${filler}${b}`, "매출", 5000);
    expect(out.indexOf("AAA")).toBeLessThan(out.indexOf("BBB"));
  });
});
