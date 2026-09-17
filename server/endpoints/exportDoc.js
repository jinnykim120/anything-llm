// [auto-docu 다른 파일 형태 다운로드] 초안(§06)/전사문서작성tool(§07)/자료
// 추출하기(§08) 결과를 HTML 말고 DOCX·XLSX로도 내려받는다. 워크스페이스
// 컨텍스트가 필요 없는 순수 변환이라 별도 라우트로 둔다 — 프론트가
// markdown+title을 보내면 바이너리를 그대로 응답한다.
//
//   POST /doc-export/docx   { title, markdown }   -> application/vnd...wordprocessingml.document
//   POST /doc-export/xlsx   { title, markdown }   -> application/vnd...spreadsheetml.sheet
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { markdownToDocx } = require("../utils/exporters/markdownToDocx");
const { markdownToXlsx } = require("../utils/exporters/markdownToXlsx");

function exportDocEndpoints(app) {
  if (!app) return;

  app.post(
    "/doc-export/docx",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const { title = "문서", markdown = "" } = reqBody(request);
        if (!String(markdown).trim())
          throw new Error("내려받을 내용이 없습니다.");

        const buffer = await markdownToDocx({ title, markdown });
        const filename = `${String(title).trim() || "문서"}.docx`.slice(0, 150);

        response.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        // 한글 파일명은 RFC 5987 filename*로 넘긴다 — 평문 filename=은 ASCII
        // 폴백(브라우저가 filename*을 못 읽는 경우에만 쓰임).
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="download.docx"; filename*=UTF-8''${encodeURIComponent(filename)}`
        );
        response.status(200).send(buffer);
      } catch (e) {
        console.error("POST /doc-export/docx", e);
        response
          .status(500)
          .json({ error: e.message || "DOCX 변환 중 오류가 발생했습니다." });
      }
    }
  );

  app.post(
    "/doc-export/xlsx",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const { title = "문서", markdown = "" } = reqBody(request);
        if (!String(markdown).trim())
          throw new Error("내려받을 내용이 없습니다.");

        const buffer = await markdownToXlsx({ title, markdown });
        const filename = `${String(title).trim() || "문서"}.xlsx`.slice(0, 150);

        response.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="download.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`
        );
        response.status(200).send(buffer);
      } catch (e) {
        console.error("POST /doc-export/xlsx", e);
        response
          .status(500)
          .json({ error: e.message || "XLSX 변환 중 오류가 발생했습니다." });
      }
    }
  );
}

module.exports = { exportDocEndpoints };
