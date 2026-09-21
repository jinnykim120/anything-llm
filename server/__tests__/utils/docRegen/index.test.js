const mockPerformSimilaritySearch = jest.fn();
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: () => ({
    performSimilaritySearch: mockPerformSimilaritySearch,
  }),
}));

const mockFindUnique = jest.fn();
const mockFindMany = jest.fn();
jest.mock("../../../utils/prisma", () => ({
  workspace_documents: {
    findUnique: (...args) => mockFindUnique(...args),
    findMany: (...args) => mockFindMany(...args),
  },
}));

const mockFileData = jest.fn();
jest.mock("../../../utils/files", () => ({
  fileData: (...args) => mockFileData(...args),
}));

const mockRecordExplicitCoSelection = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../utils/classification/documentAffinity", () => ({
  recordExplicitCoSelection: (...args) =>
    mockRecordExplicitCoSelection(...args),
}));

const {
  loadBaseDocument,
  loadBaseDocuments,
  resolveOwnedArchiveDocs,
  extractOutlineFromBlocks,
  extractOutlineViaLLM,
  getOutline,
  diffOutlineAgainstGuidance,
  planFromBlankForm,
  needsMarker,
  extractNeeds,
  writeSection,
  assembleMarkdown,
  regenerateDocument,
  MIN_SECTION_PATH_COVERAGE,
} = require("../../../utils/docRegen");

const fakeConnector = (textResponse) => ({
  getChatCompletion: jest.fn().mockResolvedValue({ textResponse }),
});

describe("loadBaseDocument / loadBaseDocuments", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockFileData.mockReset();
  });

  it("loads a single document's title/pageContent/blocks by workspace_documents.id", async () => {
    mockFindUnique.mockResolvedValue({
      id: 1,
      docpath: "custom-documents\\a.json",
      filename: "a.json",
      metadata: JSON.stringify({ title: "문서 A" }),
    });
    mockFileData.mockResolvedValue({
      pageContent: "본문 A",
      blocks: JSON.stringify([{ section_path: "1 > 절", text: "본문 A" }]),
    });
    const doc = await loadBaseDocument(1);
    expect(doc).toEqual({
      title: "문서 A",
      pageContent: "본문 A",
      blocks: [{ section_path: "1 > 절", text: "본문 A" }],
    });
  });

  it("throws a clear error when the id doesn't match any document", async () => {
    mockFindUnique.mockResolvedValue(null);
    await expect(loadBaseDocument(999)).rejects.toThrow(/찾을 수 없습니다/);
  });

  it("loadBaseDocuments loads every id in order (여러 기준 문서 선택)", async () => {
    mockFindUnique
      .mockResolvedValueOnce({
        id: 1,
        docpath: "custom-documents\\a.json",
        filename: "a.json",
        metadata: JSON.stringify({ title: "문서 A" }),
      })
      .mockResolvedValueOnce({
        id: 2,
        docpath: "custom-documents\\b.json",
        filename: "b.json",
        metadata: JSON.stringify({ title: "문서 B" }),
      });
    mockFileData
      .mockResolvedValueOnce({ pageContent: "본문 A", blocks: [] })
      .mockResolvedValueOnce({ pageContent: "본문 B", blocks: [] });

    const docs = await loadBaseDocuments([1, 2]);
    expect(docs.map((d) => d.title)).toEqual(["문서 A", "문서 B"]);
  });

  it("loadBaseDocuments rejects with a clear error for an empty selection", async () => {
    await expect(loadBaseDocuments([])).rejects.toThrow(/선택/);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});

