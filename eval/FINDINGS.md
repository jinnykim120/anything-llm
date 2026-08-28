# Eval findings

Running log of what the harness has told us. Newest first.

## 2026-08-28 — reranker swapped to multilingual (P0a follow-up)

Changed `server/utils/EmbeddingRerankers/native/index.js` default model
`Xenova/ms-marco-MiniLM-L-6-v2` (EN-only) → `onnx-community/bge-reranker-v2-m3-ONNX`
(multilingual, Korean-capable). Overridable via `RERANKER_MODEL_PREF`. Loads fine
under `@xenova/transformers@2.17.2`. Model ~561MB on D:.

| mode    | MRR (before) | MRR (after) | hit@1 (before → after) |
|---------|--------------|-------------|------------------------|
| default | 0.972        | 0.935       | 0.944 → 0.889 (noise; workspace rebuilt) |
| rerank  | **0.642**    | **1.000**   | **0.444 → 1.000**      |

Rerank now **helps** instead of wrecking Korean. On this easy seed set the absolute
gap over default is small; a real corpus will show more. **Cost:** ~3.3s to rerank
6 docs on CPU (568M model) — watch latency when topN candidates grow; consider a
quantized/smaller variant or `RERANKER_MODEL_PREF` override later.

`vectorSearchMode: rerank` is now safe to enable. Keep `default` as the conservative
setting until a real-corpus eval confirms the lift.

Placeholder LLM changed `ollama` → `generic-openai` (fake base path): the ollama
provider constructor fires an unhandled `fetch` to `:11434` and **crashes the server**
when no ollama is running. generic-openai does no network call in its constructor.

## 2026-08-28 — baseline (P0a: bge-m3 dense, LanceDB), seed corpus

Seed corpus = 6 short synthetic KO gov docs, 18 questions. Each doc currently fits
in **1 chunk** (docs ~1.5k chars, chunk cap 8k), so this is an easy ranking task —
treat absolute numbers as a smoke test, not a benchmark. Real/longer docs needed
for a discriminating score.

| mode    | MRR   | hit@1 | hit@3 | hit@5 |
|---------|-------|-------|-------|-------|
| default | 0.972 | 0.944 | 1.000 | 1.000 |
| rerank  | 0.642 | 0.444 | 0.722 | 1.000 |

**Finding: the built-in reranker hurts Korean retrieval badly** (MRR 0.97 → 0.64,
hit@1 0.94 → 0.44). Cause: `server/utils/EmbeddingRerankers/native/index.js` hardcodes
`Xenova/ms-marco-MiniLM-L-6-v2` — an **English-only** MS-MARCO cross-encoder. It
reorders Korean passages essentially at random.

**Action (P0a follow-up):** swap the reranker model to a multilingual one —
`onnx-community/bge-reranker-v2-m3-ONNX` (Korean-capable, matches D6). Then re-run
`node eval/run.mjs` to confirm rerank ≥ default before enabling `vectorSearchMode: rerank`
anywhere.

**Until then:** keep workspaces on `vectorSearchMode: "default"`.
