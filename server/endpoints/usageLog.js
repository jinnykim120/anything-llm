// [auto-docu 호출량 로그] GET /usage-log/summary?days=7  (admin/manager)
//   -> { days, total, byFeature, byDay }  — 글자 수 기준(토큰 아님, 대략 1글자≈1~2토큰).
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { summarize } = require("../utils/usageLog");

function usageLogEndpoints(app) {
  if (!app) return;
  app.get(
    "/usage-log/summary",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    (request, response) => {
      const days = Math.min(90, Math.max(1, Number(request.query.days) || 7));
      response.status(200).json(summarize(days));
    }
  );
}

module.exports = { usageLogEndpoints };
