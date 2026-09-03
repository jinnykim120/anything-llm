// Retrieval performance baseline for an already-ingested workspace.
//
//   node eval/perf.mjs
//   PERF_WORKSPACE=archive-full PERF_REPEAT=3 node eval/perf.mjs
//   node eval/perf.mjs --mode default --repeat 5
//
// This deliberately measures the real vector-search endpoint. It does not
// upload or embed anything, so it is safe to run against a production-like
// workspace while ingestion is paused.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { AllmClient } from "./lib/client.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const keyPath = join(here, ".key");
const questionPath = join(here, "golden", "archive.answers.jsonl");
const reportDir = join(here, "reports");
const workspaceSlug =
  process.env.PERF_WORKSPACE ||
  (process.argv.includes("--workspace")
    ? process.argv[process.argv.indexOf("--workspace") + 1]
    : null) ||
  "archive-full";
const requestedMode = process.env.PERF_MODE ||
  (process.argv.includes("--mode")
    ? process.argv[process.argv.indexOf("--mode") + 1]
    : null);
const modes = requestedMode ? [requestedMode] : ["default", "rerank"];
const repeat = Math.max(
  1,
  Number.parseInt(
    process.env.PERF_REPEAT ||
      (process.argv.includes("--repeat")
        ? process.argv[process.argv.indexOf("--repeat") + 1]
        : "2"),
    10
  ) || 2
);
const topN = Math.max(
  1,
  Number.parseInt(process.env.PERF_TOP_N || "8", 10) || 8
);

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Number(sorted[index].toFixed(1));
}

function summarize(samples) {
  const successful = samples.filter((sample) => sample.ok);
  const latencies = successful.map((sample) => sample.elapsedMs);
  const resultCounts = successful.map((sample) => sample.resultCount);
  return {
    n: samples.length,
    ok: successful.length,
    errors: samples.length - successful.length,
    avgMs: latencies.length
      ? Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(1))
      : null,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    maxMs: latencies.length ? Number(Math.max(...latencies).toFixed(1)) : null,
    avgResults: resultCounts.length
      ? Number((resultCounts.reduce((sum, value) => sum + value, 0) / resultCounts.length).toFixed(1))
      : null,
  };
}

async function serverSnapshot() {
  const snapshot = {
    freeBytes: os.freemem(),
    totalBytes: os.totalmem(),
    server: null,
  };
  if (process.platform !== "win32") return snapshot;

  // The local development server owns port 3001. Keep this optional so the
  // benchmark remains usable on Linux/WSL and when the port is proxied.
  const script =
    "$ownerPid=(Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess); " +
    "if ($ownerPid) { Get-Process -Id $ownerPid | Select-Object Id,WorkingSet64,CPU | ConvertTo-Json -Compress }";
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 5_000, maxBuffer: 16 * 1024 }
    );
    if (stdout.trim()) snapshot.server = JSON.parse(stdout);
  } catch {
    // Process telemetry is best effort; endpoint timings remain authoritative.
  }
  return snapshot;
}

function formatMs(value) {
  return value == null ? "-" : `${value.toFixed(1)} ms`;
}

if (!existsSync(keyPath)) {
  console.error("missing eval/.key — run: node eval/setup-key.mjs");
  process.exit(1);
}
if (!existsSync(questionPath)) {
  console.error(`missing question set: ${questionPath}`);
  process.exit(1);
}

const client = new AllmClient((await readFile(keyPath, "utf8")).trim());
if (!(await client.ping())) {
  console.error("server not reachable at /api/ping — start it first");
  process.exit(1);
}

const workspace = await client.getWorkspace(workspaceSlug);
if (!workspace) {
  console.error(`workspace not found: ${workspaceSlug}`);
  process.exit(1);
}
const questions = parseJsonLines(await readFile(questionPath, "utf8"));
const before = await serverSnapshot();
console.log(
  `• workspace=${workspaceSlug}, documents=${workspace.documents?.length ?? "?"}, ` +
    `questions=${questions.length}, repeat=${repeat}, topN=${topN}`
);

const report = {
  ts: new Date().toISOString(),
  workspace: workspaceSlug,
  workspaceDocuments: workspace.documents?.length ?? null,
  questionSet: questionPath,
  repeat,
  topN,
  modes,
  before,
  byMode: {},
};

for (const mode of modes) {
  if (!new Set(["default", "rerank"]).has(mode)) {
    throw new Error(`unsupported mode: ${mode}`);
  }
  await client.updateWorkspace(workspaceSlug, {
    vectorSearchMode: mode === "rerank" ? "rerank" : "default",
    topN,
  });

  // Prime tokenizer/model and exclude one-time initialization from timings.
  await client.vectorSearch(workspaceSlug, questions[0].question, { topN });
  const samples = [];
  for (const question of questions) {
    for (let iteration = 1; iteration <= repeat; iteration += 1) {
      const started = performance.now();
      try {
        const results = await client.vectorSearch(workspaceSlug, question.question, { topN });
        samples.push({
          id: question.id,
          iteration,
          ok: true,
          elapsedMs: Number((performance.now() - started).toFixed(1)),
          resultCount: results.length,
          firstSource:
            results[0]?.metadata?.title || results[0]?.metadata?.chunkSource || null,
        });
      } catch (error) {
        samples.push({
          id: question.id,
          iteration,
          ok: false,
          elapsedMs: Number((performance.now() - started).toFixed(1)),
          error: error?.message || String(error),
        });
      }
    }
  }
  const summary = summarize(samples);
  report.byMode[mode] = { summary, samples };
  console.log(
    `  ${mode.padEnd(7)} n=${summary.n} avg=${formatMs(summary.avgMs)} ` +
      `p50=${formatMs(summary.p50Ms)} p95=${formatMs(summary.p95Ms)} ` +
      `max=${formatMs(summary.maxMs)} errors=${summary.errors}`
  );
}

report.after = await serverSnapshot();
await mkdir(reportDir, { recursive: true });
const reportPath = join(
  reportDir,
  `perf-${workspaceSlug}-${report.ts.replace(/[:.]/g, "-")}.json`
);
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(`• report → ${reportPath}`);
