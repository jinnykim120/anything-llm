// server/.env.development 의 PGVECTOR_CONNECTION_STRING 을 읽어 셸 변수 대입문으로 출력한다.
//   eval "$(node scripts/mac/parse-pg-url.cjs server/.env.development)"
// 출력: PGU PGPW PGHOST_ PGPORT_ PGDB_ (비밀번호의 특수문자도 안전하게 작은따옴표 처리)
const fs = require("fs");

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error(`env file not found: ${file}`);
  process.exit(1);
}
const line = fs
  .readFileSync(file, "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*PGVECTOR_CONNECTION_STRING\s*=/.test(l));
if (!line) {
  console.error("PGVECTOR_CONNECTION_STRING not set");
  process.exit(1);
}
const raw = line
  .replace(/^\s*PGVECTOR_CONNECTION_STRING\s*=\s*/, "")
  .replace(/\s+#.*$/, "")
  .trim()
  .replace(/^["']|["']$/g, "");
const u = new URL(raw);
const sh = (s) => `'${String(s).split("'").join("'\\''")}'`;
console.log(`PGU=${sh(decodeURIComponent(u.username))}`);
console.log(`PGPW=${sh(decodeURIComponent(u.password))}`);
console.log(`PGHOST_=${sh(u.hostname || "127.0.0.1")}`);
console.log(`PGPORT_=${sh(u.port || "5432")}`);
console.log(`PGDB_=${sh(decodeURIComponent(u.pathname.replace(/^\//, "")))}`);
