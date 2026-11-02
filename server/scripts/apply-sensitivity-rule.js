// 모든 분류 기록의 민감도를 규칙(잠긴 폴더 문서만 confidential, 나머지 general)에 맞춘다.
//   NODE_ENV=development node scripts/apply-sensitivity-rule.js [--dry-run]
const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../.env.development"),
});
const { syncAll } = require("../utils/classification/sensitivityRule");

(async () => {
  const dryRun = process.argv.includes("--dry-run");
  const r = await syncAll({ dryRun });
  console.log(
    `${dryRun ? "[미리보기] " : ""}분류 기록 ${r.total}건 중 ${r.changed}건 변경` +
      ` (general로 ${r.toGeneral}, confidential로 ${r.toConfidential}; 문서가 없는 기록 ${r.orphanChanged}건 포함)`
  );
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
