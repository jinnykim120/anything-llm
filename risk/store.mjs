// 리스크 시스템 저장소: 단일 SQLite 파일(data/risk.db) — 백업·이식은 이 파일 하나만 복사하면 된다.
//   issues : 센싱된 이슈. 원본(data/issues.json)은 risk.mjs 가 계속 갱신하고, 여기는 그 스냅샷 + 분류 상태(보류/사건화)만 얹는다.
//   cases  : 사건(케이스). 출처 = 센싱(이슈를 사건화) / 수동(직접 입력) / 과거이력(엑셀 시드).
// 분류 체계(유형·사업부문·단계)는 config/taxonomy.json 에서 읽는다. LLM·웹 호출 없음.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canOverride, accuracyOf, caseFolderName, HOLD } from "./classify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const DATA = join(here, "data");
const DB_PATH = process.env.RISK_DB || join(DATA, "risk.db");
const ISSUES_JSON = join(DATA, "issues.json");
const SEED_JSON = join(DATA, "seed", "past-cases.json");
const TAXONOMY = join(here, "config", "taxonomy.json");
mkdirSync(dirname(DB_PATH), { recursive: true });

// ── 설정(파일이 바뀌면 다시 읽음)
let _cfg = null, _cfgM = 0;
export function config() {
  const m = statSync(TAXONOMY).mtimeMs;
  if (!_cfg || m !== _cfgM) { _cfg = JSON.parse(readFileSync(TAXONOMY, "utf8")); _cfgM = m; }
  return _cfg;
}
export const publicConfig = () => { const { _note, _assumptions, ...c } = config(); return c; };

// ── 시간(KST)
const kstNow = () => new Date(Date.now() + 9 * 3600e3);
export const todayKst = () => kstNow().toISOString().slice(0, 10);
const dayKst = (iso) => (iso ? new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10) : null);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !isNaN(Date.parse(s));

// ── DB
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout=8000");   // 서버와 배치 드라이버가 같은 DB 를 쓸 때 잠깐의 잠금은 기다린다
db.exec(`
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT, area TEXT, level TEXT,
  type_id TEXT, bu_id TEXT,
  start_date TEXT,            -- 기사 게재일(출처 중 가장 이른 날짜, 없으면 발생일)
  first_seen TEXT, last_seen TEXT, sources_count INTEGER DEFAULT 0,
  state TEXT NOT NULL DEFAULT '센싱됨',   -- 센싱됨 | 추적관찰 | 보류 | 사건화
  hold_reason TEXT, held_at TEXT, case_id INTEGER, synced_at TEXT
);
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, seed_id TEXT UNIQUE,
  source TEXT NOT NULL,        -- 센싱 | 수동 | 과거이력
  issue_id TEXT, title TEXT NOT NULL, summary TEXT, level TEXT,
  type_id TEXT, type_tags TEXT NOT NULL DEFAULT '[]',   -- 주 유형 1개 + 부 유형 태그(JSON 배열)
  bu_id TEXT, bu_raw TEXT,
  status TEXT NOT NULL DEFAULT '진행',   -- 진행 | 종결
  stage_id TEXT,
  start_date TEXT, start_year INTEGER NOT NULL, date_known INTEGER NOT NULL DEFAULT 1,  -- 연도만 아는 과거 사례는 start_date NULL, date_known 0
  end_date TEXT, raw_cell TEXT, needs_review TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- v3: 아카이브(사건 폴더·파일·사건 카드·확정 이력·설정)
CREATE TABLE IF NOT EXISTS case_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL,
  rel_path TEXT NOT NULL,       -- 사건 폴더/원본/ 기준 상대 경로(슬래시 구분)
  name TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, sha256 TEXT,
  kind TEXT NOT NULL DEFAULT 'case-doc',   -- case-doc | procedure-ref | keep-only | ignore (config.fileKinds)
  stage TEXT,                   -- 6개 단계 id | overall | NULL(미지정)
  stage_source TEXT,            -- manual(담당자) | ai(AI 제안 — 확인 전)
  dup_of INTEGER,               -- 해시가 같은 앞선 파일
  dup_group TEXT, note TEXT,
  suspect_other_case INTEGER NOT NULL DEFAULT 0,   -- 다른 사건 문서로 의심(확인 필요)
  ai_stage TEXT, ai_stage_conf REAL, ai_stage_why TEXT,   -- AI 단계 제안(참고용)
  source TEXT NOT NULL DEFAULT 'upload',   -- upload | pilot | embedded
  added_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS case_files_case ON case_files(case_id);
CREATE TABLE IF NOT EXISTS case_embedded (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL,
  name TEXT NOT NULL, source_doc TEXT, sha256 TEXT, size INTEGER, w INTEGER, h INTEGER,
  doc_type TEXT, shot_date TEXT, readability TEXT, key_facts TEXT,   -- key_facts: JSON 배열
  dup_of_file INTEGER, dup_of_embedded INTEGER, linked_file_id INTEGER,
  UNIQUE(case_id, name)
);
CREATE TABLE IF NOT EXISTS case_confirms (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL,
  action TEXT NOT NULL,         -- 확정 | 초안으로 되돌림
  by_name TEXT NOT NULL, at TEXT NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
-- v4: AI 분석 실행 이력(작업 큐 겸용)·이미지 판독 캐시(같은 해시는 다시 읽지 않음)·서버 경로 가져오기 기록
CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL,
  status TEXT NOT NULL,           -- 대기 | 실행 중 | 일시중지 | 완료 | 실패 | 취소
  step INTEGER NOT NULL DEFAULT 0, step_label TEXT, progress_done INTEGER NOT NULL DEFAULT 0, progress_total INTEGER NOT NULL DEFAULT 0, message TEXT,
  options TEXT, counts TEXT, files TEXT, est_low REAL, est_high REAL,
  calls INTEGER NOT NULL DEFAULT 0, in_tokens INTEGER NOT NULL DEFAULT 0, out_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT, paused_reason TEXT, result_json TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS analysis_case ON analysis_runs(case_id);
CREATE TABLE IF NOT EXISTS vision_cache (sha256 TEXT PRIMARY KEY, result_json TEXT NOT NULL, model TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS case_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL, source_path TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE,
  file_count INTEGER, total_bytes INTEGER, skipped TEXT, imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cases_year ON cases(start_year);
CREATE INDEX IF NOT EXISTS issues_state ON issues(state);
`);
const q = (sql, ...p) => db.prepare(sql).all(...p);
const q1 = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const tx = (fn) => { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };
const nowIso = () => new Date().toISOString();

