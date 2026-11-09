#!/usr/bin/env node
// 기존 센싱 이슈에 '당사 접점(contact: 확인|불명)' 판정을 채운다(이슈 분석에 이 항목이 생기기 전에 저장된 이슈용).
//   node scripts/backfill-contact.mjs          → 대상과 호출 수만 출력(AI 호출 없음)
//   node scripts/backfill-contact.mjs --yes    → 실제 실행(Sonnet 5.5, 12건씩 묶어 호출)
//   --all  이미 판정된 이슈도 다시 판정(기준을 바꿨을 때)
// 이슈 본문(title·summary·relation)만 보고 판정하며 웹 검색은 하지 않는다. 센싱이 실행 중이면(data/.lock) 거부한다.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { claude, lastJson, usage } from "../lib.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), ".."), P = join(here, "data", "issues.json");
if (existsSync(join(here, "data", ".lock"))) { console.log("센싱이 실행 중입니다(data/.lock). 끝난 뒤 다시 실행하세요."); process.exit(1); }
const j = JSON.parse(readFileSync(P, "utf8")), todo = Object.values(j.issues).filter((i) => process.argv.includes("--all") || !i.contact);
if (!todo.length) { console.log("채울 이슈가 없습니다."); process.exit(0); }
console.log(`대상 ${todo.length}건 → ${Math.ceil(todo.length / 12)}회 호출(Sonnet 5.5)`);
if (!process.argv.includes("--yes")) { console.log("계획만 출력했습니다. 실제 실행은 --yes"); process.exit(0); }

const SYS = `당신은 GS리테일(GS25·GS더프레시·GS SHOP) 리스크 담당입니다. 각 이슈가 당사·당사 브랜드·당사 협력사·당사 취급 상품·당사 점포와 직접 연결되는지 판정합니다.
입력의 title·summary·relation 만 근거로 합니다. 확인: 당사·당사 브랜드·협력사·취급 상품·점포가 거론되거나 연결 근거가 기사·사내 아카이브 발췌에 있음, 또는 편의점·슈퍼·홈쇼핑 업태 전체를 직접 대상으로 한 조치·점검·소송이라 당사도 대상에 포함될 수 있음. 불명: 그 밖(타 업종·일반 시장·물가 같은 거시 지표·타사 개별 사고).
출력은 JSON 하나만: {"results":[{"id":"","contact":"확인|불명"}]}`;
for (let k = 0; k < todo.length; k += 12) {
  const b = todo.slice(k, k + 12);
  const user = JSON.stringify(b.map((i) => ({ id: i.id, title: i.title, summary: String(i.summary || "").slice(0, 220), relation: String(i.relation || "").slice(0, 400) })));
  const out = lastJson(await claude(SYS, user, 300000), (o) => Array.isArray(o && o.results));
  for (const r of out.results) { const i = j.issues[r.id]; if (i && (r.contact === "확인" || r.contact === "불명")) i.contact = r.contact; }
}
const tmp = P + ".tmp-" + process.pid; writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n"); renameSync(tmp, P);
const all = Object.values(j.issues), n = (c) => all.filter((i) => i.contact === c).length;
console.log(`완료: 확인 ${n("확인")}건 · 불명 ${n("불명")}건 · 미판정 ${all.filter((i) => !i.contact).length}건 · 비용 $${usage.reduce((a, u) => a + u.usd, 0).toFixed(3)}`);
