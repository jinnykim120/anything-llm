const mockFindManyCls = jest.fn();
const mockFindManyDocs = jest.fn();
jest.mock("../../../utils/prisma", () => ({
  document_classifications: { findMany: (...args) => mockFindManyCls(...args) },
  workspace_documents: { findMany: (...args) => mockFindManyDocs(...args) },
}));

const {
  resolveUnapprovedGeneratedDocIds,
  GENERATED_WORK_TYPE,
} = require("../../../utils/classification/generatedDocs");

beforeEach(() => {
  mockFindManyCls.mockReset();
  mockFindManyDocs.mockReset();
});

describe("resolveUnapprovedGeneratedDocIds", () => {
  it("returns [] when nothing is classified as 내부생성자료", async () => {
    mockFindManyCls.mockResolvedValue([]);
    const result = await resolveUnapprovedGeneratedDocIds();
    expect(result).toEqual([]);
    expect(mockFindManyDocs).not.toHaveBeenCalled();
  });

  it("queries for the exact GENERATED_WORK_TYPE, excluding confirmed rows", async () => {
    mockFindManyCls.mockResolvedValue([]);
    await resolveUnapprovedGeneratedDocIds();
    expect(mockFindManyCls).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workType: GENERATED_WORK_TYPE, status: { not: "confirmed" } },
      })
    );
  });

  it("resolves pending (proposed) 내부생성자료 rows to their doc_ids", async () => {
    mockFindManyCls.mockResolvedValue([
      { contentHash: "h1" },
      { contentHash: "h2" },
    ]);
    mockFindManyDocs.mockResolvedValue([
      { docId: "d1", metadata: JSON.stringify({ content_hash: "h1" }) },
      { docId: "d2", metadata: JSON.stringify({ content_hash: "other" }) },
      { docId: "d3", metadata: JSON.stringify({ content_hash: "h2" }) },
    ]);

    const result = await resolveUnapprovedGeneratedDocIds();
    expect(result.sort()).toEqual(["d1", "d3"]);
  });

  it("fails safe (empty list) if the DB call throws", async () => {
    mockFindManyCls.mockRejectedValue(new Error("db down"));
    const result = await resolveUnapprovedGeneratedDocIds();
    expect(result).toEqual([]);
  });
});
