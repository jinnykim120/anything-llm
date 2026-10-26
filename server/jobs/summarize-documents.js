// [NEXUS 문서 요약] 요약이 없는 새 문서를 몇 건씩 요약한다 (잠긴 폴더 문서는 제외).
// 처음 한 번의 전체 작업은 scripts/backfill-summaries.js 로 하고, 이 작업은 이후 올라오는
// 문서를 따라잡는다.
const { log, conclude } = require("./helpers/index.js");
const { runBatch } = require("../utils/summaries");

(async () => {
  try {
    const result = await runBatch({ limit: 10, concurrency: 2 });
    if (result.total === 0) return;
    log(
      `summarized ${result.done}/${result.total} documents (${result.failed} failed)`
    );
    for (const err of result.errors) log(`  ${err}`);
  } catch (e) {
    console.error(e);
    log(`errored with ${e.message}`);
  } finally {
    conclude();
  }
})();
