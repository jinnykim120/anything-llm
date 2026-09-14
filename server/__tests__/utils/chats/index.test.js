/* eslint-env jest, node */
const {
  grepCommand,
  grepAllSlashCommands,
  condenseFollowupQuery,
  mergeFollowupSearchResults,
  buildWebSearchContextBlock,
} = require("../../../utils/chats");
const { SlashCommandPresets } = require("../../../models/slashCommandsPresets");

jest.mock("../../../models/slashCommandsPresets");

// Helper to shape preset rows the way the model returns them.
const preset = (command, prompt) => ({ command, prompt });

describe("grepCommand", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the built-in command when the message starts with it", async () => {
    SlashCommandPresets.getUserPresets.mockResolvedValue([]);
    expect(await grepCommand("/reset")).toBe("/reset");
    expect(await grepCommand("/RESET now")).toBe("/reset"); // case-insensitive
  });

  it("returns the message unchanged when no command matches", async () => {
    SlashCommandPresets.getUserPresets.mockResolvedValue([]);
    expect(await grepCommand("hello there")).toBe("hello there");
  });

  describe("preset expansion", () => {
    beforeEach(() => {
      SlashCommandPresets.getUserPresets.mockResolvedValue([
        preset("/weather", "what is the weather?"),
      ]);
    });

    it("expands a command at the start of the message", async () => {
      expect(await grepCommand("/weather")).toBe("what is the weather?");
    });

    it("expands a command that follows other text and a space", async () => {
      expect(await grepCommand("ok, /weather")).toBe("ok, what is the weather?");
    });

    it("expands a command with trailing punctuation", async () => {
      expect(await grepCommand("/weather?")).toBe("what is the weather??");
    });

    it("does not expand a command that is part of a longer word", async () => {
      expect(await grepCommand("/weatherman")).toBe("/weatherman");
    });

    it("does not expand a command glued to the end of a word", async () => {
      expect(await grepCommand("foo/weather")).toBe("foo/weather");
    });
  });

  it("expands multiple presets in a single message", async () => {
    SlashCommandPresets.getUserPresets.mockResolvedValue([
      preset("/weather", "the weather"),
      preset("/time", "the time"),
    ]);
    expect(await grepCommand("/weather and /time")).toBe(
      "the weather and the time"
    );
  });

  it("scopes preset lookup to the passed user", async () => {
    SlashCommandPresets.getUserPresets.mockResolvedValue([]);
    await grepCommand("hi", { id: 42 });
    expect(SlashCommandPresets.getUserPresets).toHaveBeenCalledWith(42);
  });
});

describe("grepAllSlashCommands", () => {
  beforeEach(() => jest.clearAllMocks());

  it("expands presets regardless of user (not scoped)", async () => {
    SlashCommandPresets.where.mockResolvedValue([
      preset("/weather", "what is the weather?"),
    ]);
    expect(await grepAllSlashCommands("ok, /weather?")).toBe(
      "ok, what is the weather??"
    );
    expect(SlashCommandPresets.where).toHaveBeenCalledWith({});
  });

  it("does not expand a command that is part of a longer word", async () => {
    SlashCommandPresets.where.mockResolvedValue([
      preset("/weather", "what is the weather?"),
    ]);
    expect(await grepAllSlashCommands("/weatherman")).toBe("/weatherman");
  });

  it("expands multiple presets in a single message", async () => {
    SlashCommandPresets.where.mockResolvedValue([
      preset("/weather", "the weather"),
      preset("/time", "the time"),
    ]);
    expect(await grepAllSlashCommands("/weather and /time")).toBe(
      "the weather and the time"
    );
  });
});

