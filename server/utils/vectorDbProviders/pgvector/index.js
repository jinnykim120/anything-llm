const { VectorDatabase } = require("../base");
const SearchTuning = require("./searchTuning");
const Schema = require("./schema");
const Retrieval = require("./retrieval");

/*
 Embedding Table Schema (table name defined by user)
 - id: UUID PRIMARY KEY
 - namespace: TEXT
 - embedding: vector(xxxx)
 - metadata: JSONB
 - created_at: TIMESTAMP

 [auto-docu] This class was split into searchTuning.js (stateless tuning
 helpers), schema.js (connection/table/namespace management) and
 retrieval.js (search pipeline) for maintainability — the class below is a
 thin delegator layer so every method/static keeps its original name and
 signature for external callers (including jest.spyOn(instance, "...") in
 index.test.js, which spies on this instance, not the extracted modules).
 Extracted methods take `this` as an explicit first parameter instead of
 using `this` directly, so they never need to require this file back
 (avoids a circular require).
*/

class PGVector extends VectorDatabase {
  constructor() {
    super();
  }

  get name() {
    return "PGVector";
  }

  connectionTimeout = 30_000;
  // Possible for this to be a user-configurable option in the future.
  // Will require a handler per operator to ensure scores are normalized.
  operator = {
    l2: "<->",
    innerProduct: "<#>",
    cosine: "<=>",
    l1: "<+>",
    hamming: "<~>",
    jaccard: "<%>",
  };
  getTablesSql =
    "SELECT * FROM pg_catalog.pg_tables WHERE schemaname = 'public'";
  getEmbeddingTableSchemaSql =
    "SELECT column_name,data_type FROM information_schema.columns WHERE table_name = $1";
  createExtensionSql = "CREATE EXTENSION IF NOT EXISTS vector;";

  static tableName() {
    return SearchTuning.tableName();
  }

  static connectionString() {
    return SearchTuning.connectionString();
  }

  static integerSetting(name, fallback, min, max) {
    return SearchTuning.integerSetting(name, fallback, min, max);
  }

  static hnswSettings() {
    return SearchTuning.hnswSettings();
  }

  static rerankCandidateLimit(totalEmbeddings, topN = 4) {
    return SearchTuning.rerankCandidateLimit(totalEmbeddings, topN);
  }

  static indexName(suffix) {
    return SearchTuning.indexName(suffix);
  }

  static lexicalSearchTerms(input = "") {
    return SearchTuning.lexicalSearchTerms(input);
  }

  static termMatchRatio(terms = [], text = "") {
    return SearchTuning.termMatchRatio(terms, text);
  }

  static termTagOverlap(terms = [], tags = []) {
    return SearchTuning.termTagOverlap(terms, tags);
  }

  static docYearTokens(title = "") {
    return SearchTuning.docYearTokens(title);
  }

  static docCompanyTag(title = "") {
    return SearchTuning.docCompanyTag(title);
  }

  static hybridWeights() {
    return SearchTuning.hybridWeights();
  }

  createTableSql(dimensions) {
    return Schema.createTableSql(this, dimensions);
  }

  createIndexSql() {
    return Schema.createIndexSql(this);
  }

  async configureVectorSearch(client) {
    return Schema.configureVectorSearch(this, client);
  }

  sanitizeForJsonb(value) {
    return Schema.sanitizeForJsonb(this, value);
  }

  prepareDocumentData(documentData = {}) {
    return Schema.prepareDocumentData(this, documentData);
  }

  client(connectionString = null) {
    return Schema.client(this, connectionString);
  }

  async validateExistingEmbeddingTableSchema(pgClient, tableName) {
    return Schema.validateExistingEmbeddingTableSchema(
      this,
      pgClient,
      tableName
    );
  }

