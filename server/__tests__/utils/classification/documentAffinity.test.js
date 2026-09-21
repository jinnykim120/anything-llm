jest.mock("../../../utils/prisma", () => ({
  document_affinity: {
    upsert: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  workspace_documents: {
    findMany: jest.fn(),
  },
}));

const prisma = require("../../../utils/prisma");
const {
  recordExplicitCoSelection,
  recordValidatedCitation,
  affinityBoostFor,
  resolveDocIdStrings,
  listForWorkspace,
  deletePair,
  resetForWorkspace,
  decayFactor,
  EXPLICIT_WEIGHT,
  VALIDATED_WEIGHT,
  MIN_OCCURRENCES_TO_RANK,
} = require("../../../utils/classification/documentAffinity");

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// resolveDocIdStrings
// ---------------------------------------------------------------------------
describe("resolveDocIdStrings", () => {
  it("dedups/coerces workspace_documents ids and maps to docId strings", async () => {
    prisma.workspace_documents.findMany.mockResolvedValue([
      { docId: "a" },
      { docId: "b" },
    ]);
    // NaN is dropped by the Number.isFinite filter; note Number(null) === 0,
    // which does pass that filter (a pre-existing quirk, not something this
    // test asserts is desirable — just documenting actual behavior).
    const result = await resolveDocIdStrings([1, "1", 2, NaN, null]);
    expect(prisma.workspace_documents.findMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 2, 0] } },
      select: { docId: true },
    });
    expect(result).toEqual(["a", "b"]);
  });

  it("returns [] for empty input without querying", async () => {
    expect(await resolveDocIdStrings([])).toEqual([]);
    expect(prisma.workspace_documents.findMany).not.toHaveBeenCalled();
  });

  it("filters out falsy docId values", async () => {
    prisma.workspace_documents.findMany.mockResolvedValue([
      { docId: "a" },
      { docId: null },
    ]);
    expect(await resolveDocIdStrings([1, 2])).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// recordExplicitCoSelection
// ---------------------------------------------------------------------------
describe("recordExplicitCoSelection", () => {
  it("resolves workspace_documents ids then upserts the pair at EXPLICIT_WEIGHT", async () => {
    prisma.workspace_documents.findMany.mockResolvedValue([
      { docId: "docA" },
      { docId: "docB" },
    ]);
    prisma.document_affinity.upsert.mockResolvedValue({});

    await recordExplicitCoSelection({
      workspaceId: 7,
      workspaceDocIds: [1, 2],
    });

    expect(prisma.document_affinity.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.document_affinity.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      workspaceId_docIdA_docIdB: {
        workspaceId: 7,
        docIdA: "docA",
        docIdB: "docB",
      },
    });
    expect(call.create.weight).toBe(EXPLICIT_WEIGHT);
    expect(call.update.weight).toEqual({ increment: EXPLICIT_WEIGHT });
  });

  it("no-ops when fewer than 2 distinct docs resolve", async () => {
    prisma.workspace_documents.findMany.mockResolvedValue([
      { docId: "docA" },
    ]);
    await recordExplicitCoSelection({ workspaceId: 7, workspaceDocIds: [1] });
    expect(prisma.document_affinity.upsert).not.toHaveBeenCalled();
  });

  it("swallows a resolve failure and no-ops", async () => {
    prisma.workspace_documents.findMany.mockRejectedValue(
      new Error("db down")
    );
    await expect(
      recordExplicitCoSelection({ workspaceId: 7, workspaceDocIds: [1, 2] })
    ).resolves.toBeUndefined();
    expect(prisma.document_affinity.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// recordValidatedCitation
// ---------------------------------------------------------------------------
describe("recordValidatedCitation", () => {
  it("normalizes the pair so docIdA < docIdB regardless of input order", async () => {
    prisma.document_affinity.upsert.mockResolvedValue({});
    await recordValidatedCitation({ workspaceId: 3, docIds: ["z", "a"] });

    const call = prisma.document_affinity.upsert.mock.calls[0][0];
    expect(call.where.workspaceId_docIdA_docIdB).toEqual({
      workspaceId: 3,
      docIdA: "a",
      docIdB: "z",
    });
    expect(call.create.weight).toBe(VALIDATED_WEIGHT);
  });

  it("dedups repeated docIds into a single pair", async () => {
    prisma.document_affinity.upsert.mockResolvedValue({});
    await recordValidatedCitation({ workspaceId: 3, docIds: ["a", "b", "a"] });
    expect(prisma.document_affinity.upsert).toHaveBeenCalledTimes(1);
  });

  it("no-ops for a single doc or a missing workspaceId", async () => {
    await recordValidatedCitation({ workspaceId: 3, docIds: ["a"] });
    await recordValidatedCitation({ workspaceId: null, docIds: ["a", "b"] });
    expect(prisma.document_affinity.upsert).not.toHaveBeenCalled();
  });

  it("swallows a failed upsert for one pair without throwing", async () => {
    prisma.document_affinity.upsert.mockRejectedValue(
      new Error("constraint")
    );
    await expect(
      recordValidatedCitation({ workspaceId: 3, docIds: ["a", "b"] })
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// decayFactor
// ---------------------------------------------------------------------------
describe("decayFactor", () => {
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z").getTime();

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    Date.now.mockRestore();
  });

  it("is 1 at zero age", () => {
    expect(decayFactor(new Date(FIXED_NOW))).toBeCloseTo(1);
  });

  it("halves at the 45-day half-life", () => {
    const fortyFiveDaysAgo = new Date(FIXED_NOW - 45 * 86400000);
    expect(decayFactor(fortyFiveDaysAgo)).toBeCloseTo(0.5, 5);
  });

  it("clamps negative age (future timestamp) to 1", () => {
    const future = new Date(FIXED_NOW + 86400000);
    expect(decayFactor(future)).toBeCloseTo(1);
  });
});

// ---------------------------------------------------------------------------
// affinityBoostFor
// ---------------------------------------------------------------------------
describe("affinityBoostFor", () => {
  const FIXED_NOW = new Date("2026-01-01T00:00:00Z").getTime();

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    Date.now.mockRestore();
  });

  it("returns an all-zero map without querying when workspaceId is missing", async () => {
    const result = await affinityBoostFor({
      workspaceId: null,
      anchorDocIds: ["a"],
      candidateDocIds: ["b"],
    });
    expect(result.get("b")).toBe(0);
    expect(prisma.document_affinity.findMany).not.toHaveBeenCalled();
  });

  it("excludes anchor docs from the candidate set and queries only cross pairs", async () => {
    prisma.document_affinity.findMany.mockResolvedValue([]);
    await affinityBoostFor({
      workspaceId: 1,
      anchorDocIds: ["a"],
      candidateDocIds: ["a", "b"],
    });
    const query = prisma.document_affinity.findMany.mock.calls[0][0];
    expect(query.where.workspaceId).toBe(1);
    expect(query.where.occurrences).toEqual({ gte: MIN_OCCURRENCES_TO_RANK });
    expect(query.where.OR).toEqual([{ docIdA: "a", docIdB: "b" }]);
  });

  it("normalizes decayed weight into 0..1, capping at 1", async () => {
    prisma.document_affinity.findMany.mockResolvedValue([
      {
        docIdA: "a",
        docIdB: "b",
        weight: EXPLICIT_WEIGHT * 3,
        lastSeenAt: new Date(FIXED_NOW),
      },
    ]);
    const result = await affinityBoostFor({
      workspaceId: 1,
      anchorDocIds: ["a"],
      candidateDocIds: ["b"],
    });
    expect(result.get("b")).toBeCloseTo(1);
  });

  it("applies time decay to the normalized score", async () => {
    prisma.document_affinity.findMany.mockResolvedValue([
      {
        docIdA: "a",
        docIdB: "b",
        weight: EXPLICIT_WEIGHT * 3,
        lastSeenAt: new Date(FIXED_NOW - 45 * 86400000),
      },
    ]);
    const result = await affinityBoostFor({
      workspaceId: 1,
      anchorDocIds: ["a"],
      candidateDocIds: ["b"],
    });
    expect(result.get("b")).toBeCloseTo(0.5, 5);
  });

  it("keeps the strongest anchor pairing per candidate instead of summing", async () => {
    prisma.document_affinity.findMany.mockResolvedValue([
      {
        docIdA: "anchor1",
        docIdB: "cand",
        weight: 1,
        lastSeenAt: new Date(FIXED_NOW),
      },
      {
        docIdA: "anchor2",
        docIdB: "cand",
        weight: EXPLICIT_WEIGHT * 3,
        lastSeenAt: new Date(FIXED_NOW),
      },
    ]);
    const result = await affinityBoostFor({
      workspaceId: 1,
      anchorDocIds: ["anchor1", "anchor2"],
      candidateDocIds: ["cand"],
    });
    expect(result.get("cand")).toBeCloseTo(1);
  });

  it("defaults candidates absent from the query result to 0", async () => {
    prisma.document_affinity.findMany.mockResolvedValue([]);
    const result = await affinityBoostFor({
      workspaceId: 1,
      anchorDocIds: ["a"],
      candidateDocIds: ["b", "c"],
    });
    expect(result.get("b")).toBe(0);
    expect(result.get("c")).toBe(0);
  });

  it("returns a zero-filled map on a query error", async () => {
    prisma.document_affinity.findMany.mockRejectedValue(new Error("db down"));
    const result = await affinityBoostFor({
      workspaceId: 1,
      anchorDocIds: ["a"],
      candidateDocIds: ["b"],
    });
    expect(result.get("b")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listForWorkspace (admin UI)
// ---------------------------------------------------------------------------
describe("listForWorkspace", () => {
  it("annotates rows with decayedWeight and belowRankThreshold", async () => {
    const now = Date.now();
    prisma.document_affinity.findMany.mockResolvedValue([
      { id: 1, weight: 3, occurrences: 1, lastSeenAt: new Date(now) },
      { id: 2, weight: 5, occurrences: 3, lastSeenAt: new Date(now) },
    ]);
    const rows = await listForWorkspace({ workspaceId: 1 });
    expect(rows[0].belowRankThreshold).toBe(true);
    expect(rows[1].belowRankThreshold).toBe(false);
    expect(rows[0].decayedWeight).toBeCloseTo(3);
    expect(prisma.document_affinity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 1 } })
    );
  });

  it("returns [] for a missing workspaceId without querying", async () => {
    expect(await listForWorkspace({ workspaceId: null })).toEqual([]);
    expect(prisma.document_affinity.findMany).not.toHaveBeenCalled();
  });

  it("returns [] on a query error", async () => {
    prisma.document_affinity.findMany.mockRejectedValue(new Error("fail"));
    expect(await listForWorkspace({ workspaceId: 1 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deletePair (admin UI)
// ---------------------------------------------------------------------------
describe("deletePair", () => {
  it("scopes deletion by workspaceId and returns true on removal", async () => {
    prisma.document_affinity.deleteMany.mockResolvedValue({ count: 1 });
    const result = await deletePair({ workspaceId: 5, id: "9" });
    expect(prisma.document_affinity.deleteMany).toHaveBeenCalledWith({
      where: { id: 9, workspaceId: 5 },
    });
    expect(result).toBe(true);
  });

  it("returns false when nothing matched", async () => {
    prisma.document_affinity.deleteMany.mockResolvedValue({ count: 0 });
    expect(await deletePair({ workspaceId: 5, id: 9 })).toBe(false);
  });

  it("returns false for a missing workspaceId or id without querying", async () => {
    expect(await deletePair({ workspaceId: null, id: 9 })).toBe(false);
    expect(await deletePair({ workspaceId: 5, id: null })).toBe(false);
    expect(prisma.document_affinity.deleteMany).not.toHaveBeenCalled();
  });

  it("returns false on a query error", async () => {
    prisma.document_affinity.deleteMany.mockRejectedValue(new Error("fail"));
    expect(await deletePair({ workspaceId: 5, id: 9 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resetForWorkspace (admin UI)
// ---------------------------------------------------------------------------
describe("resetForWorkspace", () => {
  it("deletes all rows for the workspace and returns the count", async () => {
    prisma.document_affinity.deleteMany.mockResolvedValue({ count: 4 });
    const count = await resetForWorkspace({ workspaceId: 5 });
    expect(prisma.document_affinity.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: 5 },
    });
    expect(count).toBe(4);
  });

  it("returns 0 for a missing workspaceId without querying", async () => {
    expect(await resetForWorkspace({ workspaceId: null })).toBe(0);
    expect(prisma.document_affinity.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 0 on a query error", async () => {
    prisma.document_affinity.deleteMany.mockRejectedValue(new Error("fail"));
    expect(await resetForWorkspace({ workspaceId: 5 })).toBe(0);
  });
});
