# Eval findings

Running log of what the harness has told us. Newest first.

## 2026-09-10 — v14 rebuild (P0–P5): retrieval rewrite + real corpus

Full context: `docs/architecture-v14.html` (diagnosis + decisions),
`docs/architecture-v15.html` (execution + results).

### Setup change

- Embedding `Xenova/bge-m3` (1024d) → `MintplexLabs/multilingual-e5-small`
  (384d). bge-m3's ONNX peak fought this box's ~1.7GB free memory → query
  embed was silently failing → whole search degrading to keyword-only. e5-small
  has no memory guard (assertLoadMemory is bge-m3-only); warm query embed
  ~0.1s vs bge-m3 ~4.8s. Restore bge-m3 on a server.
- Single workspace `archive-full` (slug hardcoded in the custom frontend).
  topN 12, similarityThreshold 0.15, vectorSearchMode default.
- `performSimilaritySearch` rewritten (commit `72521f98`): removed
  `#preferLexicalDataMatches` (was ranking keyword hits above semantic),
  removed the silent dense→keyword fallback (embed failure now aborts with a
  message), removed the post-expansion re-truncate. Added per-doc chunk cap +
  additive-only lexical merge + `filterDocIds`. Fixed `distanceToSimilarity`
  (`distance>=1 → 1` scored opposite vectors as a perfect match).

### Real corpus

`_samples/` → `archive-full`: 70 files, 68 documents (2 byte-identical
skipped). parse_path: pdfjs 52 / ocr 5 / xlsx 5 / hwp-parser 3 / hwpx-owpml 1
/ docx-mammoth 1 / pptx-text 1. All 68 classified via claudecli — doc_type:
행정규칙 39 / 실적자료 9 / 법령 8 / 보고서 3 / 협약서 3 / 계약서 2 / 기타 3 /
교육자료 1. work_type: 동반성장 35 / 공정거래 27 / 기타 6.

### Answer quality — `eval/answers.mjs --workspace archive-full` (judge claude-sonnet-5)

| metric | P5 pre-tune (8Q) | P5 post-tune (8Q) | polish + refreshed golden (10Q) |
|--------|------------------|-------------------|---------------------------------|
| faithfulness | 0.975 | 0.998 | **0.988** |
| completeness | 0.544 | 0.825 | **0.970** |
| citation accuracy | 0.981 | 0.984 | **0.982** |
| retrieval hit | 1.000 | 1.000 | **1.000** |

Final run: all 10 items at or above threshold. `hwp-innovation` completeness
0.60 → 1.00 after the whole-small-doc expansion (commit `30b76ff4`): when a
document is clearly the answer (≥2 hits) and short (≤28k chars),
expandSections pulls the entire document — a short report's facts are spread
across sections, not one hierarchical 지침 section. Golden set refreshed for
the 68-doc corpus (stale refusal replaced with a genuine 2027-target refusal;
added homeshop-linked / franchise-disclosure).

Pre-tune finding: retrieval hit the right **document** every time, but
"전부 알려줘" questions answered 2 of 5 facts. Two causes, both fixed
(commit `6485bc03`):

1. **Per-doc cap 3 starved the doc that IS the answer.** The 판매장려금 지침
   `III. 판단기준` section is 34 chunks; dense surfaced 3 header-ish chunks,
   the cap kept only those. Fix: `#capPerDocument` leaves the single top-ranked
   document uncapped (up to `topLimit`, default 40); documents #2+ still capped.
2. **expandSections skipped the section for being > 16k chars** (판단기준 ≈
   34k). Fix: section cap 16k → 40k, total budget 32k → 50k (the LLM is
   claudecli with a large window). `jangryeo-axes` completeness 0.200 → 1.000.

Two still below threshold post-tune:

- `hwp-innovation` (completeness 0.60) — facts scattered across sections of a
  big HWP; section expansion helps hierarchical 지침 but less so here.
- `refusal-netincome` (completeness 0.00) — NOT a regression. The golden set
  expects a refusal ("2024 당기순이익 없음"); the bigger corpus gained
  sustainability reports that DO contain the figure (9,791백만원, cited). The
  golden set is stale for a 68-doc corpus.

### Retrieval smoke — `eval/run.mjs --mode default` (synthetic seed corpus)

MRR 1.000, hit@1 1.000, no misses @5 — no regression (seed corpus is easy).

### RapidOCR disabled

Scanned/image PDFs no longer run the bundled RapidOCR (Chinese model, Korean
garbage — measured: 3-page 협약서 → 467 chars of "HY晶"). They get a
placeholder block + `parse_path: "image-only"`, flagged for vision ingest
(P1d). `OCR_IMAGE_PDFS=1` to re-enable. 5 such docs in the current corpus.

### Ops note

nodemon on this box restarts the server on every `utils/` file save and
sometimes crashes the restart or kills a long operation (the P5 ingest died
once this way). Run server + collector as plain `node index.js` for long runs.

## 2026-09-09 — spreadsheet ingestion integrity and retrieval fix

The archive QA review found that newly uploaded XLSX files could appear in the
document room but be absent from classification review or fail to answer
questions from spreadsheet data. This was a pipeline issue rather than a single
workbook issue.

### Root causes found

- `collector/processSingleFile/convert/asXlsx.js` named each sheet with
  `sheet-${slugify(name)}`. Korean-only sheet names collapsed to the same
  `sheet-.json` path and could overwrite earlier sheets.
- XLSX output did not carry the common `content_hash` metadata, so legacy
  workspace rows could be skipped by classification grouping.
- XLSX pipe tables used flat character splitting. Long tables lost their
  column header in later chunks, leaving numeric rows without their field names
  during retrieval.

### Fixes

- Sheet output filenames now include the per-sheet UUID:
  `sheet-${slugify(name)}-${sheetData.id}`.
- XLSX converters now write a normalized content hash for combined and
  per-sheet output.
- Flat pipe-table chunks repeat the detected header and separator lines.
- Ordinary prose containing a pipe is not treated as a table unless the
  markdown separator row is present.
- Search defaults were aligned: workspace `topN` is 12 and the pgvector
  reranker candidate default is 30.
- Existing workspace metadata rows missing `content_hash` were backfilled from
  their stored parsed JSON where possible.

### Regression coverage

- XLSX Korean/same-name sheet collision test: passed.
- Flat table header preservation test: passed.
- Ordinary pipe-text false-positive test: passed.
- Existing splitter behavior tests: passed.
- Combined focused result: **2 suites, 8 tests passed**.

The full repository test run also passed 43 suites / 538 tests. Two unrelated
environment-dependent failures remain: the workspace model test requires a
storage environment variable in its test setup, and the FFmpeg tests require an
FFmpeg binary on PATH. These are not related to spreadsheet ingestion or
retrieval.

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