describe("resolveOwnedArchiveDocs", () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockFindUnique.mockReset();
    mockFileData.mockReset();
    mockRecordExplicitCoSelection.mockClear();
  });

  it("returns [] without querying when workspaceId or docIds is missing", async () => {
    expect(
      await resolveOwnedArchiveDocs({ workspaceId: null, docIds: [1] })
    ).toEqual([]);
    expect(
      await resolveOwnedArchiveDocs({ workspaceId: 5, docIds: [] })
    ).toEqual([]);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("only loads docs that belong to the workspace, ignoring foreign ids", async () => {
    mockFindMany.mockResolvedValue([{ id: 1 }]); // only id 1 is owned
    mockFindUnique.mockResolvedValue({
      id: 1,
      docpath: "custom-documents\\a.json",
      filename: "a.json",
      metadata: JSON.stringify({ title: "문서 A" }),
    });
    mockFileData.mockResolvedValue({ pageContent: "본문 A", blocks: [] });

    const docs = await resolveOwnedArchiveDocs({
      workspaceId: 5,
      docIds: [1, 999],
    });

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 999] }, workspaceId: 5 },
      select: { id: true },
    });
    expect(docs).toEqual([
      { id: 1, title: "문서 A", pageContent: "본문 A", blocks: [] },
    ]);
  });

  it("records explicit co-selection when 2+ docs are picked together", async () => {
    mockFindMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    mockFindUnique
      .mockResolvedValueOnce({
        id: 1,
        docpath: "a.json",
        metadata: JSON.stringify({ title: "A" }),
      })
      .mockResolvedValueOnce({
        id: 2,
        docpath: "b.json",
        metadata: JSON.stringify({ title: "B" }),
      });
    mockFileData.mockResolvedValue({ pageContent: "본문", blocks: [] });

    await resolveOwnedArchiveDocs({ workspaceId: 5, docIds: [1, 2] });

    expect(mockRecordExplicitCoSelection).toHaveBeenCalledWith({
      workspaceId: 5,
      workspaceDocIds: [1, 2],
    });
  });

  it("does not record co-selection for a single doc", async () => {
    mockFindMany.mockResolvedValue([{ id: 1 }]);
    mockFindUnique.mockResolvedValue({
      id: 1,
      docpath: "a.json",
      metadata: JSON.stringify({ title: "A" }),
    });
    mockFileData.mockResolvedValue({ pageContent: "본문", blocks: [] });

    await resolveOwnedArchiveDocs({ workspaceId: 5, docIds: [1] });

    expect(mockRecordExplicitCoSelection).not.toHaveBeenCalled();
  });

  it("drops a doc that fails to load instead of failing the whole batch", async () => {
    mockFindMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    mockFindUnique
      .mockResolvedValueOnce({
        id: 1,
        docpath: "a.json",
        metadata: JSON.stringify({ title: "A" }),
      })
      .mockResolvedValueOnce(null); // id 2 fails to load
    mockFileData.mockResolvedValue({ pageContent: "본문", blocks: [] });

    const docs = await resolveOwnedArchiveDocs({
      workspaceId: 5,
      docIds: [1, 2],
    });

    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe(1);
  });
});

describe("extractOutlineFromBlocks", () => {
  it("groups consecutive blocks by section_path, in first-seen order", () => {
    const blocks = [
      { section_path: "1 > 목적", text: "이 문서의 목적은..." },
      { section_path: "1 > 목적", text: "두 번째 문장." },
      { section_path: "2 > 배경", text: "배경 설명." },
    ];
    const outline = extractOutlineFromBlocks(blocks);
    expect(outline).toEqual([
      { title: "목적", content: "이 문서의 목적은...\n두 번째 문장." },
      { title: "배경", content: "배경 설명." },
    ]);
  });

  it("returns null when section_path coverage is below the threshold", () => {
    const blocks = [
      { section_path: "1 > 목적", text: "a" },
      { section_path: null, text: "b" },
      { section_path: null, text: "c" },
      { section_path: null, text: "d" },
    ];
    expect(1 / blocks.length).toBeLessThan(MIN_SECTION_PATH_COVERAGE);
    expect(extractOutlineFromBlocks(blocks)).toBeNull();
  });

  it("returns null for an empty or missing block list", () => {
    expect(extractOutlineFromBlocks([])).toBeNull();
    expect(extractOutlineFromBlocks(undefined)).toBeNull();
  });

  it("drops sections that end up with no text", () => {
    const blocks = [
      { section_path: "1 > 목적", text: "" },
      { section_path: "2 > 배경", text: "배경" },
    ];
    // coverage is 100% here regardless of empty text
    expect(extractOutlineFromBlocks(blocks)).toEqual([
      { title: "배경", content: "배경" },
    ]);
  });
});

