// Build the static site from APPROVED content only → insights-site/site/
//   node insights-site/build.mjs            # approved only (what gets published)
//   node insights-site/build.mjs --preview  # include unapproved drafts, banner-marked
//   node insights-site/build.mjs --preview --no-banner  # same, without the draft banner
// Output: index.html(이미지 피드) + 주제마다 <slug>.html + site-data.js + media/ — copy the `site/` folder to any web server.
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { here, DATA, dir } from "./lib.mjs";

const preview = process.argv.includes("--preview");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const load = (sub) => {
  const d = join(DATA, sub);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => ({ file: f, ...readJson(join(d, f)) })) : [];
};
const isBoard = (x) => x.file.startsWith("board-");
const isTopic = (x) => x.file.startsWith("topic-");

const approved = load("approved");
const drafts = load("drafts");
const have = new Set(approved.map((x) => x.file));
const pick = (pred) => [...approved.filter(pred), ...(preview ? drafts.filter((x) => pred(x) && !have.has(x.file)) : [])];

const out = dir(join(here, "site"));
const mediaOut = dir(join(out, "media"));
const mediaList = existsSync(join(DATA, "media.json")) ? readJson(join(DATA, "media.json")) : {};
const mediaFile = (id) => ["jpg", "png", "webp", "gif"].map((e) => `${id}.${e}`).find((f) => existsSync(join(DATA, "media", f)));
const usedMedia = (id) => {
  const f = id && mediaFile(id);
  if (!f) return null;
  copyFileSync(join(DATA, "media", f), join(mediaOut, f));
  return { src: `media/${f}`, credit: mediaList[id]?.credit || "" };
};

// ── 토픽 보드 (예: GS리테일 전망) — forecast.json 은 보드가 있을 때만 포함
const boards = pick(isBoard).map((b) => {
  const research = readJson(join(DATA, "research", `${b.slug}.json`));
  const used = new Set([...b.environment, ...b.risks, ...b.insights].flatMap((x) => x.cites));
  return {
    slug: b.slug,
    section: b.section,
    status: b.status,
    updatedAt: b.approvedAt || b.generatedAt,
    summary: b.summary,
    environment: b.environment,
    risks: b.risks,
    insights: b.insights,
    ideas: b.ideas || [],
    outlook: b.outlook || null,
    // 사내 파일 경로는 싣지 않는다 — 제목·발행처·날짜·URL 만
    sources: research.sources.map((s) => ({ id: s.id, kind: s.kind, title: s.title, publisher: s.publisher, date: s.date, url: s.url || null, facts: s.facts, used: used.has(s.id) })),
    unverified: research.unverified,
  };
});
const forecast = boards.length ? readJson(join(DATA, "forecast.json")) : null;
if (forecast) delete forecast.sources; // 아카이브 문서명 제외

