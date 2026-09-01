// [auto-docu P4] Document classification — the review screen's backend.
//
//   GET  /classification/taxonomy                 axis definitions for the UI
//   GET  /classification/documents                review list (one row per doc content)
//   POST /classification/propose                  run the LLM classifier ({contentHash} or all pending)
//   POST /classification/:contentHash/confirm     human accepts / edits
const prisma = require("../utils/prisma");
const { reqBody } = require("../utils/http");
const { fileData } = require("../utils/files");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { taxonomy } = require("../utils/classification/taxonomy");
const { DocumentClassification } = require("../models/documentClassification");

/**
 * Every distinct document currently in the archive, keyed by content_hash,
 * with the workspaces it appears in and a sample title. Reads the parsed doc
 * JSON for the hash (metadata lives there, not on a column).
 */
async function archiveDocuments() {
  const rows = await prisma.workspace_documents.findMany({
    include: { workspace: { select: { slug: true, name: true } } },
  });
  const byHash = new Map();
  for (const wd of rows) {
    let meta = {};
    try {
      meta = JSON.parse(wd.metadata || "{}");
    } catch {
      meta = {};
    }
    const hash = meta.content_hash;
    if (!hash) continue;
    if (!byHash.has(hash)) {
      byHash.set(hash, {
        contentHash: hash,
        title: meta.title || wd.filename,
        docSource: meta.docSource || null,
        parsePath: meta.parse_path || null,
        parseConfidence: meta.parse_confidence ?? null,
        ingestSensitivity: meta.sensitivity || "unclassified",
        workspaces: [],
        docpaths: [],
      });
    }
    const entry = byHash.get(hash);
    entry.workspaces.push(wd.workspace?.slug || String(wd.workspaceId));
    entry.docpaths.push(wd.docpath);
  }
  return [...byHash.values()];
}

/** Best-effort full text for a content hash (first docpath that reads). */
async function textForHash(entry) {
  for (const dp of entry.docpaths) {
    try {
      const rel = dp.split(/[\\/]/).slice(-2).join("/"); // "custom-documents/x.json"
      const j = await fileData(rel);
      if (j?.pageContent) return j.pageContent;
    } catch {
      /* try next */
    }
  }
  return "";
}

function classificationEndpoints(app) {
  if (!app) return;

  app.get(
    "/classification/taxonomy",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    (_request, response) => {
      response.status(200).json({ taxonomy: taxonomy() });
    }
  );

  app.get(
    "/classification/documents",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (_request, response) => {
      try {
        const docs = await archiveDocuments();
        const classifications = await DocumentClassification.where({});
        const byHash = Object.fromEntries(
          classifications.map((c) => [c.contentHash, c])
        );
        const out = docs.map((d) => ({
          contentHash: d.contentHash,
          title: d.title,
          docSource: d.docSource,
          parsePath: d.parsePath,
          parseConfidence: d.parseConfidence,
          workspaces: [...new Set(d.workspaces)],
          duplicateCount: d.docpaths.length,
          classification: byHash[d.contentHash] || null,
        }));
        response.status(200).json({ documents: out });
      } catch (e) {
        console.error("GET /classification/documents", e);
        response.status(500).json({ error: e.message });
      }
    }
  );

  app.post(
    "/classification/propose",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { contentHash = null } = reqBody(request);
        const docs = await archiveDocuments();
        const existing = Object.fromEntries(
          (await DocumentClassification.where({})).map((c) => [
            c.contentHash,
            c,
          ])
        );
        const targets = docs.filter((d) => {
          if (contentHash) return d.contentHash === contentHash;
          return existing[d.contentHash]?.status !== "confirmed"; // (re)propose everything not confirmed
        });

        const results = [];
        for (const d of targets) {
          const text = await textForHash(d);
          if (!text) {
            results.push({ contentHash: d.contentHash, error: "no text" });
            continue;
          }
          const { classification, error } =
            await DocumentClassification.proposeFor({
              contentHash: d.contentHash,
              title: d.title,
              text,
              docSource: d.docSource,
              parsePath: d.parsePath,
            });
          results.push({
            contentHash: d.contentHash,
            title: d.title,
            classification,
            error: error || null,
          });
        }
        response.status(200).json({ proposed: results.length, results });
      } catch (e) {
        console.error("POST /classification/propose", e);
        response.status(500).json({ error: e.message });
      }
    }
  );

  app.post(
    "/classification/:contentHash/confirm",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { contentHash } = request.params;
        const { sensitivity, docType, domain, tags } = reqBody(request);
        const { classification, error } = await DocumentClassification.confirm({
          contentHash,
          sensitivity,
          docType,
          domain,
          tags,
          userId: response.locals?.user?.id ?? null,
        });
        if (error) return response.status(400).json({ error });
        response.status(200).json({ classification });
      } catch (e) {
        console.error("POST /classification/:contentHash/confirm", e);
        response.status(500).json({ error: e.message });
      }
    }
  );
}

module.exports = { classificationEndpoints };
