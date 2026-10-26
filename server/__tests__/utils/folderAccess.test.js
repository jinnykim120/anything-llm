// [NEXUS 폴더 잠금] 접근 범위 계산·비밀번호·시도 제한 단위 테스트 (DB 는 메모리 목으로 대체).
const mockDb = {
  locks: [],
  unlocks: [],
  admins: [],
  docs: [],
};

jest.mock("../../utils/prisma", () => ({
  folder_locks: {
    findMany: async () => mockDb.locks.map((l) => ({ folder: l.folder })),
    findUnique: async ({ where }) =>
      mockDb.locks.find((l) => l.folder === where.folder) || null,
    create: async ({ data }) => {
      mockDb.locks.push({ ...data });
      return data;
    },
    update: async ({ where, data }) => {
      Object.assign(
        mockDb.locks.find((l) => l.folder === where.folder),
        data
      );
    },
    delete: async ({ where }) => {
      mockDb.locks = mockDb.locks.filter((l) => l.folder !== where.folder);
    },
  },
  folder_unlocks: {
    findMany: async ({ where }) =>
      mockDb.unlocks.filter(
        (u) => u.clientId === where.clientId && u.expiresAt > where.expiresAt.gt
      ),
    upsert: async ({ where, update, create }) => {
      const { clientId, folder } = where.clientId_folder;
      const row = mockDb.unlocks.find(
        (u) => u.clientId === clientId && u.folder === folder
      );
      if (row) Object.assign(row, update);
      else mockDb.unlocks.push({ ...create });
    },
    deleteMany: async ({ where }) => {
      mockDb.unlocks = mockDb.unlocks.filter(
        (u) =>
          !(
            (where.clientId === undefined || u.clientId === where.clientId) &&
            (where.folder === undefined || u.folder === where.folder)
          )
      );
    },
  },
  access_admins: {
    findFirst: async ({ where }) =>
      mockDb.admins.find(
        (a) => a.clientId === where.clientId && a.expiresAt > where.expiresAt.gt
      ) || null,
    upsert: async ({ where, update, create }) => {
      const row = mockDb.admins.find((a) => a.clientId === where.clientId);
      if (row) Object.assign(row, update);
      else mockDb.admins.push({ ...create });
    },
    deleteMany: async ({ where }) => {
      mockDb.admins = mockDb.admins.filter(
        (a) => a.clientId !== where.clientId
      );
    },
  },
  workspace_documents: {
    findMany: async ({ where } = {}) =>
      mockDb.docs.filter(
        (d) =>
          !where ||
          where.OR.some((c) =>
            c.docpath
              ? d.docpath.startsWith(c.docpath.startsWith)
              : c.docId
                ? c.docId.in.includes(d.docId)
                : c.id.in.includes(d.id)
          )
      ),
  },
}));

const FA = require("../../utils/folderAccess");

const CLIENT_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const CLIENT_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

beforeEach(() => {
  mockDb.locks = [];
  mockDb.unlocks = [];
  mockDb.admins = [];
  mockDb.docs = [
    { id: 1, docId: "d-secret", docpath: "비공개/a.json" },
    { id: 2, docId: "d-win", docpath: "비공개\\b.json" },
    { id: 3, docId: "d-open", docpath: "custom-documents/c.json" },
    { id: 4, docId: "d-other", docpath: "다른잠금/z.json" },
  ];
  FA._resetAttempts();
  delete process.env.NEXUS_ADMIN_PASSWORD;
});

describe("folderOfDocpath / normalizeFolderName", () => {
  it("takes the first path segment, tolerating Windows backslashes", () => {
    expect(FA.folderOfDocpath("실적/x.json")).toBe("실적");
    expect(FA.folderOfDocpath("실적\\x.json")).toBe("실적");
    expect(FA.folderOfDocpath("/실적/sub/x.json")).toBe("실적");
    expect(FA.folderOfDocpath("x.json")).toBe("");
  });
  it("rejects nested or traversal folder names", () => {
    expect(FA.normalizeFolderName("a/b")).toBeNull();
    expect(FA.normalizeFolderName("..")).toBeNull();
    expect(FA.normalizeFolderName("  ")).toBeNull();
    expect(FA.normalizeFolderName("/실적/")).toBe("실적");
  });
});

