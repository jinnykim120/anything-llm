const {
  expandQuery,
  mergeDenseCandidates,
} = require("../../../utils/vectorDbProviders/queryExpansion");

describe("expandQuery", () => {
  afterEach(() => delete process.env.QUERY_EXPANSION);

  it("adds finance vocabulary for revenue/performance questions", () => {
    const out = expandQuery("GS리테일 2026년 매출 실적");
    expect(out).toMatch(/^GS리테일 2026년 매출 실적 /);
    expect(out).toMatch(/재무정보/);
    expect(out).toMatch(/매출액/);
    expect(out).toMatch(/영업이익/);
  });
  it("does not repeat terms already in the question", () => {
    const out = expandQuery("2026년 재무정보 매출액 알려줘");
    expect(out.match(/재무정보/g)).toHaveLength(1);
    expect(out.match(/매출액/g)).toHaveLength(1);
  });
  it("returns null when nothing applies, for empty input, or when turned off", () => {
    expect(expandQuery("사규 개정 절차를 알려줘")).toBeNull();
    expect(expandQuery("")).toBeNull();
    process.env.QUERY_EXPANSION = "off";
    expect(expandQuery("매출 실적")).toBeNull();
  });
});

describe("mergeDenseCandidates", () => {
  const res = (rows) => ({
    sourceDocuments: rows.map(([id, score]) => ({
      id: "doc",
      doc_id: "d",
      chunk_index: id,
      score,
    })),
    contextTexts: rows.map(([id]) => `t${id}`),
    scores: rows.map(([, s]) => s),
  });
  it("unions by chunk keeping the best score, sorted descending", () => {
    const merged = mergeDenseCandidates(
      res([
        ["a", 0.9],
        ["b", 0.8],
      ]),
      res([
        ["b", 0.95],
        ["c", 0.85],
      ])
    );
    expect(merged.sourceDocuments.map((s) => s.chunk_index)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(merged.scores).toEqual([0.95, 0.9, 0.85]);
    expect(merged.contextTexts).toEqual(["tb", "ta", "tc"]);
  });
  it("keeps different chunks of the same document (metadata.id is per-document)", () => {
    const mk = (chunk, score) => ({
      sourceDocuments: [
        { id: "doc-1", doc_id: "d1", chunk_index: chunk, score },
      ],
      contextTexts: [`t${chunk}`],
      scores: [score],
    });
    const merged = mergeDenseCandidates(mk(1, 0.9), mk(2, 0.8));
    expect(merged.sourceDocuments.map((s) => s.chunk_index)).toEqual([1, 2]);
  });
  it("handles empty inputs", () => {
    expect(mergeDenseCandidates(undefined, res([["a", 1]])).scores).toEqual([
      1,
    ]);
    expect(mergeDenseCandidates(undefined, undefined).scores).toEqual([]);
  });
});
