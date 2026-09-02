// [auto-docu P4] Document classification — the review screen's backend.
//
//   GET  /classification/taxonomy                 axis definitions for the UI
//   GET  /classification/documents                review list (one row per doc content)
//   POST /classification/propose                  run the LLM classifier ({contentHash} or all pending)
//   POST /classification/:contentHash/confirm     human accepts / edits
//   POST /classification/:contentHash/move        move a doc to a tier-matching workspace
//   POST /classification/:contentHash/dedupe      collapse same-workspace duplicate rows to one
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
const { Document } = require("../models/documents");
const { Workspace } = require("../models/workspace");

/**
 * Every distinct document currently in the archive, keyed by content_hash,
 * with the workspaces it appears in and a sample title. Reads the parsed doc
 * JSON for the hash (metadata lives there, not on a column).
 */
async function archiveDocuments() {
  const rows = await prisma.workspace_documents.findMany({
    include: { workspace: { select: { slug: true, name: true, tier: true } } },
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
        // slug -> rows sharing this content_hash IN THAT workspace. A doc
        // legitimately living in several workspaces is fine; a workspace
        // holding it more than once (pre-dedup-fix leftovers, races) is the
        // thing the cleanup UI targets.
        byWorkspace: new Map(),
      });
    }
    const entry = byHash.get(hash);
    const slug = wd.workspace?.slug || String(wd.workspaceId);
    entry.workspaces.push({ slug, tier: wd.workspace?.tier || null });
    entry.docpaths.push(wd.docpath);
    if (!entry.byWorkspace.has(slug)) entry.byWorkspace.set(slug, []);
    entry.byWorkspace.get(slug).push({
      docId: wd.docId,
      docpath: wd.docpath,
      filename: wd.filename,
      createdAt: wd.createdAt,
    });
  }
  return [...byHash.values()];
}

/** A confirmed confidential doc sitting in a general-tier workspace (or v.v.). */
function tierMismatch(sensitivity, workspaces) {
  if (!sensitivity || sensitivity === "unclassified") return [];
  return workspaces
    .filter((w) => w.tier && w.tier !== sensitivity)
    .map((w) => w.slug);
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
        const allWorkspaces = await prisma.workspaces.findMany({
          select: { slug: true, name: true, tier: true },
        });
        const out = docs.map((d) => {
          const cls = byHash[d.contentHash] || null;
          const wsList = [];
          const seen = new Set();
          for (const w of d.workspaces) {
            if (seen.has(w.slug)) continue;
            seen.add(w.slug);
            wsList.push(w);
          }
          // A doc is "held" until a human confirms a definite tier — the LLM
          // proposal (incl. "uncertain") does not take effect on its own, and
          // a held doc is treated as confidential for access / not routed.
          const held =
            !cls ||
            cls.status !== "confirmed" ||
            !["general", "confidential"].includes(cls.sensitivity);
          const mism =
            cls?.status === "confirmed"
              ? tierMismatch(cls.sensitivity, wsList)
              : [];
          // Real duplicates = the SAME workspace holding this content_hash
          // more than once (leftovers from before the ingest-time dedup skip,
          // or a race). Living in several DIFFERENT workspaces is normal and
          // not included here.
          const duplicatesByWorkspace = [...d.byWorkspace.entries()]
            .filter(([, docs]) => docs.length > 1)
            .map(([workspace, docs]) => ({
              workspace,
              docs: docs
                .slice()
                .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
            }));
          return {
            contentHash: d.contentHash,
            title: d.title,
            docSource: d.docSource,
            parsePath: d.parsePath,
            parseConfidence: d.parseConfidence,
            workspaces: wsList,
            duplicateCount: d.docpaths.length,
            duplicatesByWorkspace,
            classification: cls,
            held,
            effectiveSensitivity:
              cls?.status === "confirmed" && cls.sensitivity === "general"
                ? "general"
                : "confidential",
            tierMismatch: mism,
            // workspaces this doc could be moved into to resolve a mismatch
            moveTargets:
              mism.length && cls?.sensitivity
                ? allWorkspaces
                    .filter(
                      (w) =>
                        w.tier === cls.sensitivity &&
                        !wsList.some((x) => x.slug === w.slug)
                    )
                    .map((w) => w.slug)
                : [],
          };
        });
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

  // Move a document's embeddings from one workspace to another (manual
  // resolution of a tier mismatch — there is no automatic routing). The parsed
  // doc file stays on disk; only the per-workspace vectors move.
  app.post(
    "/classification/:contentHash/move",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { contentHash } = request.params;
        const { fromWorkspace, toWorkspace } = reqBody(request);
        if (!fromWorkspace || !toWorkspace || fromWorkspace === toWorkspace)
          return response
            .status(400)
            .json({ error: "fromWorkspace and toWorkspace required" });

        const fromWs = await Workspace.get({ slug: String(fromWorkspace) });
        const toWs = await Workspace.get({ slug: String(toWorkspace) });
        if (!fromWs || !toWs)
          return response.status(404).json({ error: "workspace not found" });

        // The doc(s) with this content hash in the source workspace.
        const inFrom = (
          await Document.where({ workspaceId: fromWs.id })
        ).filter((d) => {
          try {
            return JSON.parse(d.metadata || "{}").content_hash === contentHash;
          } catch {
            return false;
          }
        });
        if (!inFrom.length)
          return response
            .status(404)
            .json({ error: "document not found in fromWorkspace" });

        const docpaths = inFrom.map((d) => d.docpath);
        await Document.removeDocuments(fromWs, docpaths);
        const { failedToEmbed = [] } = await Document.addDocuments(
          toWs,
          docpaths,
          response.locals?.user?.id
        );
        response.status(200).json({
          moved: docpaths.length - failedToEmbed.length,
          failed: failedToEmbed,
        });
      } catch (e) {
        console.error("POST /classification/:contentHash/move", e);
        response.status(500).json({ error: e.message });
      }
    }
  );

  // Collapse duplicate rows for this content_hash WITHIN one workspace down
  // to a single one (keepDocId) — leftovers from before the ingest-time
  // dedup skip, or a race. Removes the others' vectors + workspace_documents
  // rows; the parsed file(s) on disk are untouched (other hashes may still
  // reference them).
  app.post(
    "/classification/:contentHash/dedupe",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { contentHash } = request.params;
        const { workspace: workspaceSlug, keepDocId } = reqBody(request);
        if (!workspaceSlug || !keepDocId)
          return response
            .status(400)
            .json({ error: "workspace and keepDocId required" });

        const ws = await Workspace.get({ slug: String(workspaceSlug) });
        if (!ws)
          return response.status(404).json({ error: "workspace not found" });

        const inWs = (await Document.where({ workspaceId: ws.id })).filter(
          (d) => {
            try {
              return (
                JSON.parse(d.metadata || "{}").content_hash === contentHash
              );
            } catch {
              return false;
            }
          }
        );
        if (!inWs.some((d) => d.docId === keepDocId))
          return response.status(400).json({
            error: "keepDocId not found in this workspace for this document",
          });

        const docpaths = inWs
          .filter((d) => d.docId !== keepDocId)
          .map((d) => d.docpath);
        if (!docpaths.length) return response.status(200).json({ removed: 0 });

        await Document.removeDocuments(ws, docpaths, response.locals?.user?.id);
        response.status(200).json({ removed: docpaths.length });
      } catch (e) {
        console.error("POST /classification/:contentHash/dedupe", e);
        response.status(500).json({ error: e.message });
      }
    }
  );
}

module.exports = { classificationEndpoints };
