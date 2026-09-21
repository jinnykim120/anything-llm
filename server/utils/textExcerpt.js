// 긴 문서에서 요청과 관련 있는 구간만 골라 담는다(앞부분 자르기 대신).
// 통계분석·자료 추출하기가 공유한다.
const EXCERPT_WINDOW = 1500;
const FINANCE_TERMS = [
  "매출",
  "영업이익",
  "당기순이익",
  "분기",
  "반기",
  "연결",
  "재무",
  "손익",
  "단위",
];
function excerptRelevant(text, query = "", cap = 60000) {
  const full = String(text || "");
  if (full.length <= cap) return full;
  const terms = [
    ...new Set(
      [...FINANCE_TERMS, ...(String(query).match(/[가-힣A-Za-z0-9]{2,}/g) || [])]
    ),
  ];
  const windows = [];
  for (let i = 0; i < full.length; i += EXCERPT_WINDOW) {
    const chunk = full.slice(i, i + EXCERPT_WINDOW);
    let score = 0;
    for (const t of terms) if (chunk.includes(t)) score += 1;
    const digits = (chunk.match(/\d/g) || []).length;
    if (score > 0) score += digits / EXCERPT_WINDOW;
    windows.push({ i, chunk, score });
  }
  const head = windows[0];
  let budget = cap - head.chunk.length;
  const picked = new Set([0]);
  const ranked = windows.slice(1).sort((a, b) => b.score - a.score);
  for (const w of ranked) {
    if (w.score <= 0 || budget < w.chunk.length) continue;
    picked.add(w.i / EXCERPT_WINDOW);
    budget -= w.chunk.length;
  }
  return [...picked]
    .sort((a, b) => a - b)
    .map((k) => windows[k].chunk)
    .join("\n…(중략)…\n");
}


module.exports = { excerptRelevant };
