// 사건 삭제(잘못 올라온 사건 정리). 되돌릴 수 있게 만든다:
//   · 지우기 직전에 DB 를 통째로 백업한다(data/risk.db.bak-delete-<시각>).
//   · 이 PC 의 사건 폴더는 영구 삭제하지 않고 data/.trash/<시각>_<폴더>/ 로 옮긴다.
//   · 센싱에서 사건화한 사건이면 그 이슈를 '센싱됨'으로 되돌려 센싱 목록에 다시 나타나게 한다.
//   · Mac NEXUS 에 올려 둔 파일은 가능하면 함께 지운다(Mac 이 꺼져 있으면 건너뛰고 알려 준다. Mac 의 빈 하위 폴더는 API 로 못 지운다).
import { existsSync, mkdirSync, renameSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";
import * as S from "./store.mjs";
import * as CF from "./casefiles.mjs";
import * as A from "./analyze.mjs";
import * as N from "./nexus.mjs";

const { q, q1, run, tx, nowIso } = S._db;
const CASE_TABLES = ["case_files", "case_embedded", "case_confirms", "analysis_runs", "case_imports", "response_steps", "response_suggestions", "response_summary"];

export async function deleteCase(id, { confirm } = {}) {
  const c = S.getCase(id);
  if (confirm !== "삭제") throw new S.HttpError(400, "삭제하려면 확인 입력('삭제')이 필요합니다");
  if (c.source === "과거이력") throw new S.HttpError(409, "과거 이력으로 불러온 사건은 삭제할 수 없습니다");
  if (A.activeRun(id)) throw new S.HttpError(409, "AI 분석이 진행 중이라 지금은 삭제할 수 없습니다");
  const files = q("SELECT nexus_loc FROM case_files WHERE case_id=?", id), locs = files.filter((f) => f.nexus_loc).map((f) => f.nexus_loc);
  const { dir } = CF.ensureCaseDir(id), ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backup = `risk.db.bak-delete-${ts}-case${id}`;
  const bpath = join(S.DATA, backup).split(String.fromCharCode(92)).join("/").split("'").join("''");
  run("VACUUM INTO '" + bpath + "'");
  tx(() => {
    for (const t of CASE_TABLES) { try { run(`DELETE FROM ${t} WHERE case_id=?`, id); } catch { /* 테이블이 없으면(아직 안 쓴 기능) 건너뜀 */ } }
    run("UPDATE issues SET state='센싱됨', case_id=NULL WHERE case_id=?", id);
    run("DELETE FROM cases WHERE id=?", id);
  });
  let trash = null;
  if (existsSync(dir)) { mkdirSync(join(S.DATA, ".trash"), { recursive: true }); trash = `${ts}_${basename(dir)}`; renameSync(dir, join(S.DATA, ".trash", trash)); }
  const mac = { removed: 0, failed: 0, skipped: 0 };
  if (locs.length) { if (!N.configured()) mac.skipped = locs.length; else { try { await N.removeCaseDocs(locs); mac.removed = locs.length; } catch { mac.failed = locs.length; } } }
  try { mkdirSync(join(S.DATA, "..", "logs"), { recursive: true }); appendFileSync(join(S.DATA, "..", "logs", "deleted-cases.log"), `${new Date().toISOString()} case#${id} "${c.title}" files=${files.length} backup=${backup} trash=${trash || "-"} mac=${JSON.stringify(mac)}\n`); } catch { /* 기록 실패는 무시 */ }
  return { deleted: true, title: c.title, files: files.length, backup, trash, mac };
}
