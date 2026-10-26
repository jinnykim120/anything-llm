// 운영 중인 SQLite DB 를 일관된 스냅샷으로 복사한다 (서버를 멈추지 않아도 됨).
//   node scripts/mac/export-sqlite.cjs <출력 파일 경로>
// SQLite 의 VACUUM INTO 는 원본을 수정하지 않고 트랜잭션 일관성 있는 복사본을 만든다.
// 출력: 복사본 경로와 주요 행 수(MANIFEST 용 key=value 줄).
const path = require("path");
const fs = require("fs");

const SERVER_DIR = path.resolve(__dirname, "../../server");
process.chdir(SERVER_DIR);
process.env.NODE_ENV = process.env.NODE_ENV || "development";
require(path.join(SERVER_DIR, "node_modules/dotenv")).config({
  path: path.join(SERVER_DIR, ".env.development"),
});

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/mac/export-sqlite.cjs <output.db>");
  process.exit(1);
}
const target = path.resolve(out);

(async () => {
  const prisma = require(path.join(SERVER_DIR, "utils/prisma"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target);
  // SQLite 문자열 리터럴: 작은따옴표는 두 번 겹쳐 이스케이프
  const lit = target.split("'").join("''");
  await prisma.$executeRawUnsafe(`VACUUM INTO '${lit}'`);

  const count = async (table) =>
    Number((await prisma.$queryRawUnsafe(`select count(*) n from "${table}"`))[0].n);
  console.log(`sqlite_file=${target}`);
  console.log(`sqlite_bytes=${fs.statSync(target).size}`);
  for (const t of [
    "workspaces",
    "workspace_documents",
    "document_classifications",
    "workspace_chats",
    "workspace_threads",
  ]) {
    try {
      console.log(`rows_${t}=${await count(t)}`);
    } catch {
      /* 테이블이 없으면 건너뜀 */
    }
  }
  await prisma.$disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
