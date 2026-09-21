const { featureForPath } = require("../../utils/usageLog");

describe("featureForPath", () => {
  it.each([
    ["/api/workspace/x/extract-data/run", "extract-data"],
    ["/api/workspace/x/stats/analyze", "stats"],
    ["/api/workspace/x/ppt-draft", "ppt-draft"],
    ["/api/workspace/x/draft/revise-block", "draft-revise"],
    ["/api/workspace/x/draft", "draft"],
    ["/api/workspace/x/doc-regen/stream", "doc-regen"],
    ["/api/workspace/x/stream-chat", "chat"],
    ["/api/system/ping", "other"],
  ])("%s -> %s", (url, expected) => {
    expect(featureForPath(url)).toBe(expected);
  });
});
