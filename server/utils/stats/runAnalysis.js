// [auto-docu 통계분석] run_analysis.py를 실제로 실행해 결과를 받아온다 —
// collector/processSingleFile/convert/asHwp.js가 hwp_extract.py를 부르는
// 방식(같은 docling venv의 python.exe, spawnSync, 성공/실패는 종료코드로
// 판정)을 그대로 따른다. LLM은 여기서 나온 실수치만 보고 서술을 쓴다
// (server/endpoints/statsAnalysis.js) — 이 파일 자체는 숫자를 만들어내지
// 않고 Python 결과를 그대로 전달만 한다.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const VENV = path.join(REPO_ROOT, ".local-cache/docling-venv/Scripts");
const EXE = process.platform === "win32" ? ".exe" : "";
const PYTHON_BIN =
  process.env.STATS_PYTHON_BIN || path.join(VENV, `python${EXE}`);
const RUN_ANALYSIS_PY = path.join(__dirname, "run_analysis.py");

const METHOD_LABELS = {
  linear_regression: "선형 회귀",
  logistic_regression: "로지스틱 회귀",
  kmeans: "군집분석(K-means)",
  monte_carlo: "몬테카를로 시뮬레이션",
  ttest: "t검정",
  anova: "분산분석(ANOVA)",
  chi_square: "카이제곱검정",
  descriptive: "기술통계",
  correlation: "상관분석",
  time_series: "시계열분석",
  decision_tree: "의사결정나무",
  random_forest: "랜덤포레스트",
  pca: "주성분분석(PCA)",
  cohort: "코호트분석",
  survival: "생존분석",
  market_basket: "시장바구니분석",
  rfm: "RFM분석",
  pareto: "파레토분석(80-20)",
  outlier: "이상치탐지",
};

/**
 * @param {{method:string, data:object, params:object}} payload
 * @returns {Promise<{ok:true, method:string, result:object}|{ok:false, method:string, error:string}>}
 */
async function runAnalysis(payload) {
  const { method } = payload;
  if (!METHOD_LABELS[method])
    return {
      ok: false,
      method,
      error: `알 수 없는 분석 방법입니다: ${method}`,
    };

  const tmpFile = path.join(
    os.tmpdir(),
    `auto-docu-stats-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(payload), "utf-8");
    const res = spawnSync(PYTHON_BIN, [RUN_ANALYSIS_PY, tmpFile], {
      encoding: "utf-8",
      timeout: 60000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });

    if (res.status !== 0 || !res.stdout?.trim()) {
      const why = (res.stderr || res.error?.message || "no output")
        .split("\n")
        .find((l) => l.trim());
      return { ok: false, method, error: why || "통계 계산에 실패했습니다." };
    }

    const result = JSON.parse(res.stdout);
    return { ok: true, method, result };
  } catch (e) {
    return { ok: false, method, error: e.message };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* best effort */
    }
  }
}

module.exports = { runAnalysis, METHOD_LABELS };