// ── 스키마 마이그레이션(v2: 유형 출처·AI 제안 보관). 기존 데이터가 있으면 먼저 VACUUM INTO 로 백업 복사본을 만든다.
//    컬럼은 존재 여부를 확인하고 추가하므로 여러 번 실행해도 안전하다(멱등).
const SCHEMA_VERSION = 10;
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
const ISSUE_COLS = { type_source: "TEXT", ai_type_id: "TEXT", ai_type_conf: "REAL", ai_type_why: "TEXT", ai_type_status: "TEXT", ai_bu_id: "TEXT", ai_bu_why: "TEXT", ai_type_at_confirm: "TEXT", type_confirmed_at: "TEXT", origin: "TEXT", signal: "TEXT" , archive_ok: "INTEGER" , watch_note: "TEXT", watched_at: "TEXT" , contact: "TEXT" };
const CASE_COLS = { type_source: "TEXT", ai_type_id: "TEXT", ai_type_conf: "REAL", ai_type_why: "TEXT", ai_bu_id: "TEXT", ai_bu_why: "TEXT",
  folder: "TEXT", card_json: "TEXT", card_status: "TEXT", card_by: "TEXT", card_at: "TEXT",   // v3: 사건 폴더 이름·사건 카드(초안/확정)
  start_provisional: "INTEGER" , title_source: "TEXT" , nexus_sub: "TEXT" };   // v4: 1 = 시작일의 '연월'만 임시값(최초 민원 접수일 미확정 — 서버 경로 가져오기)
const FILE_COLS = { kind_source: "TEXT", pii_state: "TEXT", pii_note: "TEXT", nexus_state: "TEXT", nexus_loc: "TEXT", nexus_err: "TEXT", nexus_at: "TEXT" };   // v4: 종류를 누가 정했나(manual|auto) · 개인정보 의심(suspect|cleared)
export let lastBackup = null;
function migrate() {
  const v = q1("PRAGMA user_version").user_version;
  if (v >= SCHEMA_VERSION) return;
  const hasData = q1("SELECT (SELECT COUNT(*) FROM issues)+(SELECT COUNT(*) FROM cases) n").n > 0;
  if (hasData) {
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    lastBackup = `${DB_PATH}.bak-v${v}-${ts}`;
    db.exec(`VACUUM INTO '${lastBackup.replace(/'/g, "''")}'`);
  }
  tx(() => {
    for (const [c, t] of Object.entries(ISSUE_COLS)) if (!hasCol("issues", c)) db.exec(`ALTER TABLE issues ADD COLUMN ${c} ${t}`);
    for (const [c, t] of Object.entries(CASE_COLS)) if (!hasCol("cases", c)) db.exec(`ALTER TABLE cases ADD COLUMN ${c} ${t}`);
    for (const [c, t] of Object.entries(FILE_COLS)) if (!hasCol("case_files", c)) db.exec(`ALTER TABLE case_files ADD COLUMN ${c} ${t}`);
    // 기존 값의 출처 채우기: 과거이력 시드는 '문서 지정', 사람이 사건화한 값은 '담당자'
    db.exec("UPDATE cases SET type_source='document' WHERE type_source IS NULL AND type_id IS NOT NULL AND source='과거이력'");
    db.exec("UPDATE cases SET type_source='manual' WHERE type_source IS NULL AND type_id IS NOT NULL");
    db.exec("UPDATE issues SET type_source='manual' WHERE type_source IS NULL AND type_id IS NOT NULL");
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  });
}
migrate();