  /**
   * Validate the connection to the database and verify that the table does not already exist.
   * so that anythingllm can manage the table directly.
   *
   * @param {{connectionString: string | null, tableName: string | null}} params
   * @returns {Promise<{error: string | null, success: boolean}>}
   */
  static async validateConnection({
    connectionString = null,
    tableName = null,
  }) {
    if (!connectionString) throw new Error("No connection string provided");
    const instance = new PGVector();

    try {
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            error: `Connection timeout (${(instance.connectionTimeout / 1000).toFixed(0)}s). Please check your connection string and try again.`,
            success: false,
          });
        }, instance.connectionTimeout);
      });

      const connectionPromise = new Promise(async (resolve) => {
        let pgClient = null;
        try {
          pgClient = instance.client(connectionString);
          await pgClient.connect();
          const result = await pgClient.query(instance.getTablesSql);

          if (result.rows.length !== 0 && !!tableName) {
            const tableExists = result.rows.some(
              (row) => row.tablename === tableName
            );
            if (tableExists)
              await instance.validateExistingEmbeddingTableSchema(
                pgClient,
                tableName
              );
          }
          resolve({ error: null, success: true });
        } catch (err) {
          resolve({ error: err.message, success: false });
        } finally {
          if (pgClient) await pgClient.end();
        }
      });

      // Race the connection attempt against the timeout
      const result = await Promise.race([connectionPromise, timeoutPromise]);
      return result;
    } catch (err) {
      instance.logger("Validation Error:", err.message);
      let readableError = err.message;
      switch (true) {
        case err.message.includes("ECONNREFUSED"):
          readableError =
            "The host could not be reached. Please check your connection string and try again.";
          break;
        default:
          break;
      }
      return { error: readableError, success: false };
    }
  }

  /**
   * Test the connection to the database directly.
   * @returns {{error: string | null, success: boolean}}
   */
  async testConnectionToDB() {
    return Schema.testConnectionToDB(this);
  }

  async connect() {
    return Schema.connect(this);
  }

  async heartbeat() {
    return Schema.heartbeat(this);
  }

  async dbTableExists() {
    return Schema.dbTableExists(this);
  }

  async totalVectors() {
    return Schema.totalVectors(this);
  }

  distanceToSimilarity(distance = null) {
    return Schema.distanceToSimilarity(this, distance);
  }

  async namespaceCount(namespace = null) {
    return Schema.namespaceCount(this, namespace);
  }

  normalizeVector(vector) {
    return Schema.normalizeVector(this, vector);
  }

  async updateOrCreateCollection({
    connection,
    submissions,
    namespace,
    dimensions = 384,
  }) {
    return Schema.updateOrCreateCollection(this, {
      connection,
      submissions,
      namespace,
      dimensions,
    });
  }

  async createTableIfNotExists(connection, dimensions = 384) {
    return Schema.createTableIfNotExists(this, connection, dimensions);
  }

  async namespace(connection, namespace = null) {
    return Schema.namespace(this, connection, namespace);
  }

  async hasNamespace(namespace = null) {
    return Schema.hasNamespace(this, namespace);
  }

  async namespaceExists(connection, namespace = null) {
    return Schema.namespaceExists(this, connection, namespace);
  }

  async deleteVectorsInNamespace(connection, namespace = null) {
    return Schema.deleteVectorsInNamespace(this, connection, namespace);
  }

  async addDocumentToNamespace(
    namespace,
    documentData = {},
    fullFilePath = null,
    skipCache = false
  ) {
    return Schema.addDocumentToNamespace(
      this,
      namespace,
      documentData,
      fullFilePath,
      skipCache
    );
  }

  async deleteDocumentFromNamespace(namespace, docId) {
    return Schema.deleteDocumentFromNamespace(this, namespace, docId);
  }

  async lexicalSearchResponse(params) {
    return Retrieval.lexicalSearchResponse(this, params);
  }

  async tagsForDocIds(docIds = []) {
    return Retrieval.tagsForDocIds(this, docIds);
  }

  async similarityResponse(params) {
    return Retrieval.similarityResponse(this, params);
  }

  async rerankedSimilarityResponse(params) {
    return Retrieval.rerankedSimilarityResponse(this, params);
  }

  async expandSections(params) {
    return Retrieval.expandSections(this, params);
  }

  /**
   * [auto-docu v14 P1] Retrieval pipeline entry point — see retrieval.js for
   * the full rationale (dense candidate pull, per-document cap, additive
   * lexical merge, hybrid rerank, conservative whole-section expansion).
   */
  async performSimilaritySearch(params) {
    return Retrieval.performSimilaritySearch(this, params);
  }

  async "namespace-stats"(reqBody = {}) {
    return Schema.namespaceStats(this, reqBody);
  }

  async "delete-namespace"(reqBody = {}) {
    return Schema.deleteNamespace(this, reqBody);
  }

  async reset() {
    return Schema.reset(this);
  }

  curateSources(sources = []) {
    return Schema.curateSources(this, sources);
  }
}

module.exports.PGVector = PGVector;
