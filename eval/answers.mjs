// P0.5b — answer-quality eval harness (lightweight).
// Runs golden questions through the real grounded chat endpoint, then has
// `claude -p` judge each answer on faithfulness / completeness / citation
// accuracy against a reference. Prints a table, writes a JSON report.
//
//   node eval/answers.mjs                     # all items, workspace "archive-test"
//   node eval/answers.mjs --workspace eval    # a different workspace
//   node eval/answers.mjs --id jangryeo-axes  # one item
//   node eval/answers.mjs --limit 3
//
// Needs: server running, eval/.key present (node eval/setup-key.mjs), the target
// workspace already populated, and the `claude` CLI on PATH (or CLAUDE_CLI_BIN).
//
// This is a REGRESSION tool — run it before and after a parsing/chunking/
// retrieval/prompt change and compare. Absolute scores are soft (the default
// judge model is the same one that writes the answers — set EVAL_JUDGE_MODEL to
// a different model for a less biased read).

import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AllmClient } from "./lib/client.mjs";
import { judge, JUDGE_MODEL } from "./lib/judge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const WS = arg("--workspace") || "archive-test";
const ONLY_ID = arg("--id");
const LIMIT = arg("--limit") ? Number(arg("--limit")) : Infinity;

const AXES = ["faithfulness", "completeness", "citation_accuracy"];
const PASS = { faithfulness: 0.8, completeness: 0.7, citation_accuracy: 0.8 };

async function loadGolden() {
  const dir = join(here, "golden");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".answers.jsonl"));
  const items = [];
  for (const f of files) {
    const lines = (await readFile(join(dir, f), "utf8"))
      .split("\n")
      .filter((l) => l.trim());
    for (const l of lines) items.push(JSON.parse(l));
  }
  return items;
}