describe("password hashing", () => {
  it("verifies the right password and rejects wrong/garbage ones", () => {
    const h = FA.hashPassword("s3cret!");
    expect(h).not.toContain("s3cret!");
    expect(FA.verifyPassword("s3cret!", h)).toBe(true);
    expect(FA.verifyPassword("wrong", h)).toBe(false);
    expect(FA.verifyPassword("x", "garbage")).toBe(false);
    expect(FA.verifyPassword("x", null)).toBe(false);
  });
  it("uses a per-hash salt", () => {
    expect(FA.hashPassword("same")).not.toBe(FA.hashPassword("same"));
  });
});

describe("scope + folder lifecycle", () => {
  it("creator is unlocked, others are not; docs of locked folders are denied", async () => {
    await FA.createLock({
      folder: "비공개",
      password: "pw1234",
      clientId: CLIENT_A,
    });
    const a = await FA.buildScope(CLIENT_A);
    const b = await FA.buildScope(CLIENT_B);
    expect(await FA.deniedDocIds(a)).toEqual([]);
    expect((await FA.deniedDocIds(b)).sort()).toEqual(["d-secret", "d-win"]);
    expect(await FA.canAccessDocpath("비공개/a.json", b)).toBe(false);
    expect(await FA.canAccessDocpath("custom-documents/c.json", b)).toBe(true);
    expect(
      await FA.filterDocpaths(["비공개/a.json", "custom-documents/c.json"], b)
    ).toEqual(["custom-documents/c.json"]);
  });

  it("unlock with the right password widens only that client's scope", async () => {
    await FA.createLock({
      folder: "비공개",
      password: "pw1234",
      clientId: CLIENT_A,
    });
    expect(
      (
        await FA.unlockFolder({
          clientId: CLIENT_B,
          folder: "비공개",
          password: "no",
        })
      ).reason
    ).toBe("bad-password");
    expect(
      (
        await FA.unlockFolder({
          clientId: CLIENT_B,
          folder: "비공개",
          password: "pw1234",
        })
      ).ok
    ).toBe(true);
    expect(await FA.deniedDocIds(await FA.buildScope(CLIENT_B))).toEqual([]);
    await FA.relockFolder({ clientId: CLIENT_B, folder: "비공개" });
    expect((await FA.deniedDocIds(await FA.buildScope(CLIENT_B))).length).toBe(
      2
    );
  });

  it("unknown scope (outside a request) sees only public folders", async () => {
    await FA.createLock({ folder: "비공개", password: "pw1234" });
    expect(FA.currentScope()).toBeNull();
    expect(await FA.canAccessDocpath("비공개/a.json")).toBe(false);
    expect(await FA.canAccessDocpath("custom-documents/c.json")).toBe(true);
    expect((await FA.deniedDocIds()).sort()).toEqual(["d-secret", "d-win"]);
  });

  it("rate-limits brute force after 5 wrong attempts, even with the right password", async () => {
    await FA.createLock({ folder: "비공개", password: "pw1234" });
    for (let i = 0; i < 5; i++)
      await FA.unlockFolder({
        clientId: CLIENT_B,
        folder: "비공개",
        password: "x",
      });
    const r = await FA.unlockFolder({
      clientId: CLIENT_B,
      folder: "비공개",
      password: "pw1234",
    });
    expect(r).toEqual({ ok: false, reason: "blocked" });
  });

  it("changing the password re-locks everyone who had it open", async () => {
    await FA.createLock({
      folder: "비공개",
      password: "pw1234",
      clientId: CLIENT_A,
    });
    const bad = await FA.changeLock({
      folder: "비공개",
      currentPassword: "no",
      newPassword: "newpw99",
      clientId: CLIENT_A,
    });
    expect(bad.reason).toBe("bad-password");
    const ok = await FA.changeLock({
      folder: "비공개",
      currentPassword: "pw1234",
      newPassword: "newpw99",
      clientId: CLIENT_A,
    });
    expect(ok.ok).toBe(true);
    expect((await FA.deniedDocIds(await FA.buildScope(CLIENT_A))).length).toBe(
      2
    );
    expect(
      (
        await FA.unlockFolder({
          clientId: CLIENT_A,
          folder: "비공개",
          password: "newpw99",
        })
      ).ok
    ).toBe(true);
  });

  it("removing the lock makes the folder public", async () => {
    await FA.createLock({ folder: "비공개", password: "pw1234" });
    const r = await FA.changeLock({ folder: "비공개", asAdmin: true });
    expect(r.ok).toBe(true);
    expect(await FA.deniedDocIds(await FA.buildScope(CLIENT_B))).toEqual([]);
  });

  it("rejects weak passwords and duplicate locks", async () => {
    await expect(
      FA.createLock({ folder: "비공개", password: "ab" })
    ).rejects.toThrow();
    await FA.createLock({ folder: "비공개", password: "pw1234" });
    await expect(
      FA.createLock({ folder: "비공개", password: "pw1234" })
    ).rejects.toThrow();
  });
});

