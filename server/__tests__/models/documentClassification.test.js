const mockUpsert = jest.fn();
const mockFindUnique = jest.fn();
jest.mock("../../utils/prisma", () => ({
  document_classifications: {
    upsert: (...args) => mockUpsert(...args),
    findUnique: (...args) => mockFindUnique(...args),
  },
}));
jest.mock("../../utils/classification/classify", () => ({
  classifyDocument: jest.fn(),
}));

const { DocumentClassification } = require("../../models/documentClassification");

beforeEach(() => {
  mockUpsert.mockReset();
  mockFindUnique.mockReset();
  mockFindUnique.mockResolvedValue({ contentHash: "h1", tags: '["기존태그1","기존태그2"]' });
  mockUpsert.mockImplementation(async ({ update }) => ({
    contentHash: "h1",
    tags: '["기존태그1","기존태그2"]',
    ...update,
  }));
});

// [auto-docu 태그 소실 버그 회귀 테스트] 일괄 확정(confirm-bulk)이 tags를
// 항상 []로 보내 확정된 문서 74건의 기존 태그가 지워진 실제 사고 — 원인은
// 호출부가 tags:[]를 "defined"로 넘겨서였다. confirm() 자체는 tags가
// undefined일 때 그 필드를 절대 건드리지 않아야 한다.
describe("DocumentClassification.confirm — tags preservation", () => {
  it("does not touch the tags column when tags is undefined (bulk-confirm's normal case)", async () => {
    await DocumentClassification.confirm({
      contentHash: "h1",
      workType: "계약서",
      businessUnit: "편의점BU",
      // tags 생략 — 일괄 확정처럼 태그를 아예 지정하지 않는 경우
    });

    const updateArg = mockUpsert.mock.calls[0][0].update;
    expect(updateArg).not.toHaveProperty("tags");
  });

  it("does overwrite tags when the caller explicitly provides a new array", async () => {
    await DocumentClassification.confirm({
      contentHash: "h1",
      tags: ["새태그"],
    });

    const updateArg = mockUpsert.mock.calls[0][0].update;
    expect(updateArg.tags).toBe(JSON.stringify(["새태그"]));
  });

  it("regression: explicitly passing tags:[] (the old bulk-confirm bug) DOES wipe tags — callers must omit the field instead", async () => {
    await DocumentClassification.confirm({
      contentHash: "h1",
      tags: [],
    });

    const updateArg = mockUpsert.mock.calls[0][0].update;
    expect(updateArg.tags).toBe("[]");
  });
});
