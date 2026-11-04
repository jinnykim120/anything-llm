// NEXUS 아카이브(general 등급 문서만)에서 이슈와 관련된 대목을 찾는다. 매일 카드(daily.mjs)가 쓴다.
//   import { loadChunks, search, catalog } from "./archive.mjs"
// general 이 아닌 문서는 lib.mjs 단계에서 이미 빠진다. 파일 경로는 다루지 않고 제목·종류·날짜만 내보낸다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allGeneralDomains, loadGeneralDocs } from "./lib.mjs";
import * as N from "./nexus.mjs";

const cleanTitle = (t) => String(t).replace(/\.(pdf|md)(-[0-9a-f-]{20,}\.pdf)?$/i, "").replace(/-[0-9a-f]{8}-[0-9a-f-]{20,}.*$/i, "").replace(/\s*\(\d\)\s*$/, "").replace(/^★\s*/, "").replace(/_페이지.*$/, "").trim();
const dateOf = (d) => d.date || ((d.title.match(/\((20\d{2})[.\-]?(\d{2})[.\-]?(\d{2})\)/) || []).slice(1).join("-") || "");

let cache = null;
export function loadChunks() {
  if (cache) return cache;
  const seen = new Set(), docs = [], chunks = [];
  for (const { domain } of allGeneralDomains()) for (const d of loadGeneralDocs(domain)) {
    if (seen.has(d.hash)) continue; seen.add(d.hash);
    docs.push({ title: cleanTitle(d.title), docType: d.docType || "", domain, date: dateOf(d), n: d.text.length });
    const di = docs.length - 1; let buf = "";
    const flush = () => { const t = buf.replace(/\s+/g, " ").trim(); if (t.length > 80) chunks.push({ doc: di, text: t.slice(0, 900) }); buf = ""; };
    for (const line of d.text.split(/\n+/)) { buf += line + "\n"; if (buf.length >= 600) flush(); }
    flush();
  }
  return (cache = { docs, chunks });
}

// 문서 목록(모델에게 "사내에 어떤 자료가 있는지" 알려 주는 용도)
export function catalog() {
  const { docs } = loadChunks();
  return docs.map((d) => `${d.docType || d.domain} | ${d.title.slice(0, 60)}${d.date ? " | " + d.date : ""}`);
}

// 키워드가 2개 이상 들어 있는 대목을 점수순으로. 희귀한 키워드일수록 점수가 높다.
export function search(keywords, { top = 10, perDoc = 3 } = {}) {
  const { docs, chunks } = loadChunks();
  const kws = [...new Set(keywords.map((k) => String(k).trim()).filter((k) => k.length >= 2))];
  const df = Object.fromEntries(kws.map((k) => [k, chunks.filter((c) => c.text.includes(k)).length]));
  const w = (k) => Math.log((chunks.length + 1) / (1 + df[k]));
  const seenText = new Set(), scored = [];
  for (const c of chunks) {
    const hit = kws.filter((k) => c.text.includes(k));
    if (hit.length < 2) continue;
    const key = c.text.slice(0, 120); if (seenText.has(key)) continue; seenText.add(key);
    scored.push({ ...c, hit, score: hit.reduce((s, k) => s + w(k), 0) * (1 + 0.3 * (hit.length - 1)) });
  }
  scored.sort((a, b) => b.score - a.score);
  const per = {}, picked = [];
  for (const c of scored) { if ((per[c.doc] = (per[c.doc] || 0) + 1) > perDoc) continue; picked.push(c); if (picked.length >= top) break; }
  return { passages: picked.map((c, i) => ({ id: `A${i + 1}`, ...docs[c.doc], text: c.text, hit: c.hit, score: c.score })), relevance: picked.slice(0, 5).reduce((s, c) => s + c.score, 0), count: scored.length };
}