describe("extractOutlineViaLLM", () => {
  it("slices pageContent at each boundary's exact text, in position order", async () => {
    const pageContent = "제1장 총칙\n내용1\n\n제2장 세부사항\n내용2";
    const LLMConnector = fakeConnector(
      JSON.stringify([
        { title: "세부사항", startsWith: "제2장 세부사항" },
        { title: "총칙", startsWith: "제1장 총칙" },
      ])
    );
    const outline = await extractOutlineViaLLM({ pageContent, LLMConnector });
    expect(outline).toEqual([
      { title: "총칙", content: "제1장 총칙\n내용1" },
      { title: "세부사항", content: "제2장 세부사항\n내용2" },
    ]);
  });

  it("falls back to one whole-document section when the LLM response isn't usable JSON", async () => {
    const LLMConnector = fakeConnector("이건 JSON이 아님");
    const outline = await extractOutlineViaLLM({
      pageContent: "본문 내용",
      LLMConnector,
    });
    expect(outline).toEqual([{ title: "본문", content: "본문 내용" }]);
  });

  it("falls back when none of the boundary markers are found verbatim in the text", async () => {
    const LLMConnector = fakeConnector(
      JSON.stringify([{ title: "X", startsWith: "존재하지 않는 문구" }])
    );
    const outline = await extractOutlineViaLLM({
      pageContent: "실제 본문",
      LLMConnector,
    });
    expect(outline).toEqual([{ title: "본문", content: "실제 본문" }]);
  });

  it("falls back to a whole-document section when the LLM call throws", async () => {
    const LLMConnector = {
      getChatCompletion: jest.fn().mockRejectedValue(new Error("rate limited")),
    };
    const outline = await extractOutlineViaLLM({
      pageContent: "본문",
      LLMConnector,
    });
    expect(outline).toEqual([{ title: "본문", content: "본문" }]);
  });

  it("returns an empty-safe fallback for empty pageContent", async () => {
    const LLMConnector = fakeConnector("[]");
    const outline = await extractOutlineViaLLM({ pageContent: "", LLMConnector });
    expect(outline).toEqual([{ title: "본문", content: "" }]);
  });
});

describe("getOutline", () => {
  it("prefers metadata-based extraction when coverage is high", async () => {
    const LLMConnector = fakeConnector("should not be called");
    const blocks = [{ section_path: "1 > 절", text: "내용" }];
    const outline = await getOutline({ pageContent: "무시됨", blocks, LLMConnector });
    expect(outline).toEqual([{ title: "절", content: "내용" }]);
    expect(LLMConnector.getChatCompletion).not.toHaveBeenCalled();
  });

  it("falls back to the LLM method when blocks have no usable section_path", async () => {
    const LLMConnector = fakeConnector(
      JSON.stringify([{ title: "전체", startsWith: "본문" }])
    );
    const outline = await getOutline({
      pageContent: "본문 내용입니다",
      blocks: [{ section_path: null, text: "본문 내용입니다" }],
      LLMConnector,
    });
    expect(outline).toEqual([{ title: "전체", content: "본문 내용입니다" }]);
    expect(LLMConnector.getChatCompletion).toHaveBeenCalledTimes(1);
  });
});

