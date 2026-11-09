// 사건 대응(Incident Response): 단계별 진행 기록 · AI 제안(버튼으로만) · 종결 요약(Word/PDF).
//   · 진행 기록: 사건×단계마다 상태·담당자·일자·메모. 사람이 입력한 값만 저장한다.
//   · 제안 받기: 단계 버튼을 눌렀을 때만 AI 호출. 각 제안에 출처를 붙인다(당사 과거사건=확인됨 / AI 일반 제안=근거 미확인).
//   · 종결: 요약 초안(AI) → 담당자가 고침 → 확정(확정 비밀번호+이름) → 사건 종결·아카이브 보관, Word/PDF 내려받기.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { deflateRawSync, crc32 } from "node:zlib";
import * as S from "./store.mjs";
import * as CF from "./casefiles.mjs";
import * as A from "./analyze.mjs";
import { verifyConfirm } from "./confirmpw.mjs";

const { q, q1, run, tx, nowIso } = S._db, HttpError = S.HttpError;
run(`CREATE TABLE IF NOT EXISTS response_steps (case_id INTEGER NOT NULL, stage_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT '미착수', owner TEXT, step_date TEXT, note TEXT, updated_at TEXT, PRIMARY KEY (case_id, stage_id))`);
run(`CREATE TABLE IF NOT EXISTS response_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL, stage_id TEXT NOT NULL, items_json TEXT NOT NULL, cost_usd REAL, at TEXT)`);
run(`CREATE TABLE IF NOT EXISTS response_summary (case_id INTEGER PRIMARY KEY, summary_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT '초안', by_name TEXT, confirmed_at TEXT, updated_at TEXT)`);

const STATES = ["미착수", "진행", "완료"];
const stages = () => S.config().caseStages;
const stageOf = (id) => { const s = stages().find((x) => x.id === id); if (!s) throw new HttpError(400, "알 수 없는 단계입니다"); return s; };
const clip = (s, n) => String(s ?? "").slice(0, n);

// ── 목록: 진행 중 사건(기본) / 종결 사건
export function list(status = "진행") {
  const rows = q("SELECT id,title,level,type_id,bu_id,status,stage_id,start_date,start_year,date_known FROM cases WHERE source!='과거이력' AND status=? ORDER BY COALESCE(start_date, start_year||'-01-01') DESC", status === "종결" ? "종결" : "진행");
  return rows.map((c) => {
    const st = q("SELECT stage_id,state FROM response_steps WHERE case_id=?", c.id), done = st.filter((x) => x.state === "완료").length;
    return { id: c.id, title: c.title, folderName: S.caseFolderName({ title: c.title, startDate: c.start_date, startYear: c.start_year }), level: c.level, typeId: c.type_id, buId: c.bu_id, status: c.status, startDate: c.start_date, startYear: c.start_year, dateKnown: !!c.date_known, doneStages: done, totalStages: stages().length, activeStage: st.find((x) => x.state === "진행")?.stage_id || null };
  });
}

// ── 한 사건의 대응 화면 데이터
export function detail(caseId) {
  const c = S.getCase(caseId), files = CF.listFiles(caseId).filter((f) => f.kind !== "ignore");
  const steps = stages().map((s) => {
    const r = q1("SELECT * FROM response_steps WHERE case_id=? AND stage_id=?", caseId, s.id) || {};
    const sg = q1("SELECT id,items_json,cost_usd,at FROM response_suggestions WHERE case_id=? AND stage_id=? ORDER BY id DESC LIMIT 1", caseId, s.id);
    return { id: s.id, name: s.name, desc: s.desc, state: r.state || "미착수", owner: r.owner || "", date: r.step_date || "", note: r.note || "", updatedAt: r.updated_at || null,
      files: files.filter((f) => f.stage === s.id).map((f) => ({ id: f.id, name: f.name, size: f.size })),
      suggestion: sg ? { id: sg.id, items: JSON.parse(sg.items_json), cost: sg.cost_usd, at: sg.at } : null };
  });
  const sm = q1("SELECT summary_json,status,by_name,confirmed_at,updated_at FROM response_summary WHERE case_id=?", caseId);
  const card = CF.getCard(caseId);
  return { case: { id: c.id, title: c.title, status: c.status, level: c.level, typeId: c.typeId, buId: c.buId, startDate: c.startDate, startYear: c.startYear, endDate: c.endDate || null, folderName: c.folderName, summary: c.summary || "" },
    hasCard: !!card.card, cardStatus: card.status, steps, summary: sm ? { ...JSON.parse(sm.summary_json), status: sm.status, by: sm.by_name, confirmedAt: sm.confirmed_at, updatedAt: sm.updated_at } : null };
}

