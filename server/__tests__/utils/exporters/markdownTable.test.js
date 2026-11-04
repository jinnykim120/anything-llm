const {
  markdownToDocx,
  markdownToBlocks,
} = require("../../../utils/exporters/markdownToDocx");
const { markdownToXlsx } = require("../../../utils/exporters/markdownToXlsx");
const { Table } = require("docx");
const ExcelJS = require("exceljs");

const FORMS = {
  "leading pipes": "| 구분 | 값 |\n|---|---|\n| 가 | 1 |",
  "no leading/trailing pipes": "구분 | 값\n--|--\n가 | 1",
  "single-dash separator": "| 구분 | 값 |\n| - | - |\n| 가 | 1 |",
  "aligned separator": "| 구분 | 값 |\n|:--:|--:|\n| 가 | 1 |",
};

describe("markdown tables reach Word and Excel like they reach HTML", () => {
  for (const [name, md] of Object.entries(FORMS)) {
    it(`docx keeps a ${name} table`, async () => {
      expect(
        markdownToBlocks(`문단\n\n${md}\n`).some((b) => b instanceof Table)
      ).toBe(true);
      const JSZip = require("jszip");
      const zip = await JSZip.loadAsync(
        await markdownToDocx({ title: "t", markdown: md })
      );
      const xml = await zip.file("word/document.xml").async("string");
      expect(xml).toContain("<w:tbl>");
    });

    it(`xlsx keeps a ${name} table`, async () => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await markdownToXlsx({ title: "t", markdown: md }));
      const values = [];
      wb.eachSheet((ws) =>
        ws.eachRow((row) => row.eachCell((c) => values.push(String(c.value))))
      );
      expect(values).toEqual(expect.arrayContaining(["구분", "값", "가", "1"]));
    });
  }

  it("keeps an escaped pipe inside one cell and pads short rows", () => {
    const [table] = markdownToBlocks(
      "| a | b | c |\n|---|---|---|\n| x \\| y | 2 |"
    );
    expect(table).toBeInstanceOf(Table);
  });

  it("does not turn a sentence containing a pipe into a table", () => {
    expect(
      markdownToBlocks("a | b 가 섞인 문장\n다음 줄").some(
        (b) => b instanceof Table
      )
    ).toBe(false);
  });
});
