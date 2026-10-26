// purgeFolder 가 한글 폴더 이름의 유니코드 표기 차이(NFC/NFD)와 상관없이 폴더를 지우고,
// 워크스페이스 문서 연결도 어느 표기의 docpath 로든 풀어 주는지.
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "purge-folder-"));
process.env.STORAGE_DIR = tmpRoot;
const docsDir = path.join(tmpRoot, "documents");

const mockRemove = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../models/documents", () => ({
  Document: { removeDocuments: (...a) => mockRemove(...a) },
}));
jest.mock("../../../models/workspace", () => ({
  Workspace: { where: async () => [{ id: 1, slug: "ws" }] },
}));
jest.mock("../../../utils/files/index.js", () => {
  const actual = jest.requireActual("../../../utils/files/index.js");
  return { ...actual, purgeVectorCache: jest.fn().mockResolvedValue(true) };
});

const { purgeFolder } = require("../../../utils/files/purgeDocument");

const NFC = "엔에프디".normalize("NFC");
const NFD = "엔에프디".normalize("NFD");

beforeEach(() => {
  fs.rmSync(docsDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(docsDir, "custom-documents"), { recursive: true });
  mockRemove.mockClear();
});
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe("purgeFolder", () => {
  it("deletes a folder stored as NFD when asked with the NFC spelling", async () => {
    fs.mkdirSync(path.join(docsDir, NFD));
    fs.writeFileSync(path.join(docsDir, NFD, "a.json"), "{}");
    await purgeFolder(NFC);
    expect(
      fs.readdirSync(docsDir).map((n) => n.normalize("NFC"))
    ).not.toContain(NFC);
  });

  it("unlinks workspace documents whichever spelling their docpath uses", async () => {
    fs.mkdirSync(path.join(docsDir, NFD));
    fs.writeFileSync(path.join(docsDir, NFD, "a.json"), "{}");
    await purgeFolder(NFC);
    const [, filenames] = mockRemove.mock.calls[0];
    expect(filenames).toContain(`${NFC}/a.json`);
    expect(filenames).toContain(`${NFD}/a.json`);
  });

  it("never deletes custom-documents or a folder that does not exist", async () => {
    fs.writeFileSync(path.join(docsDir, "custom-documents", "x.json"), "{}");
    await purgeFolder("custom-documents");
    await purgeFolder("없는폴더");
    expect(
      fs.existsSync(path.join(docsDir, "custom-documents", "x.json"))
    ).toBe(true);
    expect(mockRemove).not.toHaveBeenCalled();
  });
});
