// 당사 협력사·취급 품목 참조 목록(data/company-terms.json). 센싱 검색 대상이 아니라 '당사 접점' 판정을 돕는 자료로만 쓴다.
//   협력사 이름이 이슈 제목·요약·관련 상품에 그대로 나오면 접점 '확인'으로 본다(AI 호출 없음).
//   품목 이름 일치는 '와인'·'만두'처럼 일반 단어가 많아 자동 판정에는 쓰지 않고 AI 에게 참고로만 알려 준다.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = join(fileURLToPath(import.meta.url), "..", "data", "company-terms.json");
let cache = null;

// 회사 형태 표기((주)·㈜·주식회사 등)와 공백·괄호를 지우고 소문자로 맞춘다.
export const norm = (s) => String(s ?? "").toLowerCase().replace(/\(주\)|㈜|주\)|\(주|주식회사|\(유\)|유한회사|\(사\)|[\s()\[\]·.,]/g, "");

function load() {
  if (cache) return cache;
  let j = { partners: [], products: [] };
  try { if (existsSync(FILE)) j = JSON.parse(readFileSync(FILE, "utf8")); } catch {}
  // 협력사: 정규화한 이름이 3글자 이상일 때만 쓴다('대상'·'동원'처럼 2글자 이름은 일반 단어와 겹쳐 오판이 많다).
  const partners = [], seenP = new Set(); let skippedShort = 0;
  for (const p of j.partners || []) { const k = norm(p.name); if (k.length < 3) { skippedShort++; continue; } if (seenP.has(k)) continue; seenP.add(k); partners.push({ key: k, name: p.name }); }
  const products = [], seenI = new Set();
  // 운영·분류용 이름('지정일배송'·'기타와인'·'택배박스'·'서비스상품' 등)은 실제 상품이 아니라 이슈 기사에 나오지 않으므로 뺀다.
  const OPS = /^기타|기타$|^온라인-|^카탈로그-|서비스상품|배송|택배|소모품|포장상품|포장봉투|상품권|행사|경품|티켓|특정판매|순회/;
  for (const p of j.products || []) { const k = norm(p.name); if (k.length < 3 || seenI.has(k) || OPS.test(k)) continue; seenI.add(k); products.push({ key: k, name: p.name }); }
  return (cache = { partners, products, skippedShort, total: { partners: (j.partners || []).length, products: (j.products || []).length } });
}

// 텍스트에 이름이 들어 있는 협력사·품목을 찾는다. 돌려주는 값: {partners:[이름…], products:[이름…]}
export function matchTerms(...texts) {
  const T = load(), t = norm(texts.flat().filter(Boolean).join(" "));
  if (!t) return { partners: [], products: [] };
  const pick = (L, max) => { const o = []; for (const x of L) if (t.includes(x.key)) { o.push(x.name); if (o.length >= max) break; } return o; };
  return { partners: pick(T.partners, 5), products: pick(T.products, 8) };
}
export const termStats = () => { const T = load(); return { partners: T.partners.length, products: T.products.length, skippedShort: T.skippedShort, total: T.total }; };
