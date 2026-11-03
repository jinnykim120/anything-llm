// 서버 경로로 가져오기: 이 서버 PC에서 읽을 수 있는 폴더를 사건으로 가져온다. AI 호출 없음(분석은 사건 상세의 'AI 분석' 버튼에서만).
//   preview(경로, 모드)  — 파일을 복사하지 않고 후보(사건) 목록만 보여 준다(dry-run).
//   importOne(...)       — 후보 1건을 가져온다: 사건 폴더 생성(제목·시작연월은 폴더명에서) → 하위 경로를 유지해 data/cases/<폴더>/원본/ 으로 스트림 복사 → 규칙 분류.
// 보안: 로그인 세션 필수(server.mjs). 절대 경로만, config/import.json 의 허용 경로 아래만, 심볼릭 링크·정션은 따라가지 않는다. 원본 폴더는 읽기만 한다.
import { readdirSync, lstatSync, realpathSync, existsSync, statSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep, basename, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "./store.mjs";
import * as CF from "./casefiles.mjs";
import * as X from "./extract.mjs";

const { q1, run, nowIso } = S._db;
const here = dirname(fileURLToPath(import.meta.url));
const readJson = (f) => JSON.parse(readFileSync(join(here, "config", f), "utf8"));
const NOISE = /^(thumbs\.db|desktop\.ini|\.ds_store|\._.*|~\$.*|.*\.tmp)$/i;
const win = process.platform === "win32";
const norm = (p) => (win ? p.toLowerCase() : p);
const within = (child, root) => { const c = norm(resolve(child)), r = norm(resolve(root)); return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep); };

export function importConfig() {
  const c = readJson("import.json"), env = process.env.RISK_IMPORT_ROOTS;
  const roots = (env ? env.split(";") : c.allowedImportRoots || []).map((s) => s.trim()).filter(Boolean);
  return { roots, deniedNames: new Set((c.deniedNames || []).map((s) => s.toLowerCase())), limits: { maxFilesPerCase: 5000, maxFileBytes: 524288000, maxCandidates: 500, ...(c.limits || {}) }, fromEnv: !!env };
}

