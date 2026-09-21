const {
  archiveDocsBlock,
  buildMessages,
  clampSlideCount,
} = require("../../endpoints/pptDraft");

describe("clampSlideCount", () => {
  it("clamps to the 4-20 range and rounds", () => {
    expect(clampSlideCount(1)).toBe(4);
    expect(clampSlideCount(100)).toBe(20);
    expect(clampSlideCount(7.6)).toBe(8);
  });

  it("defaults to 8 for a non-numeric input", () => {
    expect(clampSlideCount("abc")).toBe(8);
    expect(clampSlideCount(undefined)).toBe(8);
  });
});

describe("archiveDocsBlock", () => {
  it("returns an empty string for no docs", () => {
    expect(archiveDocsBlock([])).toBe("");
    expect(archiveDocsBlock()).toBe("");
  });

  it("renders each doc as a heading + its content", () => {
    const block = archiveDocsBlock([
      { title: "문서A", pageContent: "내용A" },
      { title: "문서B", pageContent: "내용B" },
    ]);
    expect(block).toMatch(/### 문서A\n내용A/);
    expect(block).toMatch(/### 문서B\n내용B/);
  });

  it("truncates a document longer than the per-doc cap", () => {
    const long = "가".repeat(70000);
    const block = archiveDocsBlock([{ title: "큰문서", pageContent: long }]);
    expect(block.length).toBeLessThan(long.length);
  });
});

describe("buildMessages — archiveDocs", () => {
  const base = {
    sourceText: "본문",
    citations: [],
    purpose: "analysis",
    slideCount: 8,
    instructions: "",
  };

  it("omits 추가 아카이브 자료 when none are given", () => {
    const [system, user] = buildMessages({
      ...base,
      archiveDocs: [],
    }).map((m) => m.content);
    expect(system).not.toMatch(/추가 아카이브 자료/);
    expect(user).not.toMatch(/추가 아카이브 자료/);
  });

  it("includes 추가 아카이브 자료 and instructs treating it as equal evidence", () => {
    const [system, user] = buildMessages({
      ...base,
      archiveDocs: [{ title: "반기보고서", pageContent: "매출액 6조" }],
    }).map((m) => m.content);
    expect(system).toMatch(/추가 아카이브 자료.*동등한 근거/);
    expect(user).toMatch(/## 추가 아카이브 자료/);
    expect(user).toMatch(/반기보고서/);
    expect(user).toMatch(/매출액 6조/);
  });
});
