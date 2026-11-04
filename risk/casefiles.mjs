// 리스크 아카이브: 사건 폴더·파일·사건 카드·내장 이미지. LLM·웹 호출 없음(저장·조회·다운로드만).
//   data/cases/<YYYY-MM_제목>/원본/…        업로드한 파일(사건 폴더 이름은 공백 없음, 시작연월 접두)
//   data/cases/<…>/내장이미지/…             문서 안에서 꺼낸 그림(참고용, 사건 자료로 '연결'할 때만 원본/ 으로 복사)
//   data/cases/<…>/manifest.json            DB 와 같은 내용을 사람이 읽을 수 있게 남긴 목록(변경 때마다 갱신)
// 단계 하위폴더는 실제 디렉터리가 아니라 DB(case_files.stage/kind)로 관리한다. zip 으로 내려받을 때만 단계별 폴더로 만든다.
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync, copyFileSync, createReadStream, rmSync } from "node:fs";
import { join, dirname, basename, extname, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";
import { _db, HttpError, config, getCase, listCases, caseFolderName, updateStartDate, DATA } from "./store.mjs";
import { verifyConfirm } from "./confirmpw.mjs";
import * as N from "./nexus.mjs";

const { q, q1, run, tx, nowIso } = _db;
export const CASES = join(DATA, "cases");
const MAX_UPLOAD = 500 * 1024 * 1024, MAX_ZIP = 3.5 * 1024 ** 3;
mkdirSync(CASES, { recursive: true });

// ── 설정 도우미
const kinds = () => config().fileKinds;
const kindOf = (id) => kinds().find((k) => k.id === id);
const stageIds = () => new Set([...config().caseStages.map((s) => s.id), ...(config().stageExtras || []).map((s) => s.id)]);
const ANALYZABLE = () => new Set(kinds().filter((k) => k.analyze).map((k) => k.id));
const cleanSeg = (s) => String(s).normalize("NFC").replace(/[<>:"|?*\u0000-\u001f]/g, "").replace(/[. ]+$/g, "").trim().slice(0, 120);
export function sanitizeRel(rel, fallbackName = "파일") {
  const segs = String(rel || "").split(/[\\/]+/).map((s) => s.trim()).filter((s) => s && s !== "." && s !== "..").map(cleanSeg).filter(Boolean);
  return (segs.length ? segs : [cleanSeg(fallbackName) || "파일"]).join("/");
}

// ── 사건 폴더
export function ensureCaseDir(caseId) {
  const c = getCase(caseId);
  let folder = q1("SELECT folder FROM cases WHERE id=?", caseId).folder;
  if (!folder) {
    const base = caseFolderName({ title: c.title, startDate: c.startDate, startYear: c.startYear });
    let name = base, n = 2;
    while (q1("SELECT id FROM cases WHERE folder=? AND id<>?", name, caseId) || existsSync(join(CASES, name))) name = `${base}(${n++})`;
    run("UPDATE cases SET folder=? WHERE id=?", name, caseId); folder = name;
  }
  const dir = join(CASES, folder);
  mkdirSync(join(dir, "원본"), { recursive: true });
  return { dir, folder };
}
const inside = (dir, p) => { const r = resolve(p), d = resolve(dir) + sep; return r.startsWith(d); };

export const hooks = { onAdded: null };   // nexussync 가 등록: 파일이 새로 저장되면 Mac 업로드 줄에 넣는다
// ── 파일 행
const fileRow = (r) => ({ id: r.id, name: r.name, relPath: r.rel_path, size: r.size, sha256: r.sha256, kind: r.kind, stage: r.stage || null, stageSource: r.stage ? r.stage_source || "manual" : null,
  analyze: !!kindOf(r.kind)?.analyze, dupOf: r.dup_of, dupGroup: r.dup_group, note: r.note, suspectOtherCase: !!r.suspect_other_case,
  aiStage: r.ai_stage ? { id: r.ai_stage, confidence: r.ai_stage_conf, why: r.ai_stage_why } : null, source: r.source, addedAt: r.added_at,
  kindSource: r.kind_source || null, piiState: r.pii_state || null, piiNote: r.pii_note || null, nexusState: r.nexus_state || null, nexusErr: r.nexus_err || null,
  group: r.kind === "ignore" ? "ignore" : r.kind === "keep-only" ? "keep-only" : r.kind === "procedure-ref" ? "procedure-ref" : r.stage || "unassigned" });
export const listFiles = (caseId) => q("SELECT * FROM case_files WHERE case_id=? ORDER BY id", caseId).map(fileRow);
const getFileRow = (caseId, fid) => { const r = q1("SELECT * FROM case_files WHERE id=? AND case_id=?", fid, caseId); if (!r) throw new HttpError(404, "파일을 찾을 수 없습니다"); return r; };
const stemOf = (name) => basename(name, extname(name)).normalize("NFC").toLowerCase();

// 읽을 수 있는 형식(텍스트·이미지) — config/analysis.json 의 rules
const readableExts = () => { try { const r = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "config", "analysis.json"), "utf8")).rules; return new Set([...r.textExts, ...r.imageExts]); } catch { return new Set(["docx", "pptx", "pdf", "txt", "xlsx", "csv", "png", "jpg", "jpeg"]); } };

