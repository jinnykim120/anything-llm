const { extractLimits } = require("../../utils/extractLimits");

describe("extractLimits", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("applies defaults", () => {
    delete process.env.EXTRACT_LIMITS;
    const l = extractLimits();
    expect(l).toMatchObject({ limited: true, maxDocs: 8, maxChunksPerDoc: 10, maxCalls: 50 });
  });

  it("EXTRACT_LIMITS=off restores the old unlimited behaviour", () => {
    process.env.EXTRACT_LIMITS = "off";
    const l = extractLimits();
    expect(l.limited).toBe(false);
    expect(l.maxDocs).toBe(15);
    expect(l.maxChunksPerDoc).toBe(Infinity);
    expect(l.maxCalls).toBe(Infinity);
  });

  it("individual values can be overridden", () => {
    delete process.env.EXTRACT_LIMITS;
    process.env.EXTRACT_MAX_DOCS = "3";
    process.env.EXTRACT_MAX_CALLS = "7";
    expect(extractLimits()).toMatchObject({ maxDocs: 3, maxCalls: 7 });
  });

  it("ignores invalid values", () => {
    process.env.EXTRACT_MAX_DOCS = "abc";
    expect(extractLimits().maxDocs).toBe(8);
  });
});
