// 민감도 규칙: 잠긴 폴더에 있는 문서만 confidential, 나머지(문서가 없는 기록 포함)는 general.
const mockDb = { docs: [], locks: [], cls: [] };
const mockUpdates = [];
jest.mock("../../utils/prisma", () => ({
  workspace_documents: { findMany: async () => mockDb.docs },
  folder_locks: {
    findMany: async () => mockDb.locks.map((folder) => ({ folder })),
  },
  document_classifications: {
    findMany: async ({ where } = {}) =>
      mockDb.cls.filter(
        (c) => !where || where.contentHash.in.includes(c.contentHash)
      ),
    updateMany: async ({ where, data }) => {
      mockDb.cls.forEach((c) => {
        if (where.contentHash.in.includes(c.contentHash))
          Object.assign(c, data);
      });
      mockUpdates.push({ where, data });
    },
    update: async ({ where, data }) => {
      Object.assign(
        mockDb.cls.find((c) => c.contentHash === where.contentHash),
        data
      );
    },
  },
}));

const Rule = require("../../utils/classification/sensitivityRule");

const doc = (docpath, hash) => ({
  docpath,
  metadata: JSON.stringify({ content_hash: hash }),
});

beforeEach(() => {
  mockUpdates.length = 0;
  mockDb.docs = [
    doc("custom-documents/a.json", "h-public"),
    doc("비공개/b.json", "h-locked"),
    doc("custom-documents/c.json", "h-dup"),
    doc("비공개/c2.json", "h-dup"), // 같은 내용이 공개·잠금 양쪽에 있음
  ];
  mockDb.locks = ["비공개"];
  mockDb.cls = [
    { contentHash: "h-public", sensitivity: "confidential" },
    { contentHash: "h-locked", sensitivity: "general" },
    { contentHash: "h-dup", sensitivity: "general" },
    { contentHash: "h-gone", sensitivity: "confidential" }, // 문서는 이미 없음
    { contentHash: "h-unc", sensitivity: "uncertain" },
  ];
});

describe("targetFor / sensitivityForHash", () => {
  it("is confidential only when a copy sits in a locked folder", async () => {
    expect(await Rule.sensitivityForHash("h-locked")).toBe("confidential");
    expect(await Rule.sensitivityForHash("h-dup")).toBe("confidential");
    expect(await Rule.sensitivityForHash("h-public")).toBe("general");
    expect(await Rule.sensitivityForHash("h-never-seen")).toBe("general");
  });
  it("matches a lock written as NFD against NFC document paths", async () => {
    mockDb.locks = ["비공개".normalize("NFD")];
    expect(await Rule.sensitivityForHash("h-locked")).toBe("confidential");
  });
});

describe("syncAll", () => {
  it("previews without writing", async () => {
    const r = await Rule.syncAll({ dryRun: true });
    expect(r).toMatchObject({
      total: 5,
      changed: 5,
      toGeneral: 3,
      toConfidential: 2,
    });
    expect(mockUpdates).toHaveLength(0);
    expect(mockDb.cls[0].sensitivity).toBe("confidential");
  });

  it("sets everything to general except locked-folder documents", async () => {
    const r = await Rule.syncAll();
    expect(r.changed).toBe(5);
    expect(r.orphanChanged).toBe(2); // h-gone, h-unc 는 문서가 없다
    const by = Object.fromEntries(
      mockDb.cls.map((c) => [c.contentHash, c.sensitivity])
    );
    expect(by).toEqual({
      "h-public": "general",
      "h-locked": "confidential",
      "h-dup": "confidential",
      "h-gone": "general",
      "h-unc": "general",
    });
  });

  it("is idempotent", async () => {
    await Rule.syncAll();
    mockUpdates.length = 0;
    expect((await Rule.syncAll()).changed).toBe(0);
  });
});

describe("syncFolder", () => {
  it("re-labels documents of a folder that just got locked", async () => {
    mockDb.locks = [];
    mockDb.cls = [{ contentHash: "h-locked", sensitivity: "general" }];
    mockDb.locks = ["비공개"];
    const r = await Rule.syncFolder("비공개");
    expect(r.changed).toBe(1);
    expect(mockDb.cls[0].sensitivity).toBe("confidential");
  });
  it("returns documents of a folder whose lock was removed to general", async () => {
    mockDb.locks = [];
    mockDb.cls = [{ contentHash: "h-locked", sensitivity: "confidential" }];
    await Rule.syncFolder("비공개");
    expect(mockDb.cls[0].sensitivity).toBe("general");
  });
});