// ── 중복 처리
//  1) 같은 사건 안에서 해시가 같으면 뒤에 온 파일을 '보관만'으로 표시(dup_of)
//  2) 이름(확장자 제외)이 같고 확장자만 다른 판본(docx/pdf 등)은 큰 파일을 기본으로 두고 작은 쪽을 '보관만'으로 표시
function applyDedupe(caseId, id) {
  const me = q1("SELECT * FROM case_files WHERE id=?", id), notes = [];
  const same = me.sha256 && q1("SELECT * FROM case_files WHERE case_id=? AND sha256=? AND id<>? AND kind<>'ignore' ORDER BY id LIMIT 1", caseId, me.sha256, id);
  if (same) {
    run("UPDATE case_files SET dup_of=?, kind=CASE WHEN kind IN ('case-doc','procedure-ref') THEN 'keep-only' ELSE kind END, note=COALESCE(note||' · ','')||? WHERE id=?", same.id, `같은 파일(해시 동일): ${same.name}`, id);
    notes.push({ type: "same-hash", with: same.name }); return notes;
  }
  const an = ANALYZABLE(), readable = readableExts();
  const peers = q("SELECT * FROM case_files WHERE case_id=? AND id<>? AND dup_of IS NULL AND kind<>'ignore'", caseId, id).filter((p) => stemOf(p.name) === stemOf(me.name) && extname(p.name).toLowerCase() !== extname(me.name).toLowerCase());
  for (const p of peers) {
    const [big, small] = (p.size >= me.size ? [p, me] : [me, p]);
    if (!an.has(small.kind)) continue;
    if (!readable.has(extname(big.name).slice(1).toLowerCase())) continue;   // 큰 쪽이 .msg·.hwp 처럼 읽을 수 없는 형식이면 읽을 수 있는 작은 판본을 보관만으로 내리지 않는다
    run("UPDATE case_files SET kind='keep-only', dup_group=?, note=COALESCE(note||' · ','')||? WHERE id=?", stemOf(me.name), `같은 문서의 다른 판본: 큰 파일(${big.name}) 기준, 이 파일은 보관만`, small.id);
    run("UPDATE case_files SET dup_group=? WHERE id=?", stemOf(me.name), big.id);
    notes.push({ type: "same-doc-version", keep: big.name, demoted: small.name });
  }
  return notes;
}
function crossCaseWarnings(caseId, sha) {
  if (!sha) return [];
  return q("SELECT f.name, c.id cid, c.folder, c.title FROM case_files f JOIN cases c ON c.id=f.case_id WHERE f.sha256=? AND f.case_id<>? AND f.kind<>'ignore' LIMIT 5", sha, caseId)
    .map((r) => ({ type: "same-file-in-other-case", caseId: r.cid, case: r.folder || r.title, name: r.name }));
}
const CONTENT_CHECK = { status: "준비 중", message: "내용을 읽어 다른 사건 문서인지 판정하는 기능은 아직 연결되지 않았습니다." };

