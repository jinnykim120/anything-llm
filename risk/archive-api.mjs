// 아카이브 API(데이터 기반, LLM·웹 호출 없음). api.mjs 가 /api/archive/*, /api/settings/* 를 여기로 넘긴다. 로그인 확인은 server.mjs 가 이미 했다.
//   GET  /api/archive/cases?year=&type=&bu=&status=&q=&sort=new|old     사건 목록(파일 수·의심 파일 수 포함)
//   POST /api/archive/cases                                              사건 폴더 만들기 {title,startDate(최초 민원 접수일),typeId,buId?,level?,summary?}
//   GET  /api/archive/cases/:id                                          사건 상세(사건·파일·카드·내장 이미지·단계·파일 종류)
//   POST /api/archive/cases/:id/files?name=&relPath=&kind=&stage=        파일 올리기(본문=원본 바이트, 한 번에 한 파일)
//   POST /api/archive/cases/:id/files/:fid                               파일 종류·단계·메모·'다른 사건 의심' 해제 {kind?,stage?,note?,suspectOtherCase:false?}
//   GET  /api/archive/cases/:id/files/:fid/download[?inline=1]           파일 내려받기
//   GET  /api/archive/cases/:id/zip[?evidence=1]                         사건 전체 zip(단계별 하위폴더 자동 생성) / evidence=1 이면 사건 카드가 인용한 파일만
//   GET  /api/archive/cases/:id/card                                     사건 카드(+확정 이력)
//   POST /api/archive/cases/:id/card/confirm   {password,name}           카드 확정(확정 비밀번호 + 확정자 이름)
//   POST /api/archive/cases/:id/card/reopen    {password,name,note?}     확정 취소(초안으로)
//   GET  /api/archive/cases/:id/analyze/plan                             AI 분석 확인창용 계획(파일 수·보관만·개인정보 의심·이미지 수·예상 비용). 복사·AI 호출 없음
//   POST /api/archive/cases/:id/analyze {images?:true, fresh?:false}      AI 분석 시작(작업 큐에 넣는다). 이미 결과가 있으면 fresh:true(새로 만들기)가 있어야 한다
//   GET  /api/archive/cases/:id/analysis                                 분석 진행 상태·이력(새로고침해도 이어서 조회)
//   POST /api/archive/cases/:id/analyze/resume | /analyze/cancel         일시중지·실패 분석 이어서 실행 / 취소
//   POST /api/archive/cases/:id/start-date {date}                        최초 민원 접수일 확정(폴더 이름의 시작연월도 맞춘다)
//   GET  /api/archive/import/config                                      서버 경로 가져오기 허용 경로
//   POST /api/archive/import/preview {path, mode?}                       서버 경로 미리보기(dry-run — 파일 복사 없음)
//   POST /api/archive/import/run {path, key, title?, ym?, action?}       후보 1건 가져오기(action: new | merge)
//   GET  /api/archive/cases/:id/embedded/:name/image                     문서 내장 이미지 미리보기
//   POST /api/archive/cases/:id/embedded/:name/link                      중복이 아닌 내장 이미지를 사건 자료로 연결(복사)
//   GET/POST /api/settings/confirm-password                              확정 비밀번호 상태 / 변경 {current,next} / 입장 비밀번호와 같게 되돌리기 {current,reset:true}
import { createReadStream } from "node:fs";
import { extname } from "node:path";
import * as S from "./store.mjs";
import * as CF from "./casefiles.mjs";
import { confirmPwInfo, setConfirmPassword, resetConfirmPassword } from "./confirmpw.mjs";
import * as A from "./analyze.mjs";
import * as I from "./importer.mjs";
import * as R from "./respond.mjs";
import * as NX from "./nexussync.mjs";
CF.hooks.onAdded = (caseId, fileId) => NX.enqueue(caseId, fileId);

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf" };
const INLINE_OK = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"]);   // 이미지·PDF 는 새 탭 미리보기(inline), 나머지는 내려받기
const dispo = (name, inline) => `${inline ? "inline" : "attachment"}; filename="download${extname(name).replace(/[^\w.]/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
const base = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export async function handleArchive(req, res, p, url, { body, json }) {
  const m = req.method, ip = req.socket.remoteAddress || "";
  const bodyJson = async () => { const t = await body(req); try { return t ? JSON.parse(t) : {}; } catch { throw new S.HttpError(400, "JSON 형식이 맞지 않습니다"); } };
  let mm;
  try {
    if (p === "/api/settings/confirm-password") {
      if (m === "GET") return json(res, 200, confirmPwInfo()), true;
      if (m === "POST") { const b = await bodyJson(); return json(res, 200, b.reset ? resetConfirmPassword(b.current, ip) : setConfirmPassword(b.current, b.next, ip)), true; }
      return false;
    }
    // ── 사건 대응(Incident Response)
    if (p.startsWith("/api/respond")) {
      if (p === "/api/respond/cases" && m === "GET") { json(res, 200, { cases: R.list(url.searchParams.get("status") || "진행") }); return true; }
      const rm = p.match(/^\/api\/respond\/cases\/(\d+)(\/.*)?$/); if (!rm) return false;
      const cid = Number(rm[1]), rs = rm[2] || "", sm = rs.match(/^\/steps\/([\w-]+)(\/suggest)?$/);
      if (!rs && m === "GET") { json(res, 200, R.detail(cid)); return true; }
      if (sm && !sm[2] && m === "POST") { json(res, 200, { step: R.saveStep(cid, sm[1], await bodyJson()) }); return true; }
      if (sm && sm[2] && m === "POST") { json(res, 200, { step: await R.suggest(cid, sm[1]) }); return true; }
      if (rs === "/summary/generate" && m === "POST") { json(res, 200, await R.makeSummary(cid)); return true; }
      if (rs === "/summary" && m === "POST") { json(res, 200, R.saveSummary(cid, await bodyJson())); return true; }
      if (rs === "/summary/confirm" && m === "POST") { json(res, 200, R.confirmClose(cid, await bodyJson(), ip)); return true; }
      if (rs === "/report.docx" && m === "GET") { const b = R.buildDocx(cid); res.writeHead(200, { ...base, "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-length": b.length, "content-disposition": dispo(R.reportName(cid) + ".docx", false) }); res.end(b); return true; }
      if (rs === "/report.pdf" && m === "GET") { const b = await R.buildPdf(cid); res.writeHead(200, { ...base, "content-type": "application/pdf", "content-length": b.length, "content-disposition": dispo(R.reportName(cid) + ".pdf", false) }); res.end(b); return true; }
      return false;
    }
    if (p === "/api/archive/import/config" && m === "GET") { const c = I.importConfig(); json(res, 200, { roots: c.roots, fromEnv: c.fromEnv, limits: c.limits }); return true; }
    if (p === "/api/archive/import/preview" && m === "POST") { json(res, 200, I.preview(await bodyJson())); return true; }
    if (p === "/api/archive/import/run" && m === "POST") { json(res, 200, await I.importOne(await bodyJson())); return true; }
    // 브라우저에서 폴더를 직접 고른 경우: 폴더 이름 → 제목·시작연월 미리보기, 빠른 사건 생성(유형·사업부문 미지정, AI 호출 없음)
    if (p === "/api/archive/parse-name" && m === "POST") { const b = await bodyJson(); json(res, 200, I.parseFolderName(String(b.name || ""), null)); return true; }
    if (p === "/api/archive/cases/quick" && m === "POST") {
      const b = await bodyJson(), ym = /^\d{4}-\d{2}$/.test(b.ym || "") ? b.ym : null;
      const c = S.createImportedCase({ title: b.title, ym, year: Number(b.year) || Number(S.todayKst().slice(0, 4)) }); if (b.closed) S.setCaseStatus(c.id, "종결"); CF.ensureCaseDir(c.id); CF.writeManifest(c.id);
      json(res, 200, CF.caseDetail(c.id)); return true;
    }
    if (p === "/api/archive/cases" && m === "GET") { json(res, 200, { cases: CF.listArchive(Object.fromEntries(url.searchParams)), today: S.todayKst() }); return true; }
    if (p === "/api/archive/cases" && m === "POST") {
      const c = S.createCase(await bodyJson()); CF.ensureCaseDir(c.id); CF.writeManifest(c.id);
      json(res, 200, CF.caseDetail(c.id)); return true;
    }
    if (!(mm = p.match(/^\/api\/archive\/cases\/(\d+)(\/.*)?$/))) return false;
    const id = Number(mm[1]), sub = mm[2] || "";
    if (!sub && m === "GET") { json(res, 200, CF.caseDetail(id)); return true; }
    if (sub === "/files" && m === "POST") {
      const q = url.searchParams, r = await CF.saveUpload(id, req, { name: q.get("name") || "파일", relPath: q.get("relPath"), kind: q.get("kind") || "case-doc", stage: q.get("stage") || null, note: q.get("note") });
      json(res, 200, r); return true;
    }
    let f;
    if ((f = sub.match(/^\/files\/(\d+)$/)) && m === "POST") { json(res, 200, { file: CF.updateFile(id, Number(f[1]), await bodyJson()) }); return true; }
    if ((f = sub.match(/^\/files\/(\d+)\/download$/)) && m === "GET") {
      const { abs, name, size } = CF.filePath(id, Number(f[1])), ext = extname(name).toLowerCase(), inline = url.searchParams.has("inline") && INLINE_OK.has(ext);
      res.writeHead(200, { ...base, "content-type": inline ? MIME[ext] : "application/octet-stream", "content-length": size, "content-disposition": dispo(name, inline) });
      createReadStream(abs).pipe(res); return true;
    }
    if (sub === "/nexus-sync" && m === "POST") { S.getCase(id); json(res, 200, NX.syncCase(id)); return true; }
    if (sub === "/status" && m === "POST") { const st = String((await bodyJson()).status || ""); S.setCaseStatus(id, st); CF.writeManifest(id); json(res, 200, CF.caseDetail(id)); return true; }
    if (sub === "/zip" && m === "GET") {
      const z = CF.buildZip(id, url.searchParams.has("evidence") ? { onlyIds: CF.evidenceFileIds(id) } : {}), len = z.parts.reduce((n, b) => n + b.length, 0);
      res.writeHead(200, { ...base, "content-type": "application/zip", "content-length": len, "content-disposition": dispo(z.name, false) });
      for (const b of z.parts) res.write(b); res.end(); return true;
    }
    if (sub === "/card" && m === "GET") { const cd = CF.getCard(id); json(res, 200, { ...cd, card: cd.card ? CF.enrichSources(cd.card, CF.listFiles(id), CF.listEmbedded(id)) : null }); return true; }
    if (sub === "/card/confirm" && m === "POST") { json(res, 200, CF.confirmCard(id, await bodyJson(), ip)); return true; }
    if (sub === "/card/reopen" && m === "POST") { json(res, 200, CF.reopenCard(id, await bodyJson(), ip)); return true; }
    if (sub === "/analyze/plan" && m === "GET") { S.getCase(id); json(res, 200, await A.plan(id)); return true; }
    if (sub === "/analyze" && m === "POST") { S.getCase(id); const b = await bodyJson(); json(res, 200, { run: await A.createRun(id, { images: b.images !== false, fresh: !!b.fresh }) }); return true; }
    if (sub === "/analysis" && m === "GET") { S.getCase(id); json(res, 200, A.state(id)); return true; }
    if (sub === "/analyze/resume" && m === "POST") { S.getCase(id); json(res, 200, { run: A.resumeRun(id) }); return true; }
    if (sub === "/analyze/cancel" && m === "POST") { S.getCase(id); json(res, 200, { run: A.cancelRun(id) }); return true; }
    if (sub === "/start-date" && m === "POST") {
      if (A.activeRun(id)) throw new S.HttpError(409, "AI 분석이 진행 중이라 지금은 바꿀 수 없습니다");
      json(res, 200, { case: CF.setStartDate(id, String((await bodyJson()).date || "")) }); return true;
    }
    if ((f = sub.match(/^\/embedded\/([^/]+)\/image$/)) && m === "GET") {
      const abs = CF.embeddedImagePath(id, decodeURIComponent(f[1])), ext = extname(abs).toLowerCase();
      res.writeHead(200, { ...base, "content-type": MIME[ext] || "application/octet-stream", "content-disposition": "inline" }); createReadStream(abs).pipe(res); return true;
    }
    if ((f = sub.match(/^\/embedded\/([^/]+)\/link$/)) && m === "POST") { json(res, 200, { file: CF.linkEmbedded(id, decodeURIComponent(f[1])) }); return true; }
    return false;
  } catch (e) {
    if (e instanceof S.HttpError) { json(res, e.code, { error: e.message, ...(e.extra || {}) }); return true; }
    throw e;
  }
}
