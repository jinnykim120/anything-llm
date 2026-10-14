jest.mock("../../utils/files", () => ({
  documentsPath: "/tmp/docs",
  hotdirPath: "/tmp/hotdir",
  normalizePath: (p) => p,
  isWithin: () => true,
  fileData: jest.fn(),
  purgeSourceDocument: jest.fn(),
  purgeVectorCache: jest.fn(),
}));

const { mergeMissingPages } = require("../../utils/pdfConvert");

const b = (page, text) => ({ page, text });

describe("mergeMissingPages (Docling 이 놓친 쪽을 이전 블록으로 채움)", () => {
  it("returns fresh blocks untouched when no page is missing", () => {
    const fresh = [b(1, "a"), b(2, "b")];
    const old = [b(1, "x"), b(2, "y")];
    const out = mergeMissingPages(fresh, old);
    expect(out.filledPages).toEqual([]);
    expect(out.blocks).toBe(fresh);
  });

  it("fills only the missing pages and keeps page order", () => {
    const fresh = [b(1, "new1"), b(2, "new2a"), b(2, "new2b"), b(5, "new5")];
    const old = [b(1, "old1"), b(2, "old2"), b(3, "old3"), b(4, "old4a"), b(4, "old4b")];
    const out = mergeMissingPages(fresh, old);
    expect(out.filledPages).toEqual([3, 4]);
    expect(out.blocks.map((x) => x.text)).toEqual([
      "new1",
      "new2a",
      "new2b",
      "old3",
      "old4a",
      "old4b",
      "new5",
    ]);
  });

  it("never replaces a page Docling did read, even if the old parse has more text", () => {
    const out = mergeMissingPages([b(1, "docling")], [b(1, "long old text")]);
    expect(out.blocks.map((x) => x.text)).toEqual(["docling"]);
  });

  it("ignores old blocks that have no page number", () => {
    const out = mergeMissingPages([b(1, "a")], [{ text: "no page" }, b(2, "p2")]);
    expect(out.filledPages).toEqual([2]);
    expect(out.blocks.map((x) => x.text)).toEqual(["a", "p2"]);
  });
});
