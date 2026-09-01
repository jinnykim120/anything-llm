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

## Answer-quality harness (P0.5b — lightweight)

`node eval/answers.mjs` — runs golden questions through the **real grounded chat
endpoint** and has `claude -p` judge each answer against a reference.

```bash
node eval/answers.mjs                      # all items, workspace "archive-test"
node eval/answers.mjs --id jangryeo-axes   # one item
node eval/answers.mjs --workspace eval --limit 3
EVAL_JUDGE_MODEL=claude-opus-5 node eval/answers.mjs   # less-biased judge
```

Needs: server running, `eval/.key`, the target workspace already populated, and
the `claude` CLI on PATH (`CLAUDE_CLI_BIN` to override).

**Metrics** (0.0–1.0, judged by `claude -p`):
- **faithfulness** — is every claim in the answer supported by the retrieved context?
- **completeness** — what fraction of the golden `expect_facts` does the answer convey?
- **citation_accuracy** — do the `[n]` markers point to context that supports the sentence?
- **retrieval_hit** — did a retrieved chunk's `section_path` contain `expect_section`? (0/1, informational)

Pass thresholds: faithfulness ≥ 0.8, completeness ≥ 0.7, citation_accuracy ≥ 0.8.
It's a **regression tool** — run before/after a parsing/chunking/retrieval/prompt
change and compare. Absolute scores are soft: by default the judge is the same
model that writes the answers (self-preference bias) — set `EVAL_JUDGE_MODEL`.

### Golden answer items — `golden/*.answers.jsonl`

```json
{"id": "law-art7", "question": "…", "domain": "공정거래",
 "expect_section": "제7조(상품대금 감액의 금지)",
 "expect_facts": ["fact the answer must convey", "…"]}
```

- `expect_facts` — the key points a *complete* answer conveys (substance, not verbatim).
- `expect_section` — a `section_path` substring that should appear in a retrieved chunk.
- Omit `expect_section` + set `expect_docs: []` for a **refusal item** (the system should
  say the info isn't in the corpus).

### Re-ingesting the target workspace

`node eval/reingest-archive.mjs` re-uploads the `archive-test` docs from `_samples/`
on the current code (needed after an ingest-time change — e.g. a new chunk field).
Uploads via Node's `FormData` because `curl -F` on a cp949 Windows box mojibakes
Korean filenames.

## Not here yet

- RAGAS / DeepEval / Langfuse, synthetic-question generation, PR gate, regression alerts
- per-citation feedback UI (chat-level `feedbackScore` already exists in `workspace_chats`)