describe("diffOutlineAgainstGuidance", () => {
  const outline = [
    { title: "목적", content: "작년 목적 내용" },
    { title: "실적", content: "작년 실적 내용" },
  ];

  it("maps the LLM's plan back onto the prior outline's content", async () => {
    const LLMConnector = fakeConnector(
      JSON.stringify([
        { title: "목적", status: "keep", guidanceExcerpt: "", outlineIndex: 0 },
        { title: "실적", status: "update", guidanceExcerpt: "새 기준 발췌", outlineIndex: 1 },
        { title: "리스크", status: "new", guidanceExcerpt: "리스크 요구사항", outlineIndex: null },
      ])
    );
    const plan = await diffOutlineAgainstGuidance({
      outline,
      guidanceText: "올해 기준...",
      LLMConnector,
    });
    expect(plan).toEqual([
      { title: "목적", status: "keep", guidanceExcerpt: "", priorContent: "작년 목적 내용" },
      { title: "실적", status: "update", guidanceExcerpt: "새 기준 발췌", priorContent: "작년 실적 내용" },
      { title: "리스크", status: "new", guidanceExcerpt: "리스크 요구사항", priorContent: "" },
    ]);
  });

  it("falls back to an all-keep plan when the LLM response isn't usable JSON", async () => {
    const LLMConnector = fakeConnector("설명 텍스트, JSON 아님");
    const plan = await diffOutlineAgainstGuidance({
      outline,
      guidanceText: "...",
      LLMConnector,
    });
    expect(plan).toEqual([
      { title: "목적", status: "keep", guidanceExcerpt: "", priorContent: "작년 목적 내용" },
      { title: "실적", status: "keep", guidanceExcerpt: "", priorContent: "작년 실적 내용" },
    ]);
  });

  it("falls back to an all-keep plan when the LLM call throws", async () => {
    const LLMConnector = {
      getChatCompletion: jest.fn().mockRejectedValue(new Error("boom")),
    };
    const plan = await diffOutlineAgainstGuidance({
      outline,
      guidanceText: "...",
      LLMConnector,
    });
    expect(plan.every((p) => p.status === "keep")).toBe(true);
  });

  it("normalizes an unrecognized status to 'update' rather than dropping the section", async () => {
    const LLMConnector = fakeConnector(
      JSON.stringify([{ title: "이상함", status: "delete", guidanceExcerpt: "", outlineIndex: null }])
    );
    const plan = await diffOutlineAgainstGuidance({ outline, guidanceText: "...", LLMConnector });
    expect(plan[0].status).toBe("update");
  });

  it("returns an empty plan for an empty outline", async () => {
    const LLMConnector = fakeConnector("[]");
    const plan = await diffOutlineAgainstGuidance({ outline: [], guidanceText: "...", LLMConnector });
    expect(plan).toEqual([]);
    expect(LLMConnector.getChatCompletion).not.toHaveBeenCalled();
  });
});

// [auto-docu 전사문서작성tool v2] 빈양식 모드 — diffOutlineAgainstGuidance는
// 그대로 재사용해 절별 guidanceExcerpt를 뽑지만, "유지할 기존 내용"이 없는
// 빈 서식에는 "keep"이 의미가 없으므로 update로 강제 승격돼야 한다.
describe("planFromBlankForm", () => {
  const outline = [
    { title: "필드1", content: "" },
    { title: "필드2", content: "" },
  ];

  it("promotes a 'keep' verdict to 'update' and clears its (blank) priorContent", async () => {
    const LLMConnector = fakeConnector(
      JSON.stringify([
        { title: "필드1", status: "keep", guidanceExcerpt: "", outlineIndex: 0 },
        { title: "필드2", status: "new", guidanceExcerpt: "새 요구사항", outlineIndex: null },
      ])
    );
    const plan = await planFromBlankForm({
      outline,
      guidanceText: "올해 기준...",
      LLMConnector,
    });
    expect(plan).toEqual([
      { title: "필드1", status: "update", guidanceExcerpt: "", priorContent: "" },
      { title: "필드2", status: "new", guidanceExcerpt: "새 요구사항", priorContent: "" },
    ]);
  });

  it("leaves 'update'/'new' verdicts untouched", async () => {
    const LLMConnector = fakeConnector(
      JSON.stringify([
        { title: "필드1", status: "update", guidanceExcerpt: "발췌", outlineIndex: 0 },
      ])
    );
    const plan = await planFromBlankForm({ outline, guidanceText: "...", LLMConnector });
    expect(plan[0].status).toBe("update");
    expect(plan[0].guidanceExcerpt).toBe("발췌");
  });
});

describe("needsMarker / extractNeeds", () => {
  it("round-trips a description through the marker format", () => {
    const marker = needsMarker("2025년 매출 실적 수치");
    expect(marker).toBe("[자료 필요: 2025년 매출 실적 수치]");
    expect(extractNeeds(marker)).toEqual(["2025년 매출 실적 수치"]);
  });

  it("extracts multiple distinct markers in order, deduped", () => {
    const content =
      "일부 내용... [자료 필요: 계약 조건] 더 내용... [자료 필요: 수수료율] 그리고 [자료 필요: 계약 조건] 또.";
    expect(extractNeeds(content)).toEqual(["계약 조건", "수수료율"]);
  });

  it("returns an empty array when there are no markers", () => {
    expect(extractNeeds("완전히 채워진 내용입니다.")).toEqual([]);
  });
});

