const { Document } = require("../models/documents");
const {
  normalizePath,
  documentsPath,
  isWithin,
  fileData,
} = require("../utils/files");
const { reqBody } = require("../utils/http");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const fs = require("fs");
const path = require("path");

const RAW_MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  hwp: "application/x-hwp",
  hwpx: "application/hwp+zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  tiff: "image/tiff",
};

function documentEndpoints(app) {
  if (!app) return;

  // 재임베딩 도중 끊긴 문서가 있으면 인덱스에 되돌린다(DB/벡터 준비 후).
  if (process.env.NODE_ENV !== "test")
    setTimeout(() => {
      require("../utils/pdfConvert")
        .recoverPendingReembeds()
        .catch((err) => console.error("[pdfConvert] recover:", err.message));
    }, 15000).unref();

  // [auto-docu P2] Stream the ORIGINAL file for a document so the citation viewer
  // can render it (page + bbox highlight). Text/data files have no kept original
  // and return 404 — the viewer falls back to showing the chunk text.
  app.get(
    "/document/raw/:docId",
    [validatedRequest],
    async (request, response) => {
      try {
        const { docId } = request.params;
        const doc = await Document.get({ docId: String(docId) });
        if (!doc) return response.sendStatus(404);

        const parsed = await fileData(doc.docpath);
        // Prefer a PDF render (HWP→PDF) so the viewer can page + highlight it;
        // fall back to the true original.
        const rel = parsed?.render_path || parsed?.original_path;
        if (!rel) return response.sendStatus(404); // no kept original (text file)

        const originalsRoot = path.resolve(documentsPath, "originals");
        const filePath = path.resolve(documentsPath, normalizePath(rel));
        if (!isWithin(originalsRoot, filePath) || !fs.existsSync(filePath))
          return response.sendStatus(404);

        const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
        const mime = RAW_MIME[ext] || "application/octet-stream";
        const stat = fs.statSync(filePath);
        const total = stat.size;

        response.setHeader("Content-Type", mime);
        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Cache-Control", "private, max-age=300");
        response.setHeader(
          "Content-Disposition",
          `inline; filename*=UTF-8''${encodeURIComponent(parsed.title || "document." + ext)}`
        );

        const range = request.headers.range;
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range);
          let start = m && m[1] ? parseInt(m[1], 10) : 0;
          let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
          if (Number.isNaN(start) || start < 0) start = 0;
          if (Number.isNaN(end) || end >= total) end = total - 1;
          if (start > end) return response.sendStatus(416);
          response.status(206);
          response.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
          response.setHeader("Content-Length", end - start + 1);
          fs.createReadStream(filePath, { start, end }).pipe(response);
          return;
        }

        response.setHeader("Content-Length", total);
        fs.createReadStream(filePath).pipe(response);
      } catch (e) {
        console.error("[document/raw]", e.message);
        response.sendStatus(500);
      }
    }
  );
  app.post(
    "/document/create-folder",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        const storagePath = path.join(documentsPath, normalizePath(name));
        if (!isWithin(path.resolve(documentsPath), path.resolve(storagePath)))
          throw new Error("Invalid folder name.");

        if (fs.existsSync(storagePath)) {
          response.status(500).json({
            success: false,
            message: "Folder by that name already exists",
          });
          return;
        }

        fs.mkdirSync(storagePath, { recursive: true });
        response.status(200).json({ success: true, message: null });
      } catch (e) {
        console.error(e);
        response.status(500).json({
          success: false,
          message: `Failed to create folder: ${e.message} `,
        });
      }
    }
  );

  app.post(
    "/document/move-files",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { files } = reqBody(request);
        const docpaths = files.map(({ from }) => from);
        const documents = await Document.where({ docpath: { in: docpaths } });

        const embeddedFiles = documents.map((doc) => doc.docpath);
        const moveableFiles = files.filter(
          ({ from }) => !embeddedFiles.includes(from)
        );

        const movePromises = moveableFiles.map(({ from, to }) => {
          const sourcePath = path.join(documentsPath, normalizePath(from));
          const destinationPath = path.join(documentsPath, normalizePath(to));

          return new Promise((resolve, reject) => {
            if (
              !isWithin(documentsPath, sourcePath) ||
              !isWithin(documentsPath, destinationPath)
            )
              return reject("Invalid file location");

            fs.rename(sourcePath, destinationPath, (err) => {
              if (err) {
                console.error(`Error moving file ${from} to ${to}:`, err);
                reject(err);
              } else {
                resolve();
              }
            });
          });
        });

        Promise.all(movePromises)
          .then(() => {
            const unmovableCount = files.length - moveableFiles.length;
            if (unmovableCount > 0) {
              response.status(200).json({
                success: true,
                message: `${unmovableCount}/${files.length} files not moved. Unembed them from all workspaces.`,
              });
            } else {
              response.status(200).json({
                success: true,
                message: null,
              });
            }
          })
          .catch((err) => {
            console.error("Error moving files:", err);
            response
              .status(500)
              .json({ success: false, message: "Failed to move some files." });
          });
      } catch (e) {
        console.error(e);
        response
          .status(500)
          .json({ success: false, message: "Failed to move files." });
      }
    }
  );
  // [auto-docu] 이미 적재된 PDF/PPT 를 Docling 으로 다시 읽고 재임베딩.
  // Docling 이 꺼져 있거나 Docling 으로 읽지 못하면 기존 내용을 건드리지 않는다.
  app.post(
    "/document/reparse-docling",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { docpath } = reqBody(request);
        if (!docpath || typeof docpath !== "string")
          return response
            .status(400)
            .json({ success: false, error: "문서 경로가 없습니다." });
        const { convertDocumentToPdf } = require("../utils/pdfConvert");
        const userId = response.locals?.user?.id ?? null;
        const result = await convertDocumentToPdf(docpath, {
          userId,
          requireDocling: true,
        });
        return response.status(200).json({ success: true, ...result });
      } catch (err) {
        console.error("[document/reparse-docling]", err.message);
        return response
          .status(500)
          .json({ success: false, error: err.message || "다시 읽기 실패" });
      }
    }
  );

  // [auto-docu] PPTX/PPT/ODP → PDF 변환 후 다시 읽기. 문서함 버튼이 문서 하나씩
  // 호출한다(LibreOffice 변환 + 파싱 + 재임베딩이라 수십 초 걸릴 수 있음).
  app.post(
    "/document/convert-to-pdf",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { docpath } = reqBody(request);
        if (!docpath || typeof docpath !== "string")
          return response
            .status(400)
            .json({ success: false, error: "문서 경로가 없습니다." });
        const { convertDocumentToPdf } = require("../utils/pdfConvert");
        const userId = response.locals?.user?.id ?? null;
        const result = await convertDocumentToPdf(docpath, { userId });
        return response.status(200).json({ success: true, ...result });
      } catch (e) {
        console.error("[document/convert-to-pdf]", e.message);
        return response
          .status(500)
          .json({ success: false, error: e.message || "PDF 변환 실패" });
      }
    }
  );
}

module.exports = { documentEndpoints };
