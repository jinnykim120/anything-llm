const pgsql = require("pg");
const { toChunks, getEmbeddingEngineSelection } = require("../../helpers");
const { TextSplitter } = require("../../TextSplitter");
const { v4: uuidv4 } = require("uuid");
const { sourceIdentifier } = require("../../chats");
const { NativeEmbeddingReranker } = require("../../EmbeddingRerankers/native");
const { VectorDatabase } = require("../base");

/*
 Embedding Table Schema (table name defined by user)
 - id: UUID PRIMARY KEY
 - namespace: TEXT
 - embedding: vector(xxxx)
 - metadata: JSONB
 - created_at: TIMESTAMP
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

  /**
   * Get the table name for the PGVector database.
   * - Defaults to "anythingllm_vectors" if no table name is provided.
   * @returns {string}
   */
  static tableName() {
    return process.env.PGVECTOR_TABLE_NAME || "anythingllm_vectors";
  }

  /**
   * Get the connection string for the PGVector database.
   * - Requires a connection string to be present in the environment variables.
   * @returns {string | null}
   */
  static connectionString() {
    return process.env.PGVECTOR_CONNECTION_STRING;
  }

  static integerSetting(name, fallback, min, max) {
    const parsed = Number.parseInt(process.env[name], 10);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  static hnswSettings() {
    return {
      m: this.integerSetting("PGVECTOR_HNSW_M", 16, 2, 100),
      efConstruction: this.integerSetting(
        "PGVECTOR_HNSW_EF_CONSTRUCTION",
        64,
        4,
        1_000
      ),
      efSearch: this.integerSetting("PGVECTOR_HNSW_EF_SEARCH", 40, 1, 1_000),
    };
  }

  static indexName(suffix) {
    const base = PGVector.tableName().replace(/[^a-zA-Z0-9_]/g, "_");
    return `${base}_${suffix}`.slice(0, 63);
  }

  createTableSql(dimensions) {
    return `CREATE TABLE IF NOT EXISTS "${PGVector.tableName()}" (id UUID PRIMARY KEY, namespace TEXT, embedding vector(${Number(dimensions)}), metadata JSONB, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`;
  }

  createIndexSql() {
    const { m, efConstruction } = PGVector.hnswSettings();
    return [
      `CREATE INDEX IF NOT EXISTS "${PGVector.indexName("namespace_idx")}" ON "${PGVector.tableName()}" (namespace)`,
      `CREATE INDEX IF NOT EXISTS "${PGVector.indexName("embedding_hnsw_idx")}" ON "${PGVector.tableName()}" USING hnsw (embedding vector_cosine_ops) WITH (m = ${m}, ef_construction = ${efConstruction})`,
    ];
  }

  async configureVectorSearch(client) {
    const { efSearch } = PGVector.hnswSettings();
    await client.query(`SET hnsw.ef_search = ${efSearch}`);
  }

  /**
   * Recursively sanitize values intended for JSONB to prevent Postgres errors
   * like "unsupported Unicode escape sequence". This primarily removes the
   * NUL character (\u0000) and other disallowed control characters from
   * strings. Arrays and objects are traversed and sanitized deeply.
   * @param {any} value
   * @returns {any}
   */
  sanitizeForJsonb(value) {
    // Fast path for null/undefined and primitives that do not need changes
    if (value === null || value === undefined) return value;

    // Strings: strip NUL and unsafe C0 control characters except common whitespace
    if (typeof value === "string") {
      // Build a sanitized string by excluding C0 control characters except
      // horizontal tab (9), line feed (10), and carriage return (13).
      let sanitized = "";
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code === 9 || code === 10 || code === 13 || code >= 0x20) {
          sanitized += value[i];
        }
      }
      return sanitized;
    }

    // Arrays: sanitize each element
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeForJsonb(item));
    }

    // Dates: keep as ISO string
    if (value instanceof Date) {
      return value.toISOString();
    }

    // Objects: sanitize each property value
    if (typeof value === "object") {
      const result = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.sanitizeForJsonb(v);
      }
      return result;
    }

    // Numbers, booleans, etc.
    return value;
  }

  /**
   * Keep per-document fields out of chunk JSONB while retaining the stable
   * retrieval metadata shared with LanceDB.
   */
  prepareDocumentData(documentData = {}) {
    const {
      pageContent,
      docId,
      blocks,
      file_hash: _fileHash,
      content_hash: _contentHash,
      original_path: originalPath,
      render_path: renderPath,
      ...rest
    } = documentData;
    return {
      pageContent,
      docId,
      blocks,
      metadata: {
        ...rest,
        doc_id: docId || "",
        has_original: originalPath || renderPath ? 1 : 0,
        sensitivity: rest.sensitivity || "unclassified",
        parse_path: rest.parse_path || "",
        parse_confidence:
          typeof rest.parse_confidence === "number" ? rest.parse_confidence : 0,
      },
    };
  }

  client(connectionString = null) {
    return new pgsql.Client({
      connectionString: connectionString || PGVector.connectionString(),
    });
  }

  /**
   * Validate the existing embedding table schema.
   * @param {pgsql.Client} pgClient
   * @param {string} tableName
   * @returns {Promise<boolean>}
   */
  async validateExistingEmbeddingTableSchema(pgClient, tableName) {
    const result = await pgClient.query(this.getEmbeddingTableSchemaSql, [
      tableName,
    ]);

    // Minimum expected schema for an embedding table.
    // Extra columns are allowed but the minimum exact columns are required
    // to be present in the table.
    const expectedSchema = [
      {
        column_name: "id",
        expected: "uuid",
        validation: function (dataType) {
          return dataType.toLowerCase() === this.expected;
        },
      },
      {
        column_name: "namespace",
        expected: "text",
        validation: function (dataType) {
          return dataType.toLowerCase() === this.expected;
        },
      },
      {
        column_name: "embedding",
        expected: "vector",
        validation: function (dataType) {
          return !!dataType;
        },
      }, // just check if it exists
      {
        column_name: "metadata",
        expected: "jsonb",
        validation: function (dataType) {
          return dataType.toLowerCase() === this.expected;
        },
      },
      {
        column_name: "created_at",
        expected: "timestamp",
        validation: function (dataType) {
          return dataType.toLowerCase().includes(this.expected);
        },
      },
    ];

    if (result.rows.length === 0)
      throw new Error(
        `The table '${tableName}' was found but does not contain any columns or cannot be accessed by role. It cannot be used as an embedding table in AnythingLLM.`
      );

    for (const rowDef of expectedSchema) {
      const column = result.rows.find(
        (c) => c.column_name === rowDef.column_name
      );
      if (!column)
        throw new Error(
          `The column '${rowDef.column_name}' was expected but not found in the table '${tableName}'.`
        );
      if (!rowDef.validation(column.data_type))
        throw new Error(
          `Invalid data type for column: '${column.column_name}'. Got '${column.data_type}' but expected '${rowDef.expected}'`
        );
    }

    this.logger(
      `✅ The pgvector table '${tableName}' was found and meets the minimum expected schema for an embedding table.`
    );
    return true;
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
    try {
      const pgClient = await this.connect();
      await pgClient.query(this.getTablesSql);
      await pgClient.end();
      return { error: null, success: true };
    } catch (err) {
      return { error: err.message, success: false };
    }
  }

  /**
   * Connect to the database.
   * - Throws an error if the connection string or table name is not provided.
   * @returns {Promise<pgsql.Client>}
   */
  async connect() {
    if (!PGVector.connectionString())
      throw new Error("No connection string provided");
    if (!PGVector.tableName()) throw new Error("No table name provided");

    const client = this.client();
    await client.connect();
    return client;
  }

  /**
   * Test the connection to the database with already set credentials via ENV
   * @returns {{error: string | null, success: boolean}}
   */
  async heartbeat() {
    return this.testConnectionToDB();
  }

  /**
   * Check if the anythingllm embedding table exists in the database
   * @returns {Promise<boolean>}
   */
  async dbTableExists() {
    let connection = null;
    try {
      connection = await this.connect();
      const tables = await connection.query(this.getTablesSql);
      if (tables.rows.length === 0) return false;
      const tableExists = tables.rows.some(
        (row) => row.tablename === PGVector.tableName()
      );
      return !!tableExists;
    } catch {
      return false;
    } finally {
      if (connection) await connection.end();
    }
  }

  async totalVectors() {
    if (!(await this.dbTableExists())) return 0;
    let connection = null;
    try {
      connection = await this.connect();
      const result = await connection.query(
        `SELECT COUNT(id) FROM "${PGVector.tableName()}"`
      );
      return result.rows[0].count;
    } catch {
      return 0;
    } finally {
      if (connection) await connection.end();
    }
  }

  // Distance for cosine is just the distance for pgvector.
  distanceToSimilarity(distance = null) {
    if (distance === null || typeof distance !== "number") return 0.0;
    if (distance >= 1.0) return 1;
    if (distance < 0) return 1 - Math.abs(distance);
    return 1 - distance;
  }

  async namespaceCount(namespace = null) {
    if (!(await this.dbTableExists())) return 0;
    let connection = null;
    try {
      connection = await this.connect();
      const result = await connection.query(
        `SELECT COUNT(id) FROM "${PGVector.tableName()}" WHERE namespace = $1`,
        [namespace]
      );
      return result.rows[0].count;
    } catch {
      return 0;
    } finally {
      if (connection) await connection.end();
    }
  }

  /**
   * Performs a SimilaritySearch on a given PGVector namespace.
   * @param {Object} params
   * @param {pgsql.Client} params.client
   * @param {string} params.namespace
   * @param {number[]} params.queryVector
   * @param {number} params.similarityThreshold
   * @param {number} params.topN
   * @param {string[]} params.filterIdentifiers
   * @returns
   */
  async similarityResponse({
    client,
    namespace,
    queryVector,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
  }) {
    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    await this.configureVectorSearch(client);
    const embedding = `[${queryVector.map(Number).join(",")}]`;
    const response = await client.query(
      `SELECT embedding ${this.operator.cosine} $1 AS _distance, metadata FROM "${PGVector.tableName()}" WHERE namespace = $2 ORDER BY _distance ASC LIMIT $3`,
      [embedding, namespace, topN]
    );
    response.rows.forEach((item) => {
      const distance = Number(item._distance);
      if (!Number.isFinite(distance)) return;
      const score = this.distanceToSimilarity(distance);
      if (score < similarityThreshold) return;
      if (filterIdentifiers.includes(sourceIdentifier(item.metadata))) {
        this.logger(
          "A source was filtered from context as it's parent document is pinned."
        );
        return;
      }

      result.contextTexts.push(item.metadata.text);
      result.sourceDocuments.push({
        ...item.metadata,
        score,
      });
      result.scores.push(score);
    });

    return result;
  }

  /** Retrieve a wider dense candidate set, then apply the local multilingual
   * reranker. This mirrors the LanceDB path so changing vector stores does not
   * silently lower Korean retrieval quality.
   */
  async rerankedSimilarityResponse({
    client,
    namespace,
    query,
    queryVector,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
  }) {
    const totalEmbeddings = await this.namespaceCount(namespace);
    const searchLimit = Math.max(
      10,
      Math.min(50, Math.ceil(totalEmbeddings * 0.1))
    );
    await this.configureVectorSearch(client);
    const embedding = `[${queryVector.map(Number).join(",")}]`;
    const response = await client.query(
      `SELECT embedding ${this.operator.cosine} $1 AS _distance, metadata FROM "${PGVector.tableName()}" WHERE namespace = $2 ORDER BY _distance ASC LIMIT $3`,
      [embedding, namespace, searchLimit]
    );
    const candidates = response.rows.map((item) => ({
      ...item.metadata,
      _distance: Number(item._distance),
    }));
    const result = { contextTexts: [], sourceDocuments: [], scores: [] };
    const reranker = new NativeEmbeddingReranker();

    try {
      const reranked = await reranker.rerank(query, candidates, { topK: topN });
      for (const item of reranked) {
        if (this.distanceToSimilarity(item._distance) < similarityThreshold)
          continue;
        const { vector: _vector, ...rest } = item;
        if (filterIdentifiers.includes(sourceIdentifier(rest))) {
          this.logger(
            "A source was filtered from context as it's parent document is pinned."
          );
          continue;
        }
        const score =
          item.rerank_score || this.distanceToSimilarity(item._distance);
        result.contextTexts.push(rest.text);
        result.sourceDocuments.push({ ...rest, score });
        result.scores.push(score);
      }
    } catch (err) {
      this.logger("rerankedSimilarityResponse", err.message);
      this.logger("Falling back to dense similarity search.");
      return await this.similarityResponse({
        client,
        namespace,
        queryVector,
        similarityThreshold,
        topN,
        filterIdentifiers,
      });
    }
    return result;
  }

  normalizeVector(vector) {
    const magnitude = Math.sqrt(
      vector.reduce((sum, val) => sum + val * val, 0)
    );
    if (magnitude === 0) return vector; // Avoid division by zero
    return vector.map((val) => val / magnitude);
  }

  /**
   * Update or create a collection in the database
   * @param {Object} params
   * @param {pgsql.Connection} params.connection
   * @param {{id: number, vector: number[], metadata: Object}[]} params.submissions
   * @param {string} params.namespace
   * @param {number} params.dimensions
   * @returns {Promise<boolean>}
   */
  async updateOrCreateCollection({
    connection,
    submissions,
    namespace,
    dimensions = 384,
  }) {
    await this.createTableIfNotExists(connection, dimensions);
    this.logger(`Updating or creating collection ${namespace}`);

    try {
      // Create a transaction of all inserts
      await connection.query(`BEGIN`);
      for (const submission of submissions) {
        const embedding = `[${submission.vector.map(Number).join(",")}]`; // stringify the vector for pgvector
        const sanitizedMetadata = this.sanitizeForJsonb(submission.metadata);
        await connection.query(
          `INSERT INTO "${PGVector.tableName()}" (id, namespace, embedding, metadata) VALUES ($1, $2, $3, $4)`,
          [submission.id, namespace, embedding, sanitizedMetadata]
        );
      }
      this.logger(`Committing ${submissions.length} vectors to ${namespace}`);
      await connection.query(`COMMIT`);
    } catch (err) {
      this.logger(
        `Rolling back ${submissions.length} vectors to ${namespace}`,
        err
      );
      await connection.query(`ROLLBACK`);
    }
    return true;
  }

  /**
   * create a table if it doesn't exist
   * @param {pgsql.Client} connection
   * @param {number} dimensions
   * @returns
   */
  async createTableIfNotExists(connection, dimensions = 384) {
    this.logger(`Creating embedding table with ${dimensions} dimensions`);
    await connection.query(this.createExtensionSql);
    await connection.query(this.createTableSql(dimensions));
    for (const statement of this.createIndexSql())
      await connection.query(statement);
    return true;
  }

  /**
   * Get the namespace from the database
   * @param {pgsql.Client} connection
   * @param {string} namespace
   * @returns {Promise<{name: string, vectorCount: number}>}
   */
  async namespace(connection, namespace = null) {
    if (!namespace) throw new Error("No namespace provided");
    const result = await connection.query(
      `SELECT COUNT(id) FROM "${PGVector.tableName()}" WHERE namespace = $1`,
      [namespace]
    );
    return { name: namespace, vectorCount: result.rows[0].count };
  }

  /**
   * Check if the namespace exists in the database
   * @param {string} namespace
   * @returns {Promise<boolean>}
   */
  async hasNamespace(namespace = null) {
    if (!namespace) throw new Error("No namespace provided");
    let connection = null;
    try {
      connection = await this.connect();
      return await this.namespaceExists(connection, namespace);
    } catch {
      return false;
    } finally {
      if (connection) await connection.end();
    }
  }

  /**
   * Check if the namespace exists in the database
   * @param {pgsql.Client} connection
   * @param {string} namespace
   * @returns {Promise<boolean>}
   */
  async namespaceExists(connection, namespace = null) {
    if (!namespace) throw new Error("No namespace provided");
    const result = await connection.query(
      `SELECT COUNT(id) FROM "${PGVector.tableName()}" WHERE namespace = $1 LIMIT 1`,
      [namespace]
    );
    return result.rows[0].count > 0;
  }

  /**
   * Delete all vectors in the namespace
   * @param {pgsql.Client} connection
   * @param {string} namespace
   * @returns {Promise<boolean>}
   */
  async deleteVectorsInNamespace(connection, namespace = null) {
    if (!namespace) throw new Error("No namespace provided");
    await connection.query(
      `DELETE FROM "${PGVector.tableName()}" WHERE namespace = $1`,
      [namespace]
    );
    return true;
  }

  async addDocumentToNamespace(
    namespace,
    documentData = {},
    fullFilePath = null,
    skipCache = false
  ) {
    const { DocumentVectors } = require("../../../models/vectors");
    const {
      storeVectorResult,
      cachedVectorInformation,
    } = require("../../files");
    let connection = null;

    try {
      const { pageContent, docId, blocks, metadata } =
        this.prepareDocumentData(documentData);
      if (!pageContent || pageContent.length == 0) return false;
      connection = await this.connect();

      this.logger("Adding new vectorized document into namespace", namespace);
      if (!skipCache) {
        const cacheResult = await cachedVectorInformation(fullFilePath);
        let vectorDimensions;
        if (cacheResult.exists) {
          const { chunks } = cacheResult;
          const documentVectors = [];
          const submissions = [];

          for (const chunk of chunks.flat()) {
            if (!vectorDimensions) vectorDimensions = chunk.values.length;
            const id = uuidv4();
            const { id: _id, ...metadata } = chunk.metadata;
            documentVectors.push({ docId, vectorId: id });
            submissions.push({ id: id, vector: chunk.values, metadata });
          }

          await this.updateOrCreateCollection({
            connection,
            submissions,
            namespace,
            dimensions: vectorDimensions,
          });
          await DocumentVectors.bulkInsert(documentVectors);
          return { vectorized: true, error: null };
        }
      }

      // If we are here then we are going to embed and store a novel document.
      // We have to do this manually as opposed to using LangChains `xyz.fromDocuments`
      // because we then cannot atomically control our namespace to granularly find/remove documents
      // from vectordb.
      const { SystemSettings } = require("../../../models/systemSettings");
      const EmbedderEngine = getEmbeddingEngineSelection();
      const textSplitter = new TextSplitter({
        chunkSize: TextSplitter.determineMaxChunkSize(
          await SystemSettings.getValueOrFallback({
            label: "text_splitter_chunk_size",
          }),
          EmbedderEngine?.embeddingMaxChunkLength
        ),
        chunkOverlap: await SystemSettings.getValueOrFallback(
          { label: "text_splitter_chunk_overlap" },
          20
        ),
        chunkHeaderMeta: TextSplitter.buildHeaderMeta(metadata),
        chunkPrefix: EmbedderEngine?.embeddingPrefix,
      });
      const { chunks: textChunks, metas: chunkMetas } =
        await textSplitter.splitDocument({ pageContent, blocks });

      this.logger("Snippets created from document:", textChunks.length);
      const documentVectors = [];
      const vectors = [];
      const submissions = [];
      const vectorValues = await EmbedderEngine.embedChunks(textChunks);
      let vectorDimensions;

      if (!!vectorValues && vectorValues.length > 0) {
        for (const [i, vector] of vectorValues.entries()) {
          if (!vectorDimensions) vectorDimensions = vector.length;
          const vectorRecord = {
            id: uuidv4(),
            values: vector,
            metadata: {
              ...metadata,
              ...(chunkMetas[i] || {}),
              text: textChunks[i],
            },
          };

          vectors.push(vectorRecord);
          submissions.push({
            id: vectorRecord.id,
            vector: vectorRecord.values,
            metadata: vectorRecord.metadata,
          });
          documentVectors.push({ docId, vectorId: vectorRecord.id });
        }
      } else {
        throw new Error(
          "Could not embed document chunks! This document will not be recorded."
        );
      }

      if (vectors.length > 0) {
        const chunks = [];
        for (const chunk of toChunks(vectors, 500)) chunks.push(chunk);

        this.logger("Inserting vectorized chunks into PGVector collection.");
        await this.updateOrCreateCollection({
          connection,
          submissions,
          namespace,
          dimensions: vectorDimensions,
        });
        await storeVectorResult(chunks, fullFilePath);
      }

      await DocumentVectors.bulkInsert(documentVectors);
      return { vectorized: true, error: null };
    } catch (err) {
      this.logger("addDocumentToNamespace", err.message);
      return { vectorized: false, error: err.message };
    } finally {
      if (connection) await connection.end();
    }
  }

  /**
   * Delete a document from the namespace
   * @param {string} namespace
   * @param {string} docId
   * @returns {Promise<boolean>}
   */
  async deleteDocumentFromNamespace(namespace, docId) {
    if (!namespace) throw new Error("No namespace provided");
    if (!docId) throw new Error("No docId provided");

    let connection = null;
    try {
      connection = await this.connect();
      const exists = await this.namespaceExists(connection, namespace);
      if (!exists)
        throw new Error(
          `PGVector:deleteDocumentFromNamespace - namespace ${namespace} does not exist.`
        );

      const { DocumentVectors } = require("../../../models/vectors");
      const vectorIds = (await DocumentVectors.where({ docId })).map(
        (record) => record.vectorId
      );
      if (vectorIds.length === 0) return;

      try {
        await connection.query(`BEGIN`);
        for (const vectorId of vectorIds)
          await connection.query(
            `DELETE FROM "${PGVector.tableName()}" WHERE id = $1`,
            [vectorId]
          );
        await connection.query(`COMMIT`);
      } catch (err) {
        await connection.query(`ROLLBACK`);
        throw err;
      }

      this.logger(
        `Deleted ${vectorIds.length} vectors from namespace ${namespace}`
      );
      return true;
    } catch (err) {
      this.logger(
        `Error deleting document from namespace ${namespace}: ${err.message}`
      );
      return false;
    } finally {
      if (connection) await connection.end();
    }
  }

  /**
   * Expand repeated hits in one top-level section into the section's remaining
   * chunks. Location-aware metadata and chunk_index make this deterministic.
   */
  async expandSections({ client, namespace, result }) {
    const { contextTexts, sourceDocuments, scores } = result;
    if (process.env.SECTION_EXPANSION === "off" || sourceDocuments.length === 0)
      return result;

    const minHits = Number(process.env.SECTION_EXPANSION_MIN_HITS) || 2;
    const sectionMaxChars =
      Number(process.env.SECTION_EXPANSION_SECTION_MAX_CHARS) || 16_000;
    const budgetMax =
      Number(process.env.SECTION_EXPANSION_BUDGET_CHARS) || 32_000;
    const topSegment = (sectionPath) =>
      String(sectionPath || "")
        .split(">")
        .at(0)
        .trim();
    const rowKey = (docId, value) => JSON.stringify([docId || "", value]);

    const groups = new Map();
    sourceDocuments.forEach((source, index) => {
      const segment = topSegment(source.section_path);
      if (!source.doc_id || !segment) return;
      const key = rowKey(source.doc_id, segment);
      if (!groups.has(key))
        groups.set(key, { docId: source.doc_id, segment, hits: [] });
      groups.get(key).hits.push(index);
    });

    const seen = new Set(
      sourceDocuments.map((source) => rowKey(source.doc_id, source.chunk_index))
    );
    const additions = [];
    let budget = budgetMax;

    for (const group of groups.values()) {
      if (group.hits.length < minHits) continue;
      const groupScore = Math.min(
        ...group.hits.map((index) => scores[index] ?? 0)
      );
      let rows = [];
      try {
        const response = await client.query(
          `SELECT metadata FROM "${PGVector.tableName()}" WHERE namespace = $1 AND metadata->>'doc_id' = $2 LIMIT 5000`,
          [namespace, group.docId]
        );
        rows = response.rows.map((row) => row.metadata);
      } catch (err) {
        this.logger(`expandSections: query failed - ${err.message}`);
        continue;
      }

      const section = rows
        .filter((row) => topSegment(row.section_path) === group.segment)
        .sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
      const sectionChars = section.reduce(
        (total, row) => total + (row.text?.length || 0),
        0
      );
      if (!section.length || sectionChars > sectionMaxChars) continue;

      for (const row of section) {
        const key = rowKey(row.doc_id, row.chunk_index);
        if (seen.has(key)) continue;
        const length = row.text?.length || 0;
        if (length > budget) continue;
        additions.push({ metadata: row, text: row.text, score: groupScore });
        seen.add(key);
        budget -= length;
      }
    }

    if (!additions.length) return result;
    this.logger(
      `expandSections: +${additions.length} chunks from ${
        new Set(additions.map((item) => item.metadata.doc_id)).size
      } section(s).`
    );
    const rows = [
      ...sourceDocuments.map((source, index) => ({
        metadata: source,
        text: contextTexts[index],
        score: scores[index] ?? 0,
      })),
      ...additions,
    ];
    const bestByDocument = {};
    for (const row of rows) {
      const docId = row.metadata.doc_id || "";
      bestByDocument[docId] = Math.max(
        bestByDocument[docId] ?? -Infinity,
        row.score
      );
    }
    rows.sort((a, b) => {
      const aDoc = a.metadata.doc_id || "";
      const bDoc = b.metadata.doc_id || "";
      if (aDoc !== bDoc)
        return (bestByDocument[bDoc] ?? 0) - (bestByDocument[aDoc] ?? 0);
      return (a.metadata.chunk_index ?? 0) - (b.metadata.chunk_index ?? 0);
    });

    return {
      contextTexts: rows.map((row) => row.text),
      sourceDocuments: rows.map((row) => ({
        ...row.metadata,
        score: row.score,
      })),
      scores: rows.map((row) => row.score),
    };
  }

  async performSimilaritySearch({
    namespace = null,
    input = "",
    LLMConnector = null,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
    rerank = false,
  }) {
    let connection = null;
    if (!namespace || !input || !LLMConnector)
      throw new Error("Invalid request to performSimilaritySearch.");

    try {
      connection = await this.connect();
      const exists = await this.namespaceExists(connection, namespace);
      if (!exists) {
        this.logger(
          `The namespace ${namespace} does not exist or has no vectors. Returning empty results.`
        );
        return {
          contextTexts: [],
          sources: [],
          message: null,
        };
      }

      const queryVector = await LLMConnector.embedTextInput(input);
      const searchResult = rerank
        ? await this.rerankedSimilarityResponse({
            client: connection,
            namespace,
            query: input,
            queryVector,
            similarityThreshold,
            topN,
            filterIdentifiers,
          })
        : await this.similarityResponse({
            client: connection,
            namespace,
            queryVector,
            similarityThreshold,
            topN,
            filterIdentifiers,
          });
      const result = await this.expandSections({
        client: connection,
        namespace,
        result: searchResult,
      });

      const { contextTexts, sourceDocuments } = result;
      const sources = sourceDocuments.map((metadata, i) => {
        return { metadata: { ...metadata, text: contextTexts[i] } };
      });
      return {
        contextTexts,
        sources: this.curateSources(sources),
        message: false,
      };
    } catch (err) {
      return { error: err.message, success: false };
    } finally {
      if (connection) await connection.end();
    }
  }

  async "namespace-stats"(reqBody = {}) {
    const { namespace = null } = reqBody;
    if (!namespace) throw new Error("namespace required");
    if (!(await this.dbTableExists()))
      return { message: "No table found in database" };

    let connection = null;
    try {
      connection = await this.connect();
      if (!(await this.namespaceExists(connection, namespace)))
        throw new Error("Namespace by that name does not exist.");
      const stats = await this.namespace(connection, namespace);
      return stats
        ? stats
        : { message: "No stats were able to be fetched from DB for namespace" };
    } catch (err) {
      return {
        message: `Error fetching stats for namespace ${namespace}: ${err.message}`,
      };
    } finally {
      if (connection) await connection.end();
    }
  }

  async "delete-namespace"(reqBody = {}) {
    const { namespace = null } = reqBody;
    if (!namespace) throw new Error("No namespace provided");

    let connection = null;
    try {
      const existingCount = await this.namespaceCount(namespace);
      if (existingCount === 0)
        return {
          message: `Namespace ${namespace} does not exist or has no vectors.`,
        };

      connection = await this.connect();
      await this.deleteVectorsInNamespace(connection, namespace);
      return {
        message: `Namespace ${namespace} was deleted along with ${existingCount} vectors.`,
      };
    } catch (err) {
      return {
        message: `Error deleting namespace ${namespace}: ${err.message}`,
      };
    } finally {
      if (connection) await connection.end();
    }
  }

  /**
   * Reset the entire vector database table associated with anythingllm
   * @returns {Promise<{reset: boolean}>}
   */
  async reset() {
    let connection = null;
    try {
      connection = await this.connect();
      await connection.query(`DROP TABLE IF EXISTS "${PGVector.tableName()}"`);
      return { reset: true };
    } catch {
      return { reset: false };
    } finally {
      if (connection) await connection.end();
    }
  }

  curateSources(sources = []) {
    const documents = [];
    for (const source of sources) {
      const { text, vector: _v, _distance: _d, ...rest } = source;
      const metadata = rest.hasOwnProperty("metadata") ? rest.metadata : rest;
      if (Object.keys(metadata).length > 0) {
        documents.push({
          ...metadata,
          ...(text ? { text } : {}),
        });
      }
    }

    return documents;
  }
}

module.exports.PGVector = PGVector;