export function saveStep(caseId, stageId, b = {}) {
  S.getCase(caseId); stageOf(stageId);
  const state = STATES.includes(b.state) ? b.state : "미착수", date = b.date ? (S._db.isDate(b.date) ? b.date : (() => { throw new HttpError(400, "일자는 YYYY-MM-DD 형식입니다"); })()) : null;
  run(`INSERT INTO response_steps (case_id,stage_id,state,owner,step_date,note,updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(case_id,stage_id) DO UPDATE SET state=excluded.state, owner=excluded.owner, step_date=excluded.step_date, note=excluded.note, updated_at=excluded.updated_at`,
    caseId, stageId, state, clip(b.owner, 40) || null, date, clip(b.note, 8000) || null, nowIso());
  if (state === "진행") run("UPDATE cases SET stage_id=?, updated_at=? WHERE id=? AND status!='종결'", stageId, nowIso(), caseId);
  return detail(caseId).steps.find((s) => s.id === stageId);
}

// ── 같은 유형의 과거·종결 사건(제안의 근거 후보)
function similar(c, limit = 3) {
  const rows = c.typeId ? q("SELECT id,title,summary,card_json,start_year FROM cases WHERE id!=? AND type_id=? AND (card_json IS NOT NULL OR summary IS NOT NULL) ORDER BY (card_json IS NOT NULL) DESC, (status='종결') DESC, start_year DESC LIMIT ?", c.id, c.typeId, limit) : [];
  return rows.map((r) => ({ id: r.id, title: r.title, year: r.start_year, text: clip(r.card_json ? r.card_json : r.summary, 900) }));
}

const SUGGEST_SYS = `당신은 기업 리스크 대응 담당자를 돕는 보조자입니다. 지정한 대응 단계에서 담당자가 검토할 만한 조치를 3~5개 제안합니다.
규칙:
- 입력에 없는 사실(날짜·금액·인물·조문 번호)을 만들지 않습니다. 법령·조문은 이름이나 번호를 단정하지 말고 "확인 필요"로 적습니다.
- 제안마다 basis 를 정합니다. 아래 '과거 사건' 목록의 내용에서 가져온 제안이면 basis="past" 와 caseId(목록의 id)를 적고, 그렇지 않은 일반 제안이면 basis="general" 입니다. 목록에 없는 id 를 쓰지 않습니다.
- 각 제안은 text(한두 문장, 무엇을 할지), why(이유 한 줄)로 씁니다. 한국어.
- 출력은 JSON 하나만: {"items":[{"text":"","why":"","basis":"past|general","caseId":null}]}`;

export async function suggest(caseId, stageId) {
  const c = S.getCase(caseId), st = stageOf(stageId), d = detail(caseId), sim = similar(c);
  const card = CF.getCard(caseId).card;
  const done = d.steps.filter((s) => s.note).map((s) => `- ${s.name}(${s.state}): ${clip(s.note, 600)}`).join("\n") || "(아직 기록 없음)";
  const user = `[사건] ${c.title}\n유형: ${c.typeId ? S.config().issueTypes.find((t) => t.id === c.typeId)?.name || c.typeId : "미분류"} / 위험도: ${c.level || "미지정"}\n[사건 카드]\n${card ? clip(JSON.stringify(card), 5000) : "(카드 없음)"}\n[지금까지 대응 기록]\n${done}\n[제안을 받을 단계] ${st.name} — ${st.desc}\n[과거 사건(같은 유형)]\n${sim.length ? sim.map((s) => `#${s.id} ${s.title} (${s.year}년)\n${s.text}`).join("\n\n") : "(없음)"}`;
  const { result, cost } = await A.askClaude({ system: SUGGEST_SYS, user, timeoutMs: 180000 });
  const raw = A.lastJson(result, (o) => Array.isArray(o.items)), ok = new Set(sim.map((s) => s.id));
  const items = raw.items.slice(0, 6).map((i) => {
    const past = i.basis === "past" && ok.has(Number(i.caseId)), pc = past ? sim.find((s) => s.id === Number(i.caseId)) : null;
    return { text: clip(i.text, 400), why: clip(i.why, 300), trust: past ? "past" : "general", caseId: past ? pc.id : null, caseTitle: past ? pc.title : null };
  }).filter((i) => i.text);
  run("INSERT INTO response_suggestions (case_id,stage_id,items_json,cost_usd,at) VALUES (?,?,?,?,?)", caseId, stageId, JSON.stringify(items), cost, nowIso());
  return detail(caseId).steps.find((s) => s.id === stageId);
}

