// 요약이 없는 문서를 전부 요약한다 (이어서 실행 가능 — 이미 만든 문서는 건너뜀).
//   NODE_ENV=development node scripts/backfill-summaries.js [--concurrency 3] [--limit 200]
const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../.env.development"),
});
const { pendingDocuments, runBatch } = require("../utils/summaries");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) || fallback : fallback;
}

(async () => {
  const concurrency = arg("concurrency", 3);
  const limit = arg("limit", 100000);
  const pending = await pendingDocuments({ limit });
  console.log(
    `요약할 문서 ${pending.length}건 (동시 ${concurrency}개, 잠긴 폴더 문서 제외)`
  );
  if (!pending.length) process.exit(0);
  const startedAt = Date.now();
  let last = 0;
  const result = await runBatch({
    limit,
    concurrency,
    onProgress: (p) => {
      const n = p.done + p.failed;
      if (n - last >= 5 || n === p.total) {
        last = n;
        const sec = Math.round((Date.now() - startedAt) / 1000);
        console.log(`  ${n}/${p.total} 완료 (실패 ${p.failed}) · ${sec}초`);
      }
    },
  });
  console.log(
    `끝: 성공 ${result.done}건, 실패 ${result.failed}건, ${Math.round((Date.now() - startedAt) / 1000)}초`
  );
  for (const e of result.errors) console.log("  실패:", e);
  process.exit(result.failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
