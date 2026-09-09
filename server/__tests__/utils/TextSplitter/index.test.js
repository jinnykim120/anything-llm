const { TextSplitter } = require("../../../utils/TextSplitter");

describe("TextSplitter", () => {
  test("splits long text into n sized chunks", async () => {
    const text = "This is a test text to be split into chunks".repeat(2);
    const textSplitter = new TextSplitter({ chunkSize: 20, chunkOverlap: 0 });
    const chunks = await textSplitter.splitText(text);
    expect(chunks.length).toEqual(5);
  });

  test("applies chunk overlap of 20 characters on invalid chunkOverlap", async () => {
    const text = "This is a test text to be split into chunks".repeat(2);
    const textSplitter = new TextSplitter({ chunkSize: 30 });
    const chunks = await textSplitter.splitText(text);
    expect(chunks.length).toEqual(6);
  });

  test("does not allow chunkOverlap to be greater than chunkSize", () => {
    expect(() => new TextSplitter({ chunkSize: 20, chunkOverlap: 21 })).toThrow();
  });

  test("applies specific metadata to stringifyHeader to each chunk", () => {
    const metadata = {
      title: "Example",
      url: "https://example.com",
      published: "2021-01-01",
      chunkSource: "link://https://example.com",
    };
    expect(TextSplitter.buildHeaderMeta(metadata)).toEqual({
      sourceDocument: "Example",
      source: "https://example.com",
      published: "2021-01-01",
    });
  });

  test("applies a valid chunkPrefix to each chunk", async () => {
    const text = "This is a test text to be split into chunks".repeat(2);
    const textSplitter = new TextSplitter({
      chunkSize: 20,
      chunkOverlap: 0,
      chunkPrefix: "testing: ",
    });
    const chunks = await textSplitter.splitText(text);
    expect(chunks.length).toEqual(5);
    expect(chunks.every((chunk) => chunk.startsWith("testing: "))).toBe(true);
  });

  test("repeats the table header on every flat-table chunk", async () => {
    const header = "| 연도 | 직접생산 | 중소기업 OEM |\n| --- | --- | --- |";
    const rows = Array.from(
      { length: 40 },
      (_, index) => `| ${2021 + (index % 5)}년 | 0 | ${index * 1000} |`
    ).join("\n");
    const splitter = new TextSplitter({ chunkSize: 180, chunkOverlap: 20 });
    const { chunks } = await splitter.splitDocument({
      pageContent: `${header}\n${rows}`,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk).toContain(header);
  });

  test("does not treat ordinary pipe text as a table", async () => {
    const text = Array.from(
      { length: 30 },
      (_, index) => `A | B 선택 안내 문장 ${index}입니다.`
    ).join("\n");
    const splitter = new TextSplitter({ chunkSize: 100, chunkOverlap: 10 });
    const { chunks } = await splitter.splitDocument({ pageContent: text });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => !chunk.includes("| --- |"))).toBe(true);
  });
});
