# Eval findings

Running log of what the harness has told us. Newest first.

## 2026-09-07 — live regression, bug fixes, and performance correction

The archive QA stack was re-run against the live local services after the
`claudecli` and native BGE-M3 memory-guard changes. The reports below are
committed under `eval/reports/` and should be treated as the current baseline.

### Answer quality: ENAMETOOLONG fixed

Before the fix, `answers-2026-09-07T01-35-18-613Z.json` recorded 7 successful
answers and one complete failure:

| run | faithfulness | completeness | citation accuracy | result |
|-----|--------------|--------------|-------------------|--------|
| before `claudecli` fix | 0.875 | 0.875 | 0.875 | `jangryeo-contract` failed with `spawn ENAMETOOLONG` |
| after fix | 0.99375 | 1.000 | 0.99375 | 8/8 passed |

The failure occurred because the complete retrieved system prompt was passed
as a Windows process argument. Section expansion could grow the prompt beyond
the process command-line limit. `server/utils/AiProviders/claudeCli/index.js`
now writes the system prompt to a temporary file and passes it with
`--system-prompt-file` for normal, streaming, and agent completion paths.

Current answer-quality report:

- Report: `answers-2026-09-07T03-34-15-018Z.json`
- Workspace: `archive-test`
- Golden questions: 8
- Judge: `claude-sonnet-5`
- Faithfulness mean: `0.99375`
- Completeness mean: `1.0`
- Citation accuracy mean: `0.99375`
- Threshold result: 8/8 passed

The judge is the same Claude CLI family used for answer generation, so these
absolute scores still have self-preference bias. Use this harness primarily as
a before/after regression gate.

### Retrieval regression after the memory guard change

The current retrieval smoke test still passes after dense BGE-M3 was allowed to
load on this host:

- Report: `2026-09-07T03-27-07-050Z.json`
- Golden questions: 18
- Default mode MRR: `0.9444`
- Default hit@1: `0.8889`
- Default hit@3/5/8: `1.0`
- Default recall@3/5/8: `1.0`
- No misses at `@5`

This is still a smoke test. The synthetic seed corpus is intentionally easy;
the real archive answer set is the more useful product regression target.

### Performance baseline correction

The older `perf-archive-full-2026-09-04T00-13-31-587Z.json` report showed about
25 ms average latency, but every sample in that report had `resultCount: 0`.
That was a successful HTTP request with an empty result, not a valid result
latency baseline.

The corrected pre-memory-fix report is:

- Report: `perf-archive-full-2026-09-07T01-29-20-591Z.json`
- Workspace: `archive-full`
- Documents: 232
- Queries: 8, repeated twice per mode, 16 samples per mode
- Default: average `426.1 ms`, p50 `416.8 ms`, p95 `515.8 ms`, 0 errors,
  average 9.8 results
- Rerank: average `427.5 ms`, p50 `420.8 ms`, p95 `498.4 ms`, 0 errors,
  average 9.8 results

After the memory guard was lowered to `NATIVE_EMBEDDING_MIN_FREE_MEMORY_MB=1600`,
the live rerun reported approximately `371.8 ms` average for default mode. The
same run showed rerank latency spikes up to roughly 14 seconds when
`expandSections` supplied up to 32 candidates to the CPU reranker. This is a
follow-up performance investigation, not a correctness failure.

The 25 ms figure must not be used as the archive search baseline going forward.

### 2026-09-07 — rerank candidate cap

The first live performance run showed that rerank latency was dominated by the
number of dense candidates passed to the CPU cross-encoder. A corpus of 232
documents produced 9–32 candidates and individual rerank calls took up to about
14 seconds. The pgvector provider now uses the configurable
`RERANKER_CANDIDATE_LIMIT` value, while never selecting fewer candidates than
the requested `topN` or the existing minimum of 10.

The initial cap of 16 was still too slow on this host:

- Report: `perf-archive-full-2026-09-07T04-55-20-918Z.json`
- Candidate cap: 16
- Rerank average: `15,575.4 ms`
- p50: `16,495.7 ms`
- p95/max: `22,571.9 ms`
- Errors: 0

The live default was then set to `RERANKER_CANDIDATE_LIMIT="10"` in the ignored
local `server/.env.development`, with the same documented value in both env
templates. The one-pass rerank performance run improved to:

- Report: `perf-archive-full-2026-09-07T05-01-30-685Z.json`
- Candidate cap: 10
- Rerank average: `7,572.6 ms`
- p50: `8,643.6 ms`
- p95/max: `16,334.4 ms`
- Errors: 0

Correctness did not regress:

- `eval/run.mjs --keep --mode rerank`: MRR `1.000`, hit@1 `1.000`, no misses
  at @5 (`2026-09-07T05-05-38-527Z.json`)
- `eval/answers.mjs`: 8/8 passed, faithfulness `1.0`, completeness `0.988`,
  citation accuracy `1.0` (`answers-2026-09-07T05-10-53-367Z.json`)

Conclusion: candidate capping is useful and prevents the worst 32-candidate
case, but CPU reranking remains a multi-second optional mode. Keep default
search as the normal user path and expose rerank as a precision mode. A future
performance pass should evaluate a smaller/quantized reranker or move rerank
to a dedicated service; lowering the candidate cap further would make the
current `topN=8` contract unsafe because the provider intentionally keeps a
minimum of 10 candidates.

### 2026-09-07 — reranker batch-size experiment

The current `onnx-community/bge-reranker-v2-m3-ONNX` model was measured with
`RERANKER_MAX_BATCH_SIZE` values 2, 4, and 6. The candidate cap remained 10 for
all runs. Each run used `archive-full` (232 documents), eight questions, one
iteration per question, and zero errors.

| batch size | average | p50 | p95/max | retrieval MRR | answer quality |
|------------|---------|-----|---------|---------------|----------------|
| 2 | `9,528 ms` | `9,275 ms` | `14,300 ms` | `1.000` | mean f `0.994`, c `0.981`, ca `0.994` |
| 4 | `10,521 ms` | `9,701 ms` | `16,096 ms` | `1.000` | mean f `1.000`, c `0.988`, ca `1.000` |
| 6 | `10,850 ms` | `9,413 ms` | `20,112 ms` | `1.000` | mean f `1.000`, c `1.000`, ca `1.000` |

Reports:

- Batch 2: `perf-archive-full-2026-09-07T05-49-09-021Z.json`,
  `2026-09-07T05-53-19-334Z.json`, `answers-2026-09-07T05-58-13-520Z.json`
- Batch 4: `perf-archive-full-2026-09-07T05-59-42-270Z.json`,
  `2026-09-07T06-04-37-799Z.json`, `answers-2026-09-07T06-09-52-414Z.json`
- Batch 6: `perf-archive-full-2026-09-07T06-10-49-095Z.json`,
  `2026-09-07T06-15-41-009Z.json`, `answers-2026-09-07T06-20-47-158Z.json`

Batch 4 and 6 did not improve latency on this CPU host. Batch 6 also had the
largest p95 spike. The local runtime was restored to
`RERANKER_MAX_BATCH_SIZE="2"`, which remains the safest and fastest measured
configuration. The bottleneck is model inference itself, not only the number
of batches. Further improvement requires a smaller/quantized compatible model
or a separate inference service.

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
