// [auto-docu 통계분석] 파라미터 추출 LLM(statsAnalysis.js 1단계)에게 방법별로
// {data, params}를 정확히 어떤 모양으로 채워야 하는지 알려주는 스키마 설명.
// run_analysis.py의 각 m_* 함수가 실제로 읽는 키와 1:1로 맞춰져 있다 — 여기서
// 모양이 틀리면 Python 쪽에서 KeyError로 실패하므로, 이 문자열이 바뀌면
// run_analysis.py도 같이 봐야 한다.
const METHOD_SCHEMAS = {
  linear_regression: {
    label: "선형 회귀",
    schema: `data: {"rows": [{"열이름": 숫자, ...}, ...]}
params: {"target": "종속변수 열이름", "features": ["독립변수 열이름", ...]}`,
  },
  logistic_regression: {
    label: "로지스틱 회귀",
    schema: `data: {"rows": [{"열이름": 숫자, ...}, ...]} (target 열은 반드시 0 또는 1)
params: {"target": "종속변수(0/1) 열이름", "features": ["독립변수 열이름", ...]}`,
  },
  kmeans: {
    label: "군집분석(K-means)",
    schema: `data: {"rows": [{"열이름": 숫자, ...}, ...]}
params: {"features": ["군집에 쓸 열이름", ...], "n_clusters": 정수(기본 3)}`,
  },
  monte_carlo: {
    label: "몬테카를로 시뮬레이션",
    schema: `data: {}
params: {"variables": [{"name":"변수명","distribution":"normal|uniform|triangular","params":{...분포별 파라미터}}, ...],
         "formula": "변수명들을 사용한 산술식(예: revenue - cost)", "n_trials": 정수(기본 10000)}
분포별 params — normal: {mean, std} / uniform: {low, high} / triangular: {low, mode, high}`,
  },
  ttest: {
    label: "t검정",
    schema: `data: {"group_a": [숫자, ...], "group_b": [숫자, ...]}
params: {"paired": true|false(기본 false)}`,
  },
  anova: {
    label: "분산분석(ANOVA)",
    schema: `data: {"groups": {"그룹명1": [숫자,...], "그룹명2": [숫자,...], ...}} (3개 이상 그룹)
params: {}`,
  },
  chi_square: {
    label: "카이제곱검정",
    schema: `data: {"table": [[숫자,...],[숫자,...],...]} (범주 x 범주 분할표, 행=변수1 범주, 열=변수2 범주)
params: {}`,
  },
  descriptive: {
    label: "기술통계",
    schema: `data: {"rows": [{"열이름": 숫자, ...}, ...]}
params: {"columns": ["요약할 열이름", ...]}`,
  },
  correlation: {
    label: "상관분석",
    schema: `data: {"rows": [{"열이름": 숫자, ...}, ...]}
params: {"columns": ["열이름", ...], "method": "pearson|spearman"(기본 pearson)}`,
  },
  time_series: {
    label: "시계열분석",
    schema: `data: {"series": [{"period": "시점(예: 2025-01)", "value": 숫자}, ...]} (시간순 정렬)
params: {"period": 계절주기(정수, 월별=12/분기별=4, 모르면 생략), "forecast_periods": 예측할 미래 기간 수(기본 3)}`,
  },
  decision_tree: {
    label: "의사결정나무",
    schema: `data: {"rows": [{"열이름": 값, ...}, ...]}
params: {"target": "예측 대상 열이름", "features": ["설명변수 열이름", ...], "task": "regression|classification", "max_depth": 정수(기본 3)}`,
  },
  random_forest: {
    label: "랜덤포레스트",
    schema: `data: {"rows": [{"열이름": 값, ...}, ...]}
params: {"target": "예측 대상 열이름", "features": ["설명변수 열이름", ...], "task": "regression|classification", "n_estimators": 정수(기본 100)}`,
  },
  pca: {
    label: "주성분분석(PCA)",
    schema: `data: {"rows": [{"열이름": 숫자, ...}, ...]}
params: {"features": ["압축할 열이름", ...] (3개 이상 권장)}`,
  },
  cohort: {
    label: "코호트분석",
    schema: `data: {"rows": [{"id": "고객/사용자ID", "cohort_period": "가입시점", "activity_period": "활동시점"}, ...]}
params: {}`,
  },
  survival: {
    label: "생존분석",
    schema: `data: {"rows": [{"duration": 관찰기간(숫자), "event": 1(이탈/이벤트 관찰됨) 또는 0(중도절단)}, ...]}
params: {}`,
  },
  market_basket: {
    label: "시장바구니분석",
    schema: `data: {"transactions": [["상품A","상품B",...], ...]} (거래 1건당 상품 목록)
params: {"min_support": 최소 지지도(0~1, 기본 0.05)}`,
  },
  rfm: {
    label: "RFM분석",
    schema: `data: {"rows": [{"customer_id": "고객ID", "recency": 최근구매까지일수, "frequency": 구매횟수, "monetary": 총구매액}, ...]}
params: {}`,
  },
  pareto: {
    label: "파레토분석(80-20)",
    schema: `data: {"rows": [{"label": "품목/거래처명", "value": 숫자}, ...]}
params: {}`,
  },
  outlier: {
    label: "이상치탐지",
    schema: `data: {"rows": [{"열이름": 숫자, ...}, ...]}
params: {"features": ["검사할 열이름", ...], "method": "iqr|isolation_forest"(기본 iqr)}`,
  },
};

const ALL_METHOD_KEYS = Object.keys(METHOD_SCHEMAS);

module.exports = { METHOD_SCHEMAS, ALL_METHOD_KEYS };
