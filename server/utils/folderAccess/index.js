// [NEXUS 폴더 잠금] 폴더(= docpath 의 첫 구간) 단위 비밀번호 접근 제어.
//
// 로그인 없이 쓰는 시스템이라 "사용자"는 브라우저가 만든 임의의 클라이언트 ID
// (X-Nexus-Client 헤더)다. 요청마다 접근 범위(scope)를 한 번 계산해
// AsyncLocalStorage 에 두고, 검색·문서 읽기 경로는 전부 이 범위만 본다.
//
//   접근 범위 = 공개 폴더(잠금 행 없음) + 이 클라이언트가 비밀번호로 연 폴더
//               (관리자 로그인한 클라이언트는 전부)
//
// 원칙: 범위를 알 수 없으면(요청 밖 작업, 헤더 없음) 공개 폴더만 허용한다.
const { AsyncLocalStorage } = require("async_hooks");
const crypto = require("crypto");
const prisma = require("../prisma");

const als = new AsyncLocalStorage();

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const HOUR = 60 * 60 * 1000;

function unlockTtlMs() {
  const h = Number(process.env.NEXUS_UNLOCK_TTL_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 8) * HOUR;
}
function adminTtlMs() {
  const h = Number(process.env.NEXUS_ADMIN_TTL_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 12) * HOUR;
}

