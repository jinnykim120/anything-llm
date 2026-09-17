import { useState } from "react";

// [auto-docu 통계분석] 6줄짜리 통계 방법 선택 UI — 왼쪽 선택 박스 + 오른쪽
// 개념/특징/주요용도 3줄 설명. DraftPanel의 마법사 단계(전체 보고서 생성)와
// ScopedEditOverlay의 블록별 "통계 분석" 애드혹 요청 양쪽에서 그대로
// 재사용한다(부모가 selected/onSelect만 다르게 넘겨주면 됨).
const FIXED_METHODS = [
  {
    key: "linear_regression",
    label: "선형 회귀 (Linear Regression)",
    concept: "독립변수와 종속변수 간의 선형(직선) 관계를 정량화하는 모델",
    feature:
      "모델 구조가 단순해 해석이 쉽고, 원인과 결과 간의 영향력을 직관적으로 파악할 수 있음",
    usage:
      "매출 예측·임금 추정·가격 산정 등 연속적인 수치 예측, 여러 요인을 함께 넣으면 월별 수요예측에도 사용",
  },
  {
    key: "logistic_regression",
    label: "로지스틱 회귀 (Logistic Regression)",
    concept:
      "여러 변수를 바탕으로 어떤 사건이 일어날 확률을 추정해 두 결과 중 하나로 분류하는 모델",
    feature:
      '결과가 "예/아니오"처럼 둘 중 하나일 때 적합, 각 요인이 확률을 얼마나 높이거나 낮추는지 해석 가능',
    usage: "고객 이탈 예측, 구매 가능성 평가, 프로모션 반응 여부 판단",
  },
  {
    key: "kmeans",
    label: "군집분석 (K-means Clustering)",
    concept:
      "고객·데이터를 특성이 비슷한 것끼리 몇 개 그룹으로 자동으로 나누는 모델",
    feature:
      "정답 없이도 데이터 안의 패턴을 찾아내며, 그룹 수는 미리 정해야 함",
    usage: "고객 세분화, 타겟 마케팅 그룹 설정",
  },
  {
    key: "monte_carlo",
    label: "몬테카를로 시뮬레이션",
    concept:
      "불확실한 변수에 난수값을 반복 대입해 가능한 결과들의 분포를 계산하는 시뮬레이션",
    feature:
      '하나의 정답 대신 "수천 번 시도하면 결과가 어떻게 퍼지는가"를 보여줘 리스크 폭까지 파악 가능',
    usage: "매출·수요 시나리오 리스크 분석, 최악/평균/최선 비교",
  },
];