// ── Mac 의 NEXUS 검색(네트워크). config/nexus.json 에 baseUrl·workspace 와 키 파일이 있으면 이 경로를 쓰고, 아니면 위의 로컬 검색을 쓴다.
// 응답에는 민감도 정보가 없으므로, 허용 목록(allowTitlePatterns: 제목 정규식)에 맞는 문서만 AI 에 보낸다. 목록이 비어 있으면 아무것도 보내지 않는다.
export const remote = () => N.configured() && !!N.workspace();
const allowRes = () => { try { return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "config", "nexus.json"), "utf8")).allowTitlePatterns || []).map((s) => new RegExp(s)); } catch { return []; } };
export const lastSearch = { fetched: 0, allowed: 0, dropped: 0 };
export async function searchRemote(keywords, { top = 10, perDoc = 3 } = {}) {
  const kws = [...new Set(keywords.map((k) => String(k).trim()).filter((k) => k.length >= 2))];
  if (!kws.length) return { passages: [], relevance: 0, count: 0 };
  const allow = allowRes();
  const r = await N.call(`/api/v1/workspace/${encodeURIComponent(N.workspace())}/vector-search`, { method: "POST", body: { query: kws.join(" "), topN: 30, scoreThreshold: 0.3 }, timeoutMs: 45000 });
  const rows = (r.results || []).slice(0, 60), per = {}, picked = []; let dropped = 0;
  for (const x of rows) {
    const title = String(x.metadata?.title || "").trim(); if (!title) continue;
    if (!allow.some((re) => re.test(title))) { dropped++; continue; }
    if ((per[title] = (per[title] || 0) + 1) > perDoc) continue;
    const text = String(x.text || "").replace(/^[\s\S]{0,400}?<\/document_metadata>/, "").replace(/<document_metadata>[\s\S]*$/, "").replace(/\s+/g, " ").trim().slice(0, 900); if (text.length < 80) continue;
    picked.push({ title: cleanTitle(title), docType: "", domain: "", date: dateOf({ title, date: null }), text, hit: kws.filter((k) => text.includes(k)), score: Number(x.score) || 0 });
    if (picked.length >= top) break;
  }
  Object.assign(lastSearch, { fetched: rows.length, allowed: picked.length, dropped });
  return { passages: picked.map((p, i) => ({ id: `A${i + 1}`, ...p })), relevance: picked.slice(0, 5).reduce((s, p) => s + p.score, 0), count: picked.length };
}
export const searchAny = (keywords, o) => (remote() ? searchRemote(keywords, o) : Promise.resolve(search(keywords, o)));

// 본문에 새어 나온 발췌 번호(A7 등)를 지운다. 출처는 cites 로만 표시한다.
export function cleanRefs(s) {
  return String(s)
    .replace(/,\s*A\d+(?=[,)\s·])/g, "").replace(/\(\s*A\d+\s*,\s*/g, "(").replace(/\s*\(\s*A\d+(?:\s*[,·]\s*A\d+)*\s*\)/g, "")
    .replace(/\bA\d+(?:\s*[,·]\s*A\d+)*([은는이가을를의에도와과로])/g, (_, p) => "이 자료" + ({ 은: "는", 이: "가", 을: "를", 과: "와" }[p] || p)).replace(/\bA\d+\b/g, "").replace(/\(\s*\)/g, "").replace(/ {2,}/g, " ");
}

// 문장 속 큰 숫자(천 단위 쉼표·4자리 이상, 소수 %)가 아카이브 전체 텍스트에 없으면 목록으로 돌려준다(연도 제외).
let allFlat = null;
export function unknownNumbers(text, extra) {
  // extra 가 있으면(원격 NEXUS 모드) 가져온 발췌+이슈 본문을 기준으로, 없으면 로컬 아카이브 전체를 기준으로 검사한다.
  let flat;
  if (extra !== undefined) flat = String(extra).replace(/[,\s]/g, "");
  else { if (!allFlat) allFlat = loadChunks().chunks.map((c) => c.text).join(" ").replace(/[,\s]/g, ""); flat = allFlat; }
  const out = [];
  for (const m of String(text).matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?|\d+\.\d+(?=\s*%)/g)) {
    const n = m[0].replace(/,/g, "");
    if (/^(19|20)\d{2}$/.test(n) || /^(19|20)\d{6}$/.test(n)) continue;
    if (!flat.includes(n)) out.push(m[0]);
  }
  return out;
}
