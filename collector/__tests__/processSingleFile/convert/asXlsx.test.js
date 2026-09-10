const mockFs = require("fs");
const os = require("os");
const mockPath = require("path");

const tempRoot = mockFs.mkdtempSync(
  mockPath.join(os.tmpdir(), "as-xlsx-test-")
);
const mockDocumentsFolder = mockPath.join(tempRoot, "documents");
mockFs.mkdirSync(mockDocumentsFolder, { recursive: true });

// [auto-docu v14 P3] node-xlsx returns { name, data:[[...]] } per sheet. Cover:
// Korean-only sheet names (the old empty-slug filename-collision case), a
// title/preamble row above the header, a plain sheet, and an empty sheet.
jest.mock("node-xlsx", () => ({
  default: {
    parse: jest.fn(() => [
      {
        name: "국수 집계표",
        data: [
          ["2021~2025 국수 출하량"],
          ["구분", "직접생산", "대기업 OEM"],
          ["2025년", 98426.8, 0],
          ["2024년", 91300.1, 12],
        ],
      },
      {
        name: "냉면 집계표",
        data: [
          ["연도", "출하량"],
          ["2025", 200],
        ],
      },
      { name: "빈 시트", data: [[], [""]] },
    ]),
  },
}));

jest.mock("../../../utils/files", () => {
  const path = require("path");
  return {
    createdDate: jest.fn(() => "2026-01-01"),
    trashFile: jest.fn(),
    documentsFolder: mockDocumentsFolder,
    writeToServerDocuments: jest.fn(({ data, filename }) => {
      const dest = path.join(mockDocumentsFolder, `${filename}.json`);
      mockFs.writeFileSync(dest, JSON.stringify(data));
      return { ...data, location: dest };
    }),
  };
});

const asXlsx = require("../../../processSingleFile/convert/asXlsx");

describe("asXlsx — workbook to a single blocks document", () => {
  afterAll(() => mockFs.rmSync(tempRoot, { recursive: true, force: true }));

  it("produces exactly one document for a multi-sheet workbook (no per-sheet filename collision)", async () => {
    const source = mockPath.join(tempRoot, "면류 데이터.xlsx");
    mockFs.writeFileSync(source, "binary-xlsx-bytes");
    const result = await asXlsx({
      fullFilePath: source,
      filename: "면류 데이터.xlsx",
    });

    expect(result.success).toBe(true);
    expect(result.documents).toHaveLength(1);
  });

  it("keeps every non-empty sheet's data and a content hash", async () => {
    const source = mockPath.join(tempRoot, "면류2.xlsx");
    mockFs.writeFileSync(source, "binary-xlsx-bytes");
    const { documents } = await asXlsx({
      fullFilePath: source,
      filename: "면류2.xlsx",
    });
    const doc = documents[0];

    expect(doc.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.pageContent).toContain("국수 집계표");
    expect(doc.pageContent).toContain("냉면 집계표");
    expect(doc.pageContent).not.toContain("빈 시트");
    // numeric answer survives with its column context
    expect(doc.pageContent).toContain("98426.8");
    expect(doc.pageContent).toContain("직접생산");
    // title/preamble row captured, not silently dropped
    expect(doc.pageContent).toContain("2021~2025 국수 출하량");
    expect(doc.title).toContain("국수 집계표");
    expect(doc.title).toContain("냉면 집계표");
  });

  it("emits table blocks tagged with the sheet name as section_path", async () => {
    const source = mockPath.join(tempRoot, "면류3.xlsx");
    mockFs.writeFileSync(source, "binary-xlsx-bytes");
    const { documents } = await asXlsx({
      fullFilePath: source,
      filename: "면류3.xlsx",
    });
    const tableBlocks = documents[0].blocks.filter(
      (b) => b.block_type === "table"
    );
    expect(tableBlocks).toHaveLength(2);
    expect(tableBlocks.map((b) => b.section_path).sort()).toEqual([
      "국수 집계표",
      "냉면 집계표",
    ]);
    // header + markdown separator so the splitter repeats it on a big-sheet split
    expect(tableBlocks[0].text).toMatch(/구분 \| 직접생산.*\n---/s);
  });
});
