// [auto-docu P4] Document classification — the review screen's backend.
//
//   GET  /classification/taxonomy                 axis definitions for the UI
//   GET  /classification/documents                review list (one row per doc content)
//   POST /classification/propose                  run the LLM classifier ({contentHash} or all pending)
//   POST /classification/:contentHash/confirm     human accepts / edits
//   POST /classification/:contentHash/move        move a doc to a tier-matching workspace
//   POST /classification/:contentHash/dedupe      collapse same-workspace duplicate rows to one
const prisma = require("../utils/prisma");
const { reqBody, safeJsonParse } = require("../utils/http");
const { fileData } = require("../utils/files");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const {
  taxonomy,
  DOC_TYPE,
  WORK_TYPE,
  BUSINESS_UNIT,
  DOMAIN,
} = require("../utils/classification/taxonomy");
const { DocumentClassification } = require("../models/documentClassification");
const { Document } = require("../models/documents");
const { Workspace } = require("../models/workspace");
const { purgeDocument } = require("../utils/files/purgeDocument");

const CUSTOM_DOC_TYPES_SETTING = "archive_document_types";
const CUSTOM_AXIS_SETTINGS = {
  workType: "archive_work_types",
  businessUnit: "archive_business_units",
  domain: "archive_domains",
};

async function storedDocumentTypes() {
  const setting = await prisma.system_settings
    .findUnique({ where: { label: CUSTOM_DOC_TYPES_SETTING } })
    .catch(() => null);
  const values = safeJsonParse(setting?.value, []);
  return (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function storedAxisValues(label) {
  if (!label) return [];
  const setting = await prisma.system_settings
    .findUnique({ where: { label } })
    .catch(() => null);
  const values = safeJsonParse(setting?.value, []);
  return Array.isArray(values) ? values.filter(Boolean) : [];
}

async function documentTypeOptions() {
  const [stored, classifications] = await Promise.all([
    storedDocumentTypes(),
    prisma.document_classifications
      .findMany({ select: { docType: true } })
      .catch(() => []),
  ]);
  const used = classifications.map((row) => row.docType).filter(Boolean);
  return [...new Set([...DOC_TYPE.suggested, ...stored, ...used])];
}

async function axisOptions(field, suggested) {
  if (field === "workType") {
    return [
      ...new Set([
        ...suggested,
        ...(await storedAxisValues(CUSTOM_AXIS_SETTINGS[field])),
      ]),
    ];
  }
  const rows = await prisma.document_classifications
    .findMany({ select: { [field]: true } })
    .catch(() => []);
  return [
    ...new Set([
      ...suggested,
      ...(await storedAxisValues(CUSTOM_AXIS_SETTINGS[field])),
      ...rows.map((row) => row[field]).filter(Boolean),
    ]),
  ];
}

async function taxonomyWithDocumentTypes() {
  return {
    ...taxonomy(),
    work_type: {
      suggested: await axisOptions("workType", WORK_TYPE.suggested),
    },
    business_unit: {
      suggested: await axisOptions("businessUnit", BUSINESS_UNIT.suggested),
    },
    doc_type: { suggested: await documentTypeOptions() },
  };
}

/**
 * Every distinct document currently in the archive, keyed by content_hash,
 * with the workspaces it appears in and a sample title. Reads the parsed doc
 * JSON for the hash (metadata lives there, not on a column).
 */
async function archiveDocuments(workspaceSlug = null) {
  const rows = await prisma.workspace_documents.findMany({
    ...(workspaceSlug ? { where: { workspace: { slug: workspaceSlug } } } : {}),
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
        uploaders: [],
      });
    }
    const entry = byHash.get(hash);
    if (wd.uploadedByUserId || wd.uploadedByOrgUnit) {
      entry.uploaders.push({
        userId: wd.uploadedByUserId || null,
        orgUnit: wd.uploadedByOrgUnit || null,
      });
    }
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

async function orphanedWorkspaceDocuments(workspaceSlug = null) {
  const rows = await prisma.workspace_documents.findMany({
    where: workspaceSlug ? { workspace: { slug: workspaceSlug } } : {},
    include: { workspace: { select: { slug: true } } },
  });
  return rows
    .map((row) => {
      const metadata = safeJsonParse(row.metadata, {});
      return {
        id: row.id,
        workspace: row.workspace?.slug || null,
        filename: row.filename,
        docpath: row.docpath,
        title: metadata.title || row.filename,
        reason: metadata.content_hash ? "" : "content_hash 없음",
      };
    })
    .filter((row) => row.reason);
}

function classificationEndpoints(app) {
  if (!app) return;

  app.get(
    "/classification/taxonomy",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (_request, response) => {
      response
        .status(200)
        .json({ taxonomy: await taxonomyWithDocumentTypes() });
    }
  );

  app.post(
    "/classification/taxonomy/doc-type",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const value = String(reqBody(request).value || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!value || value.length > 80)
          return response
            .status(400)
            .json({ error: "문서 종류는 1~80자로 입력하세요." });

        const current = await storedDocumentTypes();
        const values = [...new Set([...current, value])].slice(0, 100);
        await prisma.system_settings.upsert({
          where: { label: CUSTOM_DOC_TYPES_SETTING },
          update: { value: JSON.stringify(values) },
          create: {
            label: CUSTOM_DOC_TYPES_SETTING,
            value: JSON.stringify(values),
          },
        });
        response.status(200).json({
          value,
          taxonomy: await taxonomyWithDocumentTypes(),
        });
      } catch (e) {
        console.error("POST /classification/taxonomy/doc-type", e);
        response.status(500).json({ error: e.message });
      }
    }
  );

  app.post(
    "/classification/taxonomy/axis",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { axis, value } = reqBody(request);
        const label = CUSTOM_AXIS_SETTINGS[axis];
        const normalized = String(value || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!label || !normalized || normalized.length > 80)
          return response
            .status(400)
            .json({ error: "유효하지 않은 분류 항목입니다." });
        const current = await storedAxisValues(label);
        const values = [...new Set([...current, normalized])].slice(0, 100);
        await prisma.system_settings.upsert({
          where: { label },
          update: { value: JSON.stringify(values) },
          create: { label, value: JSON.stringify(values) },
        });
        response.status(200).json({
          value: normalized,
          taxonomy: await taxonomyWithDocumentTypes(),
        });
      } catch (e) {
        console.error("POST /classification/taxonomy/axis", e);
        response.status(500).json({ error: e.message });
      }
    }
  );

  // [auto-docu] Delete a custom classification value. Blocked if a CONFIRMED
  // document still uses it (the user must re-classify those first). Base
  // (suggested) values cannot be deleted. On success the value is also cleared
  // from any non-confirmed (proposed) rows so it stops reappearing.
  const AXIS_FIELD = {
    workType: "workType",
    businessUnit: "businessUnit",
    domain: "domain",
  };
  const AXIS_SUGGESTED = {
    workType: WORK_TYPE.suggested,
    businessUnit: BUSINESS_UNIT.suggested,
    domain: DOMAIN.suggested,
  };

  async function deleteTaxonomyValue({
    field,
    settingLabel,
    suggested,
    value,
  }) {
    const v = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!v) return { status: 400, error: "삭제할 항목을 지정하세요." };
    if ((suggested || []).includes(v))
      return {
        status: 400,
        error: `"${v}"은(는) 기본 분류 항목이라 삭제할 수 없습니다.`,
      };

    const confirmedCount = await prisma.document_classifications
      .count({ where: { [field]: v, status: "confirmed" } })
      .catch(() => 0);
    if (confirmedCount > 0)
      return {
        status: 409,
        error: `"${v}"(으)로 이미 확정된 문서가 ${confirmedCount}건 있어 삭제할 수 없습니다. 먼저 해당 문서의 분류를 변경한 뒤 다시 시도하세요.`,
      };

    const current =
      field === "docType"
        ? await storedDocumentTypes()
        : await storedAxisValues(settingLabel);
    const next = current.filter((x) => x !== v);
    await prisma.system_settings.upsert({
      where: { label: settingLabel },
      update: { value: JSON.stringify(next) },
      create: { label: settingLabel, value: JSON.stringify(next) },
    });
    await prisma.document_classifications
      .updateMany({
        where: { [field]: v, status: { not: "confirmed" } },
        data: { [field]: field === "workType" ? "기타" : null },
      })
      .catch(() => {});
    return { status: 200 };
  }

  app.delete(
    "/classification/taxonomy/doc-type",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const result = await deleteTaxonomyValue({
          field: "docType",
          settingLabel: CUSTOM_DOC_TYPES_SETTING,
          suggested: DOC_TYPE.suggested,
          value: reqBody(request).value,
        });
        if (result.error)
          return response.status(result.status).json({ error: result.error });
        response
          .status(200)
          .json({ taxonomy: await taxonomyWithDocumentTypes() });
      } catch (e) {
        console.error("DELETE /classification/taxonomy/doc-type", e);
        response.status(500).json({ error: e.message });
      }
    }
  );

  app.delete(
    "/classification/taxonomy/axis",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { axis, value } = reqBody(request);
        const field = AXIS_FIELD[axis];
        const settingLabel = CUSTOM_AXIS_SETTINGS[axis];
        if (!field || !settingLabel)
          return response
            .status(400)
            .json({ error: "유효하지 않은 분류 축입니다." });
        const result = await deleteTaxonomyValue({
          field,
          settingLabel,
          suggested: AXIS_SUGGESTED[axis],
          value,
        });
        if (result.error)
          return response.status(result.status).json({ error: result.error });
        response
          .status(200)
          .json({ taxonomy: await taxonomyWithDocumentTypes() });
      } catch (e) {
        console.error("DELETE /classification/taxonomy/axis", e);
        response.status(500).json({ error: e.message });
      }
    }
  );

  app.get(
    "/classification/documents",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const workspaceSlug = String(request.query?.workspace || "").trim();
        const docs = await archiveDocuments(workspaceSlug || null);
        const classifications = await DocumentClassification.where({});
        const byHash = Object.fromEntries(
          classifications.map((c) => [c.contentHash, c])
        );
        const confirmerIds = [
          ...new Set(
            classifications
              .map((c) => c.confirmedBy)
              .filter((id) => Number.isInteger(id))
          ),
        ];
        const confirmers = confirmerIds.length
          ? await prisma.users.findMany({
              where: { id: { in: confirmerIds } },
              select: { id: true, username: true },
            })
          : [];
        const confirmerById = new Map(confirmers.map((u) => [u.id, u]));
        const uploaderIds = [
          ...new Set(
            docs
              .flatMap((d) => d.uploaders || [])
              .map((u) => u.userId)
              .filter((id) => Number.isInteger(id))
          ),
        ];
        const uploaders = uploaderIds.length
          ? await prisma.users.findMany({
              where: { id: { in: uploaderIds } },
              select: { id: true, username: true },
            })
          : [];
        const uploaderById = new Map(uploaders.map((u) => [u.id, u]));
        const out = docs.map((d) => {
          const cls = byHash[d.contentHash] || null;
          const wsList = [];
          const seen = new Set();
          for (const w of d.workspaces) {
            if (seen.has(w.slug)) continue;
            seen.add(w.slug);
            wsList.push(w);
          }
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
            documentLocations: d.docpaths,
            duplicatesByWorkspace,
            classification: cls
              ? {
                  ...cls,
                  confirmedByUser: confirmerById.get(cls.confirmedBy) || null,
                }
              : null,
            uploaders: [
              ...new Map(
                (d.uploaders || []).map((u) => [
                  `${u.userId || ""}:${u.orgUnit || ""}`,
                  {
                    userId: u.userId,
                    username: uploaderById.get(u.userId)?.username || null,
                    orgUnit: u.orgUnit,
                  },
                ])
              ).values(),
            ],
          };
        });
        response.status(200).json({ documents: out });
      } catch (e) {
        console.error("GET /classification/documents", e);
        response.status(500).json({ error: e.message });
      }
    }
  );

  app.get(
    "/classification/orphaned",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const workspace = String(request.query?.workspace || "").trim();
        response.status(200).json({
          documents: await orphanedWorkspaceDocuments(workspace || null),
        });
      } catch (e) {
        console.error("GET /classification/orphaned", e);
        response.status(500).json({ error: e.message });
      }
    }
  );

  app.post(
    "/classification/confirm-bulk",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const {
          contentHashes = [],
          docType,
          workType,
          businessUnit,
          domain,
          tags = [],
        } = reqBody(request);
        const hashes = [
          ...new Set(
            (Array.isArray(contentHashes) ? contentHashes : [])
              .map((hash) => String(hash || "").trim())
              .filter(Boolean)
          ),
        ];
        if (!hashes.length)
          return response.status(400).json({ error: "문서를 선택하세요." });
        // [auto-docu v14 P4] sensitivity dormant — no longer required for bulk confirm.
        if (!workType && !businessUnit && !docType && !domain)
          return response
            .status(400)
            .json({ error: "일괄 적용할 분류값을 하나 이상 지정하세요." });

        const userId = response.locals?.user?.id || null;
        const results = [];
        for (const contentHash of hashes) {
          results.push(
            await DocumentClassification.confirm({
              contentHash,
              workType,
              businessUnit,
              docType,
              domain,
              tags,
              userId,
            })
          );
        }
        const failed = results.filter((result) => result.error);
        response.status(200).json({
          confirmed: results.length - failed.length,
          failed: failed.length,
          errors: failed.map((result) => result.error),
        });
      } catch (e) {
        console.error("POST /classification/confirm-bulk", e);
        response.status(500).json({ error: e.message });
      }
    }
  );

  app.post(
    "/classification/:contentHash/type",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { contentHash } = request.params;
        const { docType = "" } = reqBody(request);
        const current = await DocumentClassification.get(contentHash);
        if (!current)
          return response
            .status(404)
            .json({ error: "분류 정보를 찾을 수 없습니다." });
        const row = await prisma.document_classifications.update({
          where: { contentHash },
          data: { docType: String(docType).trim() || null },
        });
        response.status(200).json({
          classification: DocumentClassification._serialize(row),
          error: null,
        });
      } catch (e) {
        console.error("POST /classification/:contentHash/type", e);
        response.status(500).json({ error: e.message });
      }
    }
  );

  app.post(
    "/classification/types",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { contentHashes = [], docType = "" } = reqBody(request);
        const hashes = [
          ...new Set(
            (Array.isArray(contentHashes) ? contentHashes : [])
              .map((hash) => String(hash || "").trim())
              .filter(Boolean)
          ),
        ];
        const normalizedType = String(docType).trim();
        if (!hashes.length)
          return response.status(400).json({ error: "문서를 선택하세요." });
        if (!normalizedType)
          return response
            .status(400)
            .json({ error: "이동할 분류 폴더를 선택하세요." });

        const result = await prisma.document_classifications.updateMany({
          where: { contentHash: { in: hashes } },
          data: { docType: normalizedType },
        });
        response.status(200).json({ updated: result.count, error: null });
      } catch (e) {
        console.error("POST /classification/types", e);
        response.status(500).json({ error: e.message });
      }
    }
  );

  app.delete(
    "/classification/documents",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { contentHashes = [] } = reqBody(request);
        const hashes = [
          ...new Set(
            (Array.isArray(contentHashes) ? contentHashes : [])
              .map((hash) => String(hash || "").trim())
              .filter(Boolean)
          ),
        ];
        if (!hashes.length)
          return response.status(400).json({ error: "문서를 선택하세요." });

        const docs = await archiveDocuments();
        const locations = [
          ...new Set(
            docs
              .filter((doc) => hashes.includes(doc.contentHash))
              .flatMap((doc) => doc.docpaths)
          ),
        ];
        for (const location of locations) await purgeDocument(location);
        response
          .status(200)
          .json({ deleted: hashes.length, locations: locations.length });
      } catch (e) {
        console.error("DELETE /classification/documents", e);
        response.status(500).json({ error: e.message });
      }
    }
  );

  app.post(
    "/classification/propose",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const { contentHash = null, workspace = null } = reqBody(request);
        const docs = await archiveDocuments(
          String(workspace || "").trim() || null
        );
        const existing = Object.fromEntries(
          (await DocumentClassification.where({})).map((c) => [
            c.contentHash,
            c,
          ])
        );
        // [auto-docu v14 P4] a classification is "done" once the business axes
        // are set — sensitivity is dormant (no tier routing), so it no longer
        // gates re-proposal or reference-example selection.
        const isDone = (cls) =>
          cls?.status === "confirmed" &&
          cls.workType &&
          cls.businessUnit &&
          cls.docType &&
          cls.domain;
        const referenceDocs = docs
          .map((doc) => ({ ...doc, classification: existing[doc.contentHash] }))
          .filter((doc) => isDone(doc.classification));
        const targets = docs.filter((d) => {
          if (contentHash) return d.contentHash === contentHash;
          return !isDone(existing[d.contentHash]);
        });

        const results = [];
        for (const d of targets) {
          const text = await textForHash(d);
          if (!text) {
            results.push({ contentHash: d.contentHash, error: "no text" });
            continue;
          }
          const examples = referenceDocs
            .filter((reference) => reference.contentHash !== d.contentHash)
            .sort((a, b) => {
              const extension = (title) =>
                String(title || "")
                  .split(".")
                  .pop()
                  ?.toLowerCase();
              return (
                Number(extension(b.title) === extension(d.title)) -
                Number(extension(a.title) === extension(d.title))
              );
            })
            .slice(0, 8)
            .map((reference) => ({
              title: reference.title,
              ...reference.classification,
            }));
          const { classification, error } =
            await DocumentClassification.proposeFor({
              contentHash: d.contentHash,
              title: d.title,
              text,
              docSource: d.docSource,
              parsePath: d.parsePath,
              examples,
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
        const { sensitivity, workType, businessUnit, docType, domain, tags } =
          reqBody(request);
        const { classification, error } = await DocumentClassification.confirm({
          contentHash,
          sensitivity,
          workType,
          businessUnit,
          docType,
          domain,
          tags,
          userId: response.locals?.user?.id ?? null,
        });
        if (error) return response.status(400).json({ error });
        const confirmer = response.locals?.user;
        response.status(200).json({
          classification: {
            ...classification,
            confirmedByUser:
              classification.confirmedBy &&
              confirmer?.id === classification.confirmedBy
                ? { id: confirmer.id, username: confirmer.username }
                : null,
          },
        });
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