const DROPDOWN_METHODS = [
  {
    key: "ttest",
    name: "t검정 (A/B 그룹 평균 비교)",
    concept: "두 그룹의 평균값이 통계적으로 차이가 있는지 확인하는 검정",
    feature:
      "계산이 간단하고 결과가 명확해 A/B 테스트처럼 두 집단 비교에 바로 쓸 수 있음",
    usage: "광고안 A/B 테스트, 두 매장·두 기간의 평균 매출 비교",
  },
  {
    key: "anova",
    name: "분산분석/ANOVA (3개 이상 그룹 평균 비교)",
    concept:
      "세 개 이상 그룹의 평균을 한 번에 비교해 차이가 있는지 검정하는 모델",
    feature:
      "t검정을 여러 번 반복하지 않고 한 번에 비교할 수 있어 오류 누적을 줄임",
    usage: "여러 지점·여러 프로모션안의 평균 성과 비교",
  },
  {
    key: "chi_square",
    name: "카이제곱검정 (범주형 변수 간 관련성)",
    concept:
      "두 범주형 변수(예: 성별과 구매여부)가 서로 관련이 있는지 검정하는 모델",
    feature: "숫자가 아닌 범주(카테고리) 데이터에도 적용할 수 있음",
    usage: "고객 세그먼트별 구매 여부, 지역별 선호 상품 차이 분석",
  },
  {
    key: "descriptive",
    name: "기술통계 (평균·중앙값·표준편차로 현황 요약)",
    concept:
      "평균·중앙값·표준편차 등으로 데이터의 전체적인 모습을 한눈에 요약하는 방법",
    feature: "별도 모델링 없이 현재 데이터 상태를 빠르게 파악할 수 있음",
    usage: "보고서 첫머리의 현황 요약, 데이터 품질 점검",
  },
  {
    key: "correlation",
    name: "상관분석 (두 변수의 관련성 탐색)",
    concept:
      "두 변수가 같은 방향/반대 방향으로 함께 움직이는 정도를 수치로 나타내는 방법",
    feature:
      "인과관계는 알려주지 않지만 변수 간 관계의 강도와 방향을 빠르게 확인할 수 있음",
    usage: "광고비와 매출, 기온과 판매량처럼 두 지표 간 관련성 탐색",
  },
  {
    key: "time_series",
    name: "시계열분석 (월별·계절 추세 기반 수요예측)",
    concept:
      "시간 순서대로 쌓인 데이터에서 추세와 계절성을 찾아 향후 흐름을 예측하는 모델",
    feature: "계절적으로 반복되는 패턴(연말 성수기 등)을 반영해 예측할 수 있음",
    usage: "월별 매출·수요 예측, 계절상품 재고 계획",
  },
  {
    key: "decision_tree",
    name: "의사결정나무 (조건 분기로 설명 가능한 예측/분류)",
    concept: '"조건이 이렇으면 이렇다"는 분기를 반복해 예측·분류하는 모델',
    feature:
      "결과가 나온 과정을 사람이 따라가며 설명할 수 있음(왜 그렇게 예측했는지가 드러남)",
    usage: "대출 승인 기준, 고객 이탈 조건 설명이 필요한 의사결정",
  },
  {
    key: "random_forest",
    name: "랜덤포레스트 (여러 의사결정나무를 결합한 예측 정확도 향상)",
    concept:
      "여러 개의 의사결정나무를 만들어 결과를 종합해 예측 정확도를 높이는 모델",
    feature:
      "의사결정나무 하나보다 안정적이고 정확하지만, 개별 판단 과정은 덜 직관적임",
    usage: "고객 이탈·구매 예측처럼 정확도가 중요한 예측 업무",
  },
  {
    key: "pca",
    name: "주성분분석/PCA (여러 지표를 핵심 축으로 압축)",
    concept:
      "여러 개의 관련된 지표를 정보 손실을 최소화하며 몇 개의 핵심 축으로 압축하는 방법",
    feature:
      "지표가 너무 많아 한눈에 보기 어려울 때 핵심 흐름만 추려낼 수 있음",
    usage: "여러 재무·운영 지표를 통합 점수로 요약, 지표 간 중복 제거",
  },
  {
    key: "cohort",
    name: "코호트분석 (가입 시기별 그룹의 행동 변화 추적)",
    concept:
      "같은 시기에 시작한 고객 그룹(코호트)의 이후 행동 변화를 시간 흐름대로 추적하는 방법",
    feature:
      "전체 평균으로는 안 보이는, 가입 시기별 잔존·이용 패턴 차이를 드러냄",
    usage: "가입 월별 재구매·재방문율 추적, 서비스 개선 효과 검증",
  },
  {
    key: "survival",
    name: "생존분석 (이탈까지 걸리는 기간 분석)",
    concept:
      "어떤 사건(이탈, 해지 등)이 일어나기까지 걸리는 시간을 분석하는 모델",
    feature:
      "아직 이탈하지 않은(관찰이 끝나지 않은) 고객까지 포함해 계산할 수 있음",
    usage: "고객 이탈 시점 분석, 설비·부품의 고장까지 걸리는 시간 분석",
  },
  {
    key: "market_basket",
    name: "시장바구니분석 (함께 구매되는 상품 조합 패턴)",
    concept: "함께 구매되는 상품 조합의 패턴을 찾아내는 분석",
    feature:
      '"이 상품을 사는 고객은 저 상품도 같이 산다"는 규칙을 지지도·신뢰도로 수치화함',
    usage: "상품 진열·묶음 구성, 추천 상품 선정",
  },
  {
    key: "rfm",
    name: "RFM분석 (최근성·빈도·구매액 기반 고객 등급화)",
    concept:
      "최근 구매일(Recency)·구매 빈도(Frequency)·구매액(Monetary) 세 기준으로 고객을 등급화하는 방법",
    feature: "복잡한 모델 없이도 우수고객·이탈위험고객을 빠르게 구분할 수 있음",
    usage: "고객 등급별 마케팅 차별화, 이탈위험군 선제 대응",
  },
  {
    key: "pareto",
    name: "파레토분석/80-20 (상위 품목·거래처 기여도 우선순위)",
    concept:
      "전체 성과의 대부분(흔히 80%)을 차지하는 상위 항목(흔히 20%)을 찾아내는 분석",
    feature: "계산이 단순하면서도 어디에 자원을 집중해야 할지 바로 보여줌",
    usage: "매출 상위 거래처·품목 파악, 자원 배분 우선순위 결정",
  },
  {
    key: "outlier",
    name: "이상치탐지 (비정상 거래·매출 자동 탐지)",
    concept:
      "전체 데이터 패턴에서 벗어난 비정상적인 값을 자동으로 찾아내는 방법",
    feature: "사람이 일일이 훑어보지 않아도 이상 신호를 먼저 걸러낼 수 있음",
    usage: "비정상 거래·매출 급변 탐지, 데이터 입력 오류 점검",
  },
];

const AUTO_METHOD = {
  key: "auto",
  label: "미정",
  concept: "어떤 통계 모델을 써야 할지 모를 때 선택",
  feature: "입력한 목적과 자료 내용을 보고 AI가 적합한 모델을 대신 선택",
  usage: '통계 지식 없이 "이런 걸 알고 싶다"는 목적만 설명해도 됨',
};

