/**
 * Connection, schema and CRUD-level PGVector instance methods. Each exported
 * function takes the `PGVector` instance as an explicit first parameter
 * (`self`) instead of using `this`, so these can live outside the class body
 * without a circular `require("./index")` back to the class. `index.js`
 * exposes each of these under the same public method name via a one-line
 * delegator, so the class's public API is unchanged.
 */
const pgsql = require("pg");
const { v4: uuidv4 } = require("uuid");
const { toChunks, getEmbeddingEngineSelection } = require("../../helpers");
const { TextSplitter } = require("../../TextSplitter");
const SearchTuning = require("./searchTuning");

function createTableSql(self, dimensions) {
  return `CREATE TABLE IF NOT EXISTS "${SearchTuning.tableName()}" (id UUID PRIMARY KEY, namespace TEXT, embedding vector(${Number(dimensions)}), metadata JSONB, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`;
}

function createIndexSql(self) {
  const { m, efConstruction } = SearchTuning.hnswSettings();
  return [
    `CREATE INDEX IF NOT EXISTS "${SearchTuning.indexName("namespace_idx")}" ON "${SearchTuning.tableName()}" (namespace)`,
    `CREATE INDEX IF NOT EXISTS "${SearchTuning.indexName("embedding_hnsw_idx")}" ON "${SearchTuning.tableName()}" USING hnsw (embedding vector_cosine_ops) WITH (m = ${m}, ef_construction = ${efConstruction})`,
  ];
}