describe("admin", () => {
  it("is disabled without NEXUS_ADMIN_PASSWORD", async () => {
    expect(
      (await FA.adminLogin({ clientId: CLIENT_A, password: "x" })).reason
    ).toBe("disabled");
  });

  it("wrong password does not log in; right one does", async () => {
    process.env.NEXUS_ADMIN_PASSWORD = "root-pw";
    expect(
      (await FA.adminLogin({ clientId: CLIENT_B, password: "nope" })).ok
    ).toBe(false);
    expect(
      (await FA.adminLogin({ clientId: CLIENT_B, password: "root-pw" })).ok
    ).toBe(true);
  });

  it("an admin browser acts as a normal user outside the console", async () => {
    process.env.NEXUS_ADMIN_PASSWORD = "root-pw";
    await FA.createLock({ folder: "비공개", password: "pw1234" });
    await FA.adminLogin({ clientId: CLIENT_B, password: "root-pw" });
    const normal = await FA.buildScope(CLIENT_B);
    expect(normal.adminAuthed).toBe(true);
    expect(normal.isAdmin).toBe(false);
    expect((await FA.deniedDocIds(normal)).sort()).toEqual([
      "d-secret",
      "d-win",
    ]);
    expect(await FA.canAccessDocpath("비공개/a.json", normal)).toBe(false);
  });

  it("sees everything in console mode, and only after logging in", async () => {
    process.env.NEXUS_ADMIN_PASSWORD = "root-pw";
    await FA.createLock({ folder: "비공개", password: "pw1234" });
    const before = await FA.buildScope(CLIENT_B, { consoleMode: true });
    expect(before.isAdmin).toBe(false); // 콘솔 헤더만으로는 권한이 생기지 않는다
    await FA.adminLogin({ clientId: CLIENT_B, password: "root-pw" });
    const s = await FA.buildScope(CLIENT_B, { consoleMode: true });
    expect(s.isAdmin).toBe(true);
    expect(await FA.deniedDocIds(s)).toEqual([]);
    expect(await FA.canAccessDocpath("비공개/a.json", s)).toBe(true);
    await FA.adminLogout(CLIENT_B);
    expect((await FA.buildScope(CLIENT_B, { consoleMode: true })).isAdmin).toBe(
      false
    );
  });
});

