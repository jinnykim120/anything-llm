jest.mock("../../utils/files/multer", () => ({ handleFileUpload: jest.fn() }));
jest.mock("../../utils/files/parseUploadEphemeral", () => ({
  parseUploadEphemeral: jest.fn(),
}));
jest.mock("../../utils/helpers", () => ({
  getLLMProvider: jest.fn(),
  stripThinkingFromText: (t) => t,
}));
jest.mock("../../utils/docRegen", () => ({
  resolveOwnedArchiveDocs: jest.fn(),
}));
jest.mock("../../utils/classification/folderFilter", () => ({
  resolveFolderDocIds: jest.fn(),
}));
jest.mock("../../utils/prisma", () => ({}));

describe("extractFromDocument limits", () => {
  const { extractFromDocument } = require("../../endpoints/extractData");
  const mk = (resp) => ({
    defaultTemp: 0,
    getChatCompletion: jest.fn().mockResolvedValue({ textResponse: resp }),
  });

  it("caps chunk count by excerpting a long document (not head truncation)", async () => {
    const text = "가".repeat(200000) + " 매출액 9,999 " + "나".repeat(200000);
    const connector = mk('{"values":{"매출액":null}}');
    const out = await extractFromDocument({
      title: "t",
      pageContent: text,
      fields: "매출액",
      LLMConnector: connector,
      limits: { limited: true, maxChunksPerDoc: 3, maxCalls: 100 },
      budget: { calls: 0 },
    });
    expect(out.excerpted).toBe(true);
    expect(connector.getChatCompletion.mock.calls.length).toBeLessThanOrEqual(4);
    const sent = connector.getChatCompletion.mock.calls
      .map((c) => c[0][1].content)
      .join("");
    expect(sent).toContain("9,999");
  });

  it("stops when the shared call budget is exhausted", async () => {
    const connector = mk('{"values":{"매출액":null}}');
    const budget = { calls: 0 };
    const out = await extractFromDocument({
      title: "t",
      pageContent: "가".repeat(50000),
      fields: "매출액",
      LLMConnector: connector,
      limits: { limited: true, maxChunksPerDoc: 100, maxCalls: 2 },
      budget,
    });
    expect(budget.calls).toBe(2);
    expect(out.stoppedByCallCap).toBe(true);
  });

  it("unlimited mode (EXTRACT_LIMITS=off shape) reads every chunk", async () => {
    const connector = mk('{"values":{"매출액":null}}');
    await extractFromDocument({
      title: "t",
      pageContent: "가".repeat(50000),
      fields: "매출액",
      LLMConnector: connector,
      limits: { limited: false, maxChunksPerDoc: Infinity, maxCalls: Infinity },
      budget: { calls: 0 },
    });
    expect(connector.getChatCompletion).toHaveBeenCalledTimes(5);
  });
});
