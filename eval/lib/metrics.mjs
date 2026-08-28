// Retrieval metrics — no LLM judge, fully deterministic.
// A "hit" = a retrieved chunk whose source document is one of the expected docs.

export const KS = [1, 3, 5, 8];

/** @param {string[]} rankedDocs ordered source-doc ids as retrieved
 *  @param {string[]} expected   set of acceptable source-doc ids */
export function scoreOne(rankedDocs, expected) {
  const exp = new Set(expected);
  const firstRel = rankedDocs.findIndex((d) => exp.has(d)); // -1 if none
  const rr = firstRel === -1 ? 0 : 1 / (firstRel + 1);
  const out = { rr, hit: {}, recall: {}, precision: {} };
  for (const k of KS) {
    const topk = rankedDocs.slice(0, k);
    const relInTopK = topk.filter((d) => exp.has(d));
    const uniqRel = new Set(relInTopK);
    out.hit[k] = relInTopK.length > 0 ? 1 : 0;
    out.recall[k] = exp.size ? uniqRel.size / exp.size : 0;
    out.precision[k] = k ? relInTopK.length / k : 0;
  }
  return out;
}

export function aggregate(perQuestion) {
  const n = perQuestion.length || 1;
  const agg = { n: perQuestion.length, mrr: 0, hit: {}, recall: {}, precision: {} };
  for (const k of KS) { agg.hit[k] = 0; agg.recall[k] = 0; agg.precision[k] = 0; }
  for (const q of perQuestion) {
    agg.mrr += q.rr;
    for (const k of KS) {
      agg.hit[k] += q.hit[k];
      agg.recall[k] += q.recall[k];
      agg.precision[k] += q.precision[k];
    }
  }
  agg.mrr /= n;
  for (const k of KS) { agg.hit[k] /= n; agg.recall[k] /= n; agg.precision[k] /= n; }
  return agg;
}

export function fmtTable(byMode) {
  const rows = [];
  rows.push(["mode", "n", "MRR", ...KS.map((k) => `hit@${k}`), ...KS.map((k) => `rec@${k}`)]);
  for (const [mode, a] of Object.entries(byMode)) {
    rows.push([
      mode, String(a.n), a.mrr.toFixed(3),
      ...KS.map((k) => a.hit[k].toFixed(3)),
      ...KS.map((k) => a.recall[k].toFixed(3)),
    ]);
  }
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((v, c) => String(v).padEnd(w[c])).join("  ")).join("\n");
}