describe("writeSection", () => {
  it("returns the model's content and any needs markers found in it", async () => {
    const LLMConnector = fakeConnector(
      "일부 내용은 여기 있음. [자료 필요: 세부 계약 조건]"
    );
    const result = await writeSection({
      section: { title: "계약 조건", guidanceExcerpt: "", priorContent: "" },
      contextTexts: ["근거1"],
      LLMConnector,
    });
    expect(result.content).toBe("일부 내용은 여기 있음. [자료 필요: 세부 계약 조건]");
    expect(result.needs).toEqual(["세부 계약 조건"]);
  });

  it("marks the whole section as needing data when the model returns nothing", async () => {
    const LLMConnector = fakeConnector("   ");
    const result = await writeSection({
      section: { title: "빈 절", guidanceExcerpt: "", priorContent: "" },
      contextTexts: [],
      LLMConnector,
    });
    expect(result.content).toBe("[자료 필요: 이 절의 내용 전체]");
    expect(result.needs).toEqual(["이 절의 내용 전체"]);
  });

  it("marks the section as needing data (with the error) when the LLM call throws", async () => {
    const LLMConnector = {
      getChatCompletion: jest.fn().mockRejectedValue(new Error("rate limited")),
    };
    const result = await writeSection({
      section: { title: "절", guidanceExcerpt: "", priorContent: "" },
      contextTexts: [],
      LLMConnector,
    });
    expect(result.content).toMatch(/rate limited/);
    expect(result.needs.length).toBe(1);
  });
});

describe("assembleMarkdown", () => {
  it("builds a '# title' + '## section' markdown document", () => {
    const md = assembleMarkdown({
      title: "2026 보고서",
      sections: [
        { title: "목적", content: "목적 내용" },
        { title: "배경", content: "배경 내용" },
      ],
    });
    expect(md).toBe(
      "# 2026 보고서\n\n## 목적\n\n목적 내용\n\n## 배경\n\n배경 내용"
    );
  });
});

