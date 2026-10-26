// [NEXUS 폴더 잠금] 폴더 비밀번호·관리자 엔드포인트.
//
//   GET  /nexus/access                         내 상태 (clientId 유효 여부, 관리자 여부, 관리자 기능 사용 가능 여부)
//   GET  /nexus/folders                        폴더 목록 — 잠긴 폴더도 이름·잠금 표시는 보인다 (내용은 안 보임)
//   POST /nexus/folders/:name/unlock           {password} 비밀번호로 열기 (이 브라우저에서만)
//   POST /nexus/folders/:name/lock             이 브라우저에서 다시 잠그기
//   POST /nexus/folders/:name/password         {currentPassword,newPassword} 비밀번호 변경 (아는 사람 누구나)
//   POST /nexus/folders/:name/remove-lock      {currentPassword} 잠금 해제(공개로 전환)
//   POST /nexus/admin/login                    {password} 관리자 로그인 (NEXUS_ADMIN_PASSWORD)
//   POST /nexus/admin/logout
//   POST /nexus/folders/:name/admin-reset      관리자 전용 {newPassword?} 비밀번호 초기화 (비우면 잠금 해제)
const fs = require("fs");
const path = require("path");
const { reqBody } = require("../utils/http");
const { documentsPath } = require("../utils/files");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const FA = require("../utils/folderAccess");

const REASON_MESSAGE = {
  "bad-password": "비밀번호가 맞지 않습니다.",
  blocked: "시도 횟수를 초과했습니다. 10분 뒤에 다시 시도하세요.",
  "no-lock": "잠긴 폴더가 아닙니다.",
  "no-client": "브라우저 식별 정보가 없습니다. 페이지를 새로고침하세요.",
  "weak-password": "비밀번호는 4자 이상이어야 합니다.",
  disabled: "관리자 기능이 설정되지 않았습니다 (NEXUS_ADMIN_PASSWORD).",
};

const fail = (response, status, reason) =>
  response.status(status).json({
    success: false,
    reason,
    message: REASON_MESSAGE[reason] || reason,
  });

/** 문서 폴더 디렉터리 이름들 (originals 등 내부용 제외). */
function diskFolders() {
  try {
    return fs
      .readdirSync(documentsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "originals")
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function folderLockEndpoints(app) {
  if (!app) return;

  app.get("/nexus/access", [validatedRequest], async (_request, response) => {
    const scope = response.locals.nexusScope;
    response.json({
      clientValid: !!scope?.clientId,
      isAdmin: !!scope?.isAdmin,
      adminEnabled: FA.adminEnabled(),
    });
  });

  app.get("/nexus/folders", [validatedRequest], async (_request, response) => {
    try {
      const scope = response.locals.nexusScope;
      const locked = new Set((await FA.listFolderLocks()).map((l) => l.folder));
      const names = [...new Set([...diskFolders(), ...locked])].sort();
      response.json({
        folders: names.map((name) => ({
          name,
          locked: locked.has(name),
          open: !locked.has(name) || FA.canAccessFolder(scope, name),
        })),
        isAdmin: !!scope?.isAdmin,
      });
    } catch (e) {
      console.error(e);
      response.sendStatus(500);
    }
  });

  app.post(
    "/nexus/folders/:name/unlock",
    [validatedRequest],
    async (request, response) => {
      const scope = response.locals.nexusScope;
      const r = await FA.unlockFolder({
        clientId: scope?.clientId,
        folder: request.params.name,
        password: reqBody(request).password,
        ip: request.ip,
      });
      if (!r.ok)
        return fail(response, r.reason === "blocked" ? 429 : 403, r.reason);
      response.json({ success: true });
    }
  );

  app.post(
    "/nexus/folders/:name/lock",
    [validatedRequest],
    async (request, response) => {
      const scope = response.locals.nexusScope;
      await FA.relockFolder({
        clientId: scope?.clientId,
        folder: request.params.name,
      });
      response.json({ success: true });
    }
  );

  app.post(
    "/nexus/folders/:name/password",
    [validatedRequest],
    async (request, response) => {
      const scope = response.locals.nexusScope;
      const { currentPassword, newPassword } = reqBody(request);
      if (!newPassword) return fail(response, 400, "weak-password");
      const r = await FA.changeLock({
        folder: request.params.name,
        currentPassword,
        newPassword,
        ip: request.ip,
        clientId: scope?.clientId,
      });
      if (!r.ok)
        return fail(response, r.reason === "blocked" ? 429 : 403, r.reason);
      // 바꾼 사람은 새 비밀번호로 계속 열려 있게 한다.
      if (scope?.clientId)
        await FA.unlockFolder({
          clientId: scope.clientId,
          folder: request.params.name,
          password: newPassword,
          ip: request.ip,
        });
      response.json({ success: true });
    }
  );

  app.post(
    "/nexus/folders/:name/remove-lock",
    [validatedRequest],
    async (request, response) => {
      const scope = response.locals.nexusScope;
      const r = await FA.changeLock({
        folder: request.params.name,
        currentPassword: reqBody(request).currentPassword,
        newPassword: null,
        ip: request.ip,
        clientId: scope?.clientId,
      });
      if (!r.ok)
        return fail(response, r.reason === "blocked" ? 429 : 403, r.reason);
      response.json({ success: true });
    }
  );

  app.post(
    "/nexus/admin/login",
    [validatedRequest],
    async (request, response) => {
      const scope = response.locals.nexusScope;
      const r = await FA.adminLogin({
        clientId: scope?.clientId,
        password: reqBody(request).password,
        ip: request.ip,
      });
      if (!r.ok)
        return fail(response, r.reason === "blocked" ? 429 : 403, r.reason);
      response.json({ success: true });
    }
  );

  app.post(
    "/nexus/admin/logout",
    [validatedRequest],
    async (_request, response) => {
      await FA.adminLogout(response.locals.nexusScope?.clientId);
      response.json({ success: true });
    }
  );

  app.post(
    "/nexus/folders/:name/admin-reset",
    [validatedRequest],
    async (request, response) => {
      const scope = response.locals.nexusScope;
      if (!scope?.isAdmin)
        return fail(response, 403, "관리자만 할 수 있습니다.");
      const { newPassword } = reqBody(request);
      const r = await FA.changeLock({
        folder: request.params.name,
        newPassword: newPassword || null,
        asAdmin: true,
      });
      if (!r.ok) return fail(response, 400, r.reason);
      response.json({ success: true });
    }
  );
}

module.exports = { folderLockEndpoints, diskFolders };
