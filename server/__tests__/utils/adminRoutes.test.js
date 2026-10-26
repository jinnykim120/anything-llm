// [NEXUS 관리자 콘솔] 어떤 경로가 관리자 전용인지, 일반 사용자의 평소 경로는 막히지 않는지.
jest.mock("../../utils/prisma", () => ({}));
const {
  isAdminOnly,
  consoleGuard,
} = require("../../utils/folderAccess/adminRoutes");
const FA = require("../../utils/folderAccess");

describe("isAdminOnly", () => {
  const adminOnly = [
    ["GET", "/admin/users"],
    ["POST", "/system/update-env"],
    ["GET", "/system/api-keys"],
    ["POST", "/system/generate-api-key"],
    ["DELETE", "/system/api-key/3"],
    ["POST", "/system/workspace-chats"],
    ["DELETE", "/system/event-logs"],
    ["POST", "/system/default-system-prompt"],
    ["PUT", "/system/prompt-variables/4"],
    ["GET", "/embeds"],
    ["DELETE", "/embed/abc"],
    ["POST", "/embed/update/abc"],
    ["POST", "/experimental/toggle-live-sync"],
    ["GET", "/scheduled-jobs"],
    ["POST", "/telegram/connect"],
    ["GET", "/model-routers/2"],
    ["GET", "/usage-log/summary"],
    ["GET", "/workspace/archive-full/affinity"],
    ["DELETE", "/workspace/archive-full/affinity/5"],
    ["POST", "/workspace/new"],
    ["DELETE", "/workspace/archive-full"],
    ["DELETE", "/workspace/archive-full/reset-vector-db"],
    ["GET", "/nexus/admin/chats"],
    ["GET", "/nexus/admin/overview"],
    ["POST", "/nexus/admin/folders/x/lock"],
    ["POST", "/nexus/folders/x/admin-reset"],
  ];
  it.each(adminOnly)("%s %s is admin-only", (method, path) => {
    expect(isAdminOnly(method, path)).toBe(true);
  });

  const normalUse = [
    ["GET", "/ping"],
    ["GET", "/workspaces"],
    ["GET", "/workspace/archive-full"],
    ["POST", "/workspace/archive-full/update"], // 검색 방식 전환·모델 선택이 쓴다
    ["POST", "/workspace/archive-full/stream-chat"],
    ["POST", "/workspace/archive-full/thread/new"],
    ["DELETE", "/workspace/archive-full/thread/abc"],
    ["POST", "/workspace/archive-full/upload-and-embed"],
    ["POST", "/workspace/archive-full/update-embeddings"],
    ["POST", "/workspace/archive-full/extract-data/run"],
    ["POST", "/workspace/archive-full/affinity/record-validated"],
    ["GET", "/system/local-files"],
    ["DELETE", "/system/remove-folder"],
    ["GET", "/system/default-system-prompt"],
    ["GET", "/system/prompt-variables"],
    ["POST", "/embed/abc/stream-chat"], // 외부 임베드 위젯은 공개
    ["GET", "/classification/documents"],
    ["POST", "/classification/summary"],
    ["DELETE", "/classification/taxonomy/axis"],
    ["GET", "/nexus/folders"],
    ["POST", "/nexus/folders/x/unlock"],
    ["POST", "/nexus/admin/login"],
    ["POST", "/nexus/admin/logout"],
    ["GET", "/document/raw/abc"],
    ["POST", "/document/create-folder"],
  ];
  it.each(normalUse)("%s %s stays open to normal users", (method, path) => {
    expect(isAdminOnly(method, path)).toBe(false);
  });
});

describe("consoleGuard", () => {
  const run = (method, path, scope) => {
    const res = {
      locals: { nexusScope: scope },
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(b) {
        this.body = b;
        return this;
      },
    };
    let nexted = false;
    consoleGuard({ method, path }, res, () => (nexted = true));
    return { nexted, res };
  };

  afterEach(() => delete process.env.NEXUS_ADMIN_PASSWORD);

  it("lets everything through when no admin password is configured", () => {
    expect(FA.adminEnabled()).toBe(false);
    expect(run("GET", "/admin/users", { isAdmin: false }).nexted).toBe(true);
  });

  it("blocks admin-only paths unless the request carries admin power", () => {
    process.env.NEXUS_ADMIN_PASSWORD = "pw";
    const blocked = run("GET", "/admin/users", {
      isAdmin: false,
      adminAuthed: true,
    });
    expect(blocked.nexted).toBe(false);
    expect(blocked.res.statusCode).toBe(403);
    expect(blocked.res.body.needsAdmin).toBe(true);
    expect(blocked.res.body.adminAuthed).toBe(true);
    expect(run("GET", "/admin/users", { isAdmin: true }).nexted).toBe(true);
  });

  it("never blocks normal paths or CORS preflight", () => {
    process.env.NEXUS_ADMIN_PASSWORD = "pw";
    expect(
      run("POST", "/workspace/a/stream-chat", { isAdmin: false }).nexted
    ).toBe(true);
    expect(run("OPTIONS", "/admin/users", { isAdmin: false }).nexted).toBe(
      true
    );
  });
});
