# eval/ — P0.5 retrieval evaluation harness

Measures whether a change to parsing / chunking / embedding / retrieval **helps or hurts**,
so P0b, P1 and later phases can be gated on "no regression".

Pure retrieval metrics — **no LLM judge, fully deterministic, runs offline** on the
existing AnythingLLM stack via the `/v1/workspace/:slug/vector-search` API.

## Run

```bash
# once: create an API key for the harness  (writes eval/.key, gitignored)
node eval/setup-key.mjs

# server must be running (run-local.ps1). then:
node eval/run.mjs                  # builds the 'eval' workspace, runs default + rerank
node eval/run.mjs --mode default   # single mode
node eval/run.mjs --keep           # reuse the workspace (skip re-upload/embed)
```

Output: a table of `MRR`, `hit@k`, `recall@k` per retrieval mode, the list of misses,
and a full JSON report in `eval/reports/`.

## Metrics

- **hit@k** — fraction of questions where ≥1 of the top-k chunks comes from an expected source doc.
- **recall@k** — fraction of the expected source docs that appear in the top-k.
- **MRR** — mean reciprocal rank of the first relevant chunk.

A "relevant" chunk = one whose source document (`metadata.title`) is in the question's `expect_docs`.

## Adding golden items

`golden/*.jsonl`, one JSON object per line:

```json
{"id": "budget-01", "question": "…", "expect_docs": ["01_budget_guideline_2026.md"], "answer_contains": ["…"], "domain": "예산"}
```

- `expect_docs` — filename(s) in `docs/` that contain the answer. This is what hit/recall check.
- `answer_contains` — key strings; **not used yet** — reserved for the P0.5b answer-quality check.
- Put the corresponding source file in `docs/` (`.md`, `.txt`, later `.pdf` / `.docx` / `.hwp`).

The current `docs/` + `golden/seed.jsonl` are a **synthetic seed** so the harness is
demonstrable today. Replace them with real archive material + real questions.

## Not here yet (P0.5b — needs a judge LLM + Python ≤3.13 / WSL)

- RAGAS faithfulness / answer-relevance / context-precision (LLM-as-judge)
- DeepEval PR gate
- Langfuse tracing (needs Docker → P0b/WSL)
- per-citation feedback UI (chat-level `feedbackScore` already exists in `workspace_chats`)
