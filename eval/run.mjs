// P0.5 retrieval eval harness.
// Builds a clean eval workspace from eval/docs, runs eval/golden/*.jsonl through
// the real /v1 vector-search in each retrieval mode, reports hit@k / recall@k / MRR.
//
//   node eval/run.mjs                 # default + rerank modes
//   node eval/run.mjs --mode default  # one mode
//   node eval/run.mjs --keep          # don't rebuild the workspace (faster iteration)
//
// Needs the server running and eval/.key present (node eval/setup-key.mjs).

import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AllmClient } from "./lib/client.mjs";
import { scoreOne, aggregate, fmtTable, KS } from "./lib/metrics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const only = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : null;
const keep = args.includes("--keep");
const SLUG = "eval";
const MODES = only ? [only] : ["default", "rerank"];
const TOP_N = 8;

function docIdFromResult(r) {
  // vector-search returns metadata.title (= original filename) and metadata.chunkSource
  return r?.metadata?.title || r?.metadata?.chunkSource || "?";
}

async function loadGolden() {
  const dir = join(here, "golden");
  // `.answers.jsonl` belongs to the answer-quality harness (eval/answers.mjs) —
  // those question sets target their own workspace, not the synthetic eval one.
  const files = (await readdir(dir)).filter(
    (f) => f.endsWith(".jsonl") && !f.endsWith(".answers.jsonl")
  );
  const items = [];
  for (const f of files) {
    const lines = (await readFile(join(dir, f), "utf8")).split("\n").filter((l) => l.trim());
    for (const l of lines) items.push(JSON.parse(l));
  }
  return items;
}

async function buildWorkspace(client) {
  console.log("• rebuilding eval workspace…");
  await client.deleteWorkspace(SLUG);
  await client.newWorkspace("eval");
  const dir = join(here, "docs");
  const files = (await readdir(dir)).filter((f) => /\.(md|txt|pdf|docx)$/i.test(f));
  const locations = [];
  for (const f of files) {
    process.stdout.write(`  uploading ${f} … `);
    locations.push(await client.uploadDoc(join(dir, f)));
    console.log("ok");
  }
  process.stdout.write(`  embedding ${locations.length} docs … `);
  await client.embed(SLUG, locations);
  console.log("ok");
}

async function runMode(client, golden, mode) {
  await client.updateWorkspace(SLUG, {
    vectorSearchMode: mode === "rerank" ? "rerank" : "default",
    topN: TOP_N,
  });
  const per = [];
  for (const q of golden) {
    const results = await client.vectorSearch(SLUG, q.question, { topN: TOP_N });
    const ranked = results.map(docIdFromResult);
    const s = scoreOne(ranked, q.expect_docs);
    per.push({ id: q.id, domain: q.domain, rr: s.rr, hit: s.hit, recall: s.recall, precision: s.precision, ranked });
  }
  return { agg: aggregate(per), per };
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

const golden = await loadGolden();
console.log(`• golden set: ${golden.length} questions`);
if (!keep) await buildWorkspace(client);

const byMode = {};
const details = {};
for (const mode of MODES) {
  process.stdout.write(`• mode=${mode} … `);
  const { agg, per } = await runMode(client, golden, mode);
  byMode[mode] = agg;
  details[mode] = per;
  console.log("done");
}

console.log("\n" + fmtTable(byMode) + "\n");

// per-question misses at hit@5 (primary mode = first in list)
const primary = MODES[0];
const misses = details[primary].filter((q) => q.hit[5] === 0);
if (misses.length) {
  console.log(`misses @5 (mode=${primary}):`);
  for (const m of misses) console.log(`  ✗ ${m.id.padEnd(12)} got: ${m.ranked.slice(0, 3).join(", ")}`);
} else {
  console.log(`no misses @5 (mode=${primary})`);
}

const report = {
  ts: new Date().toISOString(),
  goldenCount: golden.length,
  topN: TOP_N,
  ks: KS,
  byMode,
  details,
};
const out = join(here, "reports", `${report.ts.replace(/[:.]/g, "-")}.json`);
await writeFile(out, JSON.stringify(report, null, 2));
console.log(`\nreport → ${out}`);
