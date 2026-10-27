// Human gate. Only approved files are ever read by build.mjs.
//   node insights-site/review.mjs list
//   node insights-site/review.mjs show 공정거래
//   node insights-site/review.mjs approve 공정거래 [--by 이름]
//   node insights-site/review.mjs unpublish 공정거래
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA, dir } from "./lib.mjs";

const [cmd, domain, ...rest] = process.argv.slice(2);
const draftP = (d) => join(DATA, "drafts", `${d}.json`);
const apprP = (d) => join(DATA, "approved", `${d}.json`);

if (cmd === "list") {
  const dd = join(DATA, "drafts");
  for (const f of existsSync(dd) ? readdirSync(dd) : []) {
    const d = f.replace(/\.json$/, "");
    const j = JSON.parse(readFileSync(draftP(d), "utf8"));
    console.log(`${d}\t초안 ${j.generatedAt}\t${existsSync(apprP(d)) ? "승인됨" : "미승인"}`);
  }
} else if (cmd === "show") {
  const j = JSON.parse(readFileSync(draftP(domain), "utf8"));
  console.log(`# ${j.domain} — ${j.headline}\n`);
  j.insights.forEach((x) =>
    console.log(
      `■ ${x.title}\n  ${x.body}\n  근거: ${x.cites.map((c) => j.sources[c].title).join(" | ")}\n`
    )
  );
  j.trends.forEach((x) => console.log(`· ${x.date} ${x.title}: ${x.summary}`));
} else if (cmd === "approve") {
  const by = rest.includes("--by") ? rest[rest.indexOf("--by") + 1] : "unknown";
  const j = JSON.parse(readFileSync(draftP(domain), "utf8"));
  dir(join(DATA, "approved"));
  writeFileSync(
    apprP(domain),
    JSON.stringify(
      { ...j, status: "approved", approvedBy: by, approvedAt: new Date().toISOString() },
      null,
      2
    )
  );
  console.log(`${domain} 승인 완료 (${by})`);
} else if (cmd === "unpublish") {
  if (existsSync(apprP(domain))) unlinkSync(apprP(domain));
  console.log(`${domain} 발행 취소`);
} else {
  console.log("usage: list | show <domain> | approve <domain> [--by 이름] | unpublish <domain>");
}