describe("regenerateDocument (전체 파이프라인)", () => {
  beforeEach(() => {
    mockPerformSimilaritySearch.mockReset();
  });

  it("streams outline -> plan -> one section_done per section -> done, and passes 'keep' through verbatim without searching", async () => {
    const workspace = { slug: "archive-full" };
    const baseDoc = {
      title: "작년 보고서",
      pageContent: "무시됨",
      blocks: [
        { section_path: "1 > 목적", text: "작년 목적" },
        { section_path: "2. 리스크", text: "작년 리스크 서술" },
      ],
    };
    // 신구비교 호출 1번만 일어나므로, 그 하나의 응답만 큐에 넣는다.
    const LLMConnector = fakeConnector(
      JSON.stringify([
        { title: "목적", status: "keep", guidanceExcerpt: "", outlineIndex: 0 },
        { title: "리스크", status: "update", guidanceExcerpt: "새 리스크 기준", outlineIndex: 1 },
      ])
    );
    // update 절의 writeSection 호출에 대한 응답을 diff 호출 이후로 겹치게 mock.
    LLMConnector.getChatCompletion
      .mockResolvedValueOnce({
        textResponse: JSON.stringify([
          { title: "목적", status: "keep", guidanceExcerpt: "", outlineIndex: 0 },
          { title: "리스크", status: "update", guidanceExcerpt: "새 리스크 기준", outlineIndex: 1 },
        ]),
      })
      .mockResolvedValueOnce({ textResponse: "새로 작성된 리스크 절 내용" });

    mockPerformSimilaritySearch.mockResolvedValue({
      contextTexts: ["아카이브 검색 근거"],
      sources: [{ title: "다른 문서" }],
    });

    const events = [];
    for await (const ev of regenerateDocument({
      workspace,
      baseDocs: [baseDoc],
      guidanceText: "올해 신규 기준",
      LLMConnector,
      title: "2026 보고서",
    })) {
      events.push(ev);
    }

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "outline_start",
      "outline",
      "plan",
      "section_start",
      "section_done",
      "section_start",
      "section_done",
      "done",
    ]);

    const keepDone = events.find(
      (e) => e.type === "section_done" && e.section.title === "목적"
    );
    expect(keepDone.section.content).toBe("작년 목적");
    expect(keepDone.section.needs).toEqual([]);

    const updateDone = events.find(
      (e) => e.type === "section_done" && e.section.title === "리스크"
    );
    expect(updateDone.section.content).toBe("새로 작성된 리스크 절 내용");
    expect(updateDone.section.sources).toEqual([{ title: "다른 문서" }]);

    // "keep" 절은 아카이브 검색 없이 그대로 넘어가야 한다 — update 절 1건에만 검색이 붙는다.
    expect(mockPerformSimilaritySearch).toHaveBeenCalledTimes(1);
    expect(mockPerformSimilaritySearch).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "archive-full" })
    );

    const done = events.at(-1);
    expect(done.markdown).toBe(
      "# 2026 보고서\n\n## 목적\n\n작년 목적\n\n## 리스크\n\n새로 작성된 리스크 절 내용"
    );
  });

  // [auto-docu 전사문서작성tool v2] 사용자가 미리 자료를 모아둔 문서함
  // 폴더를 고르면, 그 폴더의 doc_id 허용목록(filterDocIds)이 절 검색에
  // 그대로 전달돼야 한다 — 아카이브 전체가 아니라 그 폴더 안에서만 찾는다.
  it("filterDocIds가 주어지면 절 검색(performSimilaritySearch)에 그대로 전달된다", async () => {
    const workspace = { slug: "archive-full" };
    const baseDoc = {
      title: "작년 보고서",
      pageContent: "무시됨",
      blocks: [{ section_path: "1 > 리스크", text: "작년 리스크 서술" }],
    };
    const LLMConnector = fakeConnector();
    LLMConnector.getChatCompletion
      .mockResolvedValueOnce({
        textResponse: JSON.stringify([
          {
            title: "리스크",
            status: "update",
            guidanceExcerpt: "새 리스크 기준",
            outlineIndex: 0,
          },
        ]),
      })
      .mockResolvedValueOnce({ textResponse: "새로 작성된 리스크 절 내용" });
    mockPerformSimilaritySearch.mockResolvedValue({
      contextTexts: ["폴더 안 근거"],
      sources: [],
    });

    const events = [];
    for await (const ev of regenerateDocument({
      workspace,
      baseDocs: [baseDoc],
      guidanceText: "올해 신규 기준",
      LLMConnector,
      title: "2026 보고서",
      filterDocIds: ["doc-1", "doc-2"],
    })) {
      events.push(ev);
    }

    expect(events.at(-1).type).toBe("done");
    expect(mockPerformSimilaritySearch).toHaveBeenCalledWith(
      expect.objectContaining({ filterDocIds: ["doc-1", "doc-2"] })
    );
  });

  it("여러 기준 문서를 고르면 문서별 목차를 순서대로 이어붙인다", async () => {
    const workspace = { slug: "archive-full" };
    const baseDocs = [
      {
        title: "문서 A",
        pageContent: "무시됨",
        blocks: [{ section_path: "1 > A절", text: "A 문서 내용" }],
      },
      {
        title: "문서 B",
        pageContent: "무시됨",
        blocks: [{ section_path: "1 > B절", text: "B 문서 내용" }],
      },
    ];
    // 신구비교 1회만 호출 — 두 문서의 절 모두 그대로 유지.
    const LLMConnector = fakeConnector(
      JSON.stringify([
        { title: "A절", status: "keep", guidanceExcerpt: "", outlineIndex: 0 },
        { title: "B절", status: "keep", guidanceExcerpt: "", outlineIndex: 1 },
      ])
    );

    const events = [];
    for await (const ev of regenerateDocument({
      workspace,
      baseDocs,
      guidanceText: "기준",
      LLMConnector,
      title: "합본 문서",
    })) {
      events.push(ev);
    }

    const outlineEvent = events.find((e) => e.type === "outline");
    expect(outlineEvent.outline).toEqual(["A절", "B절"]);
    expect(mockPerformSimilaritySearch).not.toHaveBeenCalled(); // 전부 keep
    const done = events.at(-1);
    expect(done.markdown).toBe(
      "# 합본 문서\n\n## A절\n\nA 문서 내용\n\n## B절\n\nB 문서 내용"
    );
  });

  // [auto-docu 전사문서작성tool v2] 빈양식 모드 — 목차는 blankForm에서
  // 뽑고(baseDocs는 무시), 모든 절이 검색 대상(new/update)이 된다.
  it("빈양식이 주어지면 baseDocs 대신 그 목차를 쓰고, 'keep'을 만들지 않는다", async () => {
    const workspace = { slug: "archive-full" };
    const blankForm = {
      title: "빈 서식",
      pageContent: "무시됨",
      // 실제 빈양식은 라벨만 있고 값은 비어 있다 — text가 아예 빈 문자열이면
      // extractOutlineFromBlocks가 그 절을 통째로 드롭하므로(내용 없는 절 제외),
      // 라벨 텍스트만 있는 최소한의 형태로 준다.
      blocks: [{ section_path: "1 > 필수 품목", text: "필수 품목: ___" }],
    };
    const ignoredBaseDoc = {
      title: "무시될 기준 문서",
      pageContent: "무시됨",
      blocks: [{ section_path: "1 > 다른 절", text: "다른 절 내용" }],
    };
    const LLMConnector = fakeConnector(
      JSON.stringify([
        { title: "필수 품목", status: "keep", guidanceExcerpt: "", outlineIndex: 0 },
      ])
    );
    LLMConnector.getChatCompletion
      .mockResolvedValueOnce({
        textResponse: JSON.stringify([
          { title: "필수 품목", status: "keep", guidanceExcerpt: "", outlineIndex: 0 },
        ]),
      })
      .mockResolvedValueOnce({ textResponse: "채워진 필수 품목 내용" });
    mockPerformSimilaritySearch.mockResolvedValue({
      contextTexts: ["근거"],
      sources: [],
    });

    const events = [];
    for await (const ev of regenerateDocument({
      workspace,
      baseDocs: [ignoredBaseDoc],
      blankForm,
      guidanceText: "올해 기준",
      LLMConnector,
      title: "제목",
    })) {
      events.push(ev);
    }

    const outlineEvent = events.find((e) => e.type === "outline");
    expect(outlineEvent.outline).toEqual(["필수 품목"]); // baseDocs의 "다른 절"은 안 섞임
    const planEvent = events.find((e) => e.type === "plan");
    expect(planEvent.plan).toEqual([{ title: "필수 품목", status: "update" }]);
    // "keep"이 아니므로(update로 승격) 아카이브 검색이 실제로 일어난다.
    expect(mockPerformSimilaritySearch).toHaveBeenCalledTimes(1);
    const done = events.at(-1);
    expect(done.markdown).toBe("# 제목\n\n## 필수 품목\n\n채워진 필수 품목 내용");
  });

  it("keeps going and marks a section as needing data when its search call fails", async () => {
    const workspace = { slug: "archive-full" };
    const baseDoc = {
      title: "작년 보고서",
      pageContent: "무시됨",
      blocks: [{ section_path: "1. 실적", text: "작년 실적" }],
    };
    const LLMConnector = fakeConnector(
      JSON.stringify([{ title: "실적", status: "update", guidanceExcerpt: "", outlineIndex: 0 }])
    );
    LLMConnector.getChatCompletion
      .mockResolvedValueOnce({
        textResponse: JSON.stringify([
          { title: "실적", status: "update", guidanceExcerpt: "", outlineIndex: 0 },
        ]),
      })
      .mockResolvedValueOnce({ textResponse: "[자료 필요: 2026년 실적 수치]" });
    mockPerformSimilaritySearch.mockRejectedValue(new Error("db down"));

    const events = [];
    for await (const ev of regenerateDocument({
      workspace,
      baseDocs: [baseDoc],
      guidanceText: "기준",
      LLMConnector,
      title: "제목",
    })) {
      events.push(ev);
    }

    const done = events.find((e) => e.type === "done");
    expect(done.sections[0].needs).toEqual(["2026년 실적 수치"]);
  });
});
