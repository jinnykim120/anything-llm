// Build or resume a full archive workspace from _samples/.
//
// The source tree contains a few exact duplicates and ZIP bundles that the
// current collector intentionally does not parse. This script uploads one
// representative of each supported content hash, then embeds in small batches
// so a long run can be resumed without touching archive-test or LanceDB data.
//
//   node eval/reingest-full.mjs
//   FULL_ARCHIVE_BATCH_SIZE=4 node eval/reingest-full.mjs
//
// The workspace slug is archive-full by default. Set FULL_ARCHIVE_INCLUDE_DUPLICATES=true
// only when preserving duplicate source paths is more important than avoiding
// duplicate parsing/embeddings.

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AllmClient } from "./lib/client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const samples = join(root, "_samples");
const manifestPath = join(root, ".local-cache", "archive-full-manifest.json");
const progressPath = join(root, ".local-cache", "archive-full-progress.json");
const keyPath = join(here, ".key");
const slug = process.env.FULL_ARCHIVE_SLUG || "archive-full";
const workspaceName = process.env.FULL_ARCHIVE_NAME || slug;
const batchSize = Math.max(
  1,
  Number.parseInt(process.env.FULL_ARCHIVE_BATCH_SIZE || "8", 10) || 8
);
const includeDuplicates = process.env.FULL_ARCHIVE_INCLUDE_DUPLICATES === "true";
const supported = new Set([
  ".docx",
  ".hwp",
  ".hwpx",
  ".jpg",
  ".jpeg",
  ".pdf",
  ".png",
  ".pptx",
  ".xlsx",
]);