// ── 업로드(원본 바이트를 그대로 받는다: POST …/files?name=&relPath=&kind=&stage=)
function receive(req, dest) {
  return new Promise((resolveP, reject) => {
    const h = createHash("sha256"); let n = 0, over = false; const ws = createWriteStream(dest);
    req.on("data", (d) => { n += d.length; if (n > MAX_UPLOAD) { over = true; req.unpipe(ws); ws.destroy(); req.resume(); return; } h.update(d); });
    req.pipe(ws);
    ws.on("finish", () => (over ? reject(new HttpError(413, "파일이 너무 큽니다(500MB 이하)")) : resolveP({ size: n, sha256: h.digest("hex") })));
    ws.on("error", reject); req.on("error", reject); req.on("aborted", () => reject(new Error("upload aborted")));
  });
}
function checkKindStage(kind, stage) {
  if (!kindOf(kind)) throw new HttpError(400, "알 수 없는 파일 종류");
  if (stage && !stageIds().has(stage)) throw new HttpError(400, "알 수 없는 단계");
}
function uniqueRel(caseId, rel) {
  const taken = new Set(q("SELECT rel_path FROM case_files WHERE case_id=?", caseId).map((r) => r.rel_path.toLowerCase()));
  if (!taken.has(rel.toLowerCase())) return rel;
  const ext = extname(rel), stem = rel.slice(0, rel.length - ext.length); let n = 2;
  while (taken.has(`${stem} (${n})${ext}`.toLowerCase())) n++;
  return `${stem} (${n})${ext}`;
}
export async function saveUpload(caseId, req, o = {}) {
  getCase(caseId); const kind = o.kind || "case-doc", stage = o.stage || null; checkKindStage(kind, stage);
  const { dir } = ensureCaseDir(caseId), tmp = join(dir, `.upload-${randomBytes(6).toString("hex")}`);
  let info;
  try { info = await receive(req, tmp); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  const rel = uniqueRel(caseId, sanitizeRel(o.relPath || o.name, o.name)), dest = join(dir, "원본", ...rel.split("/"));
  if (!inside(join(dir, "원본"), dest)) { rmSync(tmp, { force: true }); throw new HttpError(400, "잘못된 경로입니다"); }
  mkdirSync(dirname(dest), { recursive: true }); renameSync(tmp, dest);
  const name = rel.split("/").at(-1);
  const r = run("INSERT INTO case_files (case_id,rel_path,name,size,sha256,kind,kind_source,stage,stage_source,note,source,added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", caseId, rel, name, info.size, info.sha256, kind, kind !== "case-doc" ? "manual" : null, stage, stage ? "manual" : null, o.note || null, "upload", nowIso());
  const id = Number(r.lastInsertRowid), dedupe = applyDedupe(caseId, id);
  writeManifest(caseId); try { hooks.onAdded?.(caseId, id); } catch { /* Mac 연결 실패는 PC 저장에 영향 없음 */ }
  return { file: fileRow(q1("SELECT * FROM case_files WHERE id=?", id)), dedupe, warnings: crossCaseWarnings(caseId, info.sha256), contentCheck: CONTENT_CHECK };
}
// 서버 디스크의 파일을 사건 폴더로 복사(스트림, 원본은 읽기만). 서버 경로 가져오기용. 같은 하위 경로가 이미 있으면 null(병합 시 건너뜀).
export async function addFileFromDisk(caseId, srcAbs, relPath, o = {}) {
  getCase(caseId);
  const { dir } = ensureCaseDir(caseId), rel0 = sanitizeRel(relPath, basename(srcAbs));
  if (q1("SELECT id FROM case_files WHERE case_id=? AND lower(rel_path)=lower(?)", caseId, rel0)) return null;
  const dest = join(dir, "원본", ...rel0.split("/"));
  if (!inside(join(dir, "원본"), dest)) throw new HttpError(400, "잘못된 경로입니다");
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(dir, `.import-${randomBytes(6).toString("hex")}`), h = createHash("sha256");
  let size = 0;
  await new Promise((res, rej) => { const rs = createReadStream(srcAbs), ws = createWriteStream(tmp); rs.on("data", (d) => { size += d.length; h.update(d); }); rs.on("error", rej); ws.on("error", rej); ws.on("finish", res); rs.pipe(ws); })
    .catch((e) => { rmSync(tmp, { force: true }); throw e; });
  renameSync(tmp, dest);
  const sha = h.digest("hex"), name = rel0.split("/").at(-1);
  const r = run("INSERT INTO case_files (case_id,rel_path,name,size,sha256,kind,stage,note,source,added_at) VALUES (?,?,?,?,?,?,?,?,?,?)", caseId, rel0, name, size, sha, "case-doc", null, null, "import", nowIso());
  const id = Number(r.lastInsertRowid), dedupe = applyDedupe(caseId, id); try { hooks.onAdded?.(caseId, id); } catch { /* 위와 같음 */ }
  return { id, size, sha256: sha, dedupe, warnings: crossCaseWarnings(caseId, sha) };
}
// 디스크에 이미 있는 파일을 등록(시범 사건 적재용): 복사하지 않고 해시·크기만 계산한다.
export function registerFile(caseId, rel, o = {}) {
  const { dir } = ensureCaseDir(caseId), abs = join(dir, "원본", ...rel.split("/"));
  if (!existsSync(abs)) throw new HttpError(404, `파일이 없습니다: ${rel}`);
  const buf = readFileSync(abs), sha = createHash("sha256").update(buf).digest("hex");
  const ex = q1("SELECT id FROM case_files WHERE case_id=? AND rel_path=?", caseId, rel);
  const kind = o.kind || "case-doc"; checkKindStage(kind, o.stage || null);
  if (ex) { run("UPDATE case_files SET kind=?, stage=?, stage_source=?, note=?, suspect_other_case=?, ai_stage=?, ai_stage_conf=?, ai_stage_why=?, dup_group=?, size=?, sha256=? WHERE id=?", kind, o.stage || null, o.stage ? o.stageSource || "manual" : null, o.note || null, o.suspect ? 1 : 0, o.aiStage || null, o.aiConf ?? null, o.aiWhy || null, o.dupGroup || null, buf.length, sha, ex.id); return ex.id; }
  const r = run("INSERT INTO case_files (case_id,rel_path,name,size,sha256,kind,stage,stage_source,dup_group,note,suspect_other_case,ai_stage,ai_stage_conf,ai_stage_why,source,added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    caseId, rel, rel.split("/").at(-1), buf.length, sha, kind, o.stage || null, o.stage ? o.stageSource || "manual" : null, o.dupGroup || null, o.note || null, o.suspect ? 1 : 0, o.aiStage || null, o.aiConf ?? null, o.aiWhy || null, o.source || "pilot", nowIso());
  return Number(r.lastInsertRowid);
}
export function updateFile(caseId, fid, b = {}) {
  const f = getFileRow(caseId, fid), sets = [], p = [];
  if (b.kind !== undefined) { if (!kindOf(b.kind)) throw new HttpError(400, "알 수 없는 파일 종류"); sets.push("kind=?", "kind_source='manual'"); p.push(b.kind); }
  if (b.pii !== undefined) {   // 개인정보 의심 표시/해제(담당자). cleared 로 풀면 자동으로 '보관만'이던 파일은 사건자료로 되돌린다.
    if (!["cleared", "suspect", null].includes(b.pii)) throw new HttpError(400, "알 수 없는 값");
    sets.push("pii_state=?"); p.push(b.pii);
    if (b.pii === "cleared" && f.kind_source === "auto" && f.kind === "keep-only" && b.kind === undefined) sets.push("kind='case-doc'", "kind_source=NULL");
    if (b.pii === "suspect" && b.kind === undefined && !f.kind_source) sets.push("kind='keep-only'", "kind_source='auto'");
  }
  if (b.stage !== undefined) { const s = b.stage || null; if (s && !stageIds().has(s)) throw new HttpError(400, "알 수 없는 단계"); sets.push("stage=?", "stage_source=?"); p.push(s, s ? "manual" : null); }
  if (b.confirmStage === true && f.stage) sets.push("stage_source='manual'");   // AI 제안 단계를 그대로 확인
  if (b.note !== undefined) { sets.push("note=?"); p.push(String(b.note || "").slice(0, 500) || null); }
  if (b.suspectOtherCase === false) { sets.push("suspect_other_case=0"); }
  if (!sets.length) throw new HttpError(400, "바꿀 값이 없습니다");
  run(`UPDATE case_files SET ${sets.join(", ")} WHERE id=?`, ...p, f.id);
  writeManifest(caseId); return fileRow(q1("SELECT * FROM case_files WHERE id=?", f.id));
}
export function filePath(caseId, fid) {
  const f = getFileRow(caseId, fid), { dir } = ensureCaseDir(caseId), abs = join(dir, "원본", ...f.rel_path.split("/"));
  if (!inside(join(dir, "원본"), abs) || !existsSync(abs)) throw new HttpError(404, "파일이 디스크에 없습니다");
  return { abs, name: f.name, size: statSync(abs).size };
}

// ── manifest.json (DB 내용을 사람이 읽을 수 있게 남김; 기존 notes/ignored 는 보존)
export function writeManifest(caseId) {
  const c = getCase(caseId), { dir, folder } = ensureCaseDir(caseId), mf = join(dir, "manifest.json");
  let keep = {}; try { const o = JSON.parse(readFileSync(mf, "utf8")); keep = { notes: o.notes, ignored: o.ignored }; } catch {}
  const names = Object.fromEntries(kinds().map((k) => [k.id, k.name]));
  const files = listFiles(caseId);
  const out = { case: folder, caseId, title: c.title, startDate: c.startDate, generatedAt: nowIso(), ...(keep.notes ? { notes: keep.notes } : {}), ...(keep.ignored ? { ignored: keep.ignored } : {}),
    files: files.map((f) => ({ path: f.relPath, sizeKB: Math.round(f.size / 1024), sha256: f.sha256, 종류: names[f.kind] || f.kind, 단계: f.stage, 분석여부: f.analyze,
      ...(f.dupOf ? { 중복: files.find((x) => x.id === f.dupOf)?.relPath } : {}), ...(f.dupGroup ? { 중복그룹: f.dupGroup } : {}), ...(f.suspectOtherCase ? { 다른사건의심: true } : {}), ...(f.piiState ? { 개인정보: f.piiState === "suspect" ? "의심" : "해제" } : {}), ...(f.note ? { 비고: f.note } : {}) })) };
  writeFileSync(mf, JSON.stringify(out, null, 2) + "\n");
}

// ── zip(단계별 하위폴더) — 외부 라이브러리 없이 직접 만든다(UTF-8 이름, 크기·CRC 를 미리 계산하므로 스트림 기록자 불필요)
const STORE_EXT = new Set([".zip", ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".docx", ".pptx", ".xlsx", ".mp4", ".msg"]);
const dosTime = (d = new Date()) => ({ t: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), d: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });
export const stageDirName = (group) => {
  const st = config().caseStages, ex = config().stageExtras || [], safe = (s) => cleanSeg(String(s).replace(/\//g, "·"));
  const i = st.findIndex((s) => s.id === group);
  if (i >= 0) return `${String(i + 1).padStart(2, "0")}_${safe(st[i].name)}`;
  if (group === "overall") return `00_${safe(ex.find((s) => s.id === "overall")?.name || "종합")}`;
  if (group === "procedure-ref") return `${String(st.length + 1).padStart(2, "0")}_${safe(kindOf("procedure-ref")?.name || "절차참고")}`;
  if (group === "keep-only") return `${String(st.length + 2).padStart(2, "0")}_${safe(kindOf("keep-only")?.name || "보관만")}`;
  return `${String(st.length + 3).padStart(2, "0")}_단계미지정`;
};
// ── 사건 카드의 ‘근거’(출처) 해석
//  새 카드: 항목마다 src = {kind:'file', file_id, loc, quote, status} (분석 단계에서 파일 ID 로 확인·검증됨).
//  예전 카드(시범 등): 파일 이름 글자뿐이라, 사건의 파일 목록과 이름(경로 제거·확장자 무시·공백 무시)으로 맞춰 src_resolved 를 만든다. 같은 문서의 여러 판본은 큰 파일 쪽.
const stemKey = (n) => basename(String(n).replace(/\\/g, "/")).replace(/\.[^.]+$/, "").normalize("NFC").toLowerCase().replace(/\s+/g, "");
const normPath = (x) => String(x).replace(/\\/g, "/").normalize("NFC").toLowerCase().trim();
export function matchFileByName(files, raw) {
  let s = String(raw || "").trim(); if (!s) return null;
  const m = s.match(/^(.*?)\s*내장\s*(?:이미지\s*)?\S*$/);   // 'X.docx 내장 이미지3' → X.docx (문서 안의 그림)
  const loc = m && m[1] ? s.slice(m[1].length).trim() : ""; if (m && m[1]) s = m[1];
  // 확장자를 무시하고 이름이 같은 파일을 후보로 삼는다 → 같은 문서의 여러 판본(docx/pdf 등)은 큰 파일 쪽. 경로가 함께 적혀 있으면 같은 폴더의 것을 우선한다.
  const k = stemKey(s); if (!k) return null;
  let c = files.filter((f) => stemKey(f.name) === k);
  if (!c.length) return null;
  if (c.length > 1 && /[\\/]/.test(s)) { const dir = (p) => normPath(p).split("/").slice(0, -1).join("/"), want = dir(s), same = c.filter((f) => dir(f.relPath) === want); if (same.length) c = same; }
  c = [...c].sort((a, b) => b.size - a.size);
  return { file: c[0], loc };
}
const SRC_KEYS = ["src", "source_file", "source"];
export function enrichSources(card, files, embedded = []) {
  if (!card) return card;
  const c = JSON.parse(JSON.stringify(card)), byId = new Map(files.map((f) => [f.id, f])), emb = new Set(embedded.map((e) => e.name));
  const fix = (o) => {
    if (o.src && typeof o.src === "object") {
      const s = o.src;
      if (s.kind === "file") { const f = byId.get(s.file_id); if (!f) s.status = "missing"; else Object.assign(s, { name: f.name, rel: f.relPath, fileKind: f.kind, otherCase: !!f.suspectOtherCase, ext: extname(f.name).slice(1).toLowerCase() }); }
      else if (s.kind === "embedded") s.exists = emb.has(s.embedded);
      return;
    }
    const raw = typeof o.source_file === "string" && o.source_file ? o.source_file : typeof o.source === "string" && o.source ? o.source : null;
    if (!raw) return;
    const m = matchFileByName(files, raw);
    o.src_resolved = m ? { kind: "file", file_id: m.file.id, name: m.file.name, rel: m.file.relPath, fileKind: m.file.kind, otherCase: !!m.file.suspectOtherCase, ext: extname(m.file.name).slice(1).toLowerCase(), loc: m.loc, status: "name-matched", raw } : { kind: "unknown", raw, status: "unmatched" };
  };
  const walk = (n) => { if (Array.isArray(n)) { n.forEach(walk); return; } if (n && typeof n === "object") { if (SRC_KEYS.some((k) => k in n)) fix(n); for (const [k, v] of Object.entries(n)) if (k !== "src" && k !== "src_resolved") walk(v); } };
  walk(c);
  return c;
}
// 카드가 인용한 파일 ID 들(내려받기용)
export function evidenceFileIds(caseId) {
  const card = getCard(caseId).card; if (!card) return [];
  const e = enrichSources(card, listFiles(caseId), listEmbedded(caseId)), ids = new Set();
  const walk = (n) => { if (Array.isArray(n)) { n.forEach(walk); return; } if (n && typeof n === "object") { for (const k of ["src", "src_resolved"]) if (n[k]?.kind === "file" && n[k].file_id && n[k].status !== "missing") ids.add(n[k].file_id); for (const [k, v] of Object.entries(n)) if (k !== "src" && k !== "src_resolved") walk(v); } };
  walk(e);
  return [...ids];
}
export function buildZip(caseId, o = {}) {
  const { dir, folder } = ensureCaseDir(caseId), only = o.onlyIds ? new Set(o.onlyIds) : null, files = listFiles(caseId).filter((f) => f.kind !== "ignore" && (!only || only.has(f.id)));
  if (only && !files.length) throw new HttpError(404, "카드가 인용한 파일이 없습니다");
  const used = new Set(), local = [], central = []; let off = 0, total = 0; const tm = dosTime();
  for (const f of files) {
    const abs = join(dir, "원본", ...f.relPath.split("/")); if (!existsSync(abs)) continue;
    total += f.size; if (total > MAX_ZIP) throw new HttpError(413, "사건 자료가 너무 커서 한 번에 내려받을 수 없습니다");
    const data = readFileSync(abs), sd = stageDirName(f.group);
    let path = `${folder}/${sd}/${f.name}`, n = 2; while (used.has(path.toLowerCase())) path = `${folder}/${sd}/${basename(f.name, extname(f.name))} (${n++})${extname(f.name)}`;
    used.add(path.toLowerCase());
    const store = STORE_EXT.has(extname(f.name).toLowerCase()) || data.length < 64, comp = store ? data : deflateRawSync(data), nm = Buffer.from(path, "utf8"), crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(store ? 0 : 8, 8); lh.writeUInt16LE(tm.t, 10); lh.writeUInt16LE(tm.d, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(store ? 0 : 8, 10); ch.writeUInt16LE(tm.t, 12); ch.writeUInt16LE(tm.d, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    local.push(lh, nm, comp); central.push(ch, nm); off += lh.length + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22), cnt = central.length / 2;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(cnt, 8); end.writeUInt16LE(cnt, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return { name: only ? `${folder}_근거자료.zip` : `${folder}.zip`, parts: [...local, cd, end], count: cnt };
}

// ── 사건 카드(초안/확정)
export function getCard(caseId) {
  const r = q1("SELECT card_json, card_status, card_by, card_at FROM cases WHERE id=?", caseId); if (!r) throw new HttpError(404, "사건을 찾을 수 없습니다");
  return { card: r.card_json ? JSON.parse(r.card_json) : null, status: r.card_json ? r.card_status || "초안" : null, by: r.card_by, at: r.card_at,
    history: q("SELECT action, by_name, at, note FROM case_confirms WHERE case_id=? ORDER BY id DESC", caseId).map((h) => ({ action: h.action, by: h.by_name, at: h.at, note: h.note })) };
}
export function setCard(caseId, card, status = "초안") { run("UPDATE cases SET card_json=?, card_status=?, card_by=NULL, card_at=NULL, updated_at=? WHERE id=?", JSON.stringify(card), status, nowIso(), caseId); }
const needName = (n) => { const s = String(n || "").trim(); if (s.length < 2) throw new HttpError(400, "확정자 이름을 입력하세요"); return s.slice(0, 40); };
export function confirmCard(caseId, { password, name }, ip) {
  const cur = getCard(caseId); if (!cur.card) throw new HttpError(409, "확정할 사건 카드가 없습니다");
  if (cur.status === "확정") throw new HttpError(409, "이미 확정된 카드입니다");
  const by = needName(name); verifyConfirm(password, ip);
  tx(() => { run("UPDATE cases SET card_status='확정', card_by=?, card_at=?, updated_at=? WHERE id=?", by, nowIso(), nowIso(), caseId); run("INSERT INTO case_confirms (case_id,action,by_name,at) VALUES (?,?,?,?)", caseId, "확정", by, nowIso()); });
  return getCard(caseId);
}
export function reopenCard(caseId, { password, name, note }, ip) {
  const cur = getCard(caseId); if (cur.status !== "확정") throw new HttpError(409, "확정된 카드가 아닙니다");
  const by = needName(name); verifyConfirm(password, ip);
  tx(() => { run("UPDATE cases SET card_status='초안', card_by=NULL, card_at=NULL, updated_at=? WHERE id=?", nowIso(), caseId); run("INSERT INTO case_confirms (case_id,action,by_name,at,note) VALUES (?,?,?,?,?)", caseId, "초안으로 되돌림", by, nowIso(), String(note || "").slice(0, 300) || null); });
  return getCard(caseId);
}

// ── 문서 내장 이미지(참고용 목록). 해시가 사건 파일·다른 내장 이미지와 같으면 중복, 아니면 사건 자료로 연결할 수 있다.
export function refreshEmbeddedDup(caseId) {
  const files = q("SELECT id, sha256 FROM case_files WHERE case_id=? AND source<>'embedded' AND kind<>'ignore'", caseId), seen = new Map();
  for (const e of q("SELECT * FROM case_embedded WHERE case_id=? ORDER BY id", caseId)) {
    const f = files.find((x) => x.sha256 && x.sha256 === e.sha256), prior = e.sha256 && seen.get(e.sha256);
    run("UPDATE case_embedded SET dup_of_file=?, dup_of_embedded=? WHERE id=?", f ? f.id : null, !f && prior ? prior : null, e.id);
    if (e.sha256 && !seen.has(e.sha256)) seen.set(e.sha256, e.id);
  }
}
export function listEmbedded(caseId) {
  refreshEmbeddedDup(caseId);
  const names = Object.fromEntries(q("SELECT id,name FROM case_files WHERE case_id=?", caseId).map((f) => [f.id, f.name])), en = Object.fromEntries(q("SELECT id,name FROM case_embedded WHERE case_id=?", caseId).map((e) => [e.id, e.name]));
  return q("SELECT * FROM case_embedded WHERE case_id=? ORDER BY id", caseId).map((e) => ({ name: e.name, sourceDoc: e.source_doc, size: e.size, w: e.w, h: e.h, docType: e.doc_type, shotDate: e.shot_date, readability: e.readability,
    keyFacts: e.key_facts ? JSON.parse(e.key_facts) : [], linkedFileId: e.linked_file_id,
    duplicate: e.dup_of_file ? { kind: "case-file", name: names[e.dup_of_file] } : e.dup_of_embedded ? { kind: "embedded", name: en[e.dup_of_embedded] } : null }));
}
export function embeddedImagePath(caseId, name) {
  const e = q1("SELECT name FROM case_embedded WHERE case_id=? AND name=?", caseId, name); if (!e) throw new HttpError(404, "이미지를 찾을 수 없습니다");
  const { dir } = ensureCaseDir(caseId), abs = join(dir, "내장이미지", e.name);
  if (!inside(join(dir, "내장이미지"), abs) || !existsSync(abs)) throw new HttpError(404, "이미지 파일이 없습니다");
  return abs;
}
export function linkEmbedded(caseId, name) {
  refreshEmbeddedDup(caseId);
  const e = q1("SELECT * FROM case_embedded WHERE case_id=? AND name=?", caseId, name); if (!e) throw new HttpError(404, "이미지를 찾을 수 없습니다");
  if (e.linked_file_id) throw new HttpError(409, "이미 사건 자료로 연결된 이미지입니다");
  if (e.dup_of_file || e.dup_of_embedded) throw new HttpError(409, "다른 자료와 같은 이미지(중복)라 연결하지 않습니다");
  const src = embeddedImagePath(caseId, name), { dir } = ensureCaseDir(caseId), rel = uniqueRel(caseId, `내장이미지/${e.name}`), dest = join(dir, "원본", ...rel.split("/"));
  mkdirSync(dirname(dest), { recursive: true }); copyFileSync(src, dest);
  const buf = readFileSync(dest);
  const r = run("INSERT INTO case_files (case_id,rel_path,name,size,sha256,kind,stage,note,source,added_at) VALUES (?,?,?,?,?,?,?,?,?,?)", caseId, rel, rel.split("/").at(-1), buf.length, createHash("sha256").update(buf).digest("hex"), "case-doc", null, `문서 내장 이미지: ${e.source_doc || ""}`.trim(), "embedded", nowIso());
  run("UPDATE case_embedded SET linked_file_id=? WHERE id=?", Number(r.lastInsertRowid), e.id);
  writeManifest(caseId); return fileRow(q1("SELECT * FROM case_files WHERE id=?", Number(r.lastInsertRowid)));
}
export function addEmbedded(caseId, o) {
  run(`INSERT INTO case_embedded (case_id,name,source_doc,sha256,size,w,h,doc_type,shot_date,readability,key_facts) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(case_id,name) DO UPDATE SET source_doc=excluded.source_doc, sha256=excluded.sha256, size=excluded.size, w=excluded.w, h=excluded.h, doc_type=excluded.doc_type, shot_date=excluded.shot_date, readability=excluded.readability, key_facts=excluded.key_facts`,
    caseId, o.name, o.sourceDoc || null, o.sha256 || null, o.size || null, o.w || null, o.h || null, o.docType || null, o.shotDate || null, o.readability || null, JSON.stringify(o.keyFacts || []));
}

// ── 목록·상세
export function listArchive(f = {}) {
  const cnt = Object.fromEntries(q("SELECT case_id, SUM(CASE WHEN kind<>'ignore' THEN 1 ELSE 0 END) m, SUM(suspect_other_case) s FROM case_files GROUP BY case_id").map((r) => [r.case_id, r]));
  const dir = f.sort === "old" ? 1 : -1, key = (c) => (c.startDate || `${c.startYear}-00-00`) + String(c.id).padStart(8, "0");   // 시작일 기준 정렬(연도만 아는 사건은 연도 맨 앞)
  return listCases({ status: f.status, year: f.year, type: f.type, bu: f.bu, q: f.q })
    .sort((a, b) => (key(a) < key(b) ? -dir : key(a) > key(b) ? dir : 0))
    .map((c) => ({ ...c, fileCount: cnt[c.id]?.m || 0, suspectCount: cnt[c.id]?.s || 0 }));
}
const nexusSummary = (files) => { const t = files.filter((f) => f.kind !== "ignore"); return { enabled: N.configured() && !!N.caseFolder(), ok: t.filter((f) => f.nexusState === "ok").length, failed: t.filter((f) => f.nexusState === "failed").length, pending: t.filter((f) => f.nexusState !== "ok").length, total: t.length }; };
export function caseDetail(caseId) {
  ensureCaseDir(caseId);
  const c = getCase(caseId), files = listFiles(caseId), cd0 = getCard(caseId), embedded = listEmbedded(caseId);
  const cd = { ...cd0, card: cd0.card ? enrichSources(cd0.card, files, embedded) : null };
  const imports = q("SELECT source_path, file_count, total_bytes, skipped, imported_at FROM case_imports WHERE case_id=? ORDER BY id", caseId).map((i) => ({ path: i.source_path, files: i.file_count, bytes: i.total_bytes, skipped: i.skipped ? JSON.parse(i.skipped) : null, at: i.imported_at }));
  return { case: c, files, card: cd, embedded, nexus: nexusSummary(files), evidenceCount: cd0.card ? evidenceFileIds(caseId).length : 0, imports, stages: config().caseStages, stageExtras: config().stageExtras || [], fileKinds: kinds(), zipName: `${c.folderName}.zip` };
}

// 담당자가 최초 민원 접수일 확정 → 시작일 갱신 + 폴더 이름의 시작연월을 맞춘다(디렉터리 이름 변경). 진행 중인 AI 분석이 없을 때만(호출하는 쪽이 확인).
export function setStartDate(caseId, date) {
  const row = q1("SELECT folder FROM cases WHERE id=?", caseId); if (!row) throw new HttpError(404, "사건을 찾을 수 없습니다");
  const c = updateStartDate(caseId, date), want = caseFolderName({ title: c.title, startDate: c.startDate, startYear: c.startYear });
  if (row.folder && row.folder !== want) {
    let name = want, n = 2;
    while (q1("SELECT id FROM cases WHERE folder=? AND id<>?", name, caseId) || existsSync(join(CASES, name))) name = `${want}(${n++})`;
    const from = join(CASES, row.folder), to = join(CASES, name);
    if (existsSync(from)) { try { renameSync(from, to); run("UPDATE cases SET folder=? WHERE id=?", name, caseId); } catch { /* 이름 변경 실패 시 기존 폴더 유지 */ } }
    else run("UPDATE cases SET folder=? WHERE id=?", name, caseId);
  }
  writeManifest(caseId);
  return getCase(caseId);
}
