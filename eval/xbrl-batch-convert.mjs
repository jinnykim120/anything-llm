// Idempotent, re-runnable driver for the DART XBRL -> markdown converter
// (collector/utils/xbrl/xbrl_to_md.py). Point it at a folder of XBRL filing
// subfolders (default `_samples/사업보고서 XBRL`) and it converts each one
// and uploads/embeds it into archive-full — skipping anything already
// present, and replacing anything whose XBRL source changed (e.g. a 정정
// filing) instead of duplicating it.
//
// Note: `.md` uploads go through the plain-text converter (asTxt.js), which
// does NOT run finalizeBlocksDoc() — so uploaded docs have no content_hash
// in their metadata. Change-detection therefore hashes the *source* XBRL
// instance file instead, tracked in a small local manifest
// (`<source>/.xbrl-manifest.json`, already covered by the existing
// `_samples/` git-exclude). The live workspace (title match) is always the
// backstop of last resort: if the manifest is missing/stale but a doc with
// the exact target title already exists, we skip and just repair the
// manifest rather than risk a duplicate upload.
//
//   node eval/xbrl-batch-convert.mjs [--source "<folder>"] [--dry-run]
import { readFile, writeFile, readdir, mkdtemp, rm, copyFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { createHash } from "node:crypto";
import { AllmClient } from "./lib/client.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const SLUG = "archive-full";
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const XBRL_SCRIPT = join(repoRoot, "collector/utils/xbrl/xbrl_to_md.py");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const sourceIdx = args.indexOf("--source");
const source =
  sourceIdx >= 0 && args[sourceIdx + 1]
    ? args[sourceIdx + 1]
    : join(repoRoot, "_samples", "사업보고서 XBRL");
const manifestPath = join(source, ".xbrl-manifest.json");

// 연간 보고서(12월 결산)는 스크립트가 "사업연도(연간)"이라고 붙이는데, 기존
// 코퍼스에 이미 올라간 문서들은 "사업보고서"로 되어 있다(회사에 따라 결산월이
// 12월이 아닐 수도 있어 하드코딩이 아니라 이 한 가지 표기만 맞춘다).
const HALF_LABEL_FOR_FILENAME = { "사업연도(연간)": "사업보고서" };

// XBRL 데이터 자체에 등록된 회사명이 제출연도마다 다를 수 있다(예: 2024년
// 사업보고서는 법인 정식명 "주식회사 지에스리테일"로 찍혀 나오는데, 다른 해는
// 브랜드명 "GS리테일"로 찍힌다 — dry-run으로 실제 발견된 케이스). xbrl_to_md.py는
// 회사 하드코딩이 없는 범용 파서라 이건 고칠 자리가 아니고, 이 드라이버에서
// 알려진 변형만 코퍼스 기존 표기로 맞춰준다. 여기 없는 새 변형은 dry-run에서
// "+ new"로 드러나므로(중복 업로드로 조용히 새지 않음) 그때 추가하면 된다.
const COMPANY_ALIASES = { "주식회사 지에스리테일": "GS리테일" };

async function loadManifest() {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return {};
  }
}

async function findXbrlInstance(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  for (const e of entries) {
    const p = join(folder, e.name);
    if (e.isDirectory()) {
      const found = await findXbrlInstance(p);
      if (found) return found;
    } else if (e.name.endsWith(".xbrl")) {
      return p;
    }
  }
  return null;
}

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

async function convertFolder(folder, outMd) {
  await execFileAsync(PYTHON_BIN, [XBRL_SCRIPT, folder, outMd]);
  return readFile(outMd, "utf8");
}