// ── 구역 배치: 자동 생성 카드(slug 가 daily-YYYYMMDD…)는 이번 주 것만 맨 위 "Weekly Brief", 지난주 것은 "Explore"(new),
//    직접 만든 카드와 전망 보드는 모두 "Stories to Read"(read)에 쌓인다. 주는 월요일 10시(KST, 매일 배치 시각)에 바뀐다.
const mondayOf = (d) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; };
const thisMonday = mondayOf(new Date((process.env.INSIGHTS_NOW ? Date.parse(process.env.INSIGHTS_NOW) : Date.now()) + (9 - 10) * 3600e3));
const mmdd = (d) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`;
const weekLabel = `${mmdd(thisMonday)} – ${mmdd(new Date(thisMonday.getTime() + 6 * 864e5))}`;
const sectionOf = (t) => {
  const m = /^daily-(\d{4})(\d\d)(\d\d)/.exec(t.slug);
  if (!m) return t.section === "new" ? "new" : "read"; // 직접 만든 카드: JSON 의 section 값(기본 read)
  return mondayOf(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))).getTime() === thisMonday.getTime() ? "brief" : "new";
};

// ── 트렌드 주제 (기사·영상 기반 이미지 카드 페이지)
const topics = pick(isTopic).map((t) => {
  const ids = new Set([t.heroMedia, t.cardMedia, ...Object.values(t.videos || {}).map((v) => v.media), ...t.sections.flatMap((s) => s.items.map((i) => i.media))].filter(Boolean));
  const media = {};
  for (const id of ids) { const m = usedMedia(id); if (m) media[id] = m; }
  return { slug: t.slug, order: t.order ?? 99, cardMedia: t.cardMedia || t.heroMedia, cardFit: t.cardFit || "cover", card: t.card, cardPos: t.cardPos, section: sectionOf(t), cats: t.cats || [], tag: t.tag || "트렌드", status: t.status, updatedAt: t.approvedAt || t.generatedAt, eyebrow: t.eyebrow, title: t.title, summary: t.summary, heroMedia: t.heroMedia, videos: t.videos || {}, sections: t.sections, sources: t.sources, unverified: t.unverified || [], media };
}).sort((a, b) => a.order - b.order);

// ── 피드 카드: 매출 전망 → 트렌드 주제 → 상품 사례·영상 핀
const feed = [];
for (const b of boards) {
  const hist = [2023, 2024, 2025].map((y) => ({ y, v: forecast.consolidated[y] / 1e6 }));
  const fc = forecast.forecast.total.map((p) => ({ y: p.year, lo: p.p10 / 1e6, mid: p.p50 / 1e6, hi: p.p90 / 1e6 }));
  const last = fc[fc.length - 1];
  feed.push({
    kind: "topic", sec: b.section === "new" ? "new" : "read", href: `${b.slug}.html`, tag: "전망 · GS리테일", cats: ["전망", "재무"], art: { hist, fc },
    title: "GS리테일, 2026년과 향후 3년 — 매출은 어디로 가나",
    sub: `연결 매출 ${hist[2].v.toFixed(1)}조 → ${last.y}년 ${last.mid.toFixed(1)}조(중앙값). 통계 분석·대외환경·위기 요인·고민할 것까지`,
  });
}
const SHAPES = [{ span: 1, h: 540 }, { span: 2, h: 300 }, { span: 1, h: 320 }, { span: 1, h: 440 }];
topics.forEach((t, ti) => {
  const shape = { ...SHAPES[ti % SHAPES.length], ...(t.card || {}) };
  const cm = t.media[t.cardMedia]; // 카드 표지는 대표 사진 한 장(여러 장 모음은 설득력이 떨어짐)
  feed.push({ kind: "topic", href: `${t.slug}.html`, tag: t.tag, title: t.title, src: cm?.src, credit: cm?.credit, fit: t.cardFit, pos: t.cardPos, span: shape.span, h: shape.h, cats: t.cats, sec: t.section });
});
// 메인에는 동작하는 카드만 둔다(빈 칸 없음). 상품 사례·영상 핀은 주제 페이지 안에만 둔다.

const draftCount = [...boards, ...topics].filter((x) => x.status !== "approved").length;
writeFileSync(join(out, "site-data.js"), `window.SITE_DATA=${JSON.stringify({ builtAt: new Date().toISOString(), preview: preview && !process.argv.includes("--no-banner"), weekLabel, draftCount, feed, boards, forecast, topics })};`);
const T = (f) => join(here, "template", f);
const V = Date.now(); // 정적 서버가 CSS·JS 를 캐시해도 새 빌드는 새로 받게 한다
const ver = (h) => ["common.css", "common.js", "ui-extra.css"].reduce((x, f) => x.replace(`${f}"`, `${f}?v=${V}"`), h);
const page = (f, extra = (h) => h) => ver(extra(readFileSync(T(f), "utf8")));
copyFileSync(T("common.css"), join(out, "common.css"));
// 폰트(Pretendard·Outfit, OFL)는 파일째 포함 — 인터넷이 없는 사내망·서버에서도 같은 글씨가 나오게
if (existsSync(T("fonts"))) { const fo = dir(join(out, "fonts")); for (const f of readdirSync(T("fonts"))) copyFileSync(T(join("fonts", f)), join(fo, f)); }
copyFileSync(T("common.js"), join(out, "common.js"));
copyFileSync(T("ui-extra.css"), join(out, "ui-extra.css"));
writeFileSync(join(out, "index.html"), page("feed.html", (h) => h.split("@@GSLOGO@@").join("data:image/png;base64," + readFileSync(T("gsretail-logo.png")).toString("base64"))));
for (const b of boards) writeFileSync(join(out, `${b.slug}.html`), page("board.html"));
for (const t of topics) writeFileSync(join(out, `${t.slug}.html`), page("topic.html", (h) => h.replace('<html lang="ko">', `<html lang="ko" data-slug="${t.slug}">`)));
console.log(`site/ 생성: 피드 카드 ${feed.length} · 전망 보드 ${boards.length} · 트렌드 주제 ${topics.length} (${preview ? "미승인 초안 포함 미리보기" : "승인된 것만"})`);
