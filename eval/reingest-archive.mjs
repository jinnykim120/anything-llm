// Re-ingest the archive-test workspace's documents from _samples/ on the
// current code (parsing / chunking / metadata). Needed whenever an ingest-time
// change lands (e.g. a new chunk metadata field, a parser fix).
//
//   node eval/reingest-archive.mjs
//
// Uploads via Node's FormData (preserves Korean filenames — `curl -F` on a
// cp949 Windows box does not), then swaps the workspace's embeddings: adds the
// fresh docs, deletes whatever was there. Server must be running; eval/.key set.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AllmClient } from "./lib/client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SLUG = "archive-test";
const SAMPLES = join(here, "..", "_samples");

// The 4 archive-test documents, by _samples/ filename.
const DOCS = [
  "대규모유통업에서의 거래 공정화에 관한 법률(법률)(제20712호)(20250121).pdf",
  "대규모유통업 분야에서 판매장려금의 부당성 심사에 관한 지침(공정거래위원회예규)(제487호)(20251008).pdf",
  "2026년 GS리테일 유통혁신.hwp",
  "2026년 상생기업 GS리테일 공적서.hwpx",
];

const keyPath = join(here, ".key");
if (!existsSync(keyPath)) {
  console.error("missing eval/.key — run:  node eval/setup-key.mjs");
  process.exit(1);
}
const client = new AllmClient((await readFile(keyPath, "utf8")).trim());
if (!(await client.ping())) {
  console.error("server not reachable — start it first (run-local.ps1)");
  process.exit(1);
}

const ws = await client.getWorkspace(SLUG).catch(() => null);
const existing = (ws?.documents || []).map((d) => d.docpath);
console.log(`• ${SLUG}: ${existing.length} existing doc(s)`);

const adds = [];
for (const name of DOCS) {
  const fp = join(SAMPLES, name);
  if (!existsSync(fp)) {
    console.error(`  ! missing ${fp}`);
    process.exit(1);
  }
  process.stdout.write(`  uploading ${name} … `);
  const loc = await client.uploadDoc(fp);
  adds.push(loc);
  console.log("ok");
}

process.stdout.write(`• embedding ${adds.length} new, removing ${existing.length} old … `);
await client.updateEmbeddings(SLUG, { adds, deletes: existing });
console.log("ok");

const after = await client.getWorkspace(SLUG);
const docs = after?.documents || [];
console.log(`\n${SLUG} now has ${docs.length} doc(s):`);
for (const d of docs) {
  const m = JSON.parse(d.metadata || "{}");
  console.log(`  ${m.title}`);
}
