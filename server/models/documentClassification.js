// [auto-docu P4] Per-document-content classification, keyed by content_hash.
// One row per distinct document (shared across workspaces + survives re-ingest).
const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");
const { classifyDocument } = require("../utils/classification/classify");
const {
  normalizeSensitivity,
  SENSITIVITY,
} = require("../utils/classification/taxonomy");

const DocumentClassification = {
  writable: ["sensitivity", "docType", "domain", "tags", "status", "rationale"],

  _serialize(row) {
    if (!row) return null;
    return {
      ...row,
      tags: safeJsonParse(row.tags, []),
    };
  },

  get: async function (contentHash) {
    if (!contentHash) return null;
    const row = await prisma.document_classifications
      .findUnique({ where: { contentHash } })
      .catch(() => null);
    return this._serialize(row);
  },

  where: async function (clause = {}, limit = null, orderBy = null) {
    const rows = await prisma.document_classifications
      .findMany({
        where: clause,
        ...(limit ? { take: limit } : {}),
        ...(orderBy ? { orderBy } : {}),
      })
      .catch(() => []);
    return rows.map((r) => this._serialize(r));
  },

  /**
   * Store or update the LLM proposal for a content hash. A row already
   * `confirmed` by a human is left untouched.
   * @returns {Promise<object|null>}
   */
  upsertProposal: async function ({
    contentHash,
    sensitivity,
    docType,
    domain,
    tags = [],
    rationale = null,
    proposedBy = null,
    sampleTitle = null,
  }) {
    if (!contentHash) return null;
    const existing = await prisma.document_classifications
      .findUnique({ where: { contentHash } })
      .catch(() => null);
    if (existing?.status === "confirmed") return this._serialize(existing);

    const data = {
      sensitivity: normalizeSensitivity(sensitivity),
      docType: docType || null,
      domain: domain || null,
      tags: JSON.stringify(Array.isArray(tags) ? tags : []),
      status: "proposed",
      rationale: rationale || null,
      source: `llm:${proposedBy || "unknown"}`,
      proposedBy: proposedBy || null,
      ...(sampleTitle ? { sampleTitle } : {}),
    };
    const row = await prisma.document_classifications
      .upsert({
        where: { contentHash },
        update: data,
        create: { contentHash, ...data },
      })
      .catch((e) => {
        console.error("DocumentClassification.upsertProposal", e.message);
        return null;
      });
    return this._serialize(row);
  },

  /** A human accepts or edits the classification. */
  confirm: async function ({
    contentHash,
    sensitivity,
    docType,
    domain,
    tags,
    userId = null,
  }) {
    if (!contentHash) return { classification: null, error: "no contentHash" };
    // Confirming REQUIRES a definite call — "uncertain" / "unclassified" can't
    // be confirmed; the doc stays held until a human picks a real tier.
    if (
      sensitivity !== undefined &&
      !SENSITIVITY.confirmable.includes(normalizeSensitivity(sensitivity))
    )
      return {
        classification: null,
        error:
          "민감도를 '일반 범용' 또는 '격리·민감'으로 지정해야 확정할 수 있습니다.",
      };
    const existing = await prisma.document_classifications
      .findUnique({ where: { contentHash } })
      .catch(() => null);

    const data = {
      status: "confirmed",
      source: "human",
      confirmedBy: userId ?? null,
      ...(sensitivity !== undefined
        ? { sensitivity: normalizeSensitivity(sensitivity) }
        : {}),
      ...(docType !== undefined ? { docType: docType || null } : {}),
      ...(domain !== undefined ? { domain: domain || null } : {}),
      ...(tags !== undefined
        ? { tags: JSON.stringify(Array.isArray(tags) ? tags : []) }
        : {}),
    };

    const row = await prisma.document_classifications
      .upsert({
        where: { contentHash },
        update: data,
        create: {
          contentHash,
          sensitivity: normalizeSensitivity(sensitivity ?? "confidential"),
          docType: docType || null,
          domain: domain || null,
          tags: JSON.stringify(Array.isArray(tags) ? tags : []),
          status: "confirmed",
          source: "human",
          confirmedBy: userId ?? null,
        },
      })
      .catch((e) => ({ error: e.message }));
    if (row?.error) return { classification: null, error: row.error };
    return {
      classification: this._serialize(row),
      error: null,
      existed: !!existing,
    };
  },

  /**
   * Run the LLM classifier for a document and store the proposal.
   * @param {{contentHash:string, title?:string, text:string, docSource?:string, parsePath?:string}} doc
   */
  proposeFor: async function (doc = {}) {
    if (!doc?.contentHash || !doc?.text)
      return { classification: null, error: "contentHash and text required" };
    const existing = await this.get(doc.contentHash);
    if (existing?.status === "confirmed")
      return { classification: existing, error: null, skipped: "confirmed" };

    let result;
    try {
      result = await classifyDocument({
        title: doc.title,
        text: doc.text,
        docSource: doc.docSource,
        parsePath: doc.parsePath,
      });
    } catch (e) {
      return { classification: null, error: e.message };
    }

    const row = await this.upsertProposal({
      contentHash: doc.contentHash,
      sensitivity: result.sensitivity,
      docType: result.doc_type,
      domain: result.domain,
      tags: result.tags,
      rationale: result.rationale,
      proposedBy: result.model,
      sampleTitle: doc.title || null,
    });
    return { classification: row, error: null };
  },
};

module.exports = { DocumentClassification };
