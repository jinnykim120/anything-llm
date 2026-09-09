const fs = require("fs");
const os = require("os");
const path = require("path");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "as-xlsx-test-"));
const documentsFolder = path.join(tempRoot, "documents");

jest.mock("node-xlsx", () => ({
  default: {
    parse: jest.fn(() => [
      { name: "국수 집계표", data: [["연도", "출하량"], ["2025", 100]] },
      { name: "냉면 집계표", data: [["연도", "출하량"], ["2025", 200]] },
      { name: "기타", data: [["연도", "출하량"], ["2025", 300]] },
    ]),
  },
}));

jest.mock("../../../../utils/files", () => ({
  createdDate: jest.fn(() => "test"),
  trashFile: jest.fn(),
  documentsFolder,
  writeToServerDocuments: jest.fn(({ data, filename, destinationOverride }) => {
    const destination = destinationOverride || documentsFolder;
    fs.mkdirSync(destination, { recursive: true });
    const fullPath = path.join(destination, `${filename}.json`);
    fs.writeFileSync(fullPath, JSON.stringify(data));
    return { ...data, location: fullPath };
  }),
}));

const asXlsx = require("../../../../processSingleFile/convert/asXlsx");

describe("asXlsx sheet output", () => {
  afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  it("keeps every sheet when slugify removes non-ASCII names", async () => {
    const source = path.join(tempRoot, "input.xlsx");
    fs.writeFileSync(source, "xlsx");
    const result = await asXlsx({ fullFilePath: source, filename: "input.xlsx" });
    const locations = result.documents.map((document) => document.location);

    expect(result.documents).toHaveLength(3);
    expect(new Set(locations).size).toBe(3);
    expect(
      locations.every((location) => fs.existsSync(location))
    ).toBe(true);
  });
});
