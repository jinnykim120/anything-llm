// 센싱 범위: config/sensing.json(분야·제외 기준·채널·기본 품목·한도) + data/sensing-terms.json(담당자가 추가하는 협력사·품목 목록).
//   · risk.mjs(예약 실행, 별도 프로세스)와 서버(api)가 같은 파일을 읽고 쓴다. 쓸 때는 항상 최신 파일을 다시 읽어 합친 뒤 임시 파일로 저장 후 교체한다.
//   · 협력사·품목은 한 번에 전부 검색하지 않고 '오래 검색하지 않은 순'으로 한도만큼 돌려 가며 검색한다(nextBatches).
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CFG = join(here, "config", "sensing.json"), TERMS = join(here, "data", "sensing-terms.json");
let cfgCache = null, cfgM = 0;
export function scope() {
  try { const m = existsSync(CFG) ? Date.parse(JSON.stringify(0)) || 0 : 0; void m; cfgCache = JSON.parse(readFileSync(CFG, "utf8")); } catch (e) { if (!cfgCache) throw new Error("config/sensing.json 을 읽지 못했습니다: " + e.message); }
  return cfgCache;
}
export const areas = () => scope().areas.filter((a) => a.on !== false);
export const areaNames = () => areas().map((a) => a.name);
export const limits = () => ({ partnerNamesPerCall: 8, productNamesPerCall: 10, partnerCallsPerRun: 2, productCallsPerRun: 2, webMaxToolUses: 18, webMaxTurns: 32, webMaxBudgetUsd: 0.6, defaultProductSweepDays: 7, ...(scope().limits || {}) });
export const firstSignalChannels = () => scope().firstSignalChannels || ["고객VOC", "점주", "언론", "기관", "내부", "기타", "문서에 없음"];

// 프롬프트에 넣는 범위 문구(분야 정의 + 제외 기준)
export function promptText() {
  const s = scope(), n = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
  const ar = areas().map((a, i) => `${n[i] || i + 1 + ")"}${a.name}(${a.desc})`).join(" ");
  const ch = (s.channels || []).map((c) => `${c.name}(${(c.brands || []).join("·")})`).join(", ");
  return `찾는 범위: 우리 회사(${s.company})에 직접 이슈나 문제가 될 수 있는 것만 찾습니다. 판매 채널은 ${ch} 입니다. 당사·브랜드가 직접 거론된 이슈는 빼지 마세요.
분야: ${ar}
제외(담지 마세요): ${(s.exclude || []).map((x, i) => `${i + 1}) ${x}`).join(" ")}`;
}

// ── 협력사·품목 목록
const emptyTerms = () => ({ partners: [], products: [] });
export function readTerms() {
  try { const j = JSON.parse(readFileSync(TERMS, "utf8")); return { partners: j.partners || [], products: j.products || [], checked: j.checked || {} }; } catch { return { ...emptyTerms(), checked: {} }; }
}
function writeTerms(t) {
  mkdirSync(dirname(TERMS), { recursive: true });
  const tmp = TERMS + ".tmp-" + process.pid; writeFileSync(tmp, JSON.stringify(t, null, 2) + "\n"); renameSync(tmp, TERMS);
}
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
const KINDS = { partner: "partners", product: "products" };
const key = (k, name) => `${k}:${name.toLowerCase()}`;