async function configureVectorSearch(self, client) {
  const { efSearch } = SearchTuning.hnswSettings();
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
function sanitizeForJsonb(self, value) {
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
    return value.map((item) => self.sanitizeForJsonb(item));
  }

  // Dates: keep as ISO string
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Objects: sanitize each property value
  if (typeof value === "object") {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = self.sanitizeForJsonb(v);
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
function prepareDocumentData(self, documentData = {}) {
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

function client(self, connectionString = null) {
  return new pgsql.Client({
    connectionString: connectionString || SearchTuning.connectionString(),
  });
}

/**
 * Validate the existing embedding table schema.
 * @param {pgsql.Client} pgClient
 * @param {string} tableName
 * @returns {Promise<boolean>}
 */
async function validateExistingEmbeddingTableSchema(
  self,
  pgClient,
  tableName
) {
  const result = await pgClient.query(self.getEmbeddingTableSchemaSql, [
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

  self.logger(
    `✅ The pgvector table '${tableName}' was found and meets the minimum expected schema for an embedding table.`
  );
  return true;
}

/**
 * Test the connection to the database directly.
 * @returns {{error: string | null, success: boolean}}
 */
async function testConnectionToDB(self) {
  try {
    const pgClient = await self.connect();
    await pgClient.query(self.getTablesSql);
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
async function connect(self) {
  if (!SearchTuning.connectionString())
    throw new Error("No connection string provided");
  if (!SearchTuning.tableName()) throw new Error("No table name provided");

  const conn = self.client();
  await conn.connect();
  return conn;
}

/**
 * Test the connection to the database with already set credentials via ENV
 * @returns {{error: string | null, success: boolean}}
 */
async function heartbeat(self) {
  return self.testConnectionToDB();
}

/**
 * Check if the anythingllm embedding table exists in the database
 * @returns {Promise<boolean>}
 */
async function dbTableExists(self) {
  let connection = null;
  try {
    connection = await self.connect();
    const tables = await connection.query(self.getTablesSql);
    if (tables.rows.length === 0) return false;
    const tableExists = tables.rows.some(
      (row) => row.tablename === SearchTuning.tableName()
    );
    return !!tableExists;
  } catch {
    return false;
  } finally {
    if (connection) await connection.end();
  }
}

async function totalVectors(self) {
  if (!(await self.dbTableExists())) return 0;
  let connection = null;
  try {
    connection = await self.connect();
    const result = await connection.query(
      `SELECT COUNT(id) FROM "${SearchTuning.tableName()}"`
    );
    return result.rows[0].count;
  } catch {
    return 0;
  } finally {
    if (connection) await connection.end();
  }
}

// Cosine distance from pgvector's `<=>` is `1 - cosine_similarity`, range [0, 2].
// similarity = 1 - distance, clamped to [0, 1]. (The previous `distance >= 1 -> 1`
// branch was inverted: it scored unrelated/opposite vectors as a perfect match.)
function distanceToSimilarity(self, distance = null) {
  if (distance === null || typeof distance !== "number") return 0.0;
  if (!Number.isFinite(distance)) return 0.0;
  if (distance <= 0) return 1.0;
  if (distance >= 2) return 0.0;
  return Math.max(0, Math.min(1, 1 - distance));
}

async function namespaceCount(self, namespace = null) {
  if (!(await self.dbTableExists())) return 0;
  let connection = null;
  try {
    connection = await self.connect();
    const result = await connection.query(
      `SELECT COUNT(id) FROM "${SearchTuning.tableName()}" WHERE namespace = $1`,
      [namespace]
    );
    return result.rows[0].count;
  } catch {
    return 0;
  } finally {
    if (connection) await connection.end();
  }
}

function normalizeVector(self, vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
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
async function updateOrCreateCollection(
  self,
  { connection, submissions, namespace, dimensions = 384 }
) {
  await self.createTableIfNotExists(connection, dimensions);
  self.logger(`Updating or creating collection ${namespace}`);

  try {
    // Create a transaction of all inserts
    await connection.query(`BEGIN`);
    for (const submission of submissions) {
      const embedding = `[${submission.vector.map(Number).join(",")}]`; // stringify the vector for pgvector
      const sanitizedMetadata = self.sanitizeForJsonb(submission.metadata);
      await connection.query(
        `INSERT INTO "${SearchTuning.tableName()}" (id, namespace, embedding, metadata) VALUES ($1, $2, $3, $4)`,
        [submission.id, namespace, embedding, sanitizedMetadata]
      );
    }
    self.logger(`Committing ${submissions.length} vectors to ${namespace}`);
    await connection.query(`COMMIT`);
  } catch (err) {
    self.logger(
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
async function createTableIfNotExists(self, connection, dimensions = 384) {
  self.logger(`Creating embedding table with ${dimensions} dimensions`);
  await connection.query(self.createExtensionSql);
  await connection.query(self.createTableSql(dimensions));
  for (const statement of self.createIndexSql())
    await connection.query(statement);
  return true;
}

/**
 * Get the namespace from the database
 * @param {pgsql.Client} connection
 * @param {string} namespace
 * @returns {Promise<{name: string, vectorCount: number}>}
 */
async function namespace(self, connection, namespace = null) {
  if (!namespace) throw new Error("No namespace provided");
  const result = await connection.query(
    `SELECT COUNT(id) FROM "${SearchTuning.tableName()}" WHERE namespace = $1`,
    [namespace]
  );
  return { name: namespace, vectorCount: result.rows[0].count };
}

/**
 * Check if the namespace exists in the database
 * @param {string} namespace
 * @returns {Promise<boolean>}
 */
async function hasNamespace(self, namespace = null) {
  if (!namespace) throw new Error("No namespace provided");
  let connection = null;
  try {
    connection = await self.connect();
    return await self.namespaceExists(connection, namespace);
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
async function namespaceExists(self, connection, namespace = null) {
  if (!namespace) throw new Error("No namespace provided");
  const result = await connection.query(
    `SELECT COUNT(id) FROM "${SearchTuning.tableName()}" WHERE namespace = $1 LIMIT 1`,
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
async function deleteVectorsInNamespace(self, connection, namespace = null) {
  if (!namespace) throw new Error("No namespace provided");
  await connection.query(
    `DELETE FROM "${SearchTuning.tableName()}" WHERE namespace = $1`,
    [namespace]
  );
  return true;
}

async function addDocumentToNamespace(
  self,
  namespace,
  documentData = {},
  fullFilePath = null,
  skipCache = false
) {
  const { DocumentVectors } = require("../../../models/vectors");
  const { storeVectorResult, cachedVectorInformation } = require("../../files");
  let connection = null;

  try {
    const { pageContent, docId, blocks, metadata } =
      self.prepareDocumentData(documentData);
    if (!pageContent || pageContent.length == 0) return false;
    connection = await self.connect();

    self.logger("Adding new vectorized document into namespace", namespace);
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

        await self.updateOrCreateCollection({
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

    self.logger("Snippets created from document:", textChunks.length);
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

      self.logger("Inserting vectorized chunks into PGVector collection.");
      await self.updateOrCreateCollection({
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
    self.logger("addDocumentToNamespace", err.message);
    return { vectorized: false, error: err.message };
  } finally {
    if (connection) await connection.end();
  }
}

/**
 * Delete a document from the namespace.
 * [auto-docu v14 P2] Deletes by the tracked document_vectors rows AND by a
 * direct `metadata->>'doc_id'` sweep. The sweep is the backstop that finally
 * clears orphan vectors when document_vectors has drifted from the table
 * (the "I deleted it but search still returns it" bug).
 * @param {string} namespace
 * @param {string} docId
 * @returns {Promise<boolean>}
 */
async function deleteDocumentFromNamespace(self, namespace, docId) {
  if (!namespace) throw new Error("No namespace provided");
  if (!docId) throw new Error("No docId provided");

  let connection = null;
  try {
    connection = await self.connect();
    if (!(await self.dbTableExists())) return true;

    const { DocumentVectors } = require("../../../models/vectors");
    const vectorIds = (await DocumentVectors.where({ docId })).map(
      (record) => record.vectorId
    );

    try {
      await connection.query(`BEGIN`);
      for (const vectorId of vectorIds)
        await connection.query(
          `DELETE FROM "${SearchTuning.tableName()}" WHERE id = $1`,
          [vectorId]
        );
      const sweep = await connection.query(
        `DELETE FROM "${SearchTuning.tableName()}" WHERE namespace = $1 AND metadata->>'doc_id' = $2`,
        [namespace, docId]
      );
      await connection.query(`COMMIT`);
      self.logger(
        `Deleted vectors for doc ${docId} from ${namespace} (tracked: ${vectorIds.length}, swept: ${sweep.rowCount ?? 0}).`
      );
    } catch (err) {
      await connection.query(`ROLLBACK`);
      throw err;
    }
    return true;
  } catch (err) {
    self.logger(
      `Error deleting document from namespace ${namespace}: ${err.message}`
    );
    return false;
  } finally {
    if (connection) await connection.end();
  }
}

async function namespaceStats(self, reqBody = {}) {
  const { namespace = null } = reqBody;
  if (!namespace) throw new Error("namespace required");
  if (!(await self.dbTableExists()))
    return { message: "No table found in database" };

  let connection = null;
  try {
    connection = await self.connect();
    if (!(await self.namespaceExists(connection, namespace)))
      throw new Error("Namespace by that name does not exist.");
    const stats = await self.namespace(connection, namespace);
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

async function deleteNamespace(self, reqBody = {}) {
  const { namespace = null } = reqBody;
  if (!namespace) throw new Error("No namespace provided");

  let connection = null;
  try {
    const existingCount = await self.namespaceCount(namespace);
    if (existingCount === 0)
      return {
        message: `Namespace ${namespace} does not exist or has no vectors.`,
      };

    connection = await self.connect();
    await self.deleteVectorsInNamespace(connection, namespace);
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
async function reset(self) {
  let connection = null;
  try {
    connection = await self.connect();
    await connection.query(`DROP TABLE IF EXISTS "${SearchTuning.tableName()}"`);
    return { reset: true };
  } catch {
    return { reset: false };
  } finally {
    if (connection) await connection.end();
  }
}

function curateSources(self, sources = []) {
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

module.exports = {
  createTableSql,
  createIndexSql,
  configureVectorSearch,
  sanitizeForJsonb,
  prepareDocumentData,
  client,
  validateExistingEmbeddingTableSchema,
  testConnectionToDB,
  connect,
  heartbeat,
  dbTableExists,
  totalVectors,
  distanceToSimilarity,
  namespaceCount,
  normalizeVector,
  updateOrCreateCollection,
  createTableIfNotExists,
  namespace,
  hasNamespace,
  namespaceExists,
  deleteVectorsInNamespace,
  addDocumentToNamespace,
  deleteDocumentFromNamespace,
  namespaceStats,
  deleteNamespace,
  reset,
  curateSources,
};
