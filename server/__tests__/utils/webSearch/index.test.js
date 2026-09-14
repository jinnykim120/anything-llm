/* eslint-env jest, node */
const { webSearch } = require("../../../utils/webSearch");

// A trimmed but structurally faithful fixture of DuckDuckGo's HTML result
// markup — enough for the block-splitting/regex parsing to exercise real
// paths (redirect-link extraction, HTML-entity decoding, <b> stripping).
function ddgHtmlFixture() {
  const result = (title, ddgHref, snippet) => `<div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <a rel="nofollow" href="${ddgHref}" class="result__a">${title}</a>
      <a class="result__snippet" href="${ddgHref}">${snippet}</a>
    </div>
  </div>`;
  return [
    result(
      "가맹사업법 개정안 &amp; 시행령",
      "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.law.go.kr%2Fexample&rut=abc",
      "가맹사업법 <b>개정</b>안이 국회를 통과했다."
    ),
    result(
      "Example News",
      "https://news.example.com/article",
      "Some &#39;quoted&#39; snippet text."
    ),
  ].join("\n");
}

describe("webSearch (외부검색, DuckDuckGo)", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("returns an empty array for a blank query without calling fetch", async () => {
    global.fetch = jest.fn();
    expect(await webSearch("   ")).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("parses titles, decoded snippets, and resolved redirect URLs from the HTML response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => ddgHtmlFixture(),
    });

    const results = await webSearch("가맹사업법 개정");
    expect(results).toHaveLength(2);

    expect(results[0].title).toBe("가맹사업법 개정안 & 시행령"); // &amp; decoded
    expect(results[0].link).toBe("https://www.law.go.kr/example"); // redirect resolved
    expect(results[0].snippet).toBe("가맹사업법 개정안이 국회를 통과했다."); // <b> stripped

    expect(results[1].title).toBe("Example News");
    expect(results[1].link).toBe("https://news.example.com/article"); // non-redirect link kept as-is
    expect(results[1].snippet).toBe("Some 'quoted' snippet text."); // &#39; decoded
  });

  it("respects the limit option", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => ddgHtmlFixture(),
    });
    const results = await webSearch("query", { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it("returns an empty array (not a throw) when the request fails", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));
    expect(await webSearch("query")).toEqual([]);
  });

  it("returns an empty array when the response is not ok", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503, statusText: "Unavailable" });
    expect(await webSearch("query")).toEqual([]);
  });

  it("returns an empty array when the HTML has no result blocks", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => "<html><body>no results here</body></html>",
    });
    expect(await webSearch("query")).toEqual([]);
  });
});