// ── 종결 요약
const SUMMARY_SYS = `당신은 기업 리스크 사건의 보고서(종결 보고 또는 진행 중 현황 보고)를 정리합니다. 입력의 사건 카드와 단계별 대응 기록만 근거로 씁니다.
규칙:
- 기록에 없는 내용은 만들지 않습니다. 한국어, 존댓말 없이 개조식(~함/~임)으로 간결하게 씁니다.
- 위험도·진행/종결 상태·담당자·단계 상태(완료/진행)는 보고서 표와 경과 표에 따로 있으므로 문장에 쓰지 않습니다.
- "기록 없음"은 그 항목에 쓸 근거가 전혀 없을 때만 한 번 씁니다. 일부만 비어 있으면 있는 내용만 쓰고, 빈 부분을 일일이 나열하지 않습니다.
- actions, prevention, lessons 는 한 줄에 한 항목씩 줄바꿈(\n)으로 나누고 각 줄은 "- "로 시작합니다. 항목은 한 문장이며 최대 6개입니다.
출력은 JSON 하나만: {"overview":"사건 개요: 무슨 일이, 언제, 어떤 규모로, 원인이 무엇인지 3~4문장","timeline":[{"stage":"단계명","text":"그 단계에서 한 일(날짜·사실 중심) 1~2문장"}],"actions":"주요 대응 내용","prevention":"원인과 재발방지","lessons":"다음 대응에 쓸 시사점"}
timeline 은 입력에 기록이 있는 단계만 넣습니다.`;

