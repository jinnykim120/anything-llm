// 사건 원본을 Mac NEXUS 의 잠금 폴더(리스크관리/<사건 폴더>/)에도 올리고, Mac 이 파싱한 본문을 이 PC 에 캐시한다.
//   · 원본은 양쪽에 둔다(이 PC 의 data/cases 는 그대로). Mac 이 꺼져 있거나 실패하면 PC 저장은 그대로 두고 상태만 '실패'로 남긴다.
//   · 새로 올린 파일은 자동으로 줄을 선다(순서대로 한 개씩). 이미 있는 파일은 사건 화면의 버튼으로 올린다(자동 일괄 업로드 없음).
//   · Mac 이 파싱한 본문은 <사건 폴더>/.nexus/<sha256>.txt 에 저장해 AI 분석이 쓴다(PDF 처럼 이 PC 에 파서가 없는 형식을 대신 읽는다).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as S from "./store.mjs";
import * as CF from "./casefiles.mjs";
import * as N from "./nexus.mjs";

const { q, q1, run, nowIso } = S._db;
const MAX_BYTES = 80 * 1024 * 1024;
const queue = []; let working = false;
export const enabled = () => N.configured() && !!N.caseFolder();
const msg = (e) => String(e?.message || e).replace(/\s+/g, " ").slice(0, 200);
const MIME = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", txt: "text/plain", md: "text/markdown", csv: "text/csv", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

export function enqueue(caseId, fileId) { if (!enabled()) return; queue.push({ caseId, fileId }); kick(); }
async function kick() {
  if (working) return; working = true;
  try { while (queue.length) { const j = queue.shift(); await pushOne(j).catch(() => {}); } } finally { working = false; }
}
async function pushOne({ caseId, fileId }) {
  const f = q1("SELECT * FROM case_files WHERE id=? AND case_id=?", fileId, caseId);
  if (!f || f.kind === "ignore" || f.nexus_state === "ok") return;
  const fail = (e) => run("UPDATE case_files SET nexus_state='failed', nexus_err=?, nexus_at=? WHERE id=?", msg(e), nowIso(), fileId);
  try {
    const { dir } = CF.ensureCaseDir(caseId), abs = join(dir, "원본", ...f.rel_path.split("/"));
    if (!existsSync(abs)) throw new Error("PC 에 파일이 없습니다");
    const buf = readFileSync(abs); if (buf.length > MAX_BYTES) throw new Error("파일이 너무 큽니다(80MB 초과)");
    const ext = f.name.split(".").pop().toLowerCase();
    const up = await N.uploadCaseDoc(f.rel_path.replace(/\//g, "__"), buf, { sub: S.getCase(caseId).folderName, mime: MIME[ext] || "application/octet-stream" });
    if (up.text.trim()) { mkdirSync(join(dir, ".nexus"), { recursive: true }); writeFileSync(join(dir, ".nexus", `${f.sha256}.txt`), up.text); }
    run("UPDATE case_files SET nexus_state='ok', nexus_loc=?, nexus_err=NULL, nexus_at=? WHERE id=?", up.location, nowIso(), fileId);
  } catch (e) { fail(e); }
}

// 사건의 아직 못 올린 파일(없음·실패)을 줄 세운다. 올리는 중이거나 이미 올린 파일은 건너뛴다.
export function syncCase(caseId) {
  if (!enabled()) throw new S.HttpError(409, "Mac NEXUS 연결 설정(config/nexus.json, secrets/)이 없습니다");
  const rows = q("SELECT id FROM case_files WHERE case_id=? AND kind!='ignore' AND (nexus_state IS NULL OR nexus_state!='ok')", caseId);
  const inQ = new Set(queue.map((j) => j.fileId)); let n = 0;
  for (const r of rows) if (!inQ.has(r.id)) { queue.push({ caseId, fileId: r.id }); n++; }
  kick(); return { queued: n };
}
export const queueLength = () => queue.length + (working ? 1 : 0);

// Mac 이 파싱한 본문 캐시(없으면 null)
export function parsedText(dir, sha256) { const p = join(dir, ".nexus", `${sha256}.txt`); return existsSync(p) ? readFileSync(p, "utf8") : null; }
