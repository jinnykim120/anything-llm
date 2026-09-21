jest.mock("../../../utils/prisma", () => ({
  workspace_documents: { findMany: jest.fn() },
  document_classifications: { findMany: jest.fn() },
}));
const prisma = require("../../../utils/prisma");
const {
  buildGeneratedMeta,
  extractKeywords,
  mostCommon,
} = require("../../../utils/classification/generatedMeta");

describe("extractKeywords", () => {
  it("ranks title/heading terms and repeated body terms, skipping stopwords and numbers", () => {
    const md = [
      "# 회귀분석 결과 보고",
      "## 매출 회귀분석",
      "매출은 증가했다. 매출을 분석한 결과 2026 기준 매출 성장이 확인된다.",
    ].join("\n");
    const kw = extractKeywords({ title: "GS리테일 회귀분석", markdown: md });
    expect(kw[0]).toBe("회귀분석");
    expect(kw).toContain("매출");
    expect(kw).not.toContain("결과");
    expect(kw).not.toContain("2026");
  });
  it("returns [] for empty input", () => {
    expect(extractKeywords({})).toEqual([]);
  });
});

describe("mostCommon", () => {
  it("picks the most frequent non-empty value, null when none", () => {
    expect(mostCommon(["A", null, "B", "B"])).toBe("B");
    expect(mostCommon([null, ""])).toBeNull();
  });
});

describe("buildGeneratedMeta", () => {
  beforeEach(() => jest.resetAllMocks());

  it("inherits business unit/domain and tags source filenames + keywords", async () => {
    prisma.workspace_documents.findMany.mockResolvedValue([
      { filename: "x-11111111-1111-1111-1111-111111111111.json", metadata: JSON.stringify({ content_hash: "h1", title: "폴더/a.pdf" }) },
      { filename: "b.pdf-11111111-1111-1111-1111-111111111111.json", metadata: JSON.stringify({ content_hash: "h2" }) },
    ]);
    prisma.document_classifications.findMany.mockResolvedValue([
      { contentHash: "h1", businessUnit: "편의점BU", domain: "영업" },
      { contentHash: "h2", businessUnit: "편의점BU", domain: null },
    ]);
    const meta = await buildGeneratedMeta({
      workspaceId: 1,
      sourceDocIds: ["doc-uuid", 7],
      docType: "초안",
      title: "회귀분석 보고",
      markdown: "# 회귀분석\n회귀분석 매출 매출",
    });
    expect(meta.businessUnit).toBe("편의점BU");
    expect(meta.domain).toBe("영업");
    expect(meta.tags.slice(0, 4)).toEqual([
      "원본:a.pdf",
      "원본:b.pdf",
      "AI생성",
      "초안",
    ]);
    expect(meta.tags).toContain("회귀분석");
  });

  it("degrades to base tags with no sources", async () => {
    const meta = await buildGeneratedMeta({
      workspaceId: 1,
      sourceDocIds: [],
      docType: "초안",
      title: "",
      markdown: "",
    });
    expect(meta).toEqual({
      businessUnit: null,
      domain: null,
      tags: ["AI생성", "초안"],
    });
  });
});