// 이름 여러 개를 추가한다(중복·빈 값 제외). 돌려주는 값: {added, skipped}
export function addTerms(kind, names, { channel = "", note = "", source = "수동" } = {}) {
  if (!KINDS[kind]) throw new Error("kind 는 partner 또는 product 입니다");
  const t = readTerms(), list = t[KINDS[kind]], have = new Set(list.map((x) => x.name.toLowerCase()));
  if (kind === "product") for (const d of scope().defaultProducts || []) have.add(d.toLowerCase());
  let added = 0, skipped = 0;
  for (const raw of names) {
    const name = clean(raw); if (name.length < 2 || have.has(name.toLowerCase())) { skipped++; continue; }
    have.add(name.toLowerCase()); list.push({ name, channel: clean(channel), note: String(note || "").slice(0, 120), source, addedAt: new Date().toISOString() }); added++;
  }
  if (added) writeTerms(t);
  return { added, skipped };
}
export function removeTerm(kind, name) {
  if (!KINDS[kind]) throw new Error("kind 는 partner 또는 product 입니다");
  const t = readTerms(), n = t[KINDS[kind]].length; t[KINDS[kind]] = t[KINDS[kind]].filter((x) => x.name !== name);
  if (t[KINDS[kind]].length !== n) writeTerms(t); return { removed: n - t[KINDS[kind]].length };
}
// 검색 대상 전체(기본 품목 + 추가 품목, 협력사)
export function allTerms(kind) {
  const t = readTerms();
  if (kind === "partner") return t.partners.map((x) => ({ name: x.name, channel: x.channel, note: x.note, source: x.source, custom: true }));
  const defs = (scope().defaultProducts || []).map((name) => ({ name, channel: "", note: "", source: "기본", custom: false }));
  return [...defs, ...t.products.map((x) => ({ name: x.name, channel: x.channel, note: x.note, source: x.source, custom: true }))];
}
// 오래 검색하지 않은 순으로 한도만큼 묶음을 돌려준다. 돌려준 이름은 markChecked 로 검색 시각을 남긴다.
export function nextBatches(kind) {
  const L = limits(), per = kind === "partner" ? L.partnerNamesPerCall : L.productNamesPerCall, calls = kind === "partner" ? L.partnerCallsPerRun : L.productCallsPerRun;
  const t = readTerms(), items = allTerms(kind).map((x, i) => ({ ...x, i, at: t.checked[key(kind, x.name)] || "" }));
  const byStale = (p, q) => (p.at < q.at ? -1 : p.at > q.at ? 1 : p.i - q.i);
  const chunk = (names) => { const o = []; for (let i = 0; i < names.length; i += per) o.push(names.slice(i, i + per)); return o; };
  if (kind === "partner") return chunk(items.sort(byStale).slice(0, per * calls).map((x) => x.name));
  // 품목: 담당자가 직접 추가한 품목은 매 회차 한도만큼 돌려 가며, 기본 품목 범주는 defaultProductSweepDays 일마다 전부 한 번 훑는다.
  const custom = items.filter((x) => x.custom).sort(byStale), defs = items.filter((x) => !x.custom).sort(byStale);
  const out = chunk(custom.slice(0, per * calls).map((x) => x.name));
  if (defaultSweepDue()) out.push(...chunk(defs.map((x) => x.name)));
  return out;
}
const SWEEP_KEY = "__default_sweep:product";
export function defaultSweepDue() {
  const days = Number(limits().defaultProductSweepDays || 0); if (!days) return true;
  const st = readTerms().checked[SWEEP_KEY]; return !st || Date.now() - Date.parse(st) >= days * 86400e3;
}
export function sweepInfo() { const days = Number(limits().defaultProductSweepDays || 0), last = readTerms().checked[SWEEP_KEY] || null; return { days, last, due: defaultSweepDue() }; }
export function markChecked(kind, names) {
  const t = readTerms(), at = new Date().toISOString(); for (const n of names) t.checked[key(kind, n)] = at;
  if (kind === "product") { const defs = new Set((scope().defaultProducts || []).map((x) => x.toLowerCase())); if (names.some((n) => defs.has(String(n).toLowerCase()))) t.checked[SWEEP_KEY] = at; }
  writeTerms(t);
}
// 한 바퀴 도는 데 걸리는 회차 수(안내용)
export function cycleRuns(kind) {
  const L = limits(), per = kind === "partner" ? L.partnerNamesPerCall : L.productNamesPerCall, calls = kind === "partner" ? L.partnerCallsPerRun : L.productCallsPerRun;
  const total = allTerms(kind).length; return total ? Math.ceil(total / Math.max(1, per * calls)) : 0;
}

// 화면에서 바꾸는 설정 저장: 분야 켜기/끄기, 협력사·품목 검색 한도. 검증 후 임시 파일로 저장해 교체한다.
const LIMIT_RANGE = { partnerNamesPerCall: [1, 20], productNamesPerCall: [1, 20], partnerCallsPerRun: [0, 6], productCallsPerRun: [0, 6] };
export function saveSettings(b = {}) {
  const c = JSON.parse(readFileSync(CFG, "utf8"));
  if (Array.isArray(b.areas)) {
    const on = new Map(b.areas.map((a) => [String(a.id), a.on !== false]));
    for (const a of c.areas) if (on.has(a.id)) a.on = on.get(a.id);
    if (!c.areas.some((a) => a.on !== false)) throw new Error("분야를 하나 이상 켜 두어야 합니다");
  }
  if (b.limits && typeof b.limits === "object") {
    const lim = c.limits || (c.limits = {});
    for (const [k, [lo, hi]] of Object.entries(LIMIT_RANGE)) {
      if (b.limits[k] === undefined) continue;
      const v = Math.round(Number(b.limits[k]));
      if (!Number.isFinite(v) || v < lo || v > hi) throw new Error("검색 횟수·이름 수는 " + lo + "~" + hi + " 사이여야 합니다");
      lim[k] = v;
    }
  }
  const tmp = CFG + ".tmp-" + process.pid; writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n"); renameSync(tmp, CFG);
  return scope();
}
