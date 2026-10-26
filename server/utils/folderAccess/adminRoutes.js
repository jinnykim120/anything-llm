// [NEXUS 관리자 콘솔] 관리자 전용 서버 경로 목록과, 그 경로를 한 곳에서 막는 미들웨어.
//
// 로그인이 없는 시스템이라 설정·관리 기능이 지금까지는 누구에게나 열려 있었다. 라우트마다
// 가드를 달면 빠뜨리기 쉬워서, 막을 경로를 이 표 하나에 모으고 요청이 라우터에 닿기 전에
// 검사한다. 관리자 비밀번호(NEXUS_ADMIN_PASSWORD)가 설정돼 있을 때만 적용된다.
//
// 일반 사용자의 평소 작업(채팅, 업로드, 문서함, 분류 검수, 검색 방식 전환, 모델 선택 등)이
// 쓰는 경로는 여기에 넣지 않는다 — 넣으면 그 기능이 403 으로 깨진다.
const FolderAccess = require("./index");

// [메서드("*" = 전부), 경로 정규식]  — 경로는 /api 뒤부터
const ADMIN_ONLY = [
  ["*", /^\/admin\//],
  ["GET", /^\/(env-dump|migrate)$/],
  [
    "*",
    /^\/system\/(update-env|update-password|enable-multi-user|upload-logo|remove-logo|api-keys|generate-api-key|api-key\/|custom-models|event-logs|workspace-chats|export-chats|validate-sql-connection|system-vectors)/,
  ],
  ["POST", /^\/system\/default-system-prompt$/],
  ["POST|PUT|DELETE", /^\/system\/prompt-variables(\/|$)/],
  // 임베드 위젯 "관리" 경로 (외부에 공개된 /embed/:id/stream-chat 등은 제외)
  ["GET", /^\/embeds$/],
  ["POST", /^\/embeds\/new$/],
  ["POST", /^\/embed\/(update\/[^/]+|chats)$/],
  ["DELETE", /^\/embed\/(chats\/[^/]+|[^/]+)$/],
  ["*", /^\/experimental\//],
  ["POST", /^\/workspace\/[^/]+\/update-watch-status$/],
  ["*", /^\/community-hub\//],
  ["*", /^\/mcp-servers\//],
  ["*", /^\/agent-flows\//],
  ["POST", /^\/agent-skills\/whitelist\/add$/],
  ["*", /^\/scheduled-jobs/],
  ["*", /^\/telegram\//],
  ["*", /^\/model-routers/],
  ["*", /^\/browser-extension\/api-keys/],
  ["GET", /^\/usage-log\//],
  ["GET", /^\/utils\/metrics$/],
  // 문서 연계성 관리 화면 (record-validated 는 채팅이 자동으로 부르므로 제외)
  ["GET|DELETE", /^\/workspace\/[^/]+\/affinity(\/[^/]+)?$/],
  // 작업공간 만들기/삭제/벡터 초기화
  ["POST", /^\/workspace\/new$/],
  ["DELETE", /^\/workspace\/[^/]+$/],
  ["DELETE", /^\/workspace\/[^/]+\/reset-vector-db$/],
  // 콘솔 전용 API
  ["*", /^\/nexus\/admin\/(?!login$|logout$)/],
  ["POST", /^\/nexus\/folders\/[^/]+\/admin-reset$/],
];

function methodMatches(spec, method) {
  return spec === "*" || spec.split("|").includes(method);
}

function isAdminOnly(method, path) {
  return ADMIN_ONLY.some(
    ([m, re]) => methodMatches(m, String(method).toUpperCase()) && re.test(path)
  );
}

/** app.use("/api", consoleGuard) — request.path 는 /api 뒤부터다. */
function consoleGuard(request, response, next) {
  if (request.method === "OPTIONS") return next();
  if (!FolderAccess.adminEnabled()) return next();
  if (!isAdminOnly(request.method, request.path)) return next();
  const scope = response.locals.nexusScope;
  if (scope?.isAdmin) return next();
  return response.status(403).json({
    success: false,
    needsAdmin: true,
    adminAuthed: !!scope?.adminAuthed,
    error: "관리자 전용 기능입니다. 관리자 콘솔에서 로그인하세요.",
    message: "관리자 전용 기능입니다. 관리자 콘솔에서 로그인하세요.",
  });
}

module.exports = { ADMIN_ONLY, isAdminOnly, consoleGuard };
