// Insights-site pipeline helpers: archive extract + `claude -p` call.
// No OS-specific paths — everything resolves from this folder / env so the whole
// folder can be copied to another machine (see README "이식").
//
//   ARCHIVE_ROOT   repo root holding server/storage (default: parent of this folder)
//   INSIGHTS_MODEL default "claude-sonnet-5-5"
//   CLAUDE_CLI_BIN default "claude"

import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ARCHIVE_ROOT || join(here, "..");
const DOC_DIR = join(ROOT, "server", "storage", "documents", "custom-documents");
const DB_PATH = join(ROOT, "server", "storage", "anythingllm.db");
export const DATA = join(here, "data");
export const MODEL = process.env.INSIGHTS_MODEL || "claude-sonnet-5-5";
const BIN = process.env.CLAUDE_CLI_BIN || "claude";

export const dir = (p) => (mkdirSync(p, { recursive: true }), p);

// Only `general` docs may ever reach the site. Anything else (confidential /
// uncertain / unclassified) is excluded here, in code.
// Some parsed docs (XBRL .md, spreadsheets) carry no collector content_hash; the
// server derives one the same way when classifying (server/models/documents.js).
const hashOf = (j) =>
  j.content_hash ||
  createHash("sha256").update(String(j.pageContent || "").replace(/\s+/g, " ").trim()).digest("hex");

function generalRows(where = "", ...params) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db
    .prepare(
      `select contentHash, sampleTitle, docType, domain, status from document_classifications
       where sensitivity = 'general' ${where}`
    )
    .all(...params);
  db.close();
  return new Map(rows.map((r) => [r.contentHash, r]));
}

// One general doc whose title matches `re` (e.g. /2025년 사업보고서 재무제표/), or null.
export function generalDocByTitle(re) {
  const byHash = generalRows();
  for (const f of readdirSync(DOC_DIR).filter((x) => x.endsWith(".json"))) {
    let j;
    try {
      j = JSON.parse(readFileSync(join(DOC_DIR, f), "utf8"));
    } catch {
      continue;
    }
    if (re.test(j.title || "") && byHash.has(hashOf(j))) return { title: j.title, text: String(j.pageContent || "") };
  }
  return null;
}

export function loadGeneralDocs(domain) {
  const byHash = generalRows("and domain = ?", domain);
  const docs = [];
  for (const f of readdirSync(DOC_DIR).filter((x) => x.endsWith(".json"))) {
    let j;
    try {
      j = JSON.parse(readFileSync(join(DOC_DIR, f), "utf8"));
    } catch {
      continue;
    }
    const hash = hashOf(j);
    const row = byHash.get(hash);
    if (!row) continue;
    const title = String(j.title || row.sampleTitle || f).split("/").pop();
    const m = title.match(/\((20\d{2})(\d{2})(\d{2})\)/); // 개정/시행일 in the filename
    docs.push({
      hash,
      title,
      docType: row.docType,
      reviewed: row.status === "confirmed",
      date: m ? `${m[1]}-${m[2]}-${m[3]}` : null,
      text: String(j.pageContent || ""),
    });
    byHash.delete(hash); // same content under two filenames → once
  }
  return docs.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

export function allGeneralDomains() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db
    .prepare(
      `select domain, count(*) n from document_classifications
       where sensitivity = 'general' group by domain order by n desc`
    )
    .all();
  db.close();
  return rows;
}

export function claude(system, prompt, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      BIN,
      [
        "-p", "--model", MODEL, "--tools", "",
        "--settings", '{"disableAllHooks":true}',
        "--exclude-dynamic-system-prompt-sections",
        "--output-format", "json", "--system-prompt", system,
      ],
      { env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }
    );
    let out = "";
    let err = "";
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0)
        return reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`));
      try {
        const o = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
        if (o.is_error) return reject(new Error(String(o.result).slice(0, 300)));
        resolve(String(o.result || ""));
      } catch {
        reject(new Error("unparseable CLI envelope"));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// The model sometimes emits a draft, then "corrected output". Scan for balanced
// top-level objects and return the last one that parses and satisfies `ok`.
export function lastJson(raw, ok = () => true) {
  const s = raw.replace(/```json\s*|\s*```/g, "");
  let found = null;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (c === "\\") j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const o = JSON.parse(s.slice(i, j + 1));
          if (ok(o)) found = o;
        } catch {
          /* not a valid object, keep scanning */
        }
        i = j;
        break;
      }
    }
  }
  if (!found) throw new Error("no valid JSON in response");
  return found;
}
