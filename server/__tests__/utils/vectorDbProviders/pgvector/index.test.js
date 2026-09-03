const {
  PGVector: PGVectorClass,
} = require("../../../../utils/vectorDbProviders/pgvector");
const os = require("os");
const {
  NativeEmbeddingReranker,
} = require("../../../../utils/EmbeddingRerankers/native");

const PGVector = new PGVectorClass();

describe("NativeEmbeddingReranker memory guard", () => {
  const originalMinimum = process.env.RERANKER_MIN_FREE_MEMORY_MB;
  const originalBatchSize = process.env.RERANKER_MAX_BATCH_SIZE;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalMinimum === undefined)
      delete process.env.RERANKER_MIN_FREE_MEMORY_MB;
    else process.env.RERANKER_MIN_FREE_MEMORY_MB = originalMinimum;
    if (originalBatchSize === undefined)
      delete process.env.RERANKER_MAX_BATCH_SIZE;
    else process.env.RERANKER_MAX_BATCH_SIZE = originalBatchSize;
  });

  it("rejects the first native model load before ONNX can exhaust memory", () => {
    process.env.RERANKER_MIN_FREE_MEMORY_MB = "3200";
    jest.spyOn(os, "freemem").mockReturnValue(100 * 1024 * 1024);

    expect(() => NativeEmbeddingReranker.assertLoadMemory()).toThrow(
      "Insufficient free memory"
    );
  });

  it("bounds the configurable inference batch size", () => {
    process.env.RERANKER_MAX_BATCH_SIZE = "2";
    expect(NativeEmbeddingReranker.maxBatchSize).toBe(2);
    process.env.RERANKER_MAX_BATCH_SIZE = "100";
    expect(NativeEmbeddingReranker.maxBatchSize).toBe(10);
  });
});

describe("PGVector HNSW configuration", () => {
  const settingNames = [
    "PGVECTOR_HNSW_M",
    "PGVECTOR_HNSW_EF_CONSTRUCTION",
    "PGVECTOR_HNSW_EF_SEARCH",
  ];
  const originalSettings = Object.fromEntries(
    settingNames.map((name) => [name, process.env[name]])
  );

  afterEach(() => {
    for (const name of settingNames) {
      if (originalSettings[name] === undefined) delete process.env[name];
      else process.env[name] = originalSettings[name];
    }
  });

  it("uses defaults and clamps unsafe environment values", () => {
    settingNames.forEach((name) => delete process.env[name]);
    expect(PGVectorClass.hnswSettings()).toEqual({
      m: 16,
      efConstruction: 64,
      efSearch: 40,
    });

    process.env.PGVECTOR_HNSW_M = "1000";
    process.env.PGVECTOR_HNSW_EF_CONSTRUCTION = "1";
    process.env.PGVECTOR_HNSW_EF_SEARCH = "invalid";
    expect(PGVectorClass.hnswSettings()).toEqual({
      m: 100,
      efConstruction: 4,
      efSearch: 40,
    });
  });

  it("creates namespace and cosine HNSW indexes", () => {
    process.env.PGVECTOR_HNSW_M = "24";
    process.env.PGVECTOR_HNSW_EF_CONSTRUCTION = "96";
    const statements = PGVector.createIndexSql();

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("(namespace)");
    expect(statements[1]).toContain("USING hnsw");
    expect(statements[1]).toContain("vector_cosine_ops");
    expect(statements[1]).toContain("m = 24");
    expect(statements[1]).toContain("ef_construction = 96");
  });

  it("sets ef_search on each search connection", async () => {
    process.env.PGVECTOR_HNSW_EF_SEARCH = "80";
    const client = { query: jest.fn().mockResolvedValue({}) };

    await PGVector.configureVectorSearch(client);

    expect(client.query).toHaveBeenCalledWith("SET hnsw.ef_search = 80");
  });
});

describe("PGVector document metadata parity", () => {
  it("keeps retrieval metadata while removing per-document fields", () => {
    const prepared = PGVector.prepareDocumentData({
      pageContent: "body",
      docId: "doc-1",
      blocks: [{ text: "body", page: 1 }],
      file_hash: "file-hash",
      content_hash: "content-hash",
      original_path: "originals/doc.pdf",
      sensitivity: "general",
      parse_path: "docling",
      parse_confidence: 0.95,
      title: "문서",
    });

    expect(prepared.pageContent).toBe("body");
    expect(prepared.docId).toBe("doc-1");
    expect(prepared.blocks).toHaveLength(1);
    expect(prepared.metadata).toEqual({
      title: "문서",
      doc_id: "doc-1",
      has_original: 1,
      sensitivity: "general",
      parse_path: "docling",
      parse_confidence: 0.95,
    });
    expect(prepared.metadata).not.toHaveProperty("file_hash");
    expect(prepared.metadata).not.toHaveProperty("content_hash");
    expect(prepared.metadata).not.toHaveProperty("original_path");
  });
});

