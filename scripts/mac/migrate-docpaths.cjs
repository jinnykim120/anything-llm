// 윈도에서 저장된 문서 경로(workspace_documents.docpath)의 역슬래시를 슬래시로 바꾼다.
//
//   실적\(7)-.pptx-7555b44a.json  →  실적/(7)-.pptx-7555b44a.json
//
// 왜: macOS/Linux 에서 역슬래시는 폴더 구분자가 아니라 파일명의 한 글자라서,
// 윈도에서 쌓인 docpath 로는 문서 파일을 찾지 못한다. (server/utils/files 의
// normalizePath 도 POSIX 에서 역슬래시를 슬래시로 취급하도록 고쳤지만, DB 값도
// 정리해 두면 경로 비교·목록 표시가 맥/윈도에서 동일하다.) 윈도에서 실행해도 안전하다.
//
// 사용법(저장소 루트에서):
//   node scripts/mac/migrate-docpaths.cjs          # 변환 + 검증
//   node scripts/mac/migrate-docpaths.cjs --check  # 변경 없이 점검만
//
// 종료 코드: 0 = 모든 docpath 가 파일로 확인됨, 2 = 파일을 못 찾는 행이 있음
const path = require("path");
const fs = require("fs");

const SERVER_DIR = path.resolve(__dirname, "../../server");
process.chdir(SERVER_DIR);
process.env.NODE_ENV = process.env.NODE_ENV || "development";
require(path.join(SERVER_DIR, "node_modules/dotenv")).config({
  path: path.join(SERVER_DIR, ".env.development"),
});

const checkOnly = process.argv.includes("--check");
const BACKSLASH = String.fromCharCode(92);

(async () => {
  const prisma = require(path.join(SERVER_DIR, "utils/prisma"));
  const { documentsPath, normalizePath } = require(path.join(
    SERVER_DIR,
    "utils/files"
  ));

  const rows = await prisma.workspace_documents.findMany({
    select: { id: true, docpath: true },
  });
  const withBackslash = rows.filter((r) => String(r.docpath).includes(BACKSLASH));
  console.log(
    `workspace_documents: ${rows.length}행, 역슬래시 경로 ${withBackslash.length}행` +
      (checkOnly ? " (--check: 변경하지 않음)" : "")
  );

  if (!checkOnly && withBackslash.length) {
    await prisma.$transaction(
      withBackslash.map((r) =>
        prisma.workspace_documents.update({
          where: { id: r.id },
          data: { docpath: String(r.docpath).split(BACKSLASH).join("/") },
        })
      )
    );
    console.log(`변환 완료: ${withBackslash.length}행`);
  }

  // 검증: 모든 행의 docpath 가 실제 파일을 가리키는가
  const after = await prisma.workspace_documents.findMany({
    select: { docpath: true, filename: true },
  });
  const missing = [];
  for (const r of after) {
    let ok = false;
    try {
      ok = fs.existsSync(path.resolve(documentsPath, normalizePath(r.docpath)));
    } catch {
      ok = false;
    }
    if (!ok) missing.push(r.docpath);
  }
  console.log(
    `파일 확인: ${after.length - missing.length}/${after.length}행 OK` +
      (missing.length ? `, 누락 ${missing.length}행` : "")
  );
  missing.slice(0, 10).forEach((m) => console.log("  누락:", m));
  console.log(`documentsPath: ${documentsPath}`);
  await prisma.$disconnect();
  process.exit(missing.length ? 2 : 0);
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
