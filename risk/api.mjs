// 리스크 시스템 API(데이터 기반, LLM·웹 호출 없음). server.mjs 가 로그인 확인 뒤에 호출한다.
//   GET  /api/config                 분류 체계(유형·사업부문·단계·위험도·보류 사유 제안)
//   GET  /api/issues                 센싱 이슈 + 분류 상태(센싱됨/보류/사건화)
//   GET  /api/issues/states          {이슈id: {state, holdReason, caseId}}  (센싱 페이지 버튼 표시용)
//   POST /api/issues/:id/classify    담당자가 유형·사업부문 선택(출처=manual) {typeId?, buId?}  buId ""/null = 미지정
//   POST /api/issues/:id/promote     사건화  {typeId(필수), buId, tags[], level, title, typeConfirmed}  유형이 AI 제안 상태면 typeConfirmed:true 필요(없으면 409)
//   POST /api/issues/:id/hold        보류    {reason(필수)}
//   POST /api/issues/:id/restore     보류 → 센싱됨
//   GET  /api/cases?status=&year=&type=&bu=&source=&q=
//   POST /api/cases                  수동 입력 {title, startDate, typeId, buId, tags[], level, summary}
//   POST /api/cases/:id/close        종결 {endDate(기본 오늘)}
//   POST /api/cases/:id/classify     사건 유형·부 유형·사업부문 변경(출처=manual) {typeId?, tags?, buId?}
//   GET  /api/stats?year=&type=&bu=  통계·깔때기·KPI (sensingType: AI 제안 미확인·분류 보류 건수)
//   GET  /api/dashboard  대시보드·대문용 원본 행(사건·센싱 이슈) + 연도 목록(동적) + 일치율 + 대문 요약. 집계·연도 다중 선택은 클라이언트가 한다
//   GET  /api/accuracy              AI 유형 제안 일치율(전체/AI 제안 유형별) + 확인 대기 건수
import * as S from "./store.mjs";
import { handleArchive } from "./archive-api.mjs";

export async function handleApi(req, res, p, url, { body, json }) {
  if (!p.startsWith("/api/")) return false;
  if (p.startsWith("/api/archive/") || p === "/api/archive" || p.startsWith("/api/settings/")) return handleArchive(req, res, p, url, { body, json });
  const m = req.method;
  const bodyJson = async () => { const t = await body(req); try { return t ? JSON.parse(t) : {}; } catch { throw new S.HttpError(400, "JSON 형식이 맞지 않습니다"); } };
  let r, mm;
  try {
    if (p === "/api/config" && m === "GET") r = S.publicConfig();
    else if (p === "/api/issues" && m === "GET") r = { issues: S.listIssues(), today: S.todayKst() };
    else if (p === "/api/issues/states" && m === "GET") r = S.issueStates();
    else if ((mm = p.match(/^\/api\/issues\/([0-9a-f]+)\/(promote|hold|restore|classify)$/)) && m === "POST") {
      const [, id, act] = mm;
      if (act === "classify") r = { issue: S.classifyIssue(id, await bodyJson()) };
      else if (act === "promote") r = { case: S.promoteIssue(id, await bodyJson()) };
      else if (act === "hold") r = { issue: S.holdIssue(id, (await bodyJson()).reason) };
      else r = { issue: S.restoreIssue(id) };
    }
    else if (p === "/api/cases" && m === "GET") r = { cases: S.listCases(Object.fromEntries(url.searchParams)) };
    else if (p === "/api/cases" && m === "POST") r = { case: S.createCase(await bodyJson()) };
    else if ((mm = p.match(/^\/api\/cases\/(\d+)\/close$/)) && m === "POST") r = { case: S.closeCase(Number(mm[1]), (await bodyJson()).endDate) };
    else if ((mm = p.match(/^\/api\/cases\/(\d+)\/classify$/)) && m === "POST") r = { case: S.classifyCase(Number(mm[1]), await bodyJson()) };
    else if (p === "/api/accuracy" && m === "GET") r = S.accuracy();
    else if (p === "/api/stats" && m === "GET") r = S.stats({ year: url.searchParams.get("year"), type: url.searchParams.get("type"), bu: url.searchParams.get("bu") });
    else if (p === "/api/dashboard" && m === "GET") r = S.dashboard();
    else return false;
    json(res, 200, r);
  } catch (e) {
    if (e instanceof S.HttpError) json(res, e.code, { error: e.message });
    else throw e;
  }
  return true;
}
