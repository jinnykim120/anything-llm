// GS리테일 부문별 매출 전망 (2026E–2028E) → data/forecast.json
//
// 입력: 아카이브의 general 등급 사업보고서/반기 XBRL 재무제표(표 파싱) — 숫자를 손으로 옮기지 않는다.
// 방법: ① 2026E = 확정된 상반기 + 지난해 하반기 × (1+하반기 성장률), 하반기 성장률은 기저효과를 감안해 상반기값에서 30% 감쇠
//       ② 2027E~ = 감쇠 성장(damped trend): g(t) = φ·g(t-1) + (1-φ)·g_LR + 충격
//       ③ 충격 = 공통 거시 요인 + 부문 고유 요인의 정규분포, σ는 부문의 과거 성장률 변동에서 추정
//       ④ 몬테카를로 20,000회 → P10 / P50 / P90 구간
// 한계: 연간 3개 시점 + 반기 1개 시점뿐이라 통계적 신뢰도는 낮다. 점추정이 아니라 구간으로 읽을 것.
//
//   node insights-site/forecast.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, dir, generalDocByTitle } from "./lib.mjs";

const num = (s) => Number(String(s).replace(/,/g, "").trim());

// "### 사업부문별 (연결, 2025-01-01~2025-12-31)" 블록들 → { "2025-01-01~2025-12-31": {부문:{rev,op}} }
function segmentBlocks(md) {
  const out = {};
  const parts = md.split(/^### 사업부문별 \(연결, /m).slice(1);
  for (const p of parts) {
    const period = p.slice(0, p.indexOf(")"));
    const lines = p.split("\n").filter((l) => l.startsWith("|"));
    const head = lines[0].split("|").map((s) => s.trim()).slice(2, -1);
    const row = (re) => lines.find((l) => re.test((l.split("|")[1] || "").trim()));
    const revL = row(/^수익/);
    const opL = row(/^보고부문 영업이익/);
    const segs = {};
    head.forEach((name, i) => {
      const rev = num(revL.split("|").map((s) => s.trim()).slice(2, -1)[i]);
      const op = num(opL.split("|").map((s) => s.trim()).slice(2, -1)[i]);
      segs[name] = { rev, op };
    });
    out[period] = segs;
  }
  return out;
}

function consolidated(md) {
  const i = md.indexOf("## 연결 포괄손익계산서");
  const l = md.slice(i).split("\n").find((x) => /^\| 수익\(매출액\)/.test(x));
  const c = l.split("|").map((s) => s.trim()).slice(2, -1).map(num);
  const op = md.slice(i).split("\n").find((x) => /^\| 보고부문 영업이익/.test(x)).split("|").map((s) => s.trim()).slice(2, -1).map(num);
  return { rev: c, op }; // [당기, 전기, 전전기]
}

const need = (re) => {
  const d = generalDocByTitle(re);
  if (!d) throw new Error(`general 문서 없음: ${re}`);
  return d;
};
const d25 = need(/2025년 사업보고서 재무제표/);
const d24 = need(/2024년 사업보고서 재무제표/);
const dH1 = need(/2026년 반기 재무제표/);
const b25 = segmentBlocks(d25.text);
const b24 = segmentBlocks(d24.text);
const bH1 = segmentBlocks(dH1.text);
const cons25 = consolidated(d25.text); // 2025, 2024, 2023 (호텔 제외 재작성)

const SEGS = ["편의점", "수퍼마켓", "홈쇼핑", "기타"];
const pick = (blocks, start) => blocks[Object.keys(blocks).find((k) => k.startsWith(start))];
// 기타 = 개발 + 공통및기타 (+ 합계가 연결 매출과 맞도록 산출)
function fold(b) {
  const g = (n) => b[n] || { rev: 0, op: 0 };
  return {
    편의점: g("편의점"),
    수퍼마켓: g("수퍼마켓"),
    홈쇼핑: g("홈쇼핑"),
    기타: { rev: g("개발").rev + g("공통및기타").rev, op: g("개발").op + g("공통및기타").op },
  };
}
const hist = {
  2023: fold(pick(b24, "2023")),
  2024: fold(pick(b25, "2024")),
  2025: fold(pick(b25, "2025")),
};
// 2023은 구 보고서 기준 → 연결 매출(재작성)에 맞춰 '기타'를 대사
hist[2023].기타.rev = cons25.rev[2] - hist[2023].편의점.rev - hist[2023].수퍼마켓.rev - hist[2023].홈쇼핑.rev;
const h1 = { 2025: fold(pick(bH1, "2025")), 2026: fold(pick(bH1, "2026")) };

// ---- 가정 (외부 자료 근거는 research.json 참조) ----
const A = {
  phi: 0.6,
  // 장기 성장 앵커(연, %): 업황 자료를 반영한 판단값 — 숫자를 바꿔 민감도를 볼 수 있다
  gLR: { 편의점: 0.02, 수퍼마켓: 0.04, 홈쇼핑: -0.015, 기타: -0.03 },
  sigmaFloor: 0.02,
  h2Fade: 0.3, // 하반기 성장률을 장기 앵커 쪽으로 당기는 비율(기저효과 소멸)
  sigma2026: 0.012, // 하반기 불확실성
  macroLoading: 0.6,
  sims: 20000,
};

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
const sd = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
const summarize = (a) => {
  const x = [...a].sort((p, r) => p - r);
  return { p10: Math.round(q(x, 0.1)), p50: Math.round(q(x, 0.5)), p90: Math.round(q(x, 0.9)) };
};
const YEARS = [2026, 2027, 2028];

// 가정 세트 A 로 모델을 추정하고 시뮬레이션한다(민감도 분석을 위해 함수화, 시드 고정).
function run(A) {
  const rnd = mulberry32(20261027);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const model = {};
  for (const s of SEGS) {
    const r = [2023, 2024, 2025].map((y) => hist[y][s].rev);
    const yoy = [r[1] / r[0] - 1, r[2] / r[1] - 1];
    const h1share = h1[2025][s].rev / r[2]; // 참고용: 지난해 상반기 비중
    const h1yoy = h1[2026][s].rev / h1[2025][s].rev - 1;
    // 2026E = 확정된 상반기 + 지난해 하반기 × (1 + 하반기 성장률). 지난해 상반기는 기저가 낮아
    // 상반기 성장률이 부풀려져 있으므로 하반기 성장률은 상반기 값에서 장기 앵커 쪽으로 h2Fade 만큼 감쇠.
    const gH2 = (1 - A.h2Fade) * h1yoy + A.h2Fade * A.gLR[s];
    const e26 = h1[2026][s].rev + (r[2] - h1[2025][s].rev) * (1 + gH2);
    const g26 = e26 / r[2] - 1;
    const sigma = Math.max(A.sigmaFloor, sd([...yoy, h1yoy]));
    model[s] = { r, yoy, h1yoy, h1share, gH2, e26, g26, sigma };
  }
  const paths = { total: [[], [], []] };
  for (const s of SEGS) paths[s] = [[], [], []];
  for (let n = 0; n < A.sims; n++) {
    const macro = [gauss(), gauss()]; // 2027, 2028 공통 충격
    const tot = [0, 0, 0];
    for (const s of SEGS) {
      const m = model[s];
      // 2026: 상반기는 확정 → 하반기만 불확실
      let v = m.e26 * (1 + A.sigma2026 * gauss());
      paths[s][0].push(v);
      tot[0] += v;
      let g = m.g26;
      for (let t = 1; t <= 2; t++) {
        const shock = m.sigma * (A.macroLoading * macro[t - 1] + Math.sqrt(1 - A.macroLoading ** 2) * gauss());
        g = A.phi * g + (1 - A.phi) * A.gLR[s] + shock;
        v = v * (1 + g);
        paths[s][t].push(v);
        tot[t] += v;
      }
    }
    for (let t = 0; t < 3; t++) paths.total[t].push(tot[t]);
  }
  const forecast = {};
  for (const k of [...SEGS, "total"]) forecast[k] = YEARS.map((y, i) => ({ year: y, ...summarize(paths[k][i]) }));
  return { model, forecast };
}

const { model, forecast } = run(A);

// 민감도: 핵심 가정을 하나씩 흔들었을 때 2028E 연결 매출 중앙값이 얼마나 움직이는가
const shiftAnchor = (d) => ({ ...A, gLR: Object.fromEntries(SEGS.map((s) => [s, A.gLR[s] + d])) });
const sens28 = (label, a) => ({ label, p50: run(a).forecast.total[2].p50 });
const baseP50 = forecast.total[2].p50;
const sensitivity = [
  sens28("장기 성장 앵커 -1%p (전 부문)", shiftAnchor(-0.01)),
  sens28("장기 성장 앵커 +1%p (전 부문)", shiftAnchor(0.01)),
  sens28("하반기 기저효과 감쇠 0% (상반기 성장률 유지)", { ...A, h2Fade: 0 }),
  sens28("하반기 기저효과 감쇠 60%", { ...A, h2Fade: 0.6 }),
  sens28("성장 관성 φ 0.3 (빨리 앵커로 복귀)", { ...A, phi: 0.3 }),
  sens28("성장 관성 φ 0.8 (현재 성장세 오래 유지)", { ...A, phi: 0.8 }),
].map((x) => ({ ...x, delta: x.p50 - baseP50 }));

// 이익률 이력 & 회사 목표 정합성 체크 (영업이익 3,800억원 @2028, 출처: 2026.8 2Q 실적 보도)
const margins = {};
for (const s of SEGS)
  margins[s] = { 2023: hist[2023][s].op / hist[2023][s].rev, 2024: hist[2024][s].op / hist[2024][s].rev, 2025: hist[2025][s].op / hist[2025][s].rev,
    h1_2025: h1[2025][s].op / h1[2025][s].rev, h1_2026: h1[2026][s].op / h1[2026][s].rev };
const consOp = { 2023: cons25.op[2], 2024: cons25.op[1], 2025: cons25.op[0] };
const target = 380000; // 백만원
const rev28 = forecast.total[2];
const targetCheck = {
  target,
  consOp2025: consOp[2025],
  margin2025: consOp[2025] / cons25.rev[0],
  requiredMargin: { p10: target / rev28.p10, p50: target / rev28.p50, p90: target / rev28.p90 },
  note: "연결 영업이익 3,800억원(2028) 달성에 필요한 영업이익률. 2025 실적 대비 얼마나 높여야 하는지를 보여준다.",
};

const out = {
  generatedAt: new Date().toISOString(),
  unit: "백만원",
  sources: [d25.title, d24.title, dH1.title],
  history: Object.fromEntries(Object.entries(hist).map(([y, v]) => [y, Object.fromEntries(SEGS.map((s) => [s, v[s].rev]))])),
  consolidated: { 2023: cons25.rev[2], 2024: cons25.rev[1], 2025: cons25.rev[0] },
  consolidatedOp: consOp,
  h1: { 2025: Object.fromEntries(SEGS.map((s) => [s, h1[2025][s].rev])), 2026: Object.fromEntries(SEGS.map((s) => [s, h1[2026][s].rev])) },
  model: Object.fromEntries(SEGS.map((s) => [s, { yoy: model[s].yoy, h1yoy: model[s].h1yoy, gH2: model[s].gH2, g2026: model[s].g26, sigma: model[s].sigma }])),
  assumptions: A,
  forecast,
  sensitivity,
  // 연도별 중앙값 성장률(전년 대비) — 부문·연결
  growth: Object.fromEntries(
    [...SEGS, "total"].map((k) => {
      const series = [k === "total" ? cons25.rev[0] : hist[2025][k].rev, ...forecast[k].map((f) => f.p50)];
      return [k, forecast[k].map((f, i) => ({ year: f.year, g: f.p50 / series[i] - 1 }))];
    })
  ),
  // 매출 구성비(부문 합계 기준): 2023 · 2025 · 2028E(중앙값)
  mix: (() => {
    const share = (get) => {
      const t = SEGS.reduce((a, s) => a + get(s), 0);
      return Object.fromEntries(SEGS.map((s) => [s, get(s) / t]));
    };
    return { 2023: share((s) => hist[2023][s].rev), 2025: share((s) => hist[2025][s].rev), "2028E": share((s) => forecast[s][2].p50) };
  })(),
  margins,
  targetCheck,
  caveats: [
    "연간 3개 시점(2023–2025) + 반기 1개 시점(2026 H1)만으로 추정 — 통계적 신뢰도가 낮아 구간(P10–P90)으로 제시",
    "2021–22 연결 수치는 호텔 부문 분리·합병 영향으로 비교 불가해 제외",
    "'기타' = 개발 + 공통및기타. 2023은 연결 매출에 맞춰 대사한 산출값",
    "장기 성장 앵커(gLR)는 외부 업황 자료를 반영한 판단값이며 모델의 핵심 가정",
  ],
};
dir(DATA);
writeFileSync(join(DATA, "forecast.json"), JSON.stringify(out, null, 2));

const eok = (v) => (v / 100).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
console.log("부문별 이력(억원):", JSON.stringify(Object.fromEntries(Object.entries(out.history).map(([y, v]) => [y, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, eok(x)]))]))));
for (const k of [...SEGS, "total"]) console.log(k.padEnd(5), forecast[k].map((f) => `${f.year}: ${eok(f.p10)}~${eok(f.p50)}~${eok(f.p90)}`).join(" | "));
console.log("σ:", Object.fromEntries(SEGS.map((s) => [s, model[s].sigma.toFixed(3)])), "g26:", Object.fromEntries(SEGS.map((s) => [s, model[s].g26.toFixed(3)])));
console.log("목표 3,800억 필요 영업이익률:", Object.fromEntries(Object.entries(targetCheck.requiredMargin).map(([k, v]) => [k, (v * 100).toFixed(2) + "%"])), "2025 실제:", (targetCheck.margin2025 * 100).toFixed(2) + "%");