// ── 센싱 이슈 동기화(issues.json → issues). 분류·상태는 덮어쓰지 않는다.
let _syncM = 0;
export function syncSensing(force = false) {
  if (!existsSync(ISSUES_JSON)) return 0;
  const m = statSync(ISSUES_JSON).mtimeMs;
  if (!force && m === _syncM) return 0;
  const src = JSON.parse(readFileSync(ISSUES_JSON, "utf8")).issues || {};
  let n = 0;
  tx(() => {
    for (const i of Object.values(src)) {
      const dates = (i.sources || []).map((s) => s.date).filter(isDate).sort();
      const start = dates[0] || (isDate(i.occurredAt) ? i.occurredAt : dayKst(i.firstSeen));
      const ex = q1("SELECT id FROM issues WHERE id=?", i.id);
      if (ex) run("UPDATE issues SET title=?,summary=?,area=?,level=?,start_date=?,last_seen=?,sources_count=?,synced_at=? WHERE id=?",
        i.title, i.summary || "", i.area || "", i.level || null, start, i.lastUpdated || null, (i.sources || []).length, nowIso(), i.id);
      else { run("INSERT INTO issues (id,title,summary,area,level,start_date,first_seen,last_seen,sources_count,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        i.id, i.title, i.summary || "", i.area || "", i.level || null, start, i.firstSeen || null, i.lastUpdated || null, (i.sources || []).length, nowIso()); n++; }
      run("UPDATE issues SET archive_ok=?, contact=? WHERE id=?", i.archiveCheck ? (i.archiveCheck.ok === false ? 0 : 1) : null, i.contact === "불명" || i.contact === "확인" ? i.contact : null, i.id);
      if (i.aiType || i.aiBu) applyAiSuggestion(i.id, i.aiType, i.aiBu); // 센싱 분석이 남긴 AI 제안(risk.mjs → issues.json)
    }
  });
  _syncM = m;
  return n;
}

// ── AI 제안 반영(센싱 동기화·백필 공용). AI 는 담당자(manual)·문서 지정(document) 값을 절대 덮어쓰지 않는다 — 제안 필드(ai_*)만 갱신한다.
//    aiType = {status:'suggested'|'hold', id, confidence, why}, aiBu = {id, why}. 사업부문은 확정값(bu_id)을 건드리지 않고 힌트(ai_bu_id)만 둔다.
export function applyAiSuggestion(id, aiType, aiBu) {
  const r = q1("SELECT type_source FROM issues WHERE id=?", id);
  if (!r) throw new HttpError(404, "이슈를 찾을 수 없습니다");
  const ts = aiType && (aiType.status === "suggested" || aiType.status === "hold") ? aiType : null;
  if (ts && ts.status === "suggested" && !typeIds().has(ts.id)) throw new HttpError(400, "알 수 없는 유형 제안");
  if (ts) {
    run("UPDATE issues SET ai_type_id=?, ai_type_conf=?, ai_type_why=?, ai_type_status=? WHERE id=?", ts.status === "suggested" ? ts.id : null, ts.confidence ?? null, ts.why || null, ts.status, id);
    if (canOverride(r.type_source, "ai")) { // 아직 확정 전(없음/ai)일 때만 현재 유형 값에 반영
      if (ts.status === "suggested") run("UPDATE issues SET type_id=?, type_source='ai' WHERE id=?", ts.id, id);
      else run("UPDATE issues SET type_id=NULL, type_source=NULL WHERE id=?", id);
    }
  }
  if (aiBu && buIds().has(aiBu.id)) run("UPDATE issues SET ai_bu_id=?, ai_bu_why=? WHERE id=?", aiBu.id, aiBu.why || null, id);
  return true;
}

// ── 과거 사례 시드(엑셀 → data/seed/past-cases.json → cases). seed_id 로 멱등: 이미 있으면 건드리지 않는다(사람이 고친 값 보존).
export function seedPast() {
  if (!existsSync(SEED_JSON)) return { loaded: 0, skipped: "seed 파일 없음 (python -X utf8 -I seed/extract-past-cases.py <xlsx>)" };
  const seed = JSON.parse(readFileSync(SEED_JSON, "utf8"));
  let loaded = 0;
  tx(() => {
    for (const c of seed.cases) {
      const r = run(`INSERT OR IGNORE INTO cases (seed_id,source,title,type_id,type_source,type_tags,bu_id,bu_raw,status,start_date,start_year,date_known,raw_cell,needs_review,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        c.seedId, "과거이력", c.title, c.typeId, "document", "[]", c.buId, c.buRaw, "종결", null, c.year, 0, c.rawCell, c.review?.length ? c.review.join("; ") : null, nowIso(), nowIso());
      loaded += Number(r.changes);
    }
  });
  return { loaded, total: seed.cases.length };
}

// ── 검증 도우미
export class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const typeIds = () => new Set(config().issueTypes.map((t) => t.id));
const buIds = () => new Set(config().businessUnits.map((b) => b.id));
const levelIds = () => new Set(config().levels.map((l) => l.id));
function checkClass({ typeId, buId, tags, level }, { typeRequired = true } = {}) {
  if (typeRequired && !typeIds().has(typeId)) throw new HttpError(400, "유형을 선택하세요");
  if (buId && !buIds().has(buId)) throw new HttpError(400, "알 수 없는 사업부문");
  if (level && !levelIds().has(level)) throw new HttpError(400, "알 수 없는 위험도");
  const t = [...new Set((tags || []).filter((x) => x !== typeId))];
  if (t.some((x) => !typeIds().has(x))) throw new HttpError(400, "알 수 없는 부 유형");
  return t;
}

// ── 이슈 조회·상태 변경
// 유형: typeId(현재 값) + typeSource(manual|document|ai|null) + aiType(제안 원본). typeConfirmed = 담당자·문서가 확정한 값인가.
// 사업부문: buId 는 담당자가 고른 확정값만. aiBu 는 힌트일 뿐 buId 를 미리 채우지 않는다.
const issueRow = (r, caseNames = {}) => ({ id: r.id, title: r.title, summary: r.summary, area: r.area, level: r.level, typeId: r.type_id, buId: r.bu_id,
  contact: r.contact || null, watchNote: r.watch_note || null, watchedAt: r.watched_at || null, origin: r.origin || null, signal: r.signal || null, archiveOk: r.archive_ok === 0 ? false : r.archive_ok === 1 ? true : null, typeSource: r.type_source || null, typeConfirmed: r.type_source === "manual" || r.type_source === "document",
  aiType: r.ai_type_status ? { status: r.ai_type_status, id: r.ai_type_id, confidence: r.ai_type_conf, why: r.ai_type_why } : null,
  aiBu: r.ai_bu_id ? { id: r.ai_bu_id, why: r.ai_bu_why } : null,
  startDate: r.start_date, firstSeen: r.first_seen, lastSeen: r.last_seen, sourcesCount: r.sources_count, state: r.state, holdReason: r.hold_reason, heldAt: r.held_at, caseId: r.case_id, caseName: caseNames[r.case_id] || null,
  newToday: dayKst(r.first_seen) === todayKst(), updatedToday: dayKst(r.last_seen) === todayKst() });
const LV = { 높음: 0, 중간: 1, 낮음: 2 };
const caseNameMap = () => Object.fromEntries(q("SELECT id,title,start_date,start_year FROM cases WHERE source='센싱'").map((c) => [c.id, caseFolderName({ title: c.title, startDate: c.start_date, startYear: c.start_year })]));
export function listIssues() {
  syncSensing();
  const names = caseNameMap();
  return q("SELECT * FROM issues").map((r) => issueRow(r, names)).sort((a, b) => (LV[a.level] ?? 3) - (LV[b.level] ?? 3) || String(b.lastSeen).localeCompare(String(a.lastSeen)));
}
// 담당자가 센싱 이슈의 유형·사업부문을 직접 고른다(출처=manual). AI 제안 필드는 그대로 보존하고, 첫 확정 시점의 AI 제안을 일치율 계산용으로 따로 남긴다.
//   b = { typeId?, buId? }  buId 가 null/"" 이면 사업부문 미지정으로 되돌린다.
export function classifyIssue(id, b = {}) {
  syncSensing();
  const i = q1("SELECT * FROM issues WHERE id=?", id);
  if (!i) throw new HttpError(404, "이슈를 찾을 수 없습니다");
  if (i.state === "사건화") throw new HttpError(409, "사건화된 이슈는 사건에서 분류를 바꾸세요");
  if (b.typeId === undefined && b.buId === undefined) throw new HttpError(400, "바꿀 값이 없습니다");
  if (b.typeId !== undefined) {
    if (!typeIds().has(b.typeId)) throw new HttpError(400, "알 수 없는 유형");
    if (i.type_source !== "manual") run("UPDATE issues SET ai_type_at_confirm=? WHERE id=?", i.ai_type_status === "hold" ? HOLD : i.ai_type_id || "none", id);
    run("UPDATE issues SET type_id=?, type_source='manual', type_confirmed_at=? WHERE id=?", b.typeId, nowIso(), id);
  }
  if (b.buId !== undefined) {
    if (b.buId && !buIds().has(b.buId)) throw new HttpError(400, "알 수 없는 사업부문");
    run("UPDATE issues SET bu_id=? WHERE id=?", b.buId || null, id);
  }
  return issueRow(q1("SELECT * FROM issues WHERE id=?", id), caseNameMap());
}
export function issueStates() { syncSensing(); return Object.fromEntries(q("SELECT id,state,hold_reason,case_id FROM issues").map((r) => [r.id, { state: r.state, holdReason: r.hold_reason, caseId: r.case_id }])); }

// 담당자가 직접 등록하는 내부 신호(웹 센싱으로는 안 잡히는 VOC·점포·시스템·인사 이슈). 센싱 목록에 같은 방식으로 나타나고 사건화·보류도 같다.
const SIGNALS = ["고객VOC", "점주", "언론", "기관", "내부", "기타"];
export function createInternalIssue(b = {}) {
  const title = String(b.title || "").trim().slice(0, 200); if (!title) throw new HttpError(400, "제목을 입력하세요");
  const summary = String(b.summary || "").trim().slice(0, 4000), signal = SIGNALS.includes(b.signal) ? b.signal : "내부";
  const day = isDate(b.occurredAt) ? b.occurredAt : todayKst(), level = ["높음", "중간", "낮음"].includes(b.level) ? b.level : null;
  const id = "f" + Date.now().toString(16) + Math.floor(Math.random() * 0xfffff).toString(16).padStart(5, "0");   // 이슈 처리 API 가 16진수 id 만 받으므로 16진수로 만든다
  const typeOk = b.typeId && config().issueTypes.some((t) => t.id === b.typeId), buOk = b.buId && config().businessUnits.some((x) => x.id === b.buId);
  run("INSERT INTO issues (id,title,summary,area,level,type_id,bu_id,type_source,type_confirmed_at,start_date,first_seen,last_seen,sources_count,state,synced_at,origin,signal) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,'센싱됨',?,'internal',?)",
    id, title, summary, "내부 등록", level, typeOk ? b.typeId : null, buOk ? b.buId : null, typeOk ? "manual" : null, typeOk ? nowIso() : null, day, nowIso(), nowIso(), nowIso(), signal);
  return issueRow(q1("SELECT * FROM issues WHERE id=?", id));
}
export function promoteIssue(id, b = {}) {
  syncSensing();
  const i = q1("SELECT * FROM issues WHERE id=?", id);
  if (!i) throw new HttpError(404, "이슈를 찾을 수 없습니다");
  if (i.state === "사건화") throw new HttpError(409, "이미 사건화된 이슈입니다");
  const tags = checkClass(b);
  // 유형이 아직 AI 제안(또는 없음)이면 담당자가 한 번 더 확인했다는 표시(typeConfirmed)가 있어야 사건화할 수 있다.
  const confirmedBefore = i.type_source === "manual" || i.type_source === "document";
  if (!confirmedBefore && b.typeConfirmed !== true) throw new HttpError(409, "유형이 아직 확인되지 않았습니다(AI 제안). 유형을 확인한 뒤 사건화하세요");
  const title = String(b.title || i.title).trim().slice(0, 200) || i.title, level = b.level || i.level;
  return tx(() => {
    const start = i.start_date, yr = Number((start || todayKst()).slice(0, 4));
    const r = run(`INSERT INTO cases (source,issue_id,title,summary,level,type_id,type_source,type_tags,bu_id,ai_type_id,ai_type_conf,ai_type_why,ai_bu_id,ai_bu_why,status,stage_id,start_date,start_year,date_known,created_at,updated_at)
      VALUES ('센싱',?,?,?,?,?,?,?,?,?,?,?,?,?,'진행',?,?,?,?,?,?)`, id, title, i.summary, level, b.typeId, confirmedBefore && i.type_source === "document" ? "document" : "manual", JSON.stringify(tags), b.buId || null,
      i.ai_type_id, i.ai_type_conf, i.ai_type_why, i.ai_bu_id, i.ai_bu_why, config().caseStages[0]?.id || null, start, yr, start ? 1 : 0, nowIso(), nowIso());
    if (i.type_source !== "manual") run("UPDATE issues SET ai_type_at_confirm=? WHERE id=?", i.ai_type_status === "hold" ? HOLD : i.ai_type_id || "none", id);
    run("UPDATE issues SET state='사건화', case_id=?, type_id=?, type_source='manual', type_confirmed_at=?, bu_id=?, hold_reason=NULL WHERE id=?", Number(r.lastInsertRowid), b.typeId, nowIso(), b.buId || null, id);
    return getCase(Number(r.lastInsertRowid));
  });
}
export function holdIssue(id, reason) {
  syncSensing();
  const i = q1("SELECT * FROM issues WHERE id=?", id);
  if (!i) throw new HttpError(404, "이슈를 찾을 수 없습니다");
  if (i.state === "사건화") throw new HttpError(409, "사건화된 이슈는 보류할 수 없습니다");
  const r = String(reason || "").trim();
  if (r.length < 2) throw new HttpError(400, "보류 사유를 입력하세요");
  run("UPDATE issues SET state='보류', hold_reason=?, held_at=? WHERE id=?", r.slice(0, 500), nowIso(), id);
  return issueRow(q1("SELECT * FROM issues WHERE id=?", id));
}
// 추적관찰: 사건으로 올릴 단계는 아니지만 계속 지켜볼 이슈. 센싱 목록에 남고, 이후 센싱에서 새 소식이 오면 '추적 중 새 소식'으로 표시된다.
export function watchIssue(id, note) {
  syncSensing();
  const i = q1("SELECT * FROM issues WHERE id=?", id);
  if (!i) throw new HttpError(404, "이슈를 찾을 수 없습니다");
  if (i.state === "사건화") throw new HttpError(409, "사건화된 이슈는 추적관찰로 바꿀 수 없습니다");
  run("UPDATE issues SET state='추적관찰', watch_note=?, watched_at=?, hold_reason=NULL, held_at=NULL WHERE id=?", String(note || "").trim().slice(0, 300) || null, nowIso(), id);
  return issueRow(q1("SELECT * FROM issues WHERE id=?", id));
}
export function unwatchIssue(id) {
  const i = q1("SELECT * FROM issues WHERE id=?", id);
  if (!i) throw new HttpError(404, "이슈를 찾을 수 없습니다");
  if (i.state !== "추적관찰") throw new HttpError(409, "추적관찰 상태가 아닙니다");
  run("UPDATE issues SET state='센싱됨', watch_note=NULL, watched_at=NULL WHERE id=?", id);
  return issueRow(q1("SELECT * FROM issues WHERE id=?", id));
}
export function restoreIssue(id) {
  const i = q1("SELECT * FROM issues WHERE id=?", id);
  if (!i) throw new HttpError(404, "이슈를 찾을 수 없습니다");
  if (i.state !== "보류") throw new HttpError(409, "보류 상태가 아닙니다");
  run("UPDATE issues SET state='센싱됨', hold_reason=NULL, held_at=NULL WHERE id=?", id);
  return issueRow(q1("SELECT * FROM issues WHERE id=?", id));
}

// ── 사건
// 시작일(startDate) = 최초 민원 접수일(config labels.caseStartDate). folderName = 저장·아카이브·화면 공통 표기 'YYYY-MM_제목'.
const caseRow = (r) => ({ id: r.id, source: r.source, issueId: r.issue_id, title: r.title, summary: r.summary, level: r.level, typeId: r.type_id, typeSource: r.type_source || null, typeTags: JSON.parse(r.type_tags || "[]"),
  aiType: r.ai_type_id ? { id: r.ai_type_id, confidence: r.ai_type_conf, why: r.ai_type_why } : null, aiBu: r.ai_bu_id ? { id: r.ai_bu_id, why: r.ai_bu_why } : null,
  buId: r.bu_id, buRaw: r.bu_raw, status: r.status, stageId: r.stage_id, startDate: r.start_date, startYear: r.start_year, dateKnown: !!r.date_known, endDate: r.end_date, needsReview: r.needs_review, createdAt: r.created_at,
  titleSource: r.title_source || null, folderName: r.folder || caseFolderName({ title: r.title, startDate: r.start_date, startYear: r.start_year }),
  startProvisional: !!r.start_provisional,
  cardStatus: r.card_json ? r.card_status || "초안" : null, cardBy: r.card_by || null, cardAt: r.card_at || null, isPilot: r.source === "시범" });
export { caseFolderName };
export const getCase = (id) => { const r = q1("SELECT * FROM cases WHERE id=?", id); if (!r) throw new HttpError(404, "사건을 찾을 수 없습니다"); return caseRow(r); };
export function listCases(f = {}) {
  const w = [], p = [];
  if (f.status) { w.push("status=?"); p.push(f.status); }
  if (f.year) { w.push("start_year=?"); p.push(Number(f.year)); }
  if (f.type) { w.push("type_id=?"); p.push(f.type); }
  if (f.bu) { w.push("bu_id=?"); p.push(f.bu); }
  if (f.source) { w.push("source=?"); p.push(f.source); }
  if (f.q) { w.push("(title LIKE ? OR summary LIKE ?)"); p.push(`%${f.q}%`, `%${f.q}%`); }
  return q(`SELECT * FROM cases ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY start_year DESC, COALESCE(start_date,'') DESC, id DESC LIMIT 1000`, ...p).map(caseRow);
}
export function createCase(b = {}) {
  const tags = checkClass(b, { typeRequired: true });
  const title = String(b.title || "").trim().slice(0, 200);
  if (!title) throw new HttpError(400, "제목을 입력하세요");
  if (!isDate(b.startDate)) throw new HttpError(400, "시작일(YYYY-MM-DD)을 입력하세요");
  const r = run(`INSERT INTO cases (source,title,summary,level,type_id,type_source,type_tags,bu_id,status,stage_id,start_date,start_year,date_known,created_at,updated_at)
    VALUES ('수동',?,?,?,?,'manual',?,?,'진행',?,?,?,1,?,?)`, title, String(b.summary || "").slice(0, 4000), b.level || null, b.typeId, JSON.stringify(tags), b.buId || null, config().caseStages[0]?.id || null, b.startDate, Number(b.startDate.slice(0, 4)), nowIso(), nowIso());
  return getCase(Number(r.lastInsertRowid));
}
// 서버 경로 가져오기로 만든 사건: 유형·사업부문은 비워 두고(미분류), 시작일은 폴더 이름의 '연월'만 임시값(YYYY-MM-01, start_provisional=1).
// date_known=0 이라 통계의 월별 추이에는 들어가지 않고 연도 집계에만 들어간다. 최초 민원 접수일은 담당자가 확정한다(setCaseStartDate).
export function createImportedCase(b = {}) {
  const title = String(b.title || "").trim().slice(0, 200) || "제목없음";
  const ym = /^\d{4}-\d{2}$/.test(b.ym || "") && Number(b.ym.slice(5)) >= 1 && Number(b.ym.slice(5)) <= 12 ? b.ym : null;
  const sid = config().caseStages[0]?.id || null, summary = String(b.summary || "").slice(0, 4000);
  if (ym) {
    const r = run(`INSERT INTO cases (source,title,summary,type_id,type_source,type_tags,bu_id,status,stage_id,start_date,start_year,date_known,start_provisional,created_at,updated_at)
      VALUES ('수동',?,?,NULL,NULL,'[]',NULL,'진행',?,?,?,0,1,?,?)`, title, summary, sid, `${ym}-01`, Number(ym.slice(0, 4)), nowIso(), nowIso());
    return getCase(Number(r.lastInsertRowid));
  }
  // 월을 모르는 경우: 연도만 임시값(폴더 이름은 YYYY-미상_제목). 분석에서 최초 민원 접수일을 찾으면 그때 연월로 바뀐다.
  const year = Number(b.year);
  if (!(year >= 2000 && year <= 2100)) throw new HttpError(400, "시작연월(YYYY-MM) 또는 연도가 필요합니다");
  const r = run(`INSERT INTO cases (source,title,summary,type_id,type_source,type_tags,bu_id,status,stage_id,start_date,start_year,date_known,start_provisional,created_at,updated_at)
    VALUES ('수동',?,?,NULL,NULL,'[]',NULL,'진행',?,NULL,?,0,1,?,?)`, title, summary, sid, year, nowIso(), nowIso());
  return getCase(Number(r.lastInsertRowid));
}
// 담당자가 최초 민원 접수일을 확정(폴더 이름 변경은 casefiles.setStartDate 가 함께 처리)
export function updateStartDate(id, date) {
  if (!isDate(date)) throw new HttpError(400, "날짜(YYYY-MM-DD)를 입력하세요");
  getCase(id);
  run("UPDATE cases SET start_date=?, start_year=?, date_known=1, start_provisional=0, updated_at=? WHERE id=?", date, Number(date.slice(0, 4)), nowIso(), id);
  return getCase(id);
}
// AI 사건 카드의 유형·사업부문 제안 반영. AI 는 담당자(manual)·문서 지정(document) 값을 덮어쓰지 않는다 — 제안(ai_*)만 갱신한다. 사업부문은 힌트만.
export function applyCaseAiSuggestion(id, aiType, aiBu) {
  const r = q1("SELECT type_source, type_id FROM cases WHERE id=?", id);
  if (!r) throw new HttpError(404, "사건을 찾을 수 없습니다");
  if (aiType && (aiType.status === "suggested" || aiType.status === "hold")) {
    if (aiType.status === "suggested" && !typeIds().has(aiType.id)) throw new HttpError(400, "알 수 없는 유형 제안");
    run("UPDATE cases SET ai_type_id=?, ai_type_conf=?, ai_type_why=? WHERE id=?", aiType.status === "suggested" ? aiType.id : null, aiType.confidence ?? null, aiType.why || null, id);
    if (aiType.status === "suggested" && canOverride(r.type_source, "ai")) run("UPDATE cases SET type_id=?, type_source='ai' WHERE id=?", aiType.id, id);
  }
  if (aiBu && buIds().has(aiBu.id)) run("UPDATE cases SET ai_bu_id=?, ai_bu_why=? WHERE id=?", aiBu.id, aiBu.why || null, id);
  run("UPDATE cases SET updated_at=? WHERE id=?", nowIso(), id);
  return getCase(id);
}
// 사건의 유형·부 유형·사업부문을 담당자가 바꾼다(출처=manual). 사업부문 buId 가 null/"" 이면 미지정.
export function classifyCase(id, b = {}) {
  getCase(id);
  if (b.typeId === undefined && b.buId === undefined && b.tags === undefined) throw new HttpError(400, "바꿀 값이 없습니다");
  const cur = getCase(id);
  const typeId = b.typeId ?? cur.typeId;
  const tags = checkClass({ typeId, buId: b.buId || undefined, tags: b.tags ?? cur.typeTags }, { typeRequired: !!typeId || b.typeId !== undefined });
  // 유형이 아직 없는 사건(가져오기)에서 사업부문만 고르면 유형 출처는 건드리지 않는다
  run(`UPDATE cases SET type_id=?, type_source=${typeId ? "'manual'" : "type_source"}, type_tags=?, bu_id=?, updated_at=? WHERE id=?`, typeId || null, JSON.stringify(tags), b.buId === undefined ? cur.buId : b.buId || null, nowIso(), id);
  return getCase(id);
}
export function closeCase(id, endDate) {
  const c = getCase(id);
  if (c.status === "종결") throw new HttpError(409, "이미 종결된 사건입니다");
  const e = endDate || todayKst();
  if (!isDate(e)) throw new HttpError(400, "종료일 형식이 맞지 않습니다");
  if (c.startDate && e < c.startDate) throw new HttpError(400, "종료일이 시작일보다 앞입니다");
  run("UPDATE cases SET status='종결', end_date=?, stage_id=?, updated_at=? WHERE id=?", e, config().caseStages.at(-1)?.id || null, nowIso(), id);
  return getCase(id);
}

// 이미 끝난 사건(과거 사건을 올린 경우): 종료일을 모르면 비워 둔 채 '종결'로 표시한다. 다시 진행으로 되돌릴 수도 있다.
export function setCaseStatus(id, status) {
  const c = getCase(id);
  if (status === "종결") run("UPDATE cases SET status='종결', stage_id=?, updated_at=? WHERE id=?", config().caseStages.at(-1)?.id || null, nowIso(), id);
  else if (status === "진행") run("UPDATE cases SET status='진행', end_date=NULL, updated_at=? WHERE id=?", nowIso(), id);
  else throw new HttpError(400, "상태는 진행 또는 종결입니다");
  return getCase(id);
}

// ── 통계(시작일 기준). 건수는 두 대상으로 나눠 준다: case(사건) / issue(센싱).
//   필터: year, type, bu. 각 차트는 "자기 축의 필터만 빼고" 나머지를 적용한다(선택된 막대를 강조하되 다른 막대도 같이 보이게).
const UNCL = "unclassified";
export function stats(f = {}) {
  syncSensing();
  const cfg = config(), curYear = Number(todayKst().slice(0, 4));
  const fy = f.year ? Number(f.year) : null, ft = f.type || null, fb = f.bu || null;
  const cases = q("SELECT * FROM cases").map((r) => ({ year: r.start_year, month: r.date_known && r.start_date ? Number(r.start_date.slice(5, 7)) : null, type: r.type_id || UNCL, bu: r.bu_id || null, status: r.status, source: r.source }));
  // 센싱 이슈의 유형: 현재 값(AI 제안 포함) / AI 가 보류한 것('hold') / 아직 제안이 없는 것(미분류). unconf = AI 제안이 아직 담당자 확인 전.
  const issues = q("SELECT * FROM issues").map((r) => ({ year: r.start_date ? Number(r.start_date.slice(0, 4)) : null, month: r.start_date ? Number(r.start_date.slice(5, 7)) : null,
    type: r.type_id || (r.ai_type_status === "hold" ? HOLD : UNCL), unconf: r.type_source === "ai", bu: r.bu_id || null, state: r.state, first: dayKst(r.first_seen) })).filter((r) => r.year);
  const covStart = q("SELECT MIN(first_seen) m FROM issues")[0].m ? Number(dayKst(q("SELECT MIN(first_seen) m FROM issues")[0].m).slice(0, 4)) : null;
  const allYears = [...cases.map((c) => c.year), ...issues.map((i) => i.year), curYear];
  const years = []; for (let y = Math.min(...allYears); y <= curYear; y++) years.push(y);
  const typeList = cfg.issueTypes.map((t) => ({ id: t.id, name: t.name })).concat([{ id: HOLD, name: "분류 보류" }, { id: UNCL, name: "미분류" }]);
  const SOFT = new Set([UNCL, HOLD]); // 값이 있을 때만 보여 주는 가상 유형
  const buList = cfg.businessUnits.map((b) => ({ id: b.id, name: b.name })).concat([{ id: "none", name: "미지정" }]);
  const bk = (r) => r.bu || "none";
  const out = { filters: { year: fy, type: ft, bu: fb }, years, coverageStartYear: covStart, types: typeList, businessUnits: buList };
  const sensingAvail = (y) => covStart != null && y >= covStart;
  for (const [name, rows] of [["case", cases], ["issue", issues]]) {
    const pick = (skip) => rows.filter((r) => (skip === "year" || !fy || r.year === fy) && (skip === "type" || !ft || r.type === ft) && (skip === "bu" || !fb || bk(r) === fb));
    const t = { byYear: [], byMonth: null, byType: [], byBu: [], heatYearType: [], heatBuType: [] };
    const cnt = (list, fn) => list.filter(fn).length;
    const forYear = pick("year");
    t.byYear = years.map((y) => ({ year: y, count: name === "issue" && !sensingAvail(y) && !cnt(forYear, (r) => r.year === y) ? null : cnt(forYear, (r) => r.year === y) }));
    if (fy) {
      const list = pick("none").filter((r) => r.year === fy);
      t.byMonth = { year: fy, months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, count: cnt(list, (r) => r.month === i + 1) })), unknownMonth: cnt(list, (r) => r.month == null), available: name === "case" || sensingAvail(fy) || list.length > 0 };
    }
    const forType = pick("type"); t.byType = typeList.map((x) => ({ id: x.id, name: x.name, count: cnt(forType, (r) => r.type === x.id) })).filter((x) => !SOFT.has(x.id) || x.count);
    const forBu = pick("bu"); t.byBu = buList.map((x) => ({ id: x.id, name: x.name, count: cnt(forBu, (r) => bk(r) === x.id) })).filter((x) => x.id !== "none" || x.count);
    const hy = rows.filter((r) => !fb || bk(r) === fb);
    t.heatYearType = years.map((y) => ({ year: y, cells: Object.fromEntries(typeList.map((x) => [x.id, name === "issue" && !sensingAvail(y) && !cnt(hy, (r) => r.year === y) ? null : cnt(hy, (r) => r.year === y && r.type === x.id)])) }));
    const hb = rows.filter((r) => !fy || r.year === fy);
    t.heatBuType = buList.map((b) => ({ id: b.id, name: b.name, cells: Object.fromEntries(typeList.map((x) => [x.id, cnt(hb, (r) => bk(r) === b.id && r.type === x.id)])) }));
    out[name] = t;
  }
  // 깔때기(센싱 → 검토 → 사건화 → 종결). 필터(연도·유형·사업부문)를 모두 적용. 센싱이 아닌 사건(수동·과거이력)은 따로 센다.
  const fi = issues.filter((r) => (!fy || r.year === fy) && (!ft || r.type === ft) && (!fb || bk(r) === fb));
  const fc = cases.filter((r) => (!fy || r.year === fy) && (!ft || r.type === ft) && (!fb || bk(r) === fb));
  const promoted = fc.filter((c) => c.source === "센싱");
  out.funnel = { sensed: fi.length, held: cnt0(fi, (r) => r.state === "보류"), watching: cnt0(fi, (r) => r.state === "추적관찰"), promoted: promoted.length, promotedClosed: promoted.filter((c) => c.status === "종결").length, pending: cnt0(fi, (r) => r.state === "센싱됨"),
    conversionRate: fi.length ? promoted.length / fi.length : null, manualCases: fc.filter((c) => c.source === "수동").length, pastCases: fc.filter((c) => c.source === "과거이력").length, pilotCases: fc.filter((c) => c.source === "시범").length,
    available: fy ? sensingAvail(fy) || fi.length > 0 : covStart != null };
  // 센싱 유형 확인 현황(연도·유형·사업부문 필터 적용): AI 제안이 아직 확인 전인 건, AI 가 보류한 건, 제안이 아직 없는 건
  out.sensingType = { total: fi.length, aiUnconfirmed: cnt0(fi, (r) => r.unconf), hold: cnt0(fi, (r) => r.type === HOLD), unclassified: cnt0(fi, (r) => r.type === UNCL), confirmed: cnt0(fi, (r) => !r.unconf && r.type !== HOLD && r.type !== UNCL) };
  out.kpi = { todayNew: cnt0(issues, (r) => r.first === todayKst()), openCases: cnt0(cases, (c) => c.status === "진행"), held: cnt0(issues, (r) => r.state === "보류"), watching: cnt0(issues, (r) => r.state === "추적관찰"), pending: cnt0(issues, (r) => r.state === "센싱됨") };
  return out;
}
const cnt0 = (l, fn) => l.filter(fn).length;

// ── AI 유형 제안 일치율: 담당자가 처음 확정한 시점의 AI 제안과 최종 유형을 비교한다(전체·AI 가 제안한 유형별).
//    hold(AI 가 보류) / none(제안 없었음)은 일치율 분모에서 빼고 건수만 따로 준다.
export function accuracy() {
  const rows = q("SELECT type_id, ai_type_at_confirm a FROM issues WHERE type_source='manual' AND ai_type_at_confirm IS NOT NULL").map((r) => ({ typeId: r.type_id, aiAtConfirm: r.a }));
  return { ...accuracyOf(rows, config()), pendingConfirm: q1("SELECT COUNT(*) n FROM issues WHERE type_source='ai'").n };
}

// ── 대시보드·대문용 원본 행(데이터 기반, LLM 없음). 연도 다중 선택·연도별 비교는 클라이언트가 이 행으로 직접 집계한다(연도 조합마다 서버를 다시 부르지 않음).
//   cases = 사건 행(y 시작 연도, m 시작 월(모르면 null), d 시작일, t 유형(없으면 unclassified), b 사업부문(없으면 null), s 상태, src 출처, lv 위험도)
//   issues = 센싱 이슈 행(y·m = 기사 게재일 기준, t 유형(AI 가 보류하면 hold, 없으면 unclassified), unc = AI 제안 미확인, st 상태, first = 처음 센싱된 날)
//   years = 데이터가 있는 연도 + 올해(오름차순, 새 연도는 자동으로 늘어난다) / home = 대문 요약
export function dashboard() {
  syncSensing();
  const today = todayKst(), cur = Number(today.slice(0, 4));
  const cases = q("SELECT id,title,type_id,bu_id,level,start_date,start_year,date_known,status,source FROM cases").map((r) => ({ id: r.id, title: r.title, y: r.start_year,
    m: r.date_known && r.start_date ? Number(r.start_date.slice(5, 7)) : null, d: r.date_known ? r.start_date : null, t: r.type_id || UNCL, b: r.bu_id || null, s: r.status, src: r.source, lv: r.level || null }));
  const issues = q("SELECT state, level, type_id, ai_type_status ats, type_source ts, bu_id, start_date sd, first_seen fs FROM issues").map((r) => ({ y: r.sd ? Number(r.sd.slice(0, 4)) : null,
    m: r.sd ? Number(r.sd.slice(5, 7)) : null, t: r.type_id || (r.ats === "hold" ? HOLD : UNCL), b: r.bu_id || null, st: r.state, lv: r.level || null, unc: r.ts === "ai", first: r.fs ? dayKst(r.fs) : null })).filter((r) => r.y);
  const covRaw = q1("SELECT MIN(first_seen) m FROM issues").m, cov = covRaw ? Number(dayKst(covRaw).slice(0, 4)) : null;
  const ys = new Set([cur, ...cases.map((c) => c.y), ...issues.map((i) => i.y)].filter(Boolean)), years = [...ys].sort((a, b) => a - b);
  const home = { todayNew: issues.filter((r) => r.first === today).length, pending: issues.filter((r) => r.st === "센싱됨").length, openCases: cases.filter((c) => c.s === "진행").length, needConfirm: issues.filter((r) => r.unc && r.st !== "사건화").length };
  return { today, cur, years, coverageStartYear: cov, cases, issues, accuracy: accuracy(), home };
}

export const counts = () => ({ issues: q1("SELECT COUNT(*) n FROM issues").n, cases: q1("SELECT COUNT(*) n FROM cases").n });
export function seedSummary() {
  return q("SELECT start_year y, type_id t, COUNT(*) n FROM cases WHERE source='과거이력' GROUP BY 1,2 ORDER BY 1,2");
}
// 아카이브 모듈(casefiles.mjs 등)이 같은 DB 연결을 쓰도록 내부 도우미를 내보낸다.
export const _db = { q, q1, run, tx, nowIso, isDate, kstNow };
// 시작 시 1회: 동기화 + 시드
syncSensing(true); seedPast();