// ── 경로 검증: 절대 경로 · 정규화(..) · 실제 경로(realpath)가 허용 루트 아래 · 서버 자체 비밀/데이터 폴더 금지
export function resolveSource(input) {
  if (typeof input !== "string" || !input.trim()) throw new S.HttpError(400, "경로를 입력하세요");
  let p = input.trim().replace(/^["']|["']$/g, "");
  if (p.includes("\0")) throw new S.HttpError(400, "경로에 사용할 수 없는 문자가 있습니다");
  if (win && /^\\\\/.test(p)) throw new S.HttpError(400, "네트워크(UNC) 경로는 지원하지 않습니다. 이 PC의 드라이브 경로를 입력하세요");
  if (!isAbsolute(p)) throw new S.HttpError(400, "절대 경로를 입력하세요 (예: D:\\ai factory\\…)");
  p = resolve(p);
  if (!existsSync(p)) throw new S.HttpError(404, "경로를 찾을 수 없습니다. 이 서버 PC에서 접근할 수 있는 경로여야 합니다");
  const real = realpathSync(p);
  if (!statSync(real).isDirectory()) throw new S.HttpError(400, "폴더 경로가 아닙니다");
  const cfg = importConfig(), roots = cfg.roots.map((r) => { try { return realpathSync(r); } catch { return null; } }).filter(Boolean);
  if (!roots.length) throw new S.HttpError(403, "허용된 가져오기 경로가 설정되어 있지 않습니다(config/import.json 의 allowedImportRoots)");
  if (!roots.some((r) => within(real, r) && within(p, r))) throw new S.HttpError(403, `허용된 경로 밖입니다. 허용 경로: ${cfg.roots.join(", ")}`);
  for (const d of [join(here, "secrets"), join(here, "node_modules"), join(here, ".git")]) if (existsSync(d) && within(real, realpathSync(d))) throw new S.HttpError(403, "시스템 내부 폴더는 가져올 수 없습니다");
  const dataDir = join(here, "data");
  if (existsSync(dataDir) && within(real, realpathSync(dataDir))) {
    // data/ 는 시스템 데이터(DB·사건 폴더)라 막는다. 단, 사용자가 data/cases 직하에 둔 ‘원본 폴더’(시스템이 관리하는 사건 폴더가 아닌 것)는 허용한다.
    const casesDir = join(realpathSync(dataDir), "cases"), top = within(real, casesDir) && norm(real) !== norm(casesDir) ? real.slice(casesDir.length + 1).split(sep)[0] : null;
    const managed = top && (q1("SELECT 1 x FROM cases WHERE folder=?", top) || existsSync(join(casesDir, top, "manifest.json")));
    if (!top || managed) throw new S.HttpError(403, "시스템 내부 폴더는 가져올 수 없습니다(시스템이 관리하는 사건 폴더·DB·설정)");
  }
  return { input: p, real, roots: cfg.roots };
}

// ── 폴더 이름 → 제목·시작연월 ('3. 제조사 오표기(A사)_202609' → 제목 '제조사 오표기(A사)', 2026-09)
export function parseFolderName(name, fallbackYm) {
  let s = String(name).normalize("NFC").trim(), ym = null, src = null;
  s = s.replace(/^\s*\d{1,3}\s*[.)\-_]\s*/, "");                      // '3. ' 같은 번호 접두 제거
  let m = s.match(/^((?:19|20)\d{2})[-._]?(0[1-9]|1[0-2])(?:[-._]?(?:0[1-9]|[12]\d|3[01]))?[_\s\-]+(.+)$/);   // 앞쪽 날짜: 20260708_제목
  if (m) { ym = `${m[1]}-${m[2]}`; s = m[3]; src = "folder-name"; }
  else {
    m = s.match(/[_\s-]*\(?((?:19|20)\d{2})[-._]?(0[1-9]|1[0-2])(?:[-._]?(?:0[1-9]|[12]\d|3[01]))?\)?\s*$/);   // 뒤쪽 날짜: 제목_202609
    if (m && m.index > 0) { ym = `${m[1]}-${m[2]}`; s = s.slice(0, m.index); src = "folder-name"; }
    else { m = s.match(/((?:19|20)\d{2})[-._](0[1-9]|1[0-2])/); if (m) { ym = `${m[1]}-${m[2]}`; s = s.slice(0, m.index) + s.slice(m.index + m[0].length); src = "folder-name"; } }
  }
  s = s.replace(/^[_\s\-]+|[_\s\-]+$/g, "").trim();
  if (!ym && fallbackYm) { ym = fallbackYm; src = "file-date"; }
  return { title: s || String(name).trim(), ym, ymSource: src };
}

// ── 폴더 스캔(복사 없음). 심볼릭 링크·정션·허용되지 않는 이름은 건너뛴다.
function scanTree(rootReal, L, denied) {
  const files = [], skipped = { symlinks: [], large: [], noise: 0, denied: [], unreadable: [], tooMany: false };
  const walk = (dir, rel) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { skipped.unreadable.push(rel || "."); return; }
    ents.sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }));
    for (const e of ents) {
      if (skipped.tooMany) return;
      const abs = join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (denied.has(e.name.toLowerCase()) || /^\.env/i.test(e.name)) { skipped.denied.push(r); continue; }
      if (NOISE.test(e.name)) { skipped.noise++; continue; }
      let lst; try { lst = lstatSync(abs); } catch { skipped.unreadable.push(r); continue; }
      if (lst.isSymbolicLink()) { skipped.symlinks.push(r); continue; }
      if (lst.isDirectory()) {
        let rp; try { rp = realpathSync(abs); } catch { skipped.unreadable.push(r); continue; }
        if (!within(rp, rootReal)) { skipped.symlinks.push(r); continue; }   // 정션 등으로 밖을 가리키는 폴더
        walk(abs, r); continue;
      }
      if (!lst.isFile()) continue;
      if (lst.size > L.maxFileBytes) { skipped.large.push({ rel: r, size: lst.size }); continue; }
      if (files.length >= L.maxFilesPerCase) { skipped.tooMany = true; return; }
      files.push({ abs, rel: r, size: lst.size, mtime: lst.mtimeMs });
    }
  };
  walk(rootReal, "");
  return { files, skipped };
}
const ymOf = (ms) => { const d = new Date(ms + 9 * 3600e3); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
const extOf = (n) => basename(n).split(".").slice(1).pop()?.toLowerCase() || "";
const keyOf = (real) => norm(real);

// 이름·확장자만으로 하는 가벼운 분류 추정(미리보기용·가져오기 규칙). 내용 기반 점검은 AI 분석 단계에서 한다.
function guess(name) {
  const R = JSON.parse(readFileSync(join(here, "config", "analysis.json"), "utf8")).rules, ext = extOf(name);
  if (X.nameLooksPii(name, ext, R)) return "pii";
  if (R.imageExts.includes(ext)) return "image";
  if (R.textExts.includes(ext)) return (R.procedureNameWords || []).some((w) => name.includes(w)) ? "procedure" : "text";
  return "keep";
}

function summarize(c, L, denied) {
  const { files, skipped } = scanTree(c.root, L, denied), g = { text: 0, image: 0, procedure: 0, keep: 0, pii: 0 };
  let bytes = 0, newest = 0;
  for (const f of files) { g[guess(basename(f.rel))]++; bytes += f.size; newest = Math.max(newest, f.mtime); }
  const parsed = parseFolderName(c.name, newest ? ymOf(newest) : ymOf(Date.now()));
  const imp = q1("SELECT case_id, imported_at FROM case_imports WHERE source_key=?", keyOf(c.root));
  const cs = imp && q1("SELECT id, folder, title FROM cases WHERE id=?", imp.case_id);
  return { key: c.key, name: c.name, title: parsed.title, ym: parsed.ym, ymSource: parsed.ymSource, files: files.length, bytes, rules: g,
    skipped: { symlinks: skipped.symlinks.length, large: skipped.large.length, denied: skipped.denied.length, noise: skipped.noise, unreadable: skipped.unreadable.length, tooMany: skipped.tooMany },
    imported: cs ? { caseId: cs.id, folder: cs.folder || cs.title, at: imp.imported_at } : null };
}

// ── 미리보기(dry-run): 파일 복사 없음
export function preview({ path, mode = "auto" } = {}) {
  const src = resolveSource(path), cfg = importConfig(), L = cfg.limits;
  let ents = []; try { ents = readdirSync(src.real, { withFileTypes: true }); } catch { throw new S.HttpError(403, "폴더를 읽을 수 없습니다"); }
  const vis = ents.filter((e) => !NOISE.test(e.name) && !cfg.deniedNames.has(e.name.toLowerCase()) && !/^\.env/i.test(e.name));
  const topFiles = vis.filter((e) => e.isFile()).length, topDirs = vis.filter((e) => e.isDirectory() && !lstatSync(join(src.real, e.name)).isSymbolicLink());
  const detected = topFiles > 0 || !topDirs.length ? "single" : "parent", use = mode === "single" || mode === "parent" ? mode : detected;
  let cands;
  if (use === "single") cands = [{ key: ".", name: basename(src.real), root: src.real }];
  else {
    if (topDirs.length > L.maxCandidates) throw new S.HttpError(400, `하위 폴더가 너무 많습니다(${topDirs.length}개 > ${L.maxCandidates}개). 더 작은 폴더로 나눠서 가져오세요`);
    cands = topDirs.sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true })).map((d) => ({ key: d.name, name: d.name, root: join(src.real, d.name) }));
  }
  return { path: src.input, realPath: src.real, detectedMode: detected, mode: use, allowedRoots: src.roots, topLevel: { files: topFiles, folders: topDirs.length },
    candidates: cands.map((c) => summarize(c, L, cfg.deniedNames)), note: "미리보기입니다. 파일은 복사되지 않았습니다." };
}