const OPEN_RULE = "\n- 이 사건은 아직 진행 중입니다. 결과·종결을 단정하지 말고 현재까지의 사실과 대응만 쓰며, lessons 에는 남은 과제와 다음 대응을 씁니다.";
export async function makeSummary(caseId) {
  const c = S.getCase(caseId); if (c.status === "종결" && q1("SELECT status FROM response_summary WHERE case_id=?", caseId)?.status === "확정") throw new HttpError(409, "이미 확정된 종결 요약입니다");
  const d = detail(caseId), card = CF.getCard(caseId).card;
  if (!card && !d.steps.some((x) => x.note)) throw new HttpError(409, "요약할 자료가 없습니다. 사건 카드(Archive 의 AI 분석)나 단계별 기록이 있어야 만들 수 있습니다");
  const rec = d.steps.filter((s) => s.note || s.owner || s.state !== "미착수").map((s) => `[${s.name}] 상태:${s.state} 담당:${s.owner || "-"} 일자:${s.date || "-"}\n${s.note || "(메모 없음)"}`).join("\n\n") || "(대응 기록 없음)";
  const user = `[사건] ${c.title}\n시작일: ${c.startDate || c.startYear + "년"} / 위험도: ${c.level || "미지정"}\n[사건 카드]\n${card ? clip(JSON.stringify(card), 6000) : "(카드 없음)"}\n[단계별 대응 기록]\n${rec}`;
  const { result, cost } = await A.askClaude({ system: SUMMARY_SYS + (c.status === "종결" ? "" : OPEN_RULE), user, timeoutMs: 240000 });
  const o = A.lastJson(result, (x) => typeof x.overview === "string");
  const sum = { overview: clip(o.overview, 3000), timeline: (o.timeline || []).slice(0, 8).map((t) => ({ stage: clip(t.stage, 40), text: clip(t.text, 1500) })), actions: clip(o.actions, 3000), prevention: clip(o.prevention, 3000), lessons: clip(o.lessons, 3000), cost };
  run(`INSERT INTO response_summary (case_id,summary_json,status,updated_at) VALUES (?,?, '초안', ?) ON CONFLICT(case_id) DO UPDATE SET summary_json=excluded.summary_json, status='초안', by_name=NULL, confirmed_at=NULL, updated_at=excluded.updated_at`, caseId, JSON.stringify(sum), nowIso());
  return detail(caseId);
}
export function saveSummary(caseId, b = {}) {
  const cur = q1("SELECT status,summary_json FROM response_summary WHERE case_id=?", caseId); if (!cur) throw new HttpError(404, "종결 요약 초안이 없습니다");
  if (cur.status === "확정") throw new HttpError(409, "확정된 요약은 고칠 수 없습니다");
  const old = JSON.parse(cur.summary_json), s = { overview: clip(b.overview, 3000), actions: clip(b.actions, 3000), prevention: clip(b.prevention, 3000), lessons: clip(b.lessons, 3000), cost: old.cost,
    timeline: (Array.isArray(b.timeline) ? b.timeline : old.timeline).slice(0, 8).map((t) => ({ stage: clip(t.stage, 40), text: clip(t.text, 1500) })) };
  run("UPDATE response_summary SET summary_json=?, updated_at=? WHERE case_id=?", JSON.stringify(s), nowIso(), caseId);
  return detail(caseId);
}
export function confirmClose(caseId, { password, name } = {}, ip = "") {
  const cur = q1("SELECT status FROM response_summary WHERE case_id=?", caseId); if (!cur) throw new HttpError(409, "종결 요약을 먼저 만드세요");
  if (cur.status === "확정") throw new HttpError(409, "이미 확정되었습니다");
  const by = String(name || "").trim(); if (by.length < 2) throw new HttpError(400, "확정자 이름을 입력하세요"); verifyConfirm(password, ip);
  tx(() => {
    run("UPDATE response_summary SET status='확정', by_name=?, confirmed_at=?, updated_at=? WHERE case_id=?", by.slice(0, 40), nowIso(), nowIso(), caseId);
    run("INSERT INTO case_confirms (case_id,action,by_name,at,note) VALUES (?,?,?,?,?)", caseId, "종결 확정", by.slice(0, 40), nowIso(), "사건 대응 종결 요약");
    for (const st of stages()) run(`INSERT INTO response_steps (case_id,stage_id,state,updated_at) VALUES (?,?, '완료', ?) ON CONFLICT(case_id,stage_id) DO UPDATE SET state='완료', updated_at=excluded.updated_at`, caseId, st.id, nowIso());
  });
  if (S.getCase(caseId).status !== "종결") S.closeCase(caseId, S.todayKst());
  CF.writeManifest(caseId);
  return detail(caseId);
}

