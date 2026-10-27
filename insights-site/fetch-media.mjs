// data/media.json 의 이미지를 data/media/ 로 내려받는다(사내 비상업 용도; 출처는 credit 으로 표기).
//   node insights-site/fetch-media.mjs          # 없는 것만 받음
//   node insights-site/fetch-media.mjs --force  # 전부 다시
// 사내 프록시 인증서가 필요하면: NODE_EXTRA_CA_CERTS=<pem> node insights-site/fetch-media.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA, dir } from "./lib.mjs";

const force = process.argv.includes("--force");
const list = JSON.parse(readFileSync(join(DATA, "media.json"), "utf8"));
const out = dir(join(DATA, "media"));
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

for (const [id, m] of Object.entries(list)) {
  const have = ["jpg", "png", "webp", "gif"].find((e) => existsSync(join(out, `${id}.${e}`)));
  if (have && !force) { console.log(`= ${id}.${have}`); continue; }
  try {
    const r = await fetch(m.url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30000) });
    const ext = EXT[(r.headers.get("content-type") || "").split(";")[0]];
    if (!r.ok || !ext) throw new Error(`${r.status} ${r.headers.get("content-type")}`);
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(join(out, `${id}.${ext}`), buf);
    console.log(`+ ${id}.${ext} ${(buf.length / 1024).toFixed(0)}KB`);
  } catch (e) { console.log(`! ${id}: ${e.cause?.code || e.message}`); }
}
