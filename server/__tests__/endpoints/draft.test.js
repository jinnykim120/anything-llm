const {
  buildGuidance,
  comboLabel,
  citationLines,
  existingWebSources,
  mergeWebSources,
  webSourcesBlock,
  deriveDraftSearchQueries,
  gatherWebSources,
  buildMessages,
  extractTitle,
} = require("../../endpoints/draft");
const { webSearch } = require("../../utils/webSearch");

jest.mock("../../utils/webSearch");

describe("buildGuidance / comboLabel (2축 조합)", () => {
  it("basic + answer_only carries only the base structure", () => {
    const g = buildGuidance("answer_only", "basic");
    expect(g.some((l) => l.includes("목적"))).toBe(true);
    expect(g.some((l) => l.includes("시사점"))).toBe(false);
    expect(g.some((l) => l.includes("동향"))).toBe(false);
    expect(g.some((l) => l.includes("외부 참고자료"))).toBe(false);
  });

  it("analysis + answer_only adds 시사점/검토의견/향후조치, not 동향/리스크", () => {
    const g = buildGuidance("answer_only", "analysis").join("\n");
    expect(g).toMatch(/시사점 및 검토의견/);
    expect(g).toMatch(/향후 조치\(건의\)/);
    expect(g).not.toMatch(/관련 동향/);
  });

  it("analysis + answer_plus_web adds 동향/리스크, not 시사점/향후조치, plus 외부 참고자료", () => {
    const g = buildGuidance("answer_plus_web", "analysis").join("\n");
    expect(g).toMatch(/관련 동향/);
    expect(g).toMatch(/문제점 및 리스크/);
    expect(g).not.toMatch(/시사점 및 검토의견/);
    expect(g).toMatch(/외부 참고자료/);
  });

  it("basic + answer_plus_web adds 외부 참고자료 but no analysis sections", () => {
    const g = buildGuidance("answer_plus_web", "basic").join("\n");
    expect(g).toMatch(/외부 참고자료/);
    expect(g).not.toMatch(/관련 동향/);
    expect(g).not.toMatch(/시사점 및 검토의견/);
  });

  it("comboLabel joins the two axis labels", () => {
    expect(comboLabel("answer_only", "basic")).toBe("답변 내용만 · 기본보고서");
    expect(comboLabel("answer_plus_web", "analysis")).toBe(
      "외부자료 보강 · 분석보고서"
    );
  });
});