function titleFromMarkdown(md) {
  const firstLine = md.split("\n", 1)[0];
  const m = firstLine.match(/^# (\[.+?\]) (\d{4}년) (.+?) 재무제표/);
  if (!m) return null;
  const [, bracketCompany, year, half] = m;
  const rawCompany = bracketCompany.slice(1, -1);
  const company = COMPANY_ALIASES[rawCompany] || rawCompany;
  const filenameHalf = HALF_LABEL_FOR_FILENAME[half] || half;
  return `[${company}] ${year} ${filenameHalf} 재무제표(XBRL 원문).md`;
}

async function main() {
  if (!existsSync(source)) {
    console.error(`missing source folder: ${source}`);
    process.exit(1);
  }
  try {
    await execFileAsync(PYTHON_BIN, ["--version"]);
  } catch {
    console.error(
      `python not found as "${PYTHON_BIN}" — set PYTHON_BIN if it's named differently.`
    );
    process.exit(1);
  }

  const keyPath = join(here, ".key");
  const client = new AllmClient((await readFile(keyPath, "utf8")).trim());
  const serverUp = await client.ping();
  if (!dryRun && !serverUp) {
    console.error("server not reachable — start it first");
    process.exit(1);
  }

  const existingByTitle = new Map();
  if (serverUp) {
    const ws = await client.getWorkspace(SLUG);
    for (const doc of ws?.documents || []) {
      try {
        const meta = JSON.parse(doc.metadata || "{}");
        if (meta.title) existingByTitle.set(meta.title, doc);
      } catch {
        /* skip unparsable metadata */
      }
    }
    console.log(`• ${SLUG}: ${existingByTitle.size} document(s) with parseable titles\n`);
  } else {
    console.log("• (dry-run, server unreachable — skipping live workspace cross-check)\n");
  }

  const manifest = await loadManifest();

  const candidates = (await readdir(source, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => join(source, e.name));

  const tmp = await mkdtemp(join(tmpdir(), "xbrl-batch-"));
  const toAdd = []; // { tmpPath, title, folderName, instHash }
  const toDeleteDocpaths = [];
  const manifestUpdates = {}; // folderName -> { hash, title }
  let skipped = 0;
  let failed = 0;

  try {
    for (const folder of candidates) {
      const name = basename(folder);
      const inst = await findXbrlInstance(folder);
      if (!inst) {
        console.log(`  - ${name}: no *.xbrl instance file, skipping (not an XBRL folder)`);
        continue;
      }
      const instHash = sha256File(inst);
      const prior = manifest[name];

      const outMd = join(tmp, `${name}.md`);
      let md;
      try {
        md = await convertFolder(folder, outMd);
      } catch (e) {
        failed += 1;
        console.log(`  ✗ ${name}: conversion failed — ${e.message.split("\n")[0]}`);
        continue;
      }

      const title = titleFromMarkdown(md);
      if (!title) {
        failed += 1;
        console.log(`  ✗ ${name}: could not parse a title from the generated markdown`);
        continue;
      }

      const existing = existingByTitle.get(title);

      if (existing && (!prior || prior.hash === instHash)) {
        // Already present, and either we've never tracked this folder before
        // (repair the manifest rather than assume content changed) or the
        // source hash matches what we last processed — nothing to do.
        skipped += 1;
        manifestUpdates[name] = { hash: instHash, title };
        console.log(
          `  = ${name} -> "${title}": already in workspace, skipping${
            prior ? "" : " (manifest repaired)"
          }`
        );
        continue;
      }
      if (existing && prior && prior.hash !== instHash) {
        console.log(
          `  ~ ${name} -> "${title}": XBRL source changed since last run (existing doc will be replaced)`
        );
        toDeleteDocpaths.push(existing.docpath);
      } else {
        console.log(`  + ${name} -> "${title}": new`);
      }
      toAdd.push({ tmpPath: outMd, title, folderName: name, instHash });
    }

    console.log(
      `\n${dryRun ? "[dry-run] would" : "will"} add ${toAdd.length}, replace ${
        toDeleteDocpaths.length
      }, skip ${skipped}, ${failed} failed to convert.`
    );

    if (dryRun) {
      console.log("\n(dry-run — no upload/embedding/manifest write performed)");
      return;
    }

    if (Object.keys(manifestUpdates).length) {
      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, ...manifestUpdates }, null, 2)
      );
    }
    if (!toAdd.length && !toDeleteDocpaths.length) return;

    const adds = [];
    const newManifestEntries = {};
    for (const { tmpPath, title, folderName, instHash } of toAdd) {
      const renamed = join(tmp, title);
      await rm(renamed, { force: true });
      await copyFile(tmpPath, renamed);
      process.stdout.write(`  uploading "${title}" … `);
      try {
        const loc = await client.uploadDoc(renamed);
        adds.push(loc);
        newManifestEntries[folderName] = { hash: instHash, title };
        console.log("ok ->", loc);
      } catch (e) {
        failed += 1;
        console.log("FAILED —", e.message.split("\n")[0]);
      }
    }

    if (adds.length || toDeleteDocpaths.length) {
      process.stdout.write(
        `• updating embeddings: +${adds.length} -${toDeleteDocpaths.length} … `
      );
      await client.updateEmbeddings(SLUG, { adds, deletes: toDeleteDocpaths });
      console.log("ok");
    }

    if (Object.keys(newManifestEntries).length) {
      const latest = await loadManifest();
      await writeFile(
        manifestPath,
        JSON.stringify({ ...latest, ...newManifestEntries }, null, 2)
      );
    }

    const after = await client.getWorkspace(SLUG);
    console.log(`\n${SLUG} now has ${after?.documents?.length ?? 0} document(s).`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main();