// "선형 회귀 (Linear Regression)" 같은 라벨은 한글/영문 괄호를 줄바꿈해서
// 좁은 박스 안에서도 읽기 좋게 만든다. 괄호가 없는 라벨(예: "미정")은 그대로.
function MethodLabel({ text }) {
  const parenIndex = text.indexOf(" (");
  if (parenIndex === -1) return text;
  return (
    <>
      <span className="block">{text.slice(0, parenIndex)}</span>
      <span className="block">{text.slice(parenIndex + 1)}</span>
    </>
  );
}

function Row({ entry, selected, onClick, boxLabel }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full gap-3 rounded-md border p-2.5 text-left transition-colors ${
        selected
          ? "border-blue-500 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/30"
          : "border-slate-200 hover:border-blue-300 dark:border-zinc-800 dark:hover:border-blue-800"
      }`}
    >
      <span
        className={`flex w-32 flex-none flex-col items-center justify-center rounded-md border px-2 py-1.5 text-center font-mono text-[11px] font-semibold leading-tight ${
          selected
            ? "border-blue-500 bg-blue-600 text-white"
            : "border-slate-200 bg-slate-50 text-slate-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        }`}
      >
        <MethodLabel text={boxLabel || entry.label} />
      </span>
      <span className="flex-1 space-y-0.5 overflow-hidden text-[11px] leading-4 text-slate-600 dark:text-zinc-400">
        <span className="block truncate">
          <b className="text-slate-500 dark:text-zinc-300">개념</b>{" "}
          {entry.concept}
        </span>
        <span className="block truncate">
          <b className="text-slate-500 dark:text-zinc-300">특징</b>{" "}
          {entry.feature}
        </span>
        <span className="block truncate">
          <b className="text-slate-500 dark:text-zinc-300">주요용도</b>{" "}
          {entry.usage}
        </span>
      </span>
    </button>
  );
}

/**
 * @param {{selected:string|null, onSelect:(methodKey:string)=>void}} props
 */
export default function StatsMethodPicker({ selected, onSelect }) {
  const [dropdownPreview, setDropdownPreview] = useState(""); // 미확정 드롭다운 선택
  const previewEntry = DROPDOWN_METHODS.find((m) => m.key === dropdownPreview);
  const selectedDropdownEntry = DROPDOWN_METHODS.find(
    (m) => m.key === selected
  );

  return (
    <div className="flex flex-col gap-1.5">
      {FIXED_METHODS.map((entry) => (
        <Row
          key={entry.key}
          entry={entry}
          selected={selected === entry.key}
          onClick={() => onSelect(entry.key)}
        />
      ))}

      {/* 5번 줄 — 15개 드롭다운. 드롭다운에서 고르는 즉시 그 자리에서 선택 확정. */}
      <div
        className={`flex w-full gap-3 rounded-md border p-2.5 text-left transition-colors ${
          selectedDropdownEntry
            ? "border-blue-500 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/30"
            : "border-slate-200 dark:border-zinc-800"
        }`}
      >
        <div
          className={`flex w-32 flex-none flex-col items-center justify-center gap-1 rounded-md border px-1.5 py-1.5 text-center font-mono text-[10px] font-semibold leading-tight ${
            selectedDropdownEntry
              ? "border-blue-500 bg-blue-600 text-white"
              : "border-slate-200 bg-slate-50 text-slate-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          }`}
        >
          {selectedDropdownEntry ? (
            <MethodLabel text={selectedDropdownEntry.name} />
          ) : (
            "추가 방법 15종"
          )}
        </div>
        <div className="flex-1 space-y-1">
          <select
            value={dropdownPreview}
            onChange={(e) => {
              const value = e.target.value;
              setDropdownPreview(value);
              if (value) onSelect(value);
            }}
            className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 outline-none focus:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
          >
            <option value="">방법을 골라 미리보기 →</option>
            {DROPDOWN_METHODS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.name}
              </option>
            ))}
          </select>
          {(previewEntry || selectedDropdownEntry) && (
            <span className="block space-y-0.5 text-[11px] leading-4 text-slate-600 dark:text-zinc-400">
              <span className="block truncate">
                <b className="text-slate-500 dark:text-zinc-300">개념</b>{" "}
                {(previewEntry || selectedDropdownEntry).concept}
              </span>
              <span className="block truncate">
                <b className="text-slate-500 dark:text-zinc-300">특징</b>{" "}
                {(previewEntry || selectedDropdownEntry).feature}
              </span>
              <span className="block truncate">
                <b className="text-slate-500 dark:text-zinc-300">주요용도</b>{" "}
                {(previewEntry || selectedDropdownEntry).usage}
              </span>
            </span>
          )}
        </div>
      </div>

      <Row
        entry={AUTO_METHOD}
        selected={selected === "auto"}
        onClick={() => onSelect("auto")}
        boxLabel="미정"
      />
    </div>
  );
}