/** docpath("실적\\x.json" 포함)에서 폴더(첫 구간)를 뽑는다. 루트 파일은 "". */
function folderOfDocpath(docpath = "") {
  const p = String(docpath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const i = p.indexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/** 폴더 이름(단일 구간)으로 정규화. 유효하지 않으면 null. */
function normalizeFolderName(name = "") {
  const n = String(name || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (!n || n.includes("/") || n === "." || n === "..") return null;
  return n;
}

// ---------------------------------------------------------------- 비밀번호
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored || "").split("$");
    if (algo !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(
      String(password),
      Buffer.from(saltHex, "hex"),
      expected.length
    );
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function sameSecret(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ------------------------------------------------------ 무차별 대입 제한
// 같은 네트워크의 누구나 접속할 수 있으므로 비밀번호 시도를 제한한다.
// 키(클라이언트·IP·대상)별 10분에 5회 실패하면 10분간 거부. 메모리 보관(재시작 시 초기화).
const attempts = new Map();
const MAX_FAILS = 5;
const WINDOW_MS = 10 * 60 * 1000;

function rateKey(parts) {
  return parts.map((p) => String(p ?? "")).join("|");
}
function isBlocked(key, now = Date.now()) {
  const a = attempts.get(key);
  if (!a) return false;
  if (now - a.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return a.count >= MAX_FAILS;
}
function noteFail(key, now = Date.now()) {
  const a = attempts.get(key);
  if (!a || now - a.first > WINDOW_MS)
    attempts.set(key, { first: now, count: 1 });
  else a.count += 1;
}
function clearFails(key) {
  attempts.delete(key);
}

// -------------------------------------------------------------- 범위 계산
function validClientId(raw) {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && CLIENT_ID_RE.test(v) ? v : null;
}

/**
 * 클라이언트의 접근 범위를 DB에서 읽어 만든다.
 * @returns {Promise<{clientId:string|null,isAdmin:boolean,locked:Set<string>,unlocked:Set<string>}>}
 */
async function buildScope(clientId) {
  const now = new Date();
  const [locks, unlocks, admin] = await Promise.all([
    prisma.folder_locks.findMany({ select: { folder: true } }),
    clientId
      ? prisma.folder_unlocks.findMany({
          where: { clientId, expiresAt: { gt: now } },
          select: { folder: true },
        })
      : [],
    clientId
      ? prisma.access_admins.findFirst({
          where: { clientId, expiresAt: { gt: now } },
          select: { id: true },
        })
      : null,
  ]);
  return {
    clientId,
    isAdmin: !!admin,
    locked: new Set(locks.map((l) => l.folder)),
    unlocked: new Set(unlocks.map((u) => u.folder)),
    _deniedDocIds: null,
  };
}

/** 요청 밖(예약 작업 등)이거나 범위를 못 구했을 때: 공개 폴더만. */
function publicOnlyScope(locked = new Set()) {
  return {
    clientId: null,
    isAdmin: false,
    locked,
    unlocked: new Set(),
    _deniedDocIds: null,
  };
}

/** 현재 요청의 범위. 요청 밖이면 null — 호출자는 null 을 "공개만"으로 취급한다. */
function currentScope() {
  return als.getStore() || null;
}

function canAccessFolder(scope, folder) {
  if (!folder) return true; // 루트 파일은 잠글 수 없다
  if (scope?.isAdmin) return true;
  return !scope.locked.has(folder) || scope.unlocked.has(folder);
}

/**
 * 폴더 접근 가능 여부. scope 가 없으면(요청 밖) 잠금 여부를 DB에서 확인해
 * 공개 폴더만 허용한다.
 */
async function canAccessFolderAsync(folder, scope = currentScope()) {
  if (!folder) return true;
  if (scope) return canAccessFolder(scope, folder);
  const lock = await prisma.folder_locks.findUnique({ where: { folder } });
  return !lock;
}

async function canAccessDocpath(docpath, scope = currentScope()) {
  return canAccessFolderAsync(folderOfDocpath(docpath), scope);
}

/** 접근이 막힌 폴더 이름들 (범위가 없으면 잠긴 폴더 전부). */
async function inaccessibleFolders(scope = currentScope()) {
  if (scope?.isAdmin) return [];
  const s = scope || publicOnlyScope(await lockedFolderSet());
  return [...s.locked].filter((f) => !s.unlocked.has(f));
}

async function lockedFolderSet() {
  const locks = await prisma.folder_locks.findMany({
    select: { folder: true },
  });
  return new Set(locks.map((l) => l.folder));
}

/**
 * 이 범위에서 볼 수 없는 문서들의 doc_id. 검색 SQL 의 사전 필터와
 * 결과 사후 필터가 같이 쓴다. 요청 범위 안에서 한 번만 계산해 둔다.
 * @returns {Promise<string[]>}
 */
async function deniedDocIds(scope = currentScope()) {
  if (scope?._deniedDocIds) return scope._deniedDocIds;
  const folders = await inaccessibleFolders(scope);
  let ids = [];
  if (folders.length) {
    const rows = await prisma.workspace_documents.findMany({
      where: {
        OR: folders.flatMap((f) => [
          { docpath: { startsWith: `${f}/` } },
          { docpath: { startsWith: `${f}\\` } },
        ]),
      },
      select: { docId: true },
    });
    ids = [...new Set(rows.map((r) => r.docId))];
  }
  if (scope) scope._deniedDocIds = ids;
  return ids;
}

/**
 * 워크스페이스(들)의 `documents` 목록에서 열 수 없는 폴더의 문서를 뺀다 —
 * 파일명·경로만으로도 정보가 새므로 UI 응답에서는 보이지 않게 한다.
 * (내부 로직이 쓰는 Document.forWorkspace 는 그대로 둔다.)
 */
async function maskWorkspaceDocuments(input) {
  const list = Array.isArray(input) ? input : [input];
  const folders = new Set(await inaccessibleFolders());
  if (!folders.size) return input;
  const mask = (ws) =>
    !ws || !Array.isArray(ws.documents)
      ? ws
      : {
          ...ws,
          documents: ws.documents.filter(
            (d) => !folders.has(folderOfDocpath(d?.docpath))
          ),
        };
  const out = list.map(mask);
  return Array.isArray(input) ? out : out[0];
}

/**
 * 생성 문서(초안·PPT·전사문서작성 결과)를 아카이브에 보관할 때 적용할 잠금 상속 규칙.
 * 근거 자료 중 잠긴 폴더 문서가 있으면 결과도 그 폴더에 보관해야 공개 폴더로 새지 않는다.
 *   - folder: 결과를 넣을 잠긴 폴더 (없으면 null = 기존대로 공개 보관)
 *   - skip:   보관하지 말아야 하는 경우 (서로 다른 잠긴 폴더를 섞었거나, 근거를 알 수 없는데
 *             이 사용자가 잠긴 폴더를 열어 둔 상태)와 그 이유
 * @returns {Promise<{folder:string|null, skip:boolean, reason?:string}>}
 */
async function restrictionForSources({
  workspaceId,
  sourceDocIds = [],
  scope = currentScope(),
}) {
  const ids = [...new Set(Array.isArray(sourceDocIds) ? sourceDocIds : [])];
  const strIds = ids.filter((i) => typeof i === "string" && i);
  const numIds = ids.filter((i) => typeof i === "number" && Number.isFinite(i));
  const locked = await lockedFolderSet();

  let folders = new Set();
  if (workspaceId && (strIds.length || numIds.length)) {
    const rows = await prisma.workspace_documents.findMany({
      where: {
        workspaceId: Number(workspaceId),
        OR: [
          ...(strIds.length ? [{ docId: { in: strIds } }] : []),
          ...(numIds.length ? [{ id: { in: numIds } }] : []),
        ],
      },
      select: { docpath: true },
    });
    folders = new Set(
      rows.map((r) => folderOfDocpath(r.docpath)).filter((f) => locked.has(f))
    );
  }

  if (folders.size > 1)
    return {
      folder: null,
      skip: true,
      reason:
        "서로 다른 잠긴 폴더의 자료를 섞어 만든 결과라 자동 보관하지 않았습니다.",
    };
  if (folders.size === 1) {
    const [folder] = [...folders];
    if (scope && !canAccessFolder(scope, folder))
      return {
        folder: null,
        skip: true,
        reason: "잠긴 폴더의 자료로 만든 결과라 자동 보관하지 않았습니다.",
      };
    return { folder, skip: false };
  }

  // 근거 문서를 알 수 없는데 잠긴 폴더를 열어 둔 사용자가 만든 결과: 어느 폴더 자료가
  // 섞였는지 확인할 수 없으니 보관하지 않는다 (관리자는 근거 목록만 본다).
  const hasOpenLocked =
    !!scope &&
    !scope.isAdmin &&
    [...scope.unlocked].some((f) => scope.locked.has(f));
  if (hasOpenLocked && ids.length === 0)
    return {
      folder: null,
      skip: true,
      reason:
        "근거 문서를 확인할 수 없고 잠긴 폴더를 연 상태라 자동 보관하지 않았습니다.",
    };
  return { folder: null, skip: false };
}

/** 현재 요청의 클라이언트 ID (없으면 null). */
function currentClientId() {
  return currentScope()?.clientId || null;
}

/**
 * 대화·스레드 조회 조건에 "내 기록 + 도입 이전의 공개 기록"만 보이도록 합친다.
 * 관리자와 요청 밖 내부 작업(범위 없음)은 전체를 본다.
 * @param {object} clause Prisma where 절
 */
function scopeChatWhere(clause = {}) {
  const scope = currentScope();
  if (!scope || scope.isAdmin) return clause;
  const mine = scope.clientId
    ? { OR: [{ client_id: scope.clientId }, { client_id: null }] }
    : { client_id: null };
  return { AND: [clause, mine] };
}

/** docpath 배열에서 접근 가능한 것만 남긴다. */
async function filterDocpaths(docpaths = [], scope = currentScope()) {
  const folders = new Set(await inaccessibleFolders(scope));
  if (!folders.size) return docpaths;
  return docpaths.filter((d) => !folders.has(folderOfDocpath(d)));
}

/** 관리자만 통과. 관리자 비밀번호가 설정돼 있지 않으면 기존 동작(열림)을 유지한다. */
function requireAdminIfEnabled(_request, response, next) {
  if (!adminEnabled() || response.locals.nexusScope?.isAdmin) return next();
  return response
    .status(403)
    .json({ error: "관리자 로그인이 필요합니다.", success: false });
}

/** 폴더 삭제 후 잠금 흔적 정리. */
async function dropLockRow(folder) {
  const name = normalizeFolderName(folder);
  if (!name) return;
  await prisma.folder_locks.deleteMany({ where: { folder: name } });
  await prisma.folder_unlocks.deleteMany({ where: { folder: name } });
}

// ----------------------------------------------------------------- 서비스
async function listFolderLocks() {
  return prisma.folder_locks.findMany({ select: { folder: true } });
}

async function createLock({ folder, password, clientId = null }) {
  const name = normalizeFolderName(folder);
  if (!name) throw new Error("Invalid folder name.");
  if (!password || String(password).length < 4)
    throw new Error("비밀번호는 4자 이상이어야 합니다.");
  const existing = await prisma.folder_locks.findUnique({
    where: { folder: name },
  });
  if (existing) throw new Error("이미 잠긴 폴더입니다.");
  await prisma.folder_locks.create({
    data: {
      folder: name,
      passwordHash: hashPassword(password),
      createdByClient: clientId,
    },
  });
  // 만든 사람은 바로 열린 상태로 시작한다.
  if (clientId) await grantUnlock(clientId, name);
  return name;
}

async function grantUnlock(clientId, folder) {
  const expiresAt = new Date(Date.now() + unlockTtlMs());
  await prisma.folder_unlocks.upsert({
    where: { clientId_folder: { clientId, folder } },
    update: { expiresAt },
    create: { clientId, folder, expiresAt },
  });
}

/**
 * 비밀번호로 폴더를 연다.
 * @returns {Promise<{ok:boolean, reason?:"blocked"|"no-lock"|"bad-password"|"no-client"}>}
 */
async function unlockFolder({ clientId, folder, password, ip = "" }) {
  const name = normalizeFolderName(folder);
  if (!clientId) return { ok: false, reason: "no-client" };
  if (!name) return { ok: false, reason: "no-lock" };
  const keys = [rateKey(["c", clientId, name]), rateKey(["ip", ip, name])];
  if (keys.some((k) => isBlocked(k))) return { ok: false, reason: "blocked" };
  const lock = await prisma.folder_locks.findUnique({
    where: { folder: name },
  });
  if (!lock) return { ok: false, reason: "no-lock" };
  if (!verifyPassword(password, lock.passwordHash)) {
    keys.forEach((k) => noteFail(k));
    return { ok: false, reason: "bad-password" };
  }
  keys.forEach(clearFails);
  await grantUnlock(clientId, name);
  return { ok: true };
}

async function relockFolder({ clientId, folder }) {
  const name = normalizeFolderName(folder);
  if (!clientId || !name) return;
  await prisma.folder_unlocks.deleteMany({ where: { clientId, folder: name } });
}

/**
 * 비밀번호 변경/잠금 해제는 현재 비밀번호를 아는 사람 또는 관리자만 할 수 있다.
 * newPassword 가 비어 있으면 잠금 자체를 없앤다(공개로 전환).
 */
async function changeLock({
  folder,
  currentPassword = null,
  newPassword = null,
  asAdmin = false,
  ip = "",
  clientId = null,
}) {
  const name = normalizeFolderName(folder);
  if (!name) return { ok: false, reason: "no-lock" };
  const lock = await prisma.folder_locks.findUnique({
    where: { folder: name },
  });
  if (!lock) return { ok: false, reason: "no-lock" };
  if (!asAdmin) {
    const key = rateKey(["chg", clientId || ip, name]);
    if (isBlocked(key)) return { ok: false, reason: "blocked" };
    if (!verifyPassword(currentPassword, lock.passwordHash)) {
      noteFail(key);
      return { ok: false, reason: "bad-password" };
    }
    clearFails(key);
  }
  if (newPassword) {
    if (String(newPassword).length < 4)
      return { ok: false, reason: "weak-password" };
    await prisma.folder_locks.update({
      where: { folder: name },
      data: { passwordHash: hashPassword(newPassword) },
    });
    // 비밀번호가 바뀌면 이전에 열었던 모든 브라우저는 다시 잠긴다.
    await prisma.folder_unlocks.deleteMany({ where: { folder: name } });
  } else {
    await prisma.folder_locks.delete({ where: { folder: name } });
    await prisma.folder_unlocks.deleteMany({ where: { folder: name } });
  }
  return { ok: true };
}

// ------------------------------------------------------------------ 관리자
function adminEnabled() {
  return !!process.env.NEXUS_ADMIN_PASSWORD;
}

async function adminLogin({ clientId, password, ip = "" }) {
  if (!adminEnabled()) return { ok: false, reason: "disabled" };
  if (!clientId) return { ok: false, reason: "no-client" };
  const keys = [rateKey(["adm", clientId]), rateKey(["adm-ip", ip])];
  if (keys.some((k) => isBlocked(k))) return { ok: false, reason: "blocked" };
  if (!sameSecret(password ?? "", process.env.NEXUS_ADMIN_PASSWORD)) {
    keys.forEach((k) => noteFail(k));
    return { ok: false, reason: "bad-password" };
  }
  keys.forEach(clearFails);
  const expiresAt = new Date(Date.now() + adminTtlMs());
  await prisma.access_admins.upsert({
    where: { clientId },
    update: { expiresAt },
    create: { clientId, expiresAt },
  });
  return { ok: true };
}

async function adminLogout(clientId) {
  if (clientId) await prisma.access_admins.deleteMany({ where: { clientId } });
}

// -------------------------------------------------------------- 미들웨어
/**
 * 요청마다 클라이언트 ID 를 읽어 범위를 계산해 이후 모든 처리에 붙인다.
 * 헤더가 없으면 query `cid` 를 본다 (헤더를 못 보내는 <a href>/iframe 다운로드용).
 */
async function accessContext(request, response, next) {
  try {
    const clientId = validClientId(
      request.headers["x-nexus-client"] || request.query?.cid
    );
    const scope = await buildScope(clientId);
    response.locals.nexusScope = scope;
    als.run(scope, () => next());
  } catch (e) {
    // 범위를 못 구하면 공개 폴더만 허용하는 상태로 계속한다 (fail-closed).
    console.error("[folderAccess] scope failed:", e.message);
    const scope = publicOnlyScope(
      await lockedFolderSet().catch(() => new Set())
    );
    als.run(scope, () => next());
  }
}

module.exports = {
  als,
  accessContext,
  currentScope,
  publicOnlyScope,
  buildScope,
  validClientId,
  folderOfDocpath,
  normalizeFolderName,
  hashPassword,
  verifyPassword,
  canAccessFolder,
  canAccessFolderAsync,
  canAccessDocpath,
  inaccessibleFolders,
  currentClientId,
  scopeChatWhere,
  restrictionForSources,
  deniedDocIds,
  filterDocpaths,
  maskWorkspaceDocuments,
  listFolderLocks,
  createLock,
  unlockFolder,
  relockFolder,
  changeLock,
  adminEnabled,
  requireAdminIfEnabled,
  dropLockRow,
  adminLogin,
  adminLogout,
  // 테스트용
  _resetAttempts: () => attempts.clear(),
};