describe("PGVector section expansion", () => {
  it("fills in missing chunks from a section and restores reading order", async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            metadata: {
              doc_id: "doc-1",
              section_path: "제1장 > 제1조",
              chunk_index: 0,
              text: "첫 청크",
            },
          },
          {
            metadata: {
              doc_id: "doc-1",
              section_path: "제1장 > 제2조",
              chunk_index: 1,
              text: "중간 청크",
            },
          },
          {
            metadata: {
              doc_id: "doc-1",
              section_path: "제1장 > 제3조",
              chunk_index: 2,
              text: "마지막 청크",
            },
          },
        ],
      }),
    };
    const result = await PGVector.expandSections({
      client,
      namespace: "archive",
      result: {
        contextTexts: ["첫 청크", "마지막 청크"],
        sourceDocuments: [
          {
            doc_id: "doc-1",
            section_path: "제1장 > 제1조",
            chunk_index: 0,
          },
          {
            doc_id: "doc-1",
            section_path: "제1장 > 제3조",
            chunk_index: 2,
          },
        ],
        scores: [0.9, 0.8],
      },
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("metadata->>'doc_id'"),
      ["archive", "doc-1"]
    );
    expect(result.contextTexts).toEqual([
      "첫 청크",
      "중간 청크",
      "마지막 청크",
    ]);
    expect(result.sourceDocuments.map((row) => row.chunk_index)).toEqual([
      0, 1, 2,
    ]);
    expect(result.scores).toEqual([0.9, 0.8, 0.8]);
  });
});

describe("PGVector dense search", () => {
  it("normalizes pg float strings before applying the similarity threshold", async () => {
    const result = await PGVector.similarityResponse({
      client: {
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              _distance: "0.1",
              metadata: { text: "검색 결과", doc_id: "doc-1" },
            },
          ],
        }),
      },
      namespace: "archive",
      queryVector: [0.1, 0.2],
      similarityThreshold: 0.5,
      topN: 1,
    });

    expect(result.contextTexts).toEqual(["검색 결과"]);
    expect(result.scores).toEqual([0.9]);
  });

  it("falls back to dense search when the native reranker is unavailable", async () => {
    jest.spyOn(PGVector, "namespaceCount").mockResolvedValue(1);
    jest
      .spyOn(NativeEmbeddingReranker.prototype, "rerank")
      .mockRejectedValue(new Error("insufficient memory"));
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            _distance: "0.1",
            metadata: { text: "기본 검색 결과", doc_id: "doc-1" },
          },
        ],
      }),
    };

    const result = await PGVector.rerankedSimilarityResponse({
      client,
      namespace: "archive",
      query: "질문",
      queryVector: [0.1, 0.2],
      similarityThreshold: 0.5,
      topN: 1,
    });

    expect(result.contextTexts).toEqual(["기본 검색 결과"]);
    expect(result.scores).toEqual([0.9]);
    expect(client.query).toHaveBeenCalledTimes(4);
  });
});

describe("PGVector.sanitizeForJsonb", () => {
  it("returns null/undefined as-is", () => {
    expect(PGVector.sanitizeForJsonb(null)).toBeNull();
    expect(PGVector.sanitizeForJsonb(undefined)).toBeUndefined();
  });

  it("keeps safe whitespace (tab, LF, CR) and removes disallowed C0 controls", () => {
    const input = "a\u0000\u0001\u0002\tline\ncarriage\rreturn\u001Fend";
    const result = PGVector.sanitizeForJsonb(input);
    // Expect all < 0x20 except 9,10,13 removed; keep letters and allowed whitespace
    expect(result).toBe("a\tline\ncarriage\rreturnend");
  });

  it("removes only disallowed control chars; keeps normal printable chars", () => {
    const input = "Hello\u0000, World! \u0007\u0008\u000B\u000C\u001F";
    const result = PGVector.sanitizeForJsonb(input);
    expect(result).toBe("Hello, World! ");
  });

  it("deeply sanitizes objects", () => {
    const input = {
      plain: "ok",
      bad: "has\u0000nul",
      nested: {
        arr: ["fine", "bad\u0001", { deep: "\u0002oops" }],
      },
    };
    const result = PGVector.sanitizeForJsonb(input);
    expect(result).toEqual({
      plain: "ok",
      bad: "hasnul",
      nested: { arr: ["fine", "bad", { deep: "oops" }] },
    });
  });

  it("deeply sanitizes arrays", () => {
    const input = ["\u0000", 1, true, { s: "bad\u0003" }, ["ok", "\u0004bad"]];
    const result = PGVector.sanitizeForJsonb(input);
    expect(result).toEqual(["", 1, true, { s: "bad" }, ["ok", "bad"]]);
  });

  it("converts Date to ISO string", () => {
    const d = new Date("2020-01-02T03:04:05.000Z");
    expect(PGVector.sanitizeForJsonb(d)).toBe(d.toISOString());
  });

  it("returns primitives unchanged (number, boolean, bigint)", () => {
    expect(PGVector.sanitizeForJsonb(42)).toBe(42);
    expect(PGVector.sanitizeForJsonb(3.14)).toBe(3.14);
    expect(PGVector.sanitizeForJsonb(true)).toBe(true);
    expect(PGVector.sanitizeForJsonb(false)).toBe(false);
    expect(PGVector.sanitizeForJsonb(BigInt(1))).toBe(BigInt(1));
  });

  it("returns symbol unchanged", () => {
    const sym = Symbol("x");
    expect(PGVector.sanitizeForJsonb(sym)).toBe(sym);
  });

  it("does not mutate original objects/arrays", () => {
    const obj = { a: "bad\u0000", nested: { b: "ok" } };
    const arr = ["\u0001", { c: "bad\u0002" }];
    const objCopy = JSON.parse(JSON.stringify(obj));
    const arrCopy = JSON.parse(JSON.stringify(arr));
    const resultObj = PGVector.sanitizeForJsonb(obj);
    const resultArr = PGVector.sanitizeForJsonb(arr);
    // Original inputs remain unchanged
    expect(obj).toEqual(objCopy);
    expect(arr).toEqual(arrCopy);
    // Results are sanitized copies
    expect(resultObj).toEqual({ a: "bad", nested: { b: "ok" } });
    expect(resultArr).toEqual(["", { c: "bad" }]);
  });
});