// ── 가져오기 1건
const busy = new Set();
export async function importOne({ path, key, title, ym, action = "new" } = {}) {
  const src = resolveSource(path), cfg = importConfig(), L = cfg.limits;
  const k = String(key ?? ".");
  let root = src.real;
  if (k !== ".") {
    if (!k || /[\\/]/.test(k) || k === ".." || cfg.deniedNames.has(k.toLowerCase())) throw new S.HttpError(400, "잘못된 하위 폴더 이름입니다");
    root = join(src.real, k);
    if (!existsSync(root)) throw new S.HttpError(404, "하위 폴더를 찾을 수 없습니다");
    const lst = lstatSync(root); if (lst.isSymbolicLink() || !lst.isDirectory()) throw new S.HttpError(400, "폴더가 아니거나 링크입니다");
    if (!within(realpathSync(root), src.real)) throw new S.HttpError(403, "허용된 경로 밖입니다");
    root = realpathSync(root);
  }
  const sk = keyOf(root);
  if (busy.has(sk)) throw new S.HttpError(409, "이 폴더는 지금 가져오는 중입니다");
  busy.add(sk);
  try {
    const existing = q1("SELECT * FROM case_imports WHERE source_key=?", sk), exCase = existing && q1("SELECT id FROM cases WHERE id=?", existing.case_id);
    if (existing && exCase && action !== "merge") throw Object.assign(new S.HttpError(409, "이미 가져온 폴더입니다. 새 파일만 추가하려면 ‘병합’을 선택하세요"), { extra: { alreadyImported: { caseId: existing.case_id } } });
    const { files, skipped } = scanTree(root, L, cfg.deniedNames);
    // 사건 폴더 안에 같은 이름의 폴더 하나로 감싸져 있으면(복사 과정에서 흔함) 한 겹을 벗겨서 가져온다
    const seg0 = files.length ? files[0].rel.split("/")[0] : null;
    if (seg0 && files.every((f) => f.rel.startsWith(seg0 + "/")) && norm(seg0.normalize("NFC")) === norm(basename(root).normalize("NFC"))) for (const f of files) f.rel = f.rel.slice(seg0.length + 1);
    const newest = files.reduce((m, f) => Math.max(m, f.mtime), 0), parsed = parseFolderName(basename(root), newest ? ymOf(newest) : ymOf(Date.now()));
    let caseId, created = false;
    if (existing && exCase) caseId = existing.case_id;
    else {
      const unknown = ym === "unknown", useYm = /^\d{4}-\d{2}$/.test(ym || "") ? ym : unknown && parsed.ymSource !== "folder-name" ? null : parsed.ym, useTitle = String(title || "").trim() || parsed.title;
      const yr = Number((newest ? ymOf(newest) : ymOf(Date.now())).slice(0, 4));
      caseId = S.createImportedCase({ title: useTitle, ym: useYm, year: yr >= 2000 && yr <= 2100 ? yr : new Date().getFullYear() }).id; created = true;
      CF.ensureCaseDir(caseId);
    }
    const added = [], errors = []; let existingSkipped = 0, bytes = 0, same = 0, version = 0;
    for (const f of files) {
      try {
        const r = await CF.addFileFromDisk(caseId, f.abs, f.rel);
        if (!r) { existingSkipped++; continue; }
        added.push(r.id); bytes += r.size;
        for (const d of r.dedupe) { if (d.type === "same-hash") same++; else version++; }
      } catch (e) { errors.push({ rel: f.rel, error: String(e.message).slice(0, 120) }); }
    }
    if (created && !added.length) {   // 아무것도 가져오지 못했으면 만들어 둔 빈 사건을 되돌린다
      const folder = q1("SELECT folder FROM cases WHERE id=?", caseId)?.folder;
      run("DELETE FROM cases WHERE id=?", caseId); if (folder) rmSync(join(CF.CASES, folder), { recursive: true, force: true });
      throw new S.HttpError(400, files.length ? "파일을 하나도 가져오지 못했습니다" : "가져올 파일이 없는 폴더입니다");
    }
    applyNameRules(added);
    const sk2 = { symlinks: skipped.symlinks, large: skipped.large, denied: skipped.denied, unreadable: skipped.unreadable, tooMany: skipped.tooMany, noise: skipped.noise, errors };
    if (existing && exCase) run("UPDATE case_imports SET file_count=file_count+?, total_bytes=total_bytes+?, skipped=?, imported_at=? WHERE id=?", added.length, bytes, JSON.stringify(sk2), nowIso(), existing.id);
    else run("INSERT OR REPLACE INTO case_imports (case_id,source_path,source_key,file_count,total_bytes,skipped,imported_at) VALUES (?,?,?,?,?,?,?)", caseId, root, sk, added.length, bytes, JSON.stringify(sk2), nowIso());
    CF.writeManifest(caseId);
    return { caseId, created, merged: !created, added: added.length, existingSkipped, bytes, sameHash: same, otherVersion: version, skipped: { symlinks: skipped.symlinks.length, large: skipped.large.length, denied: skipped.denied.length, unreadable: skipped.unreadable.length, tooMany: skipped.tooMany, noise: skipped.noise }, errors, detail: CF.caseDetail(caseId) };
  } finally { busy.delete(sk); }
}

