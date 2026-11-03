// NEXUS 아카이브(general 등급 문서만)에서 이슈와 관련된 대목을 찾는다. 매일 카드(daily.mjs)가 쓴다.
//   import { loadChunks, search, catalog } from "./archive.mjs"
// general 이 아닌 문서는 lib.mjs 단계에서 이미 빠진다. 파일 경로는 다루지 않고 제목·종류·날짜만 내보낸다.
import { allGeneralDomains, loadGeneralDocs } from "./lib.mjs";

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

// 본문에 새어 나온 발췌 번호(A7 등)를 지운다. 출처는 cites 로만 표시한다.
export function cleanRefs(s) {
  return String(s)
    .replace(/,\s*A\d+(?=[,)\s·])/g, "").replace(/\(\s*A\d+\s*,\s*/g, "(").replace(/\s*\(\s*A\d+(?:\s*[,·]\s*A\d+)*\s*\)/g, "")
    .replace(/\bA\d+(?:\s*[,·]\s*A\d+)*([은는이가을를의에도와과로])/g, (_, p) => "이 자료" + ({ 은: "는", 이: "가", 을: "를", 과: "와" }[p] || p)).replace(/\bA\d+\b/g, "").replace(/\(\s*\)/g, "").replace(/ {2,}/g, " ");
}

// 문장 속 큰 숫자(천 단위 쉼표·4자리 이상, 소수 %)가 아카이브 전체 텍스트에 없으면 목록으로 돌려준다(연도 제외).
let allFlat = null;
export function unknownNumbers(text) {
  if (!allFlat) allFlat = loadChunks().chunks.map((c) => c.text).join(" ").replace(/[,\s]/g, "");
  const out = [];
  for (const m of String(text).matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?|\d+\.\d+(?=\s*%)/g)) {
    const n = m[0].replace(/,/g, "");
    if (/^(19|20)\d{2}$/.test(n) || /^(19|20)\d{6}$/.test(n)) continue;
    if (!allFlat.includes(n)) out.push(m[0]);
  }
  return out;
}
