// One-off: upload every file in a _samples/ subfolder into archive-full,
// adding to its existing embeddings (does NOT remove anything already there).
//
//   node eval/upload-samples-folder.mjs "<folder name under _samples/>"
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AllmClient } from "./lib/client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SLUG = "archive-full";
const folderArg = process.argv[2];
if (!folderArg) {
  console.error('usage: node eval/upload-samples-folder.mjs "<folder name>"');
  process.exit(1);
}
const folder = join(here, "..", "_samples", folderArg);
if (!existsSync(folder)) {
  console.error(`missing folder: ${folder}`);
  process.exit(1);
}

const keyPath = join(here, ".key");
const client = new AllmClient((await readFile(keyPath, "utf8")).trim());
if (!(await client.ping())) {
  console.error("server not reachable — start it first");
  process.exit(1);
}

const before = await client.getWorkspace(SLUG);
console.log(`• ${SLUG}: ${before?.documents?.length ?? 0} document(s) before`);

const files = (await readdir(folder, { withFileTypes: true }))
  .filter((e) => e.isFile())
  .map((e) => e.name);
if (!files.length) {
  console.error(`no files found in ${folder}`);
  process.exit(1);
}

const adds = [];
const failed = [];
for (const name of files) {
  process.stdout.write(`  uploading ${name} … `);
  try {
    const loc = await client.uploadDoc(join(folder, name));
    adds.push(loc);
    console.log("ok ->", loc);
  } catch (e) {
    failed.push({ name, error: e.message });
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
