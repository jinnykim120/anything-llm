// [auto-docu PPT 렌더링 점검] 슬라이드 스펙 → .pptx → (LibreOffice) PDF → PNG.
// 글자 넘침·겹침 같은 레이아웃 문제를 눈으로 확인하는 수동 QA 도구다(서버 기능
// 아님, Claude 호출 없음).
//
//   node server/scripts/ppt-render-check.js [spec.json] [outDir]
//     spec.json 생략 시 모든 레이아웃이 들어간 샘플 덱을 쓴다.
//     결과: outDir/deck.pptx, deck.pdf, slide-01.png … (기본 outDir = ./ppt-check)
//
// 필요: LibreOffice(soffice). 경로는 SOFFICE_PATH 환경변수 또는 아래 기본
// 위치에서 찾는다. PNG 변환은 python 의 pymupdf(`pip install pymupdf`)를 쓰고,
// 없으면 PDF까지만 만든다.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { polishSlides } = require("../utils/exporters/pptSpecPolish");
const { renderPptx } = require("../utils/exporters/pptxRenderer");

const SAMPLE_SLIDES = [
  {
    layout: "section",
    title: "1. 사업 개요",
    subtitle: "GS리테일의 2025년 성과를 요약합니다",
  },
  {
    layout: "stat",
    title: "2025년 핵심 지표",
    stats: [
      { value: "11.9조원", label: "연 매출", note: "전년 대비 +3.3%" },
      { value: "5,320억원", label: "영업이익", note: "전년 대비 +5.1%" },
      { value: "1.8만개", label: "편의점 점포" },
    ],
  },
  {
    layout: "content",
    title: "연도별 매출 추이(단위: 조원)",
    table: {
      headers: ["연도", "매출액(조원)", "영업이익(억원)"],
      rows: [
        ["2023", "11.08", "4,210"],
        ["2024", "11.58", "4,880"],
        ["2025", "11.96", "5,320"],
      ],
    },
  },
  {
    layout: "content",
    title: "사업부별 매출 비중",
    table: {
      headers: ["사업부", "비중(%)"],
      rows: [
        ["편의점", "62"],
        ["수퍼마켓", "21"],
        ["홈쇼핑", "17"],
      ],
    },
  },
  {
    layout: "section",
    title: "2. 전략과 계획",
    subtitle: "성장 동력과 향후 일정을 정리합니다",
  },
  {
    layout: "compare",
    title: "편의점 vs 수퍼마켓",
    columns: [
      {
        heading: "편의점BU",
        items: [
          "점포 수 확대 지속",
          "즉석식품 매출 성장",
          "심야 시간대 수요 증가",
        ],
      },
      {
        heading: "수퍼마켓BU",
        items: ["신선식품 경쟁력 강화", "배송 서비스 확대", "점포 리뉴얼 진행"],
      },
    ],
  },
  {
    layout: "timeline",
    title: "향후 추진 일정",
    steps: [
      { label: "2026 1분기", text: "조직 개편 및 KPI 확정" },
      { label: "2026 2분기", text: "신규 점포 200개 개점" },
      { label: "2026 3분기", text: "통합 물류센터 가동" },
      { label: "2026 4분기", text: "연간 성과 평가" },
    ],
  },
  {
    layout: "content",
    title:
      "주요 성과 요약 및 시사점을 한 줄로 정리하면 이렇게 매우 길어지는 제목의 경우",
    content: [
      "점포 수 증가",
      "매출 성장",
      "이익률 개선",
      "고객 만족도 상승",
      "신규 서비스 도입",
      "비용 효율화",
      "ESG 경영 강화",
    ],
  },
  {
    layout: "content",
    title: "이슈 및 리스크",
    content: [
      "경쟁 심화로 인한 출점 경쟁이 지속되고 있으며 상권 잠식 우려가 있음 (추가 확인 필요)",
      "최저임금 인상에 따른 인건비 부담이 확대되어 점포 수익성에 영향을 줄 수 있음",
      "원자재 가격 변동으로 PB 상품 원가율이 상승할 가능성이 존재함",
      "규제 환경 변화(영업시간 제한 등)에 대한 모니터링이 필요함",
    ],
  },
  {
    layout: "content",
    title: "세부 지표",
    table: {
      headers: ["항목", "2024", "2025", "비고"],
      rows: [
        ["매출", "11.58조", "11.96조", "증가"],
        ["영업이익", "4,880억", "5,320억", "증가"],
        ["점포수", "17,500", "18,000", "증가"],
        ["직원수", "12,000", "12,300", "증가"],
        ["부채비율", "150%", "140%", "개선"],
        ["ROE", "8.1%", "8.9%", "개선"],
        ["배당", "300원", "350원", "증가"],
        ["EPS", "4,100", "4,500", "증가"],
        ["BPS", "51,000", "54,000", "증가"],
        ["PER", "9.1", "8.7", "하락"],
      ],
    },
  },
  {
    layout: "quote",
    title: "핵심 메시지",
    quote: "데이터로 연결된 현장이 가장 빠른 의사결정을 만든다",
    subtitle: "2025년 경영 방침",
  },
];

function findSoffice() {
  const candidates = [
    process.env.SOFFICE_PATH,
    "D:/LibreOffice/program/soffice.exe",
    "C:/Program Files/LibreOffice/program/soffice.exe",
    "soffice",
  ].filter(Boolean);
  return candidates.find((c) => c === "soffice" || fs.existsSync(c));
}

async function main() {
  const specPath = process.argv[2];
  const outDir = path.resolve(process.argv[3] || "ppt-check");
  fs.mkdirSync(outDir, { recursive: true });

  const spec = specPath
    ? JSON.parse(fs.readFileSync(specPath, "utf8"))
    : {
        title: "NEXUS 레이아웃 점검",
        theme: "corporate",
        slides: SAMPLE_SLIDES,
      };
  const { slides, notes } = polishSlides(spec.slides);
  if (notes.length) console.log("후처리:", notes.join(" · "));

  const pptxPath = path.join(outDir, "deck.pptx");
  fs.writeFileSync(pptxPath, await renderPptx({ ...spec, slides }));
  console.log("pptx:", pptxPath, `(${slides.length}장 + 표지)`);

  const soffice = findSoffice();
  if (!soffice)
    return console.log(
      "LibreOffice 를 찾지 못해 PDF 변환을 건너뜁니다(SOFFICE_PATH 설정)."
    );
  const conv = spawnSync(
    soffice,
    ["--headless", "--convert-to", "pdf", "--outdir", outDir, pptxPath],
    { timeout: 180000 }
  );
  const pdfPath = path.join(outDir, "deck.pdf");
  if (conv.status !== 0 || !fs.existsSync(pdfPath))
    return console.log(
      "PDF 변환 실패:",
      String(conv.stderr || conv.error || "")
    );
  console.log("pdf :", pdfPath);

  const py = spawnSync(
    "python",
    [
      "-c",
      "import sys,pymupdf\nd=pymupdf.open(sys.argv[1])\nfor i,p in enumerate(d):p.get_pixmap(dpi=90).save(f'{sys.argv[2]}/slide-{i+1:02d}.png')\nprint(len(d))",
      pdfPath,
      outDir,
    ],
    { encoding: "utf8" }
  );
  if (py.status === 0)
    console.log(`png : ${path.join(outDir, "slide-01.png")} … (${py.stdout.trim()}장)`);
  else console.log("PNG 변환 생략(pip install pymupdf 필요).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
