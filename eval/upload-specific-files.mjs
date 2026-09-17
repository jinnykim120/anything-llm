// One-off: upload specific files (by path) into archive-full, adding to its
// existing embeddings (does NOT remove anything already there).
//
//   node eval/upload-specific-files.mjs "<path1>" "<path2>" ...
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AllmClient } from "./lib/client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SLUG = "archive-full";
const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('usage: node eval/upload-specific-files.mjs "<path1>" "<path2>" ...');
  process.exit(1);
}
for (const p of paths) {
  if (!existsSync(p)) {
    console.error(`missing file: ${p}`);
    process.exit(1);
  }
}

const keyPath = join(here, ".key");
const client = new AllmClient((await readFile(keyPath, "utf8")).trim());
if (!(await client.ping())) {
  console.error("server not reachable — start it first");
  process.exit(1);
}

const before = await client.getWorkspace(SLUG);
console.log(`• ${SLUG}: ${before?.documents?.length ?? 0} document(s) before`);

const adds = [];
const failed = [];
for (const p of paths) {
  process.stdout.write(`  uploading ${p} … `);
  try {
    const loc = await client.uploadDoc(p);
    adds.push(loc);
    console.log("ok ->", loc);
  } catch (e) {
    failed.push({ name: p, error: e.message });
    console.log("FAILED —", e.message.split("\n")[0]);
  }
}

if (adds.length) {
  process.stdout.write(`• embedding ${adds.length} new doc(s) into ${SLUG} … `);
  await client.embed(SLUG, adds);
  console.log("ok");
} else {
  console.log("• nothing to embed — every upload failed");
}

if (failed.length) {
  console.log(`\n${failed.length} file(s) failed to upload:`);
  for (const f of failed) console.log(`  - ${f.name}: ${f.error.split("\n")[0]}`);
}

const after = await client.getWorkspace(SLUG);
console.log(`\n${SLUG} now has ${after?.documents?.length ?? 0} document(s).`);
