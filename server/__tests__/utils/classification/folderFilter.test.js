const mockFindManyDocs = jest.fn();
const mockFindManyCls = jest.fn();
jest.mock("../../../utils/prisma", () => ({
  workspace_documents: { findMany: (...args) => mockFindManyDocs(...args) },
  document_classifications: { findMany: (...args) => mockFindManyCls(...args) },
}));

const { resolveFolderDocIds } = require("../../../utils/classification/folderFilter");

const workspace = { id: 36 };

beforeEach(() => {
  mockFindManyDocs.mockReset();
  mockFindManyCls.mockReset();
});

describe("resolveFolderDocIds", () => {
  it("returns null (no filter) when no folder is selected", async () => {
    expect(await resolveFolderDocIds(workspace, [])).toBeNull();
    expect(await resolveFolderDocIds(workspace, null)).toBeNull();
    expect(mockFindManyDocs).not.toHaveBeenCalled();
  });

  it("returns null (no filter) when '전체' is among the selections", async () => {
    expect(
      await resolveFolderDocIds(workspace, ["work:편의점BU", "전체"])
    ).toBeNull();
    expect(mockFindManyDocs).not.toHaveBeenCalled();
  });

  it("resolves a single 'work:' pick to every doc_id under that workType, any businessUnit", async () => {
    mockFindManyDocs.mockResolvedValue([
      { docId: "d1", metadata: JSON.stringify({ content_hash: "h1" }) },
      { docId: "d2", metadata: JSON.stringify({ content_hash: "h2" }) },
      { docId: "d3", metadata: JSON.stringify({ content_hash: "h3" }) },
    ]);
    mockFindManyCls.mockResolvedValue([
      { contentHash: "h1", workType: "계약서", businessUnit: "편의점BU" },
      { contentHash: "h2", workType: "계약서", businessUnit: "홈쇼핑BU" },
      { contentHash: "h3", workType: "법규", businessUnit: "편의점BU" },
    ]);

    const result = await resolveFolderDocIds(workspace, ["work:계약서"]);
    expect(result.sort()).toEqual(["d1", "d2"]);
  });

  it("resolves a 'unit:' pick to only that exact workType+businessUnit combo", async () => {
    mockFindManyDocs.mockResolvedValue([
      { docId: "d1", metadata: JSON.stringify({ content_hash: "h1" }) },
      { docId: "d2", metadata: JSON.stringify({ content_hash: "h2" }) },
    ]);
    mockFindManyCls.mockResolvedValue([
      { contentHash: "h1", workType: "계약서", businessUnit: "편의점BU" },
      { contentHash: "h2", workType: "계약서", businessUnit: "홈쇼핑BU" },
    ]);

    const result = await resolveFolderDocIds(workspace, [
      "unit:계약서:편의점BU",
    ]);
    expect(result).toEqual(["d1"]);
  });

  // 요청사항: 폴더를 겹쳐서(work: 상위 + 다른 workType의 unit: 하위) 고를 수
  // 있어야 한다 — OR로 합쳐진다.
  it("OR's multiple overlapping picks together (a whole workType + a unit under a different workType)", async () => {
    mockFindManyDocs.mockResolvedValue([
      { docId: "d1", metadata: JSON.stringify({ content_hash: "h1" }) },
      { docId: "d2", metadata: JSON.stringify({ content_hash: "h2" }) },
      { docId: "d3", metadata: JSON.stringify({ content_hash: "h3" }) },
    ]);
    mockFindManyCls.mockResolvedValue([
      { contentHash: "h1", workType: "계약서", businessUnit: "편의점BU" },
      { contentHash: "h2", workType: "계약서", businessUnit: "홈쇼핑BU" },
      { contentHash: "h3", workType: "법규", businessUnit: "편의점BU" },
    ]);

    const result = await resolveFolderDocIds(workspace, [
      "work:계약서",
      "unit:법규:편의점BU",
    ]);
    expect(result.sort()).toEqual(["d1", "d2", "d3"]);
  });

  it("returns an empty (not null) list when a folder is picked but nothing is classified into it", async () => {
    mockFindManyDocs.mockResolvedValue([
      { docId: "d1", metadata: JSON.stringify({ content_hash: "h1" }) },
    ]);
    mockFindManyCls.mockResolvedValue([
      { contentHash: "h1", workType: "계약서", businessUnit: "편의점BU" },
    ]);

    const result = await resolveFolderDocIds(workspace, ["work:실적자료"]);
    expect(result).toEqual([]);
  });

  it("treats an unclassified document as workType/businessUnit '미분류'", async () => {
    mockFindManyDocs.mockResolvedValue([
      { docId: "d1", metadata: JSON.stringify({ content_hash: "h1" }) },
    ]);
    mockFindManyCls.mockResolvedValue([]); // 분류 자체가 없음

    const result = await resolveFolderDocIds(workspace, ["work:미분류"]);
    expect(result).toEqual(["d1"]);
  });
});