// 업로드와 같은 규칙 분류(이름·확장자 기준). 담당자가 정한 종류는 건드리지 않는다(방금 가져온 파일은 kind_source 가 비어 있다).
function applyNameRules(ids) {
  const R = JSON.parse(readFileSync(join(here, "config", "analysis.json"), "utf8")).rules;
  const note = (cur, add) => (cur ? `${cur} · ${add}` : add).slice(0, 500);
  for (const id of ids) {
    const f = q1("SELECT name, kind, kind_source, note FROM case_files WHERE id=?", id); if (!f || f.kind_source) continue;
    const ext = extOf(f.name);
    if (X.nameLooksPii(f.name, ext, R)) run("UPDATE case_files SET pii_state='suspect', pii_note=?, kind='keep-only', kind_source='auto', note=? WHERE id=?", "파일 이름이 고객 명단·리스트 형식", note(f.note, "개인정보 의심 — 자동으로 보관만 처리"), id);
    else if (f.kind === "case-doc" && !R.textExts.includes(ext) && !R.imageExts.includes(ext)) run("UPDATE case_files SET kind='keep-only', kind_source='auto', note=? WHERE id=?", note(f.note, R.legacyExts[ext] ? `${R.legacyExts[ext]} — 아직 읽을 수 없어 보관만` : `지원하지 않는 형식(.${ext || "없음"}) — 보관만`), id);
    else if (f.kind === "case-doc" && (R.procedureNameWords || []).some((w) => f.name.includes(w))) run("UPDATE case_files SET kind='procedure-ref', kind_source='auto', note=? WHERE id=?", note(f.note, "이름에 절차·가이드가 있어 절차참고로 제안(바꿀 수 있음)"), id);
  }
}
