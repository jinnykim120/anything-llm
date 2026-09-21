// [auto-docu 호출량 로그] `claude -p` 호출이 어떤 기능에서 얼마나 나가는지 숫자로
// 보기 위한 가벼운 로그. 사용량 한도가 갑자기 소진될 때 원인을 추정이 아니라
// 기록으로 확인하려는 용도다.
//
// - claudecli 프로바이더의 모든 호출(비스트림/스트림)이 한 줄씩 기록된다:
//   { ts, feature, inChars, outChars, ms, ok }  → storage/usage-log/YYYY-MM.jsonl
// - feature는 요청 경로로 정한다(AsyncLocalStorage) — 각 엔드포인트를 일일이
//   고치지 않고 미들웨어 한 곳에서 태깅한다.
// - 프롬프트/응답 "내용"은 저장하지 않는다(글자 수만) — 민감 자료가 로그에
//   남지 않게.
// - USAGE_LOG=off 로 끌 수 있다.
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();

// 위에서부터 먼저 맞는 규칙이 이긴다.
const FEATURE_RULES = [
  [/\/extract-data\/run/, "extract-data"],
  [/\/stats\/analyze/, "stats"],
  [/\/ppt-draft/, "ppt-draft"],
  [/\/draft\/revise-block/, "draft-revise"],
  [/\/draft(\?|$)/, "draft"],
  [/\/doc-regen/, "doc-regen"],
  [/\/classification/, "classification"],
  [/\/stream-chat/, "chat"],
  [/\/v1\/workspace\/[^/]+\/chat/, "chat"],
  [/\/chat/, "chat"],
];

function featureForPath(url = "") {
  for (const [re, name] of FEATURE_RULES) if (re.test(url)) return name;
  return "other";
}

/** express 미들웨어 — 이후 비동기 흐름 전체에 feature 태그를 실어 둔다. */
function usageContext(req, _res, next) {
  als.run({ feature: featureForPath(req.originalUrl || req.url) }, next);
}

function currentFeature() {
  return als.getStore()?.feature || "background";
}

function logDir() {
  const base =
    process.env.NODE_ENV === "development"
      ? path.resolve(__dirname, "../../storage")
      : path.resolve(process.env.STORAGE_DIR || ".");
  return path.join(base, "usage-log");
}

function record({ inChars = 0, outChars = 0, ms = 0, ok = true }) {
  if (process.env.USAGE_LOG === "off" || process.env.NODE_ENV === "test") return;
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const file = path.join(dir, `${now.toISOString().slice(0, 7)}.jsonl`);
    const line = JSON.stringify({
      ts: now.toISOString(),
      feature: currentFeature(),
      inChars,
      outChars,
      ms,
      ok,
    });
    fs.appendFileSync(file, line + "\n");
  } catch {
    // 로그 실패가 실제 호출을 막으면 안 된다.
  }
}

/** 최근 N일을 기능별로 집계한다. */
function summarize(days = 7) {
  const dir = logDir();
  const since = Date.now() - days * 86400000;
  const byFeature = {};
  const byDay = {};
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { days, total: { calls: 0, inChars: 0, outChars: 0 }, byFeature, byDay };
  }
  const total = { calls: 0, inChars: 0, outChars: 0 };
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (new Date(e.ts).getTime() < since) continue;
      const day = e.ts.slice(0, 10);
      const feat = (byFeature[e.feature] ||= { calls: 0, inChars: 0, outChars: 0, failed: 0 });
      const d = (byDay[day] ||= { calls: 0, inChars: 0, outChars: 0 });
      for (const t of [feat, d, total]) {
        t.calls += 1;
        t.inChars += e.inChars || 0;
        t.outChars += e.outChars || 0;
      }
      if (!e.ok) feat.failed += 1;
    }
  }
  return { days, total, byFeature, byDay };
}

module.exports = {
  usageContext,
  currentFeature,
  featureForPath,
  record,
  summarize,
};
