// [auto-docu] DraftPanel 이 쓰는 정적 상수(문서 범위·보고서 유형·PPT 템플릿·슬라이드 유형 라벨).
// index.jsx 에서 분리 — 상태/로직 없음.

export const SLIDE_LAYOUT_LABEL = {
  section: "구분",
  content: "내용",
  content2: "내용(2단)",
  stat: "핵심 수치",
  compare: "비교",
  timeline: "타임라인",
  quote: "인용",
  agenda: "목차",
};

// 1단계: 어떤 자료를 근거로 쓸지.
export const DATA_SCOPES = [
  {
    key: "answer_only",
    label: "답변 내용 기반으로",
    desc: "지금 답변에만 근거해서 작성합니다 · 새로운 사실은 추가하지 않음",
  },
  {
    key: "answer_plus_web",
    label: "답변 내용 + 외부 데이터",
    desc: "답변 내용에 최신 웹 검색 자료를 더해 내용을 보강합니다",
  },
];
export const DATA_SCOPE_LABEL = {
  answer_only: "답변 내용 기반으로",
  answer_plus_web: "답변 내용 + 외부 데이터",
};

// PPT 미리보기는 실제 슬라이드를 시각적으로 흉내내지 않는 구조화된 목록이므로
// (기존 표 미리보기와 같은 원칙), 차트도 실제 그래프를 그리는 대신 라벨이
// 붙은 자리표시자로만 보여준다.
export const CHART_TYPE_LABEL = {
  bar: "막대 그래프",
  line: "선 그래프",
  pie: "원형 그래프",
};

// 2단계: 어떤 형태의 문서로 만들지 — 1단계 선택에 따라 설명이 달라진다.
// [auto-docu 통계분석] 통계분석 보고서 유형 — 실제 scikit-learn/statsmodels
// 계산을 거친 서술을 만든다(기본/분석보고서처럼 LLM이 통째로 지어내지 않음).
// PPT 쪽에는 의도적으로 없음(사용자 결정 — PPT에서는 이 기능의 가치가 낮음).
export const STATS_REPORT_TYPE = {
  key: "stats",
  label: "통계분석",
  desc: "회귀·군집분석 등 실제 통계 계산을 거쳐 수치를 분석합니다.",
};
export const REPORT_TYPES = {
  answer_only: [
    {
      key: "basic",
      label: "기본보고서",
      desc: "답변 내용을 목적 / 배경 / 현황 구조로 정리합니다.",
    },
    {
      key: "analysis",
      label: "분석보고서",
      desc: "위 내용에 시사점 · 검토의견 · 향후조치(건의)를 덧붙입니다.",
    },
    STATS_REPORT_TYPE,
  ],
  answer_plus_web: [
    {
      key: "basic",
      label: "기본보고서",
      desc: "답변 + 외부 자료를 종합해 더 풍부한 현황으로 정리합니다.",
    },
    {
      key: "analysis",
      label: "분석보고서",
      desc: "위 내용에 관련 동향 · 문제점 및 리스크 파악을 덧붙입니다.",
    },
    STATS_REPORT_TYPE,
  ],
};
export const REPORT_TYPE_LABEL = {
  basic: "기본보고서",
  analysis: "분석보고서",
  stats: "통계분석",
};

// PPT 목적별 템플릿 — server/endpoints/pptDraft.js의 PPT_TEMPLATES와 라벨을
// 맞춘 프론트엔드 전용 목록(서버 설정을 그대로 불러오지 않고 문구만 맞춤).
export const PPT_TEMPLATES = [
  {
    key: "analysis",
    label: "내용 분석",
    desc: "자료를 구조적으로 분석해 핵심 내용을 정리합니다.",
  },
  {
    key: "proposal",
    label: "제안",
    desc: "문제 제기부터 제안 내용, 기대효과까지 구성합니다.",
  },
  {
    key: "performance",
    label: "성과보고",
    desc: "주요 성과와 지표를 중심으로 보고합니다.",
  },
  {
    key: "status",
    label: "현황보고",
    desc: "현재 상태와 진행 상황을 정리해 보고합니다.",
  },
  {
    key: "data",
    label: "데이터 분석",
    desc: "수치·통계 자료를 표와 함께 분석적으로 제시합니다.",
  },
];
export const PPT_TEMPLATE_LABEL = Object.fromEntries(
  PPT_TEMPLATES.map((t) => [t.key, t.label])
);
export const MIN_SLIDE_COUNT = 4;
export const MAX_SLIDE_COUNT = 20;
