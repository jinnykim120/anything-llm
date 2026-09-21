const ExcelJS = require("exceljs");
const {
  markdownToXlsx,
  jsonToRows,
} = require("../../../utils/exporters/markdownToXlsx");

describe("jsonToRows", () => {
  it("flattens scalars, nested objects and arrays of objects", () => {
    const rows = jsonToRows({
      r2: 0.93,
      coef: { a: 1, b: 2 },
      preds: [
        { year: 2026, value: 10 },
        { year: 2027, value: 12 },
      ],
      xs: [1, 2, 3],
    });
    expect(rows).toContainEqual(["r2", 0.93]);
    expect(rows).toContainEqual(["coef.a", 1]);
    expect(rows).toContainEqual(["year", "value"]);
    expect(rows).toContainEqual([2027, 12]);
    expect(rows).toContainEqual(["xs", 1, 2, 3]);
  });
});

describe("markdownToXlsx extraSheets", () => {
  it("adds a 계산 결과 sheet from json and an 근거 sheet from rows", async () => {
    const buf = await markdownToXlsx({
      title: "t",
      markdown: "| 문서 | 매출 |\n| --- | --- |\n| A | 1,000 |",
      extraSheets: [
        { name: "계산 결과", json: { slope: 2.5 } },
        { name: "근거", rows: [["문서", "근거"], ["A", "매출 1,000"]] },
      ],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "결과",
      "계산 결과",
      "근거",
    ]);
    expect(wb.getWorksheet("계산 결과").getCell(1, 2).value).toBe(2.5);
    expect(wb.getWorksheet("결과").getCell(4, 2).value).toBe(1000);
  });
});
