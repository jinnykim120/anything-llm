const mockFs = require("fs");
const os = require("os");
const mockPath = require("path");

const tempRoot = mockFs.mkdtempSync(
  mockPath.join(os.tmpdir(), "as-xlsx-test-")
);
const mockDocumentsFolder = mockPath.join(tempRoot, "documents");

jest.mock("node-xlsx", () => ({
  default: {
    parse: jest.fn(() => [
      { name: "국수 집계표", data: [["연도", "출하량"], ["2025", 100]] },
      { name: "냉면 집계표", data: [["연도", "출하량"], ["2025", 200]] },
      { name: "기타", data: [["연도", "출하량"], ["2025", 300]] },
    ]),
  },
}));

jest.mock("../../../utils/files", () => ({
  createdDate: jest.fn(() => "test"),
  trashFile: jest.fn(),
  documentsFolder: mockDocumentsFolder,
  writeToServerDocuments: jest.fn(({ data, filename, destinationOverride }) => {
    const destination = destinationOverride || mockDocumentsFolder;
    mockFs.mkdirSync(destination, { recursive: true });
    const fullPath = mockPath.join(destination, `${filename}.json`);
    mockFs.writeFileSync(fullPath, JSON.stringify(data));
    return { ...data, location: fullPath };
  }),
}));

const asXlsx = require("../../../processSingleFile/convert/asXlsx");

describe("asXlsx sheet output", () => {
  afterAll(() => mockFs.rmSync(tempRoot, { recursive: true, force: true }));

  it("keeps every sheet when slugify removes non-ASCII names", async () => {
    const source = mockPath.join(tempRoot, "input.xlsx");
    mockFs.writeFileSync(source, "xlsx");
    const result = await asXlsx({ fullFilePath: source, filename: "input.xlsx" });
    const locations = result.documents.map((document) => document.location);

    expect(result.documents).toHaveLength(3);
    expect(new Set(locations).size).toBe(3);
    expect(
      locations.every((location) => mockFs.existsSync(location))
    ).toBe(true);
  });
});