describe("restrictionForSources (생성 문서 잠금 상속)", () => {
  async function scopeOf(clientId) {
    return FA.buildScope(clientId);
  }

  it("keeps the result public when no source sits in a locked folder", async () => {
    await FA.createLock({ folder: "비공개", password: "pw1234" });
    const r = await FA.restrictionForSources({
      workspaceId: 1,
      sourceDocIds: ["d-open"],
      scope: await scopeOf(CLIENT_B),
    });
    expect(r).toEqual({ folder: null, skip: false });
  });

  it("stores the result in the single locked folder the sources came from", async () => {
    await FA.createLock({
      folder: "비공개",
      password: "pw1234",
      clientId: CLIENT_A,
    });
    const r = await FA.restrictionForSources({
      workspaceId: 1,
      sourceDocIds: ["d-secret", 3],
      scope: await scopeOf(CLIENT_A),
    });
    expect(r).toEqual({ folder: "비공개", skip: false });
  });

  it("skips archiving when sources mix two different locked folders", async () => {
    await FA.createLock({
      folder: "비공개",
      password: "pw1234",
      clientId: CLIENT_A,
    });
    await FA.createLock({
      folder: "다른잠금",
      password: "pw5678",
      clientId: CLIENT_A,
    });
    const r = await FA.restrictionForSources({
      workspaceId: 1,
      sourceDocIds: ["d-secret", "d-other"],
      scope: await scopeOf(CLIENT_A),
    });
    expect(r.skip).toBe(true);
  });

  it("skips when the caller cannot access the locked source folder", async () => {
    await FA.createLock({
      folder: "비공개",
      password: "pw1234",
      clientId: CLIENT_A,
    });
    const r = await FA.restrictionForSources({
      workspaceId: 1,
      sourceDocIds: ["d-secret"],
      scope: await scopeOf(CLIENT_B),
    });
    expect(r.skip).toBe(true);
  });

  it("skips when sources are unknown but the caller has a locked folder open", async () => {
    await FA.createLock({
      folder: "비공개",
      password: "pw1234",
      clientId: CLIENT_A,
    });
    const open = await FA.restrictionForSources({
      workspaceId: 1,
      sourceDocIds: [],
      scope: await scopeOf(CLIENT_A),
    });
    expect(open.skip).toBe(true);
    const none = await FA.restrictionForSources({
      workspaceId: 1,
      sourceDocIds: [],
      scope: await scopeOf(CLIENT_B),
    });
    expect(none).toEqual({ folder: null, skip: false });
  });
});

describe("한글 폴더 이름의 유니코드 표기 (NFC/NFD)", () => {
  const NFC = "실적".normalize("NFC");
  const NFD = "실적".normalize("NFD");

  it("sanity: the two spellings differ as strings", () => {
    expect(NFC).not.toBe(NFD);
  });

  it("a lock created with the NFD name still protects NFC docpaths", async () => {
    mockDb.docs.push({ id: 9, docId: "d-job", docpath: `${NFC}/a.json` });
    await FA.createLock({
      folder: NFD,
      password: "pw1234",
      clientId: CLIENT_A,
    });
    expect(FA.folderOfDocpath(`${NFC}/a.json`)).toBe(
      FA.folderOfDocpath(`${NFD}/a.json`)
    );
    const b = await FA.buildScope(CLIENT_B);
    expect(await FA.deniedDocIds(b)).toContain("d-job");
    expect(await FA.canAccessDocpath(`${NFC}/a.json`, b)).toBe(false);
    expect(await FA.canAccessDocpath(`${NFD}/a.json`, b)).toBe(false);
  });

  it("unlocking with either spelling opens the folder", async () => {
    mockDb.docs.push({ id: 9, docId: "d-job", docpath: `${NFC}/a.json` });
    await FA.createLock({
      folder: NFC,
      password: "pw1234",
      clientId: CLIENT_A,
    });
    const r = await FA.unlockFolder({
      clientId: CLIENT_B,
      folder: NFD,
      password: "pw1234",
    });
    expect(r.ok).toBe(true);
    const b = await FA.buildScope(CLIENT_B);
    expect(await FA.deniedDocIds(b)).not.toContain("d-job");
    expect(FA.canAccessFolder(b, NFD)).toBe(true);
  });
});