if (!existsSync(keyPath)) {
  console.error("missing eval/.key — run: node eval/setup-key.mjs");
  process.exit(1);
}
if (!existsSync(samples)) {
  console.error(`missing samples directory: ${samples}`);
  process.exit(1);
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function parseMetadata(document) {
  if (!document?.metadata) return {};
  if (typeof document.metadata === "object") return document.metadata;
  try {
    return JSON.parse(document.metadata);
  } catch {
    return {};
  }
}

function sourceFor(item) {
  return `archive-samples://${item.path}`;
}

async function loadProgress() {
  if (!existsSync(progressPath)) return { completedHashes: [], failures: [] };
  try {
    return JSON.parse(await readFile(progressPath, "utf8"));
  } catch {
    return { completedHashes: [], failures: [] };
  }
}

async function saveProgress(completedHashes, failures) {
  await writeFile(
    progressPath,
    JSON.stringify(
      {
        workspace: slug,
        updatedAt: new Date().toISOString(),
        completedHashes: [...completedHashes],
        failures,
      },
      null,
      2
    )
  );
}

async function buildManifest() {
  const all = (await walk(samples)).sort((a, b) => a.localeCompare(b, "ko"));
  const supportedFiles = all.filter((file) => supported.has(extname(file).toLowerCase()));
  const skipped = all
    .filter((file) => !supported.has(extname(file).toLowerCase()))
    .map((file) => ({ path: relative(samples, file).split(sep).join("/"), reason: "unsupported-extension" }));
  const byHash = new Map();
  const duplicates = [];
  for (const file of supportedFiles) {
    const path = relative(samples, file).split(sep).join("/");
    const hash = await hashFile(file);
    const first = byHash.get(hash);
    if (first && !includeDuplicates) {
      duplicates.push({ path, duplicateOf: first.path, hash });
      continue;
    }
    if (!first) byHash.set(hash, { file, path, hash });
  }
  return {
    generatedAt: new Date().toISOString(),
    sourceRoot: samples,
    includeDuplicates,
    files: [...byHash.values()],
    skipped,
    duplicates,
  };
}

async function ensureWorkspace(client) {
  let workspace = await client.getWorkspace(slug).catch(() => null);
  if (!workspace) {
    const created = await client.newWorkspace(workspaceName);
    workspace = await client.getWorkspace(slug).catch(() => null);
    if (!workspace) {
      const candidate = created?.workspace || created;
      const createdSlug = candidate?.slug;
      if (createdSlug && createdSlug !== slug)
        throw new Error(`workspace created with unexpected slug: ${createdSlug}`);
      workspace = candidate;
    }
  }
  if (!workspace) throw new Error(`could not create or load workspace: ${slug}`);
  return workspace;
}

const client = new AllmClient((await readFile(keyPath, "utf8")).trim());
if (!(await client.ping())) {
  console.error("server not reachable — start it first (run-local.ps1)");
  process.exit(1);
}

const manifest = await buildManifest();
await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
console.log(
  `• manifest: ${manifest.files.length} unique supported file(s), ` +
    `${manifest.duplicates.length} duplicate(s), ${manifest.skipped.length} skipped (→ ${manifestPath})`
);
if (process.env.FULL_ARCHIVE_DRY_RUN === "true") {
  console.log("dry run — no workspace or document changes made");
  process.exit(0);
}

const workspace = await ensureWorkspace(client);
const existing = workspace.documents || [];
const existingSources = new Set(
  existing.map(parseMetadata).map((m) => m.docSource).filter(Boolean)
);
const progress = await loadProgress();
const completedHashes = new Set(progress.completedHashes || []);
const failures = Array.isArray(progress.failures) ? progress.failures : [];
const pending = manifest.files.filter(
  (item) => !existingSources.has(sourceFor(item)) && !completedHashes.has(item.hash)
);
const stored = (await client.listDocumentsFolder("custom-documents").catch(() => ({}))).documents || [];
const storedBySource = new Map(
  stored
    .filter((document) => document.docSource && document.name)
    .map((document) => [document.docSource, `custom-documents/${document.name}`])
);
console.log(
  `• workspace=${slug}: ${existing.length} existing, ` +
    `${manifest.files.length - pending.length} already present, ${pending.length} pending ` +
    `(${storedBySource.size} source-tagged parsed files available for reuse)`
);

for (let offset = 0; offset < pending.length; offset += batchSize) {
  const batch = pending.slice(offset, offset + batchSize);
  const ready = [];
  for (const item of batch) {
    try {
      let location = storedBySource.get(sourceFor(item));
      if (location) {
        process.stdout.write(`  reusing parsed ${item.path} … `);
      } else {
        const filePath = join(samples, ...item.path.split("/"));
        process.stdout.write(`  uploading ${item.path} … `);
        location = await client.uploadDoc(filePath, {
          metadata: {
            // Keep the relative source path visible in citations when two folders
            // contain files with the same basename.
            title: item.path,
            docSource: sourceFor(item),
          },
        });
      }
      ready.push({ item, location });
      console.log("ok");
    } catch (error) {
      const message = error?.message || String(error);
      // A collector 5xx with a readable response is a document-level parse
      // failure (for example, an image-only PDF with no OCR text). Keep the
      // corpus run moving and report it at the end. Network resets/timeouts are
      // rethrown so the server can be restarted and this run safely resumed.
      if (!/POST \/v1\/document\/upload -> 5\d\d/.test(message)) throw error;
      const reason = message.split(": ").slice(1).join(": ").slice(0, 500);
      console.log(`skipped (${reason})`);
      completedHashes.add(item.hash);
      failures.push({ path: item.path, reason });
      await saveProgress(completedHashes, failures);
    }
  }
  if (!ready.length) continue;
  process.stdout.write(
    `  embedding ${offset + 1}-${offset + ready.length}/${pending.length} … `
  );
  await client.embed(
    slug,
    ready.map(({ location }) => location)
  );
  for (const { item } of ready) {
    existingSources.add(sourceFor(item));
    completedHashes.add(item.hash);
  }
  await saveProgress(completedHashes, failures);
  const after = await client.getWorkspace(slug);
  console.log(`ok (workspace documents=${after?.documents?.length ?? "?"})`);
}

const final = await client.getWorkspace(slug);
console.log(
  `\n${slug} complete: ${final?.documents?.length ?? 0} workspace document(s), ` +
    `${failures.length} parse failure(s) (→ ${progressPath})`
);
