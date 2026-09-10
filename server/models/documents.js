const { v4: uuidv4 } = require("uuid");
const { getVectorDbClass } = require("../utils/helpers");
const prisma = require("../utils/prisma");
const { Telemetry } = require("./telemetry");
const { EventLogs } = require("./eventLogs");
const { safeJsonParse } = require("../utils/http");
const { getModelTag } = require("../endpoints/utils");
const fs = require("fs");
const path = require("path");
const pathModule = path;
const crypto = require("crypto");
const documentsPath =
  process.env.NODE_ENV === "development"
    ? path.resolve(__dirname, "../storage/documents")
    : path.resolve(
        process.env.STORAGE_DIR || path.resolve(__dirname, "../storage"),
        "documents"
      );

const Document = {
  writable: ["pinned", "watched", "lastUpdatedAt"],
  /**
   * @param {import("@prisma/client").workspace_documents} document - Document PrismaRecord
   * @returns {{
   *  metadata: (null|object),
   *  type: import("./documentSyncQueue.js").validFileType,
   *  source: string
   * }}
   */
  parseDocumentTypeAndSource: function (document) {
    const metadata = safeJsonParse(document.metadata, null);
    if (!metadata) return { metadata: null, type: null, source: null };

    // Parse the correct type of source and its original source path.
    const idx = metadata.chunkSource.indexOf("://");
    const [type, source] = [
      metadata.chunkSource.slice(0, idx),
      metadata.chunkSource.slice(idx + 3),
    ];
    return { metadata, type, source: this._stripSource(source, type) };
  },

  forWorkspace: async function (workspaceId = null) {
    if (!workspaceId) return [];
    return await prisma.workspace_documents.findMany({
      where: { workspaceId },
    });
  },

  delete: async function (clause = {}) {
    try {
      await prisma.workspace_documents.deleteMany({ where: clause });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  get: async function (clause = {}) {
    try {
      const document = await prisma.workspace_documents.findFirst({
        where: clause,
      });
      return document || null;
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  where: async function (
    clause = {},
    limit = null,
    orderBy = null,
    include = null,
    select = null
  ) {
    try {
      const results = await prisma.workspace_documents.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
        ...(include !== null ? { include } : {}),
        ...(select !== null ? { select: { ...select } } : {}),
      });
      return results;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  addDocuments: async function (
    workspace,
    additions = [],
    userId = null,
    opts = {}
  ) {
    const { allowDuplicates = false } = opts;
    const VectorDb = getVectorDbClass();
    if (additions.length === 0) return { failed: [], embedded: [] };
    const { fileData } = require("../utils/files");
    const { emitProgress } = require("../utils/EmbeddingWorkerManager");
    const embedded = [];
    const failedToEmbed = [];
    const errors = new Set();

    // [auto-docu v14 P2] content-hash dedup ONLY — a re-uploaded document gets a
    // fresh docpath (new uuid) every time, so the docpath checks upstream never
    // catch a byte-identical re-upload. Skip an addition whose normalized text
    // hash already lives in this workspace.
    //
    // The earlier filename/title dedup was removed: a corporate archive is full
    // of genuinely different files that share a name (붙임.pdf, 보고서.pdf), and
    // silently skipping the second one is worse than a duplicate. Pass
    // `opts.allowDuplicates` to skip the content-hash check too (re-ingest).
    const skippedDuplicates = [];
    const existingHashes = new Map();
    if (!allowDuplicates) {
      for (const wd of await prisma.workspace_documents.findMany({
        where: { workspaceId: workspace.id },
        select: { metadata: true, filename: true },
      })) {
        const h = safeJsonParse(wd.metadata, {})?.content_hash;
        if (h) existingHashes.set(h, wd.filename);
      }
    }

    emitProgress(workspace.slug, {
      type: "batch_starting",
      workspaceSlug: workspace.slug,
      userId,
      filenames: additions,
      totalDocs: additions.length,
    });

    for (const [index, path] of additions.entries()) {
      const docProgress = {
        workspaceSlug: workspace.slug,
        userId,
        filename: path,
        docIndex: index,
        totalDocs: additions.length,
      };

      const data = await fileData(path);
      if (!data) {
        emitProgress(workspace.slug, {
          type: "doc_failed",
          ...docProgress,
          error: "Failed to load file data",
        });
        continue;
      }

      // Some spreadsheet sheet outputs do not carry the collector hash. Give
      // them the same stable content hash contract as other parsed documents
      // so classification and deduplication can see them too.
      if (!data.content_hash && data.pageContent) {
        data.content_hash = crypto
          .createHash("sha256")
          .update(String(data.pageContent).replace(/\s+/g, " ").trim())
          .digest("hex");
      }

      const filename = path.split(/[/\\]/).pop();
      if (
        !allowDuplicates &&
        data.content_hash &&
        existingHashes.has(data.content_hash)
      ) {
        const dupOf = existingHashes.get(data.content_hash);
        console.log(
          `[auto-docu] skipping ${filename} — byte-identical content to "${dupOf}" already in ${workspace.slug}`
        );
        skippedDuplicates.push({ path, duplicateOf: dupOf });
        emitProgress(workspace.slug, {
          type: "doc_failed",
          ...docProgress,
          error: `중복 문서 — "${dupOf}"와 내용이 완전히 동일해 건너뜀`,
        });
        continue;
      }

      const docId = uuidv4();
      // [auto-docu P1a] `blocks` (parse-time page/bbox units) is large and only
      // needed for chunking — keep it out of the workspace_documents metadata row.
      // parse_path / parse_confidence are small and kept (drive the P1b re-parse queue).
      const { pageContent: _pageContent, blocks: _blocks, ...metadata } = data;
      const storedPath = pathModule.isAbsolute(path)
        ? pathModule.relative(documentsPath, path)
        : path;
      const newDoc = {
        docId,
        filename,
        docpath: storedPath,
        workspaceId: workspace.id,
        uploadedByUserId: userId ? Number(userId) : null,
        // Filled when the organization directory is connected. Keep the
        // upload-time snapshot separate from the classification axes.
        uploadedByOrgUnit: null,
        metadata: JSON.stringify(metadata),
      };

      emitProgress(workspace.slug, { type: "doc_starting", ...docProgress });

      global.__embeddingProgress = {
        workspaceSlug: workspace.slug,
        filename: path,
        userId,
      };

      const { vectorized, error } = await VectorDb.addDocumentToNamespace(
        workspace.slug,
        { ...data, docId },
        path
      );

      if (!vectorized) {
        console.error(
          "Failed to vectorize",
          metadata?.title || newDoc.filename
        );
        failedToEmbed.push(metadata?.title || newDoc.filename);
        errors.add(error);
        emitProgress(workspace.slug, {
          type: "doc_failed",
          ...docProgress,
          error: error || "Unknown error",
        });
        continue;
      }

      try {
        await prisma.workspace_documents.create({ data: newDoc });
        embedded.push(storedPath);
        if (data.content_hash)
          existingHashes.set(data.content_hash, newDoc.filename);
        // [auto-docu P4] opt-in: propose a classification as the doc lands, so
        // the review screen isn't empty. Fire-and-forget (an LLM call each) —
        // off by default so a bulk load doesn't hammer the LLM / hit rate limits;
        // the "미확정 N건 분류 제안" button is the batch path.
        if (process.env.CLASSIFY_ON_INGEST === "true" && data.content_hash) {
          const {
            DocumentClassification,
          } = require("./documentClassification");
          DocumentClassification.proposeFor({
            contentHash: data.content_hash,
            title: data.title,
            text: data.pageContent,
            docSource: data.docSource,
            parsePath: data.parse_path,
          }).catch((e) =>
            console.error("[auto-docu classify-on-ingest]", e.message)
          );
        }
        emitProgress(workspace.slug, {
          type: "doc_complete",
          ...docProgress,
        });
      } catch (error) {
        console.error(error.message);
        emitProgress(workspace.slug, {
          type: "doc_failed",
          ...docProgress,
          error: "Failed to save document record",
        });
      }
    }

    global.__embeddingProgress = null;

    emitProgress(workspace.slug, {
      type: "all_complete",
      workspaceSlug: workspace.slug,
      userId,
      totalDocs: additions.length,
      embedded: embedded.length,
      failed: failedToEmbed.length,
    });

    await Telemetry.sendTelemetry("documents_embedded_in_workspace", {
      LLMSelection: process.env.LLM_PROVIDER || "openai",
      Embedder: process.env.EMBEDDING_ENGINE || "inherit",
      VectorDbSelection: process.env.VECTOR_DB || "lancedb",
      TTSSelection: process.env.TTS_PROVIDER || "native",
      LLMModel: getModelTag(),
    });
    await EventLogs.logEvent(
      "workspace_documents_added",
      {
        workspaceName: workspace?.name || "Unknown Workspace",
        numberOfDocumentsAdded: additions.length,
      },
      userId
    );
    return {
      failedToEmbed,
      errors: Array.from(errors),
      embedded,
      skippedDuplicates,
    };
  },

  /**
   * Remove documents from a workspace.
   * [auto-docu v14 P2] `opts.purgeSource` also deletes the parsed source file and
   * its vector-cache entry once no other workspace still references that docpath
   * — so "remove from workspace" is a real delete, not a row-only delete that
   * leaves the file (and a stale vector cache) on disk to resurrect later.
   * The "move to another workspace" flow must NOT pass it (it re-reads the file).
   * @param {object} [opts]
   * @param {boolean} [opts.purgeSource=false]
   */
  removeDocuments: async function (
    workspace,
    removals = [],
    userId = null,
    opts = {}
  ) {
    const { purgeSource = false } = opts;
    const VectorDb = getVectorDbClass();
    if (removals.length === 0) return;
    const { purgeSourceDocument, purgeVectorCache } = require("../utils/files");

    for (const path of removals) {
      let document = await this.get({
        docpath: path,
        workspaceId: workspace.id,
      });
      // [auto-docu v14 P2] Tolerate a docpath that doesn't match exactly — a
      // legacy row may hold an absolute path while the caller passes the
      // relative one (or vice-versa). Fall back to a basename match within the
      // workspace before giving up.
      if (!document) {
        const base = String(path).split(/[/\\]/).pop();
        const candidates = await this.where({ workspaceId: workspace.id });
        document = candidates.find(
          (d) => String(d.docpath).split(/[/\\]/).pop() === base
        );
      }
      if (!document) {
        console.warn(
          `[auto-docu] removeDocuments: no workspace_documents row for "${path}" in ${workspace.slug} — skipping.`
        );
        continue;
      }
      await VectorDb.deleteDocumentFromNamespace(
        workspace.slug,
        document.docId
      );

      try {
        await prisma.workspace_documents.delete({
          where: { id: document.id, workspaceId: workspace.id },
        });
        await prisma.document_vectors.deleteMany({
          where: { docId: document.docId },
        });
      } catch (error) {
        console.error(error.message);
      }

      if (purgeSource) {
        const stillReferenced = await prisma.workspace_documents.count({
          where: { docpath: document.docpath },
        });
        if (stillReferenced === 0) {
          await purgeSourceDocument(document.docpath).catch((e) =>
            console.error("[auto-docu] purgeSourceDocument", e.message)
          );
          await purgeVectorCache(document.docpath).catch((e) =>
            console.error("[auto-docu] purgeVectorCache", e.message)
          );
        }
      }
    }

    await EventLogs.logEvent(
      "workspace_documents_removed",
      {
        workspaceName: workspace?.name || "Unknown Workspace",
        numberOfDocuments: removals.length,
      },
      userId
    );
    return true;
  },

  pruneMissingDocuments: async function (workspace, userId = null) {
    if (!workspace?.id) return { removed: 0 };
    const documents = await this.forWorkspace(workspace.id);
    const missing = documents.filter((document) => {
      const fullPath = path.resolve(documentsPath, document.docpath || "");
      return (
        !document.docpath ||
        !fullPath.startsWith(`${documentsPath}${path.sep}`) ||
        !fs.existsSync(fullPath)
      );
    });
    if (!missing.length) return { removed: 0 };
    await this.removeDocuments(
      workspace,
      missing.map((document) => document.docpath),
      userId
    );
    return { removed: missing.length };
  },

  /**
   * [auto-docu v14 P2] Rebuild a workspace's vector index from the parsed source
   * files still on disk. The recovery action for drifted ingestion state — orphan
   * vectors, half-deleted docs, or an embedding model / dimension change.
   * Classifications (keyed by content_hash) survive.
   */
  rebuildWorkspace: async function (workspace, userId = null) {
    if (!workspace?.id) return { requested: 0, embedded: 0, failed: [] };
    const VectorDb = getVectorDbClass();
    const {
      purgeVectorCache,
      purgeSourceDocument: _p,
    } = require("../utils/files");

    const docs = await this.forWorkspace(workspace.id);
    const docpaths = [...new Set(docs.map((d) => d.docpath).filter(Boolean))];
    const docIds = docs.map((d) => d.docId).filter(Boolean);

    await VectorDb["delete-namespace"]({ namespace: workspace.slug }).catch(
      (e) => console.error("[auto-docu] rebuild: delete-namespace", e.message)
    );
    if (docIds.length)
      await prisma.document_vectors.deleteMany({
        where: { docId: { in: docIds } },
      });
    await prisma.workspace_documents.deleteMany({
      where: { workspaceId: workspace.id },
    });
    for (const p of docpaths) await purgeVectorCache(p).catch(() => {});

    const {
      embedded = [],
      failedToEmbed = [],
      errors = [],
    } = await this.addDocuments(workspace, docpaths, userId, {
      allowDuplicates: true,
    });
    return {
      requested: docpaths.length,
      embedded: embedded.length,
      failed: failedToEmbed,
      errors,
    };
  },

  count: async function (clause = {}, limit = null) {
    try {
      const count = await prisma.workspace_documents.count({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
      });
      return count;
    } catch (error) {
      console.error("FAILED TO COUNT DOCUMENTS.", error.message);
      return 0;
    }
  },
  update: async function (id = null, data = {}) {
    if (!id) throw new Error("No workspace document id provided for update");

    const validKeys = Object.keys(data).filter((key) =>
      this.writable.includes(key)
    );
    if (validKeys.length === 0)
      return { document: { id }, message: "No valid fields to update!" };

    try {
      const document = await prisma.workspace_documents.update({
        where: { id },
        data,
      });
      return { document, message: null };
    } catch (error) {
      console.error(error.message);
      return { document: null, message: error.message };
    }
  },
  _updateAll: async function (clause = {}, data = {}) {
    try {
      await prisma.workspace_documents.updateMany({
        where: clause,
        data,
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },
  content: async function (docId) {
    if (!docId) throw new Error("No workspace docId provided!");
    const document = await this.get({ docId: String(docId) });
    if (!document) throw new Error(`Could not find a document by id ${docId}`);

    const { fileData } = require("../utils/files");
    const data = await fileData(document.docpath);
    return { title: data.title, content: data.pageContent };
  },
  contentByDocPath: async function (docPath) {
    const { fileData } = require("../utils/files");
    const data = await fileData(docPath);
    return { title: data.title, content: data.pageContent };
  },

  // Some data sources have encoded params in them we don't want to log - so strip those details.
  _stripSource: function (sourceString, type) {
    if (["confluence", "github"].includes(type)) {
      const _src = new URL(sourceString);
      _src.search = ""; // remove all search params that are encoded for resync.
      return _src.toString();
    }

    return sourceString;
  },

  /**
   * Functions for the backend API endpoints - not to be used by the frontend or elsewhere.
   * @namespace api
   */
  api: {
    /**
     * Process a document upload from the API and upsert it into the database. This
     * functionality should only be used by the backend /v1/documents/upload endpoints for post-upload embedding.
     * @param {string} wsSlugs - The slugs of the workspaces to embed the document into, will be comma-separated list of workspace slugs
     * @param {string} docLocation - The location/path of the document that was uploaded
     * @returns {Promise<boolean>} - True if the document was uploaded successfully, false otherwise
     */
    uploadToWorkspace: async function (wsSlugs = "", docLocation = null) {
      if (!docLocation)
        return console.log(
          "No document location provided for embedding",
          docLocation
        );

      const slugs = wsSlugs
        .split(",")
        .map((slug) => String(slug)?.trim()?.toLowerCase());
      if (slugs.length === 0)
        return console.log(`No workspaces provided got: ${wsSlugs}`);

      const { Workspace } = require("./workspace");
      const workspaces = await Workspace.where({ slug: { in: slugs } });
      if (workspaces.length === 0)
        return console.log("No valid workspaces found for slugs: ", slugs);

      // Upsert the document into each workspace - do this sequentially
      // because the document may be large and we don't want to overwhelm the embedder, plus on the first
      // upsert we will then have the cache of the document - making n+1 embeds faster. If we parallelize this
      // we will have to do a lot of extra work to ensure that the document is not embedded more than once.
      for (const workspace of workspaces) {
        const { failedToEmbed = [], errors = [] } = await Document.addDocuments(
          workspace,
          [docLocation]
        );
        if (failedToEmbed.length > 0)
          return console.log(
            `Failed to embed document into workspace ${workspace.slug}`,
            errors
          );
        console.log(`Document embedded into workspace ${workspace.slug}...`);
      }

      return true;
    },
  },
};

module.exports = { Document };