describe("citationLines", () => {
  it("returns the placeholder when there are no citations", () => {
    expect(citationLines([])).toBe("(제공된 출처 없음)");
    expect(citationLines(undefined)).toBe("(제공된 출처 없음)");
  });

  it("dedupes by title+location and caps at 20", () => {
    const citations = Array.from({ length: 25 }, (_, i) => ({
      title: `문서${i % 3}`,
      section_path: `절${i % 3}`,
    }));
    const lines = citationLines(citations).split("\n");
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("excludes link:// (web search) sources — those go in 외부 참고자료 instead", () => {
    const citations = [
      { title: "내부문서", section_path: "1장" },
      { title: "웹결과", chunkSource: "link://https://example.com/a" },
    ];
    const lines = citationLines(citations);
    expect(lines).toMatch(/내부문서/);
    expect(lines).not.toMatch(/웹결과/);
  });
});

describe("existingWebSources / mergeWebSources", () => {
  it("extracts only link:// sources from citations, stripping the prefix", () => {
    const citations = [
      { title: "내부", chunkSource: "" },
      {
        title: "브라우징 결과",
        chunkSource: "link://https://example.com/x",
        text: "요약",
      },
    ];
    const result = existingWebSources(citations);
    expect(result).toEqual([
      { title: "브라우징 결과", link: "https://example.com/x", snippet: "요약" },
    ]);
  });

  it("mergeWebSources dedupes by URL (ignoring #fragment) and caps the total", () => {
    const existing = [{ title: "A", link: "https://x.com/a", snippet: "" }];
    const fresh = [
      { title: "A dup", link: "https://x.com/a#section", snippet: "" },
      { title: "B", link: "https://x.com/b", snippet: "" },
    ];
    const merged = mergeWebSources(existing, fresh, 5);
    expect(merged).toHaveLength(2);
    expect(merged[0].title).toBe("A"); // existing kept, not overwritten by the fresh dup
  });

  it("mergeWebSources respects the cap", () => {
    const fresh = Array.from({ length: 10 }, (_, i) => ({
      title: `s${i}`,
      link: `https://x.com/${i}`,
      snippet: "",
    }));
    expect(mergeWebSources([], fresh, 3)).toHaveLength(3);
  });
});

describe("webSourcesBlock", () => {
  it("returns a placeholder for an empty list", () => {
    expect(webSourcesBlock([])).toMatch(/외부 검색 결과 없음/);
  });

  it("labels each entry [외부N] with title/snippet/URL", () => {
    const block = webSourcesBlock([
      { title: "T1", snippet: "S1", link: "https://x.com/1" },
      { title: "T2", snippet: "S2", link: "https://x.com/2" },
    ]);
    expect(block).toMatch(/\[외부0\]: T1/);
    expect(block).toMatch(/\[외부1\]: T2/);
    expect(block).toMatch(/https:\/\/x\.com\/2/);
  });
});

describe("deriveDraftSearchQueries", () => {
  const fakeConnector = (textResponse) => ({
    getChatCompletion: jest.fn().mockResolvedValue({ textResponse }),
  });

  it("parses one query per line, stripping bullets/numbering", () => {
    const LLMConnector = fakeConnector("- 유통산업발전법 개정안\n2. 대형마트 규제 완화");
    const queries = () =>
      deriveDraftSearchQueries({
        sourceText: "본문",
        instructions: "",
        LLMConnector,
      });
    return queries().then((result) => {
      expect(result).toEqual(["유통산업발전법 개정안", "대형마트 규제 완화"]);
    });
  });

  it("caps at 3 queries", async () => {
    const LLMConnector = fakeConnector("a\nb\nc\nd\ne");
    const result = await deriveDraftSearchQueries({
      sourceText: "본문",
      instructions: "",
      LLMConnector,
    });
    expect(result).toHaveLength(3);
  });

  it("returns an empty list when the LLM call fails, instead of throwing", async () => {
    const LLMConnector = {
      getChatCompletion: jest.fn().mockRejectedValue(new Error("rate limited")),
    };
    const result = await deriveDraftSearchQueries({
      sourceText: "본문",
      instructions: "",
      LLMConnector,
    });
    expect(result).toEqual([]);
  });
});

describe("gatherWebSources", () => {
  beforeEach(() => jest.clearAllMocks());

  it("combines reused citations with freshly searched results, deduped", async () => {
    const LLMConnector = {
      getChatCompletion: jest.fn().mockResolvedValue({ textResponse: "query one" }),
    };
    webSearch.mockResolvedValue([
      { title: "Fresh", link: "https://fresh.com/1", snippet: "s" },
    ]);
    const citations = [
      { title: "Reused", chunkSource: "link://https://reused.com/1", text: "s" },
    ];
    const result = await gatherWebSources({
      sourceText: "본문",
      instructions: "",
      citations,
      LLMConnector,
    });
    expect(result.map((r) => r.link)).toEqual([
      "https://reused.com/1",
      "https://fresh.com/1",
    ]);
  });

  it("skips the web search entirely when no queries could be derived", async () => {
    const LLMConnector = {
      getChatCompletion: jest.fn().mockResolvedValue({ textResponse: "" }),
    };
    const result = await gatherWebSources({
      sourceText: "본문",
      instructions: "",
      citations: [],
      LLMConnector,
    });
    expect(webSearch).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("keeps going when one query's webSearch call throws", async () => {
    const LLMConnector = {
      getChatCompletion: jest
        .fn()
        .mockResolvedValue({ textResponse: "q1\nq2" }),
    };
    webSearch
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([{ title: "OK", link: "https://ok.com", snippet: "s" }]);
    const result = await gatherWebSources({
      sourceText: "본문",
      instructions: "",
      citations: [],
      LLMConnector,
    });
    expect(result).toEqual([{ title: "OK", link: "https://ok.com", snippet: "s" }]);
  });
});

describe("buildMessages", () => {
  it("answer_only never mentions 외부 검색 자료 in the prompt", () => {
    const [system, user] = buildMessages({
      sourceText: "본문",
      citations: [],
      dataScope: "answer_only",
      reportType: "basic",
      instructions: "",
      webSources: [],
    }).map((m) => m.content);
    expect(system).not.toMatch(/외부 검색 자료/);
    expect(user).not.toMatch(/외부 검색 자료/);
  });

  it("answer_plus_web includes the 외부 검색 자료 block in the user prompt", () => {
    const [, user] = buildMessages({
      sourceText: "본문",
      citations: [],
      dataScope: "answer_plus_web",
      reportType: "basic",
      instructions: "",
      webSources: [{ title: "T", snippet: "S", link: "https://x.com" }],
    }).map((m) => m.content);
    expect(user).toMatch(/외부 검색 자료/);
    expect(user).toMatch(/\[외부0\]: T/);
  });
});

describe("extractTitle", () => {
  it("reads the first '# ' heading", () => {
    expect(extractTitle("# 제목입니다\n본문")).toBe("제목입니다");
  });

  it("falls back when there is no heading", () => {
    expect(extractTitle("본문만 있음", "기본값")).toBe("기본값");
  });
});
