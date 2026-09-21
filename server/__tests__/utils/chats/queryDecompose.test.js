const {
  isEnabled,
  looksCompound,
  parseSubqueries,
  mergeDecomposedResults,
  augmentWithDecomposition,
} = require("../../../utils/chats/queryDecompose");

describe("looksCompound", () => {
  it("flags questions mixing periods, ranges or connectors", () => {
    expect(
      looksCompound("GS리테일의 2026년 매출 실적과 2023~2025년 추이를 알려줘")
    ).toBe(true);
    expect(looksCompound("편의점 + 수퍼마켓 매출 알려줘")).toBe(true);
    expect(looksCompound("2024년 상반기와 하반기 실적 비교해줘")).toBe(true);
  });
  it("skips short or single-topic questions", () => {
    expect(looksCompound("매출은?")).toBe(false);
    expect(looksCompound("GS리테일 2025년 영업이익이 얼마야")).toBe(false);
    expect(looksCompound("")).toBe(false);
  });
});

describe("parseSubqueries", () => {
  it("parses a JSON array, drops duplicates/too-short/original", () => {
    const out = parseSubqueries(
      '```json\n["A 2026년 매출","A 2026년 매출","aa","원본 질문 그대로 입니다","A 2023~2025 추이"]\n```',
      "원본 질문 그대로 입니다"
    );
    expect(out).toEqual(["A 2026년 매출", "A 2023~2025 추이"]);
  });
  it("returns [] for garbage and caps at 3", () => {
    expect(parseSubqueries("not json", "q")).toEqual([]);
    expect(
      parseSubqueries('["질문 하나","질문 둘째","질문 셋째","질문 넷째"]', "q")
    ).toHaveLength(3);
  });
});

describe("mergeDecomposedResults", () => {
  const res = (ids) => ({
    sources: ids.map((id) => ({ id, text: `t${id}` })),
    contextTexts: ids.map((id) => `c${id}`),
  });
  it("keeps primary untouched and interleaves sub-query results up to the cap", () => {
    const primary = res(["p1", "p2", "p3", "p4"]);
    const merged = mergeDecomposedResults(primary, [
      res(["a1", "a2", "a3"]),
      res(["b1", "b2", "b3"]),
    ]);
    expect(merged.sources.slice(0, 4).map((s) => s.id)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
    // alternates a1,b1,a2,b2,a3,b3 (EXTRA_CAP=6)
    expect(merged.sources.slice(4).map((s) => s.id)).toEqual([
      "a1",
      "b1",
      "a2",
      "b2",
      "a3",
      "b3",
    ]);
    expect(merged.contextTexts).toHaveLength(merged.sources.length);
    expect(merged.added).toBe(6);
  });
  it("picks the best-scoring unseen chunk per document, diverse across documents", () => {
    const mk = (id, doc, score) => ({ id, doc_id: doc, text: id, score });
    const sub = {
      sources: [
        mk("n1", "NOISE", 0.99),
        mk("n2", "NOISE", 0.95),
        mk("n3", "NOISE", 0.94),
        mk("t1", "TARGET", 0.923),
        mk("t2", "TARGET", 0.9),
      ],
      contextTexts: ["a", "b", "c", "d", "e"],
    };
    const primary = { sources: [mk("p", "A", 1)], contextTexts: ["p"] };
    const merged = mergeDecomposedResults(primary, [sub]);
    const ids = merged.sources.map((s) => s.id);
    expect(ids.slice(0, 3)).toEqual(["p", "n1", "t1"]);
    expect(ids).toContain("t1");
  });
  it("still appends when the primary result is already larger than topN", () => {
    const big = res(Array.from({ length: 12 }, (_, i) => `p${i}`));
    const merged = mergeDecomposedResults(big, [res(["a1"]), res(["b1"])]);
    expect(merged.added).toBe(2);
    expect(merged.sources).toHaveLength(14);
  });
  it("dedupes chunks already present", () => {
    const merged = mergeDecomposedResults(res(["x"]), [res(["x", "y"])]);
    expect(merged.sources.map((s) => s.id)).toEqual(["x", "y"]);
  });
});

describe("augmentWithDecomposition", () => {
  const OLD = process.env.QUERY_DECOMPOSE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.QUERY_DECOMPOSE;
    else process.env.QUERY_DECOMPOSE = OLD;
  });
  const results = () => ({
    sources: [{ id: "p1", text: "p" }],
    contextTexts: ["p"],
  });
  const llm = (text) => ({
    getChatCompletion: jest.fn().mockResolvedValue({ textResponse: text }),
  });
  const Q = "GS리테일의 2026년 매출 실적과 2023~2025년 추이를 알려줘";

  it("does nothing (and makes no LLM call) when the flag is off", async () => {
    delete process.env.QUERY_DECOMPOSE;
    const connector = llm('["a a a a","b b b b"]');
    const r = results();
    const out = await augmentWithDecomposition({
      results: r,
      message: Q,
      LLMConnector: connector,
      search: jest.fn(),
      topN: 4,
    });
    expect(out.added).toBe(0);
    expect(connector.getChatCompletion).not.toHaveBeenCalled();
    expect(r.sources).toHaveLength(1);
  });

  it("decomposes, searches each sub-query and appends results when on", async () => {
    process.env.QUERY_DECOMPOSE = "on";
    expect(isEnabled()).toBe(true);
    const search = jest.fn(async (input) => ({
      sources: [{ id: `s:${input}`, text: input }],
      contextTexts: [`ctx:${input}`],
    }));
    const r = results();
    const out = await augmentWithDecomposition({
      results: r,
      message: Q,
      LLMConnector: llm('["GS리테일 2026년 매출","GS리테일 2023~2025년 추이"]'),
      search,
      topN: 4,
    });
    expect(search).toHaveBeenCalledTimes(2);
    expect(out.added).toBe(2);
    expect(r.sources.map((s) => s.id)).toEqual([
      "p1",
      "s:GS리테일 2026년 매출",
      "s:GS리테일 2023~2025년 추이",
    ]);
  });

  it("falls back silently when the LLM fails or the search errored", async () => {
    process.env.QUERY_DECOMPOSE = "on";
    const r = results();
    const out = await augmentWithDecomposition({
      results: r,
      message: Q,
      LLMConnector: {
        getChatCompletion: jest.fn().mockRejectedValue(new Error("boom")),
      },
      search: jest.fn(),
      topN: 4,
    });
    expect(out.added).toBe(0);
    expect(r.sources).toHaveLength(1);
  });
});