// Did retrieval surface the right source? 1 if any retrieved chunk is from an
// `expect_docs` document (title match) or its `section_path` contains
// `expect_section`. Informational — section expansion changes which chunks come
// back, so treat a 0 as "check the answer", not a hard fail.
function retrievalHit(sources, item) {
  const { expect_docs, expect_section } = item;
  if (!expect_docs?.length && !expect_section) return null;
  return sources.some((s) => {
    const title = s.title || s.metadata?.title || "";
    const sec = s.section_path || s.metadata?.section_path || "";
    const docOk = (expect_docs || []).some(
      (d) => title.includes(d) || (d && title && d.includes(title))
    );
    const secOk = expect_section ? String(sec).includes(expect_section) : false;
    return docOk || secOk;
  })
    ? 1
    : 0;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function fmt(n) {
  return n.toFixed(3);
}

function table(per) {
  const rows = per.map((p) => {
    const flag = AXES.some((a) => p.score[a] < PASS[a]) ? "▽" : " ";
    return `${flag} ${p.id.padEnd(20)} ${fmt(p.score.faithfulness)}  ${fmt(
      p.score.completeness
    )}  ${fmt(p.score.citation_accuracy)}   ${
      p.retrieval_hit === null ? "  –" : `  ${p.retrieval_hit}`
    }   ${p.ms}s`;
  });
  const agg = {
    faithfulness: mean(per.map((p) => p.score.faithfulness)),
    completeness: mean(per.map((p) => p.score.completeness)),
    citation_accuracy: mean(per.map((p) => p.score.citation_accuracy)),
  };
  const dh = per.filter((p) => p.retrieval_hit !== null);
  const head =
    "   " +
    "id".padEnd(20) +
    " faithful  complete  cite-acc   retr-hit  time";
  const foot = `   ${"MEAN".padEnd(20)} ${fmt(agg.faithfulness)}  ${fmt(
    agg.completeness
  )}  ${fmt(agg.citation_accuracy)}   ${
    dh.length ? fmt(mean(dh.map((p) => p.retrieval_hit))) : "  –"
  }`;
  return [head, "   " + "-".repeat(60), ...rows, "   " + "-".repeat(60), foot].join(
    "\n"
  );
}

// ---- main ----
const keyPath = join(here, ".key");
if (!existsSync(keyPath)) {
  console.error("missing eval/.key — run:  node eval/setup-key.mjs");
  process.exit(1);
}
const client = new AllmClient((await readFile(keyPath, "utf8")).trim());
if (!(await client.ping())) {
  console.error("server not reachable at /api/ping — start it first (run-local.ps1)");
  process.exit(1);
}

let golden = await loadGolden();
if (ONLY_ID) golden = golden.filter((g) => g.id === ONLY_ID);
golden = golden.slice(0, LIMIT);
if (!golden.length) {
  console.error("no golden items matched");
  process.exit(1);
}

console.log(
  `• workspace: ${WS}  ·  ${golden.length} question(s)  ·  judge: ${JUDGE_MODEL}\n`
);

const per = [];
for (const g of golden) {
  process.stdout.write(`  ${g.id.padEnd(20)} `);
  const t0 = Date.now();
  let answer = "";
  let sources = [];
  let error = null;
  try {
    const r = await client.chat(WS, g.question);
    answer = r.answer;
    sources = r.sources;
    error = r.error;
  } catch (e) {
    error = e.message;
  }
  if (error) {
    console.log(`chat error: ${error}`);
    per.push({
      id: g.id,
      domain: g.domain,
      score: { faithfulness: 0, completeness: 0, citation_accuracy: 0 },
      retrieval_hit: retrievalHit(sources, g),
      ms: Math.round((Date.now() - t0) / 1000),
      error,
    });
    continue;
  }
  let score;
  try {
    score = await judge({
      question: g.question,
      expectFacts: g.expect_facts,
      answer,
      contexts: sources.map((s) => s.text || ""),
    });
  } catch (e) {
    console.log(`judge error: ${e.message}`);
    score = {
      faithfulness: 0,
      completeness: 0,
      citation_accuracy: 0,
      missing_facts: [],
      unsupported_claims: [],
      note: `judge failed: ${e.message}`,
    };
  }
  const ms = Math.round((Date.now() - t0) / 1000);
  per.push({
    id: g.id,
    domain: g.domain,
    question: g.question,
    answer,
    sourceCount: sources.length,
    score,
    retrieval_hit: retrievalHit(sources, g),
    ms,
  });
  console.log(
    `f=${fmt(score.faithfulness)} c=${fmt(score.completeness)} ca=${fmt(
      score.citation_accuracy
    )}  (${ms}s)`
  );
}

console.log("\n" + table(per) + "\n");

const flagged = per.filter((p) => AXES.some((a) => p.score[a] < PASS[a]));
if (flagged.length) {
  console.log(`below threshold (${JSON.stringify(PASS)}):`);
  for (const p of flagged) {
    console.log(`  ▽ ${p.id}`);
    if (p.score.missing_facts?.length)
      console.log(`      missing: ${p.score.missing_facts.join(" | ")}`);
    if (p.score.unsupported_claims?.length)
      console.log(`      unsupported: ${p.score.unsupported_claims.join(" | ")}`);
    if (p.score.note) console.log(`      note: ${p.score.note}`);
  }
} else {
  console.log("all items at or above threshold.");
}

const report = {
  ts: new Date().toISOString(),
  workspace: WS,
  judgeModel: JUDGE_MODEL,
  count: per.length,
  pass: PASS,
  mean: {
    faithfulness: mean(per.map((p) => p.score.faithfulness)),
    completeness: mean(per.map((p) => p.score.completeness)),
    citation_accuracy: mean(per.map((p) => p.score.citation_accuracy)),
  },
  per,
};
const out = join(
  here,
  "reports",
  `answers-${report.ts.replace(/[:.]/g, "-")}.json`
);
await writeFile(out, JSON.stringify(report, null, 2));
console.log(`\nreport → ${out}`);