// ── Word(.docx) 직접 생성(외부 라이브러리 없음) + PDF 변환(LibreOffice)
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const run_ = (t, o = "") => `<w:r><w:rPr>${o}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (t, { style, bold, size, color, after } = {}) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}<w:spacing w:after="${after ?? 100}"/></w:pPr>${String(t ?? "").split("\n").map((ln, i) => (i ? "<w:r><w:br/></w:r>" : "") + run_(ln, `${bold ? "<w:b/>" : ""}${size ? `<w:sz w:val="${size}"/>` : ""}${color ? `<w:color w:val="${color}"/>` : ""}`)).join("")}</w:p>`;
const cell = (t, w, shade, bold) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ""}</w:tcPr>${para(t, { bold, after: 40 })}</w:tc>`;
const tbl = (rows, widths, headShade) => `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((b) => `<w:${b} w:val="single" w:sz="4" w:color="BFC8D8"/>`).join("")}</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>${rows.map((r, ri) => `<w:tr>${r.map((t, i) => cell(t, widths[i], headShade && ri === 0 ? "EAF0FB" : (!headShade && i === 0 ? "F3F6FB" : null), (headShade && ri === 0) || (!headShade && i === 0))).join("")}</w:tr>`).join("")}</w:tbl>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="Malgun Gothic" w:cs="Malgun Gothic"/><w:sz w:val="21"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:color w:val="1D4FC7"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="100"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="2F6DF6"/></w:pBdr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="13203A"/></w:rPr></w:style></w:styles>`;
function zipParts(files) {
  const local = [], central = []; let off = 0; const d = new Date(), t = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const [path, str] of files) {
    const data = Buffer.from(str, "utf8"), comp = deflateRawSync(data), nm = Buffer.from(path), crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(t, 10); lh.writeUInt16LE(dt, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(t, 12); ch.writeUInt16LE(dt, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    local.push(lh, nm, comp); central.push(ch, nm); off += lh.length + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, end]);
}
// 보고서 내용(Word·HTML 공통). 근거 자료·출처는 넣지 않는다(결론 내용만).
export function reportModel(caseId) {
  const d = detail(caseId), c = d.case, s = d.summary; if (!s) throw new HttpError(404, "종합 요약이 없습니다");
  const cfg = S.config(), closed = c.status === "종결";
  const tn = cfg.issueTypes.find((t) => t.id === c.typeId)?.name || "미분류", bn = cfg.businessUnits.find((x) => x.id === c.buId)?.name || "미지정";
  const period = `${c.startDate || (c.startYear ? c.startYear + "년" : "-")} ~ ${c.endDate || (closed ? "종료일 미기록" : "진행 중")}`;
  const state = closed ? (s.status === "확정" ? `종결 · 확정 (${s.by || "-"}, ${(s.confirmedAt || "").slice(0, 10)})` : "종결") : "진행 중 · 현황 보고";
  const title = closed ? "사건 종결 보고서" : "사건 현황 보고서";
  return { title, caseTitle: c.title, meta: [["기간", period], ["리스크 유형", tn], ["사업부문", bn], ["위험도", c.level || "미지정"], ["상태", state]],
    sections: [["1. 사건 개요", s.overview, "text"], ["2. 대응 경과", s.timeline, "table"], ["3. 주요 대응 내용", s.actions, "text"], ["4. 원인 및 재발방지", s.prevention, "text"], [closed ? "5. 시사점" : "5. 남은 과제·시사점", s.lessons, "text"]],
    footer: `작성: NEXUS Risk Monitor · ${S.todayKst()}${closed && s.status === "확정" ? "" : " · AI 초안, 담당자 검토 필요"}` };
}
// 줄마다 "- "로 시작하는 내용은 글머리표(•)와 내어쓰기로, 아니면 일반 문단으로 쓴다.
const bulletParas = (t) => {
  const lines = String(t || "").split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return para("기록 없음");
  if (lines.every((l) => l.startsWith("- "))) return lines.map((l) => '<w:p><w:pPr><w:ind w:left="360" w:hanging="260"/><w:spacing w:after="60"/></w:pPr>' + run_("•  " + l.slice(2).trim()) + "</w:p>").join("");
  return para(t);
};
export function buildDocx(caseId) {
  const m = reportModel(caseId);
  const body = [para(m.title, { style: "Title" }), para(m.caseTitle, { bold: true, size: 26, after: 160 }), tbl(m.meta, [2000, 7000], false),
    ...m.sections.flatMap(([h, v, kind]) => [para(h, { style: "Heading1" }), kind === "table" ? (v?.length ? tbl([["단계", "내용"], ...v.map((t) => [t.stage, t.text])], [2200, 6800], true) : para("기록 없음")) : bulletParas(v)]),
    para(m.footer, { size: 17, color: "5A6A86", after: 0 })].join("");
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1300" w:right="1300" w:bottom="1300" w:left="1300" w:header="700" w:footer="700" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zipParts([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["word/document.xml", doc], ["word/styles.xml", STYLES]]);
}
const hx = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hpara = (t) => {
  const lines = String(t || "기록 없음").split("\n").filter((l) => l.trim());
  if (lines.length && lines.every((l) => /^\s*-\s/.test(l))) return "<ul>" + lines.map((l) => "<li>" + hx(l.replace(/^\s*-\s+/, "")) + "</li>").join("") + "</ul>";
  return lines.map((l) => "<p>" + hx(l) + "</p>").join("");
};
const HTML_CSS = "body{margin:0;background:#F4F5FB;color:#1E2530;font:15px/1.75 'Pretendard Variable',Pretendard,'Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif}" +
  "main{max-width:820px;margin:32px auto;background:#fff;border-radius:20px;padding:40px 44px;box-shadow:0 0 0 1px #E1E4EC}" +
  ".brand{display:inline-block;width:10px;height:10px;border-radius:50%;background:#00D4EA;margin-right:8px}.ey{font-size:12px;font-weight:800;letter-spacing:.14em;color:#515160}" +
  "h1{margin:6px 0 4px;font-size:28px;letter-spacing:-.03em}.sub{margin:0 0 20px;font-size:19px;font-weight:700}h2{margin:30px 0 8px;font-size:17px;border-bottom:2px solid #00D4EA;padding-bottom:6px}" +
  "table{width:100%;border-collapse:collapse;font-size:14px}th,td{border:1px solid #D6D9E1;padding:9px 12px;text-align:left;vertical-align:top}th{background:#F4F5FB}.meta th{width:130px}" +
  "ul{margin:6px 0;padding-left:20px}li{margin:4px 0}p{margin:6px 0}.foot{margin-top:34px;font-size:12px;color:#515160}" +
  "@media print{body{background:#fff}main{box-shadow:none;margin:0;padding:0}}@media(max-width:600px){main{margin:0;border-radius:0;padding:24px 18px}}";
export function buildHtml(caseId) {
  const m = reportModel(caseId);
  const sec = m.sections.map(([h, v, kind]) => "<section><h2>" + hx(h) + "</h2>" + (kind === "table"
    ? (v?.length ? "<table><thead><tr><th>단계</th><th>내용</th></tr></thead><tbody>" + v.map((t) => "<tr><td>" + hx(t.stage) + "</td><td>" + hx(t.text) + "</td></tr>").join("") + "</tbody></table>" : "<p>기록 없음</p>")
    : hpara(v)) + "</section>").join("");
  return "<!doctype html><html lang='ko'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>" + hx(m.title + " · " + m.caseTitle) + "</title><style>" + HTML_CSS + "</style></head><body><main>" +
    "<div class='ey'><span class='brand'></span>NEXUS RISK MONITOR</div><h1>" + hx(m.title) + "</h1><p class='sub'>" + hx(m.caseTitle) + "</p>" +
    "<table class='meta'><tbody>" + m.meta.map(([k, v]) => "<tr><th>" + hx(k) + "</th><td>" + hx(v) + "</td></tr>").join("") + "</tbody></table>" + sec + "<p class='foot'>" + hx(m.footer) + "</p></main></body></html>";
}
const sofficeBin = () => [process.env.RISK_SOFFICE, "D:\\LibreOffice\\program\\soffice.exe", "C:\\Program Files\\LibreOffice\\program\\soffice.exe", "/Applications/LibreOffice.app/Contents/MacOS/soffice", "soffice"].find((p) => p && (p === "soffice" || existsSync(p)));
export function buildPdf(caseId) {
  const bin = sofficeBin(); if (!bin) return Promise.reject(new HttpError(501, "PDF 변환에 필요한 LibreOffice 를 찾지 못했습니다. Word 로 내려받아 저장하세요."));
  const tmp = join(S.DATA, ".tmp-pdf-" + caseId + "-" + Date.now()); mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, "report.docx"), buildDocx(caseId));
  return new Promise((resolve, reject) => {
    const cleanup = () => rmSync(tmp, { recursive: true, force: true });
    const child = spawn(bin, ["--headless", "--norestore", `-env:UserInstallation=${pathToFileURL(join(S.DATA, ".lo-profile")).href}`, "--convert-to", "pdf", "--outdir", tmp, join(tmp, "report.docx")], { stdio: "ignore" });
    const t = setTimeout(() => { child.kill("SIGKILL"); cleanup(); reject(new HttpError(504, "PDF 변환 시간이 초과되었습니다. Word 로 내려받으세요.")); }, 120000);
    child.on("error", (e) => { clearTimeout(t); cleanup(); reject(new HttpError(500, "PDF 변환 실패: " + e.message)); });
    child.on("close", () => { clearTimeout(t); const f = join(tmp, "report.pdf"); if (!existsSync(f)) { cleanup(); return reject(new HttpError(500, "PDF 를 만들지 못했습니다. Word 로 내려받으세요.")); } const buf = readFileSync(f); cleanup(); resolve(buf); });
  });
}
export const reportName = (caseId) => `${S.caseFolderName(S.getCase(caseId))}_종결보고서`;
