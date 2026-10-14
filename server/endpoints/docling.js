// [auto-docu] Docling 켜기/끄기 버튼용 엔드포인트 (admin/manager).
//   GET  /docling/status
//   POST /docling/start  { force? }  — 메모리 부족 시 needsConfirm 으로 되돌려줌
//   POST /docling/stop
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const docling = require("../utils/doclingControl");

function doclingEndpoints(app) {
  if (!app) return;
  const guard = [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])];
  docling.startIdleWatcher();

  app.get("/docling/status", guard, async (_req, res) => {
    res.status(200).json(await docling.status());
  });
  app.post("/docling/start", guard, async (req, res) => {
    const { force = false } = reqBody(req) || {};
    const result = await docling.start({ force: !!force });
    res.status(200).json({ ...result, ...(await docling.status()) });
  });
  app.post("/docling/stop", guard, async (_req, res) => {
    const result = await docling.stop();
    res.status(200).json({ ...result, ...(await docling.status()) });
  });
}

module.exports = { doclingEndpoints };