describe("condenseFollowupQuery (후속질문)", () => {
  const fakeConnector = (textResponse) => ({
    getChatCompletion: jest.fn().mockResolvedValue({ textResponse }),
  });

  it("skips the LLM call entirely with no chat history (first message in a thread)", async () => {
    const LLMConnector = fakeConnector("should never be used");
    const result = await condenseFollowupQuery({
      message: "기후위기 대책은?",
      chatHistory: [],
      LLMConnector,
    });
    expect(result).toBe("기후위기 대책은?");
    expect(LLMConnector.getChatCompletion).not.toHaveBeenCalled();
  });

  it("rewrites a follow-up into a standalone question using recent history", async () => {
    const LLMConnector = fakeConnector(
      "GS리테일 기후위기 대응 중 O6 친환경 인증제품 관련 법률적 검토사항은?"
    );
    const chatHistory = [
      { role: "user", content: "기후위기와 관련한 대책은?" },
      { role: "assistant", content: "...O6 친환경 인증제품 매출액은..." },
    ];
    const result = await condenseFollowupQuery({
      message: "그중 A 부분은 법률적으로 검토할 게 있어?",
      chatHistory,
      LLMConnector,
    });
    expect(result).toBe(
      "GS리테일 기후위기 대응 중 O6 친환경 인증제품 관련 법률적 검토사항은?"
    );
    expect(LLMConnector.getChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("falls back to the raw message when the rewrite call throws", async () => {
    const LLMConnector = {
      getChatCompletion: jest.fn().mockRejectedValue(new Error("rate limited")),
    };
    const result = await condenseFollowupQuery({
      message: "그건 왜 그런거야?",
      chatHistory: [{ role: "user", content: "hi" }],
      LLMConnector,
    });
    expect(result).toBe("그건 왜 그런거야?");
  });

  it("falls back to the raw message when the rewrite comes back empty", async () => {
    const LLMConnector = fakeConnector("   ");
    const result = await condenseFollowupQuery({
      message: "원래 질문",
      chatHistory: [{ role: "user", content: "hi" }],
      LLMConnector,
    });
    expect(result).toBe("원래 질문");
  });
});

describe("mergeFollowupSearchResults (보완 로직)", () => {
  it("keeps the primary search's own results and order untouched", () => {
    const primary = {
      contextTexts: ["p1", "p2"],
      sources: [{ id: "a" }, { id: "b" }],
    };
    const secondary = { contextTexts: [], sources: [] };
    const merged = mergeFollowupSearchResults(primary, secondary, 4);
    expect(merged.contextTexts).toEqual(["p1", "p2"]);
    expect(merged.sources.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("additively appends secondary chunks the primary search missed", () => {
    const primary = {
      contextTexts: ["p1"],
      sources: [{ id: "a" }],
    };
    const secondary = {
      contextTexts: ["s1", "s2"],
      sources: [{ id: "b" }, { id: "c" }],
    };
    const merged = mergeFollowupSearchResults(primary, secondary, 4);
    expect(merged.sources.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(merged.contextTexts).toEqual(["p1", "s1", "s2"]);
  });

  it("never duplicates a chunk the primary search already returned", () => {
    const primary = {
      contextTexts: ["p1"],
      sources: [{ id: "a" }],
    };
    const secondary = {
      contextTexts: ["s-dup", "s-new"],
      sources: [{ id: "a" }, { id: "c" }],
    };
    const merged = mergeFollowupSearchResults(primary, secondary, 4);
    expect(merged.sources.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("stops adding once topN is reached", () => {
    const primary = {
      contextTexts: ["p1", "p2"],
      sources: [{ id: "a" }, { id: "b" }],
    };
    const secondary = {
      contextTexts: ["s1", "s2"],
      sources: [{ id: "c" }, { id: "d" }],
    };
    const merged = mergeFollowupSearchResults(primary, secondary, 3);
    expect(merged.sources.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("falls back to a doc_id+text key when a chunk has no id", () => {
    const primary = {
      contextTexts: ["some long chunk text here"],
      sources: [{ doc_id: "doc1", text: "some long chunk text here" }],
    };
    const secondary = {
      contextTexts: ["some long chunk text here (duplicate)"],
      sources: [{ doc_id: "doc1", text: "some long chunk text here" }],
    };
    const merged = mergeFollowupSearchResults(primary, secondary, 4);
    expect(merged.sources).toHaveLength(1);
  });
});

describe("buildWebSearchContextBlock (외부검색)", () => {
  it("returns an empty string for no results (no-op when there's nothing to add)", () => {
    expect(buildWebSearchContextBlock([])).toBe("");
    expect(buildWebSearchContextBlock()).toBe("");
  });

  it("labels each result with its own [브라우징N] index, distinct from internal citations", () => {
    const block = buildWebSearchContextBlock([
      { title: "가맹사업법 개정안", link: "https://law.go.kr/a", snippet: "본문 A" },
      { title: "관련 뉴스", link: "https://news.example.com/b", snippet: "본문 B" },
    ]);
    expect(block).toContain("[브라우징0]: 가맹사업법 개정안");
    expect(block).toContain("본문 A");
    expect(block).toContain("[END 브라우징0]");
    expect(block).toContain("[브라우징1]: 관련 뉴스");
    expect(block).toContain("본문 B");
    // Instructs the model to keep the two citation schemes separate.
    expect(block).toMatch(/브라우징N.*내부 문서 인용/);
  });
});
