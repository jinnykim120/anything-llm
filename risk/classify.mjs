// AI 유형 제안 도우미(순수 함수 — DB·LLM 호출 없음). risk.mjs(센싱 분석 프롬프트)·store.mjs(우선순위)·백필 스크립트가 같이 쓴다.
//   유형 값 우선순위: 담당자(manual) > 문서 지정(document) > AI 제안(ai). 임계값·예시 수는 config/taxonomy.json 의 aiClassification.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
export const loadTaxonomy = () => readJson(join(here, "config", "taxonomy.json"), { issueTypes: [], businessUnits: [] });
const SEED = join(here, "data", "seed", "past-cases.json");

export const HOLD = "hold"; // AI 가 확신하지 못해 분류를 보류한 값(유형 id 가 아니다)

// ── 우선순위: 새 출처가 기존 출처를 덮어써도 되는가
export function canOverride(existingSource, newSource, tax = loadTaxonomy()) {
  const pr = Object.fromEntries((tax.typeSources || []).map((s) => [s.id, s.priority]));
  if (!existingSource) return true;
  return (pr[newSource] ?? 0) > (pr[existingSource] ?? 0) || (existingSource === newSource && newSource === "ai");
}

// ── 프롬프트용 유형 안내(과거 사례를 유형당 소수만 예시로 — 토큰 과다 방지)
export function pickExamples(tax = loadTaxonomy(), seed = existsSync(SEED) ? readJson(SEED, { cases: [] }) : { cases: [] }) {
  const cfg = tax.aiClassification || {}, per = cfg.examplesPerType ?? 2, max = cfg.maxExampleChars ?? 42;
  const by = new Map();
  for (const c of seed.cases || []) {
    if (!c.typeId || !c.title) continue;
    const t = String(c.title).replace(/\s+/g, " ").trim();
    if (!by.has(c.typeId)) by.set(c.typeId, []);
    by.get(c.typeId).push({ year: c.year || 0, title: t.length > max ? t.slice(0, max - 1) + "…" : t });
  }
  const out = {};
  for (const t of tax.issueTypes) {
    // 최근 연도 우선, 같은 제목 중복 제외, 결정적 순서
    const list = (by.get(t.id) || []).sort((a, b) => b.year - a.year || a.title.localeCompare(b.title));
    const seen = new Set(), pick = [];
    for (const x of list) if (pick.length < per && !seen.has(x.title)) { seen.add(x.title); pick.push(x.title); }
    out[t.id] = pick;
  }
  return out;
}

export function typeGuide(tax = loadTaxonomy(), examples = pickExamples(tax)) {
  const min = tax.aiClassification?.minConfidence ?? 0.6;
  const lines = tax.issueTypes.map((t) => `- ${t.id} = ${t.name}${examples[t.id]?.length ? " (예: " + examples[t.id].join(" / ") + ")" : ""}`);
  const bus = (tax.businessUnits || []).map((b) => `- ${b.id} = ${b.name}${b.hint ? " (" + b.hint + ")" : ""}`);
  return `[이슈 유형 9개 — 예시는 당사의 과거 사례]\n${lines.join("\n")}\n유형 판단: 위 중 가장 가까운 하나의 id 를 typeId 로 제안합니다. 어느 유형에도 분명히 맞지 않거나 확신이 ${min} 미만이면 억지로 other 에 넣지 말고 typeId 를 "${HOLD}" 로 합니다(other 는 '기타로 확실히 분류되는 사건'일 때만).\n[사업부문 — 제안만 하며 담당자가 최종 선택]\n${bus.join("\n")}\n사업부문은 이슈 내용에 근거가 분명할 때만 buId 를 적고, 불명확하면 null 로 둡니다.`;
}
// 분석 프롬프트의 JSON 스키마에 덧붙이는 조각(추가 LLM 호출 없음 — 기존 분석 호출에 필드만 추가)
export const SCHEMA_FRAGMENT = `"typeSuggestion":{"typeId":"위 유형 id 또는 hold","confidence":0.0~1.0,"why":"근거 1문장"},"buSuggestion":{"buId":"사업부문 id 또는 null","why":"근거 1문장(없으면 빈 문자열)"}`;

// ── LLM 응답 정리: 잘못된 값이 와도 분석 전체를 실패시키지 않고 '제안 없음'으로 처리
export function normalizeAi(raw, tax = loadTaxonomy()) {
  const min = tax.aiClassification?.minConfidence ?? 0.6;
  const types = new Set(tax.issueTypes.map((t) => t.id)), bus = new Set((tax.businessUnits || []).map((b) => b.id));
  const ts = raw?.typeSuggestion ?? raw?.type ?? null, bs = raw?.buSuggestion ?? raw?.bu ?? null;
  const out = { type: null, bu: null };
  if (ts && typeof ts === "object") {
    const conf = Number(ts.confidence), c = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null;
    const id = String(ts.typeId ?? "").trim(), why = String(ts.why || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (id === HOLD || (types.has(id) && c != null && c < min)) out.type = { status: "hold", id: null, confidence: c, why };
    else if (types.has(id) && c != null) out.type = { status: "suggested", id, confidence: c, why };
  }
  if (bs && typeof bs === "object" && bus.has(String(bs.buId ?? "").trim())) out.bu = { id: String(bs.buId).trim(), why: String(bs.why || "").replace(/\s+/g, " ").trim().slice(0, 300) };
  return out;
}

// ── 일치율 계산(순수): rows = [{ typeId(최종), aiAtConfirm('유형id'|'hold'|'none') }]
export function accuracyOf(rows, tax = loadTaxonomy()) {
  const nm = Object.fromEntries(tax.issueTypes.map((t) => [t.id, t.name]));
  const by = {}; let n = 0, match = 0, hold = 0, none = 0;
  for (const r of rows) {
    if (r.aiAtConfirm === HOLD) { hold++; continue; }
    if (!r.aiAtConfirm || r.aiAtConfirm === "none") { none++; continue; }
    n++; const ok = r.aiAtConfirm === r.typeId; if (ok) match++;
    const b = (by[r.aiAtConfirm] ||= { id: r.aiAtConfirm, name: nm[r.aiAtConfirm] || r.aiAtConfirm, n: 0, match: 0 }); b.n++; if (ok) b.match++;
  }
  const rate = (m, k) => (k ? m / k : null);
  return { overall: { n, match, rate: rate(match, n) }, byType: tax.issueTypes.filter((t) => by[t.id]).map((t) => ({ ...by[t.id], rate: rate(by[t.id].match, by[t.id].n) })), holdResolved: hold, noSuggestion: none };
}

// ── 사건 폴더/표시 이름: YYYY-MM_제목 (시작연월 접두). 월을 모르는 과거 사례는 YYYY-미상.
export function caseFolderName({ title, startDate, startYear }) {
  const ym = /^\d{4}-\d{2}/.test(startDate || "") ? startDate.slice(0, 7) : startYear ? `${startYear}-미상` : "미상";
  const t = String(title || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, "").trim().replace(/[.]+$/g, "").slice(0, 60).trim();
  return `${ym}_${t || "제목없음"}`;
}
