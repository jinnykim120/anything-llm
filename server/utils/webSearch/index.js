// [auto-docu 외부검색] Standalone web-search helper for the archive chat's
// "내부 + 외부 자료" mode. Extracted from the agent skill's DuckDuckGo engine
// (utils/agents/aibitat/plugins/web-browsing.js) so normal RAG chat can use
// the same no-API-key search without going through the agent (tool-calling)
// framework — that framework decides autonomously whether to call a tool;
// this feature needs a search that always runs when the user opts in.
//
// DuckDuckGo's HTML endpoint is scraped, not an official API — free and
// keyless, but can be flakier than a paid provider. Swap the body of
// webSearch() for one of web-browsing.js's other engines (Bing/Brave/
// Tavily/etc, all already implemented there) if/when an API key is
// available — the {title, link, snippet} shape is all downstream code
// (server/utils/chats/stream.js, the citation UI) depends on.

/** Extract the actual destination URL from a DuckDuckGo redirect link. */
function extractUrl(ddgLink) {
  if (!ddgLink) return ddgLink;
  try {
    const fullUrl = ddgLink.startsWith("//") ? `https:${ddgLink}` : ddgLink;
    const url = new URL(fullUrl);
    const actualUrl = url.searchParams.get("uddg");
    return actualUrl ? decodeURIComponent(actualUrl) : ddgLink;
  } catch {
    return ddgLink;
  }
}

function decodeHtmlEntities(str = "") {
  return String(str)
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
}

/**
 * Free, keyless web search via DuckDuckGo's HTML endpoint.
 * @param {string} query
 * @param {{limit?: number}} [opts]
 * @returns {Promise<{title:string, link:string, snippet:string}[]>}
 */
async function webSearch(query, { limit = 5 } = {}) {
  if (!query?.trim()) return [];

  const searchURL = new URL("https://html.duckduckgo.com/html");
  searchURL.searchParams.append("q", query);

  let html;
  try {
    const res = await fetch(searchURL.toString());
    if (!res.ok) throw new Error(`${res.status} - ${res.statusText}`);
    html = await res.text();
  } catch (e) {
    console.error("[webSearch] DuckDuckGo request failed:", e.message);
    return [];
  }

  const results = [];
  const blocks = html.split('<div class="result results_links');
  // Skip index 0 — it's everything before the first result. Anchor
  // attributes aren't matched in a fixed order here on purpose (a lookahead
  // for the class + an independent href capture) — DDG's markup order isn't
  // a stable contract, and a regex that assumes one order is exactly the
  // kind of thing that silently breaks when their HTML changes.
  for (let i = 1; i < blocks.length && results.length < limit; i++) {
    const block = blocks[i];
    const anchorMatch = block.match(
      /<a(?=[^>]*\bclass="result__a")[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/
    );
    const link = extractUrl(anchorMatch ? anchorMatch[1] : "");
    const title = anchorMatch
      ? decodeHtmlEntities(anchorMatch[2].replace(/<\/?b>/g, "")).trim()
      : "";
    const snippetMatch = block.match(
      /<a(?=[^>]*\bclass="result__snippet")[^>]*>([\s\S]*?)<\/a>/
    );
    const snippet = snippetMatch
      ? decodeHtmlEntities(snippetMatch[1].replace(/<\/?b>/g, "")).trim()
      : "";
    if (title && link && snippet) results.push({ title, link, snippet });
  }
  return results;
}

module.exports = { webSearch };
