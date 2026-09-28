// [auto-docu] item 6 — upgrade the archive-full PDFs that were originally parsed
// with the pdfjs fallback (docling-serve wasn't up yet at the 2026-09-11 bulk
// reingest) to a real Docling parse, now that the Docling page-batching is
// hardened (abort-on-server-death + halve-and-retry, commit 22d24643) and the
// multi-row table header bug is fixed (def5bccc).
//
// Sequential, one document at a time — this box has ~2-3GB free RAM and a
// large PDF can OOM docling-serve even with batching, so no parallelism here.
// Resumable via a local progress file; if docling-serve dies mid-run the loop
// stops immediately rather than silently falling everything back to pdfjs.
//
//   node eval/reparse-pdfs-docling.mjs [--dry-run] [--limit N]
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { AllmClient } from "./lib/client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const samples = join(root, "_samples");
const documentsRoot = join(root, "server", "storage", "documents");
const progressPath = join(root, ".local-cache", "docling-reparse-progress.json");
const SLUG = "archive-full";
const DOCLING_HEALTH_URL = process.env.DOCLING_SERVE_URL
  ? `${process.env.DOCLING_SERVE_URL.replace(/\/+$/, "")}/health`
  : "http://127.0.0.1:5001/health";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1], 10) : Infinity;

async function doclingAlive() {
  try {
    const res = await fetch(DOCLING_HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function loadProgress() {
  if (!existsSync(progressPath)) return { done: [], failed: [], notImproved: [] };
  try {
    return JSON.parse(await readFile(progressPath, "utf8"));
  } catch {
    return { done: [], failed: [], notImproved: [] };
  }
}

async function saveProgress(progress) {
  await writeFile(progressPath, JSON.stringify(progress, null, 2));
}

function parseMetadata(document) {
  try {
    return JSON.parse(document.metadata || "{}");
  } catch {
    return {};
  }
}

const keyPath = join(here, ".key");
if (!existsSync(keyPath)) {
  console.error("missing eval/.key — run: node eval/setup-key.mjs");
  process.exit(1);
}
const client = new AllmClient((await readFile(keyPath, "utf8")).trim());
if (!(await client.ping())) {
  console.error("server not reachable — start it first (run-local.ps1)");
  process.exit(1);
}
if (!(await doclingAlive())) {
  console.error(`docling-serve not reachable at ${DOCLING_HEALTH_URL} — start it first (start-docling.ps1)`);
  process.exit(1);
}

const ws = await client.getWorkspace(SLUG);
const progress = await loadProgress();
const doneSet = new Set(progress.done.map((d) => d.docpath));
const failedSet = new Set(progress.failed.map((d) => d.docpath));

const targets = (ws.documents || [])
  .map((d) => ({ doc: d, meta: parseMetadata(d) }))
  .filter(({ doc, meta }) => {
    if (doneSet.has(doc.docpath) || failedSet.has(doc.docpath)) return false;
    if (meta.parse_path !== "pdfjs") return false;
    if (!meta.docSource || !meta.docSource.startsWith("archive-samples://")) return false;
    return true;
  })
  .slice(0, limit);

console.log(
  `• ${SLUG}: ${targets.length} pdfjs-parsed PDF(s) queued for Docling reparse ` +
    `(${progress.done.length} already upgraded, ${progress.failed.length} previously failed)`
);
if (dryRun) {
  for (const { doc, meta } of targets) console.log(`  would reparse: ${meta.title || doc.filename}`);
  process.exit(0);
}

for (const [i, { doc, meta }] of targets.entries()) {
  const label = meta.title || doc.filename;
  const started = Date.now();
  process.stdout.write(`[${i + 1}/${targets.length}] ${label} … `);

  if (!(await doclingAlive())) {
    console.log("STOPPED — docling-serve is down");
    console.log(`docling-serve died before processing "${label}". Stopping run — restart docling-serve and re-run to resume.`);
    await saveProgress(progress);
    process.exit(1);
  }

  const relPath = meta.docSource.replace("archive-samples://", "");
  const sourcePath = join(samples, ...relPath.split("/"));
  if (!existsSync(sourcePath)) {
    console.log("FAILED — source file missing");
    progress.failed.push({ docpath: doc.docpath, title: label, reason: `source missing: ${sourcePath}` });
    await saveProgress(progress);
    continue;
  }

  let location;
  try {
    location = await client.uploadDoc(sourcePath, {
      metadata: { title: meta.title, docSource: meta.docSource },
    });
  } catch (error) {
    console.log(`FAILED — upload/parse error: ${(error?.message || String(error)).slice(0, 200)}`);
    progress.failed.push({ docpath: doc.docpath, title: label, reason: error?.message || String(error) });
    await saveProgress(progress);
    continue;
  }

  const newDocPath = isAbsolute(location) ? location : join(documentsRoot, location);
  let newMeta = {};
  try {
    newMeta = JSON.parse(await readFile(newDocPath, "utf8"));
  } catch (error) {
    console.log(`FAILED — could not read newly parsed doc: ${error.message}`);
    progress.failed.push({ docpath: doc.docpath, title: label, reason: `read new doc failed: ${error.message}` });
    await saveProgress(progress);
    continue;
  }

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  if (newMeta.parse_path !== "docling") {
    console.log(`not improved (still ${newMeta.parse_path}, ${secs}s) — keeping old`);
    progress.notImproved.push({ docpath: doc.docpath, title: label, newParsePath: newMeta.parse_path });
    await saveProgress(progress);
    await unlink(newDocPath).catch(() => {});
    continue;
  }

  try {
    await client.updateEmbeddings(SLUG, { adds: [location], deletes: [doc.docpath] });
  } catch (error) {
    console.log(`FAILED — swap error: ${(error?.message || String(error)).slice(0, 200)}`);
    progress.failed.push({ docpath: doc.docpath, title: label, reason: `swap failed: ${error?.message || String(error)}` });
    await saveProgress(progress);
    continue;
  }

  console.log(`OK — upgraded to docling (conf=${newMeta.parse_confidence ?? "?"}, ${newMeta.wordCount ?? "?"} words, ${secs}s)`);
  progress.done.push({ docpath: doc.docpath, title: label, newDocpath: location, wordCount: newMeta.wordCount });
  await saveProgress(progress);
}

console.log(
  `\ndone: ${progress.done.length} upgraded, ${progress.notImproved.length} not improved (kept old), ` +
    `${progress.failed.length} failed. Progress: ${progressPath}`
);
