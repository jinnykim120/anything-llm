const SUPPORTED_NATIVE_EMBEDDING_MODELS = {
  "Xenova/all-MiniLM-L6-v2": {
    maxConcurrentChunks: 25,
    // Right now, this is NOT the token length, and is instead the number of characters
    // that can be processed in a single pass. So we override to 1,000 characters.
    // roughtly the max number of tokens assuming 2 characters per token. (undershooting)
    // embeddingMaxChunkLength: 512, (from the model card)
    embeddingMaxChunkLength: 1_000,
    chunkPrefix: "",
    queryPrefix: "",
    apiInfo: {
      id: "Xenova/all-MiniLM-L6-v2",
      name: "all-MiniLM-L6-v2",
      description:
        "A lightweight and fast model for embedding text. The default model for AnythingLLM.",
      lang: "English",
      size: "23MB",
      modelCard: "https://huggingface.co/Xenova/all-MiniLM-L6-v2",
    },
  },
  "Xenova/nomic-embed-text-v1": {
    maxConcurrentChunks: 5,
    // Right now, this is NOT the token length, and is instead the number of characters
    // that can be processed in a single pass. So we override to 16,000 characters.
    // roughtly the max number of tokens assuming 2 characters per token. (undershooting)
    // embeddingMaxChunkLength: 8192, (from the model card)
    embeddingMaxChunkLength: 16_000,
    chunkPrefix: "search_document: ",
    queryPrefix: "search_query: ",
    apiInfo: {
      id: "Xenova/nomic-embed-text-v1",
      name: "nomic-embed-text-v1",
      description:
        "A high-performing open embedding model with a large token context window. Requires more processing power and memory.",
      lang: "English",
      size: "139MB",
      modelCard: "https://huggingface.co/Xenova/nomic-embed-text-v1",
    },
  },
  "MintplexLabs/multilingual-e5-small": {
    maxConcurrentChunks: 5,
    // Right now, this is NOT the token length, and is instead the number of characters
    // that can be processed in a single pass. So we override to 1,000 characters.
    // roughtly the max number of tokens assuming 2 characters per token. (undershooting)
    // embeddingMaxChunkLength: 512, (from the model card)
    embeddingMaxChunkLength: 1_000,
    chunkPrefix: "passage: ",
    queryPrefix: "query: ",
    apiInfo: {
      id: "MintplexLabs/multilingual-e5-small",
      name: "multilingual-e5-small",
      description:
        "A larger multilingual embedding model that supports 100+ languages. Requires more processing power and memory.",
      lang: "100+ languages",
      size: "487MB",
      modelCard: "https://huggingface.co/intfloat/multilingual-e5-small",
    },
  },
  // [auto-docu P0a] Primary embedder for this project: strong Korean/CJK retrieval.
  // BGE-M3 is XLM-RoBERTa based; 8192-token context. No instruction prefix needed.
  // Later (P0b, WSL/Linux) we run the full FlagEmbedding BGE-M3 for dense+sparse (D7);
  // here we use the ONNX dense-only weights via transformers.js.
  "Xenova/bge-m3": {
    maxConcurrentChunks: 5,
    // The model supports 8192 tokens, but the local ONNX attention graph grows
    // quadratically with sequence length. An 8k flat spreadsheet chunk tried to
    // allocate a 2.5GB buffer on a 16GB Windows host. Block-aware documents
    // already target 1200 chars, so use the same practical ceiling for flat
    // PDF/XLSX/text inputs as well.
    embeddingMaxChunkLength: 1_200,
    chunkPrefix: "",
    queryPrefix: "",
    apiInfo: {
      id: "Xenova/bge-m3",
      name: "bge-m3 (multilingual, Korean-strong)",
      description:
        "BAAI BGE-M3 multilingual embedding model. Strong Korean/CJK retrieval, 8k context. Larger download & slower than the small models.",
      lang: "100+ languages",
      size: "~600MB (quantized)",
      modelCard: "https://huggingface.co/Xenova/bge-m3",
    },
  },
  // [auto-docu P0a] Fallback if transformers.js v2 cannot load bge-m3's ONNX graph.
  // multilingual-e5-large is well-proven with transformers.js v2 (also XLM-RoBERTa).
  "Xenova/multilingual-e5-large": {
    maxConcurrentChunks: 5,
    // e5 max sequence length is 512 tokens.
    embeddingMaxChunkLength: 1_000,
    chunkPrefix: "passage: ",
    queryPrefix: "query: ",
    apiInfo: {
      id: "Xenova/multilingual-e5-large",
      name: "multilingual-e5-large",
      description:
        "Multilingual E5 large. Solid Korean retrieval, 512-token context. Proven with transformers.js v2.",
      lang: "100+ languages",
      size: "~1.1GB",
      modelCard: "https://huggingface.co/intfloat/multilingual-e5-large",
    },
  },
};

module.exports = {
  SUPPORTED_NATIVE_EMBEDDING_MODELS,
};
