# [auto-docu 통계분석] 실제 수치 계산 백엔드 — LLM이 숫자를 지어내지 않도록,
# LLM이 뽑아낸 파라미터를 받아 scikit-learn/statsmodels/scipy로 진짜 계산만
# 한다(서술은 이 결과를 받아 별도 LLM 호출이 담당 — runAnalysis.js 참고).
#
# I/O 규약은 collector/utils/hwp/hwp_extract.py와 동일한 모양(단일 파일 경로
# 인자, 실패 시 0이 아닌 종료코드+stderr, 성공 시 stdout)을 따르되, 입력이
# 구조화된 JSON이라 인자 자체가 아니라 그 JSON을 담은 임시파일의 경로를
# 받는다:  python run_analysis.py <payload.json 경로>
#   payload = {"method": "<15+4개 중 하나>", "data": {...}, "params": {...}}
# 성공 시 stdout에 결과 JSON 객체 하나만 쓰고 종료코드 0, 실패 시 stderr에
# 에러 메시지를 쓰고 종료코드 1 (hwp_extract.py와 동일한 성공/실패 신호
# 방식). 바깥 {"ok", "method"} 래핑은 runAnalysis.js가 붙인다.
import json
import sys
import math

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _to_numeric_if_possible(series):
    import pandas as pd

    try:
        return pd.to_numeric(series)
    except (ValueError, TypeError):
        return series


def _df(rows, columns=None):
    import pandas as pd

    df = pd.DataFrame(rows)
    if columns:
        df = df[[c for c in columns if c in df.columns]]
    return df.apply(_to_numeric_if_possible)


def _round(obj, nd=6):
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return round(obj, nd)
    if isinstance(obj, dict):
        return {k: _round(v, nd) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_round(v, nd) for v in obj]
    try:
        import numpy as np

        if isinstance(obj, np.generic):
            return _round(obj.item(), nd)
    except Exception:
        pass
    return obj


# ---------------------------------------------------------------- 4개 필수 ---
def m_linear_regression(data, params):
    import statsmodels.api as sm

    rows = data["rows"]
    target = params["target"]
    features = params["features"]
    df = _df(rows, [target] + features).dropna()
    X = sm.add_constant(df[features])
    y = df[target]
    model = sm.OLS(y, X).fit()
    conf = model.conf_int()
    return {
        "n": int(len(df)),
        "intercept": model.params.get("const"),
        "coefficients": {f: model.params.get(f) for f in features},
        "p_values": {f: model.pvalues.get(f) for f in features},
        "conf_int_95": {
            f: [conf.loc[f, 0], conf.loc[f, 1]] for f in features if f in conf.index
        },
        "r_squared": model.rsquared,
        "adj_r_squared": model.rsquared_adj,
        "f_pvalue": model.f_pvalue,
    }


def m_logistic_regression(data, params):
    import statsmodels.api as sm

    rows = data["rows"]
    target = params["target"]
    features = params["features"]
    df = _df(rows, [target] + features).dropna()
    X = sm.add_constant(df[features])
    y = df[target]
    model = sm.Logit(y, X).fit(disp=0)
    conf = model.conf_int()
    coefs = {f: model.params.get(f) for f in features}
    return {
        "n": int(len(df)),
        "intercept": model.params.get("const"),
        "coefficients": coefs,
        "odds_ratios": {f: math.exp(v) for f, v in coefs.items() if v is not None},
        "p_values": {f: model.pvalues.get(f) for f in features},
        "conf_int_95": {
            f: [conf.loc[f, 0], conf.loc[f, 1]] for f in features if f in conf.index
        },
        "pseudo_r_squared": model.prsquared,
    }


def m_kmeans(data, params):
    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score

    rows = data["rows"]
    features = params["features"]
    n_clusters = int(params.get("n_clusters", 3))
    df = _df(rows, features).dropna()
    X = df[features].values
    model = KMeans(n_clusters=n_clusters, n_init=10, random_state=42).fit(X)
    sil = None
    if len(df) > n_clusters:
        try:
            sil = float(silhouette_score(X, model.labels_))
        except Exception:
            sil = None
    return {
        "n": int(len(df)),
        "n_clusters": n_clusters,
        "cluster_assignments": [int(c) for c in model.labels_],
        "centroids": [
            {f: float(v) for f, v in zip(features, c)} for c in model.cluster_centers_
        ],
        "cluster_sizes": {
            int(k): int(v)
            for k, v in zip(*__import__("numpy").unique(model.labels_, return_counts=True))
        },
        "inertia": float(model.inertia_),
        "silhouette_score": sil,
    }


_SAFE_MATH = {
    k: getattr(math, k) for k in ("sqrt", "log", "log10", "exp", "floor", "ceil", "pow")
}
_SAFE_MATH.update({"min": min, "max": max, "abs": abs})


def m_monte_carlo(data, params):
    import numpy as np
    import re

    variables = params["variables"]  # [{name, distribution, params:{...}}]
    formula = params["formula"]  # e.g. "revenue - cost"
    n_trials = int(params.get("n_trials", 10000))
    rng = np.random.default_rng(42)

    names = [v["name"] for v in variables]
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*|[\s()+\-*/.,0-9A-Za-z_]+", formula):
        raise ValueError("formula에 허용되지 않는 문자가 있습니다.")
    for token in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", formula):
        if token not in names and token not in _SAFE_MATH:
            raise ValueError(f"formula에서 알 수 없는 변수: {token}")

    samples = {}
    for v in variables:
        dist = v.get("distribution", "normal")
        p = v.get("params", {})
        if dist == "normal":
            samples[v["name"]] = rng.normal(p.get("mean", 0), p.get("std", 1), n_trials)
        elif dist == "uniform":
            samples[v["name"]] = rng.uniform(p.get("low", 0), p.get("high", 1), n_trials)
        elif dist == "triangular":
            samples[v["name"]] = rng.triangular(
                p.get("low", 0), p.get("mode", 0.5), p.get("high", 1), n_trials
            )
        else:
            raise ValueError(f"알 수 없는 분포: {dist}")

    results = np.array(
        [eval(formula, {"__builtins__": {}}, {**_SAFE_MATH, **{k: samples[k][i] for k in names}})
         for i in range(n_trials)]
    )
    pct = np.percentile(results, [5, 25, 50, 75, 95])
    counts, edges = np.histogram(results, bins=20)
    return {
        "n_trials": n_trials,
        "mean": float(results.mean()),
        "std": float(results.std()),
        "min": float(results.min()),
        "max": float(results.max()),
        "percentiles": {"p5": pct[0], "p25": pct[1], "p50": pct[2], "p75": pct[3], "p95": pct[4]},
        "histogram": {"counts": counts.tolist(), "bin_edges": edges.tolist()},
    }


# ------------------------------------------------------------- 추가 15개 ---
def m_ttest(data, params):
    from scipy import stats

    a, b = data["group_a"], data["group_b"]
    paired = bool(params.get("paired", False))
    if paired:
        t, p = stats.ttest_rel(a, b)
        df = len(a) - 1
    else:
        t, p = stats.ttest_ind(a, b, equal_var=bool(params.get("equal_var", False)))
        df = len(a) + len(b) - 2
    import numpy as np

    return {
        "t_statistic": float(t),
        "p_value": float(p),
        "df": int(df),
        "mean_a": float(np.mean(a)),
        "mean_b": float(np.mean(b)),
        "n_a": len(a),
        "n_b": len(b),
        "paired": paired,
    }


def m_anova(data, params):
    from scipy import stats
    import numpy as np

    groups = data["groups"]  # {name: [values]}
    names = list(groups.keys())
    f, p = stats.f_oneway(*[groups[n] for n in names])
    return {
        "f_statistic": float(f),
        "p_value": float(p),
        "group_means": {n: float(np.mean(groups[n])) for n in names},
        "group_ns": {n: len(groups[n]) for n in names},
    }


def m_chi_square(data, params):
    from scipy import stats
    import numpy as np

    table = np.array(data["table"])
    chi2, p, dof, expected = stats.chi2_contingency(table)
    return {
        "chi2": float(chi2),
        "p_value": float(p),
        "dof": int(dof),
        "expected": expected.tolist(),
    }


def m_descriptive(data, params):
    rows = data["rows"]
    columns = params.get("columns") or list(rows[0].keys())
    df = _df(rows, columns)
    out = {}
    for c in columns:
        if c not in df.columns:
            continue
        s = df[c].dropna()
        if not len(s):
            continue
        out[c] = {
            "mean": float(s.mean()),
            "median": float(s.median()),
            "std": float(s.std()) if len(s) > 1 else 0.0,
            "min": float(s.min()),
            "max": float(s.max()),
            "q1": float(s.quantile(0.25)),
            "q3": float(s.quantile(0.75)),
            "count": int(s.count()),
        }
    return {"columns": out}


def m_correlation(data, params):
    from scipy import stats as sstats

    rows = data["rows"]
    columns = params.get("columns") or list(rows[0].keys())
    method = params.get("method", "pearson")
    df = _df(rows, columns).dropna()
    corr_fn = sstats.pearsonr if method == "pearson" else sstats.spearmanr
    matrix, pvals = {}, {}
    for c1 in columns:
        matrix[c1], pvals[c1] = {}, {}
        for c2 in columns:
            if c1 not in df.columns or c2 not in df.columns:
                continue
            r, p = corr_fn(df[c1], df[c2])
            matrix[c1][c2] = float(r)
            pvals[c1][c2] = float(p)
    return {"method": method, "matrix": matrix, "p_values": pvals, "n": int(len(df))}


def m_time_series(data, params):
    # 간소화: statsmodels Holt-Winters로 예측하되, 계절주기를 충족할 데이터가
    # 부족하면 단순 선형 추세(최소자승) 외삽으로 대체한다 — 완전한 ARIMA
    # 자동선택 대신 "데이터가 적어도 합리적인 값을 내는" 실용적 절충.
    import numpy as np

    series = data["series"]  # [{period, value}]
    values = np.array([s["value"] for s in series], dtype=float)
    periods = [s["period"] for s in series]
    horizon = int(params.get("forecast_periods", 3))
    season = params.get("period")  # e.g. 12, 4

    method_used = "linear_trend"
    forecast = None
    if season and len(values) >= 2 * int(season):
        try:
            from statsmodels.tsa.holtwinters import ExponentialSmoothing

            model = ExponentialSmoothing(
                values, trend="add", seasonal="add", seasonal_periods=int(season)
            ).fit()
            forecast = model.forecast(horizon)
            method_used = "holt_winters"
        except Exception:
            forecast = None

    x = np.arange(len(values))
    slope, intercept = np.polyfit(x, values, 1)
    if forecast is None:
        forecast = intercept + slope * np.arange(len(values), len(values) + horizon)

    return {
        "method_used": method_used,
        "trend_slope": float(slope),
        "trend_intercept": float(intercept),
        "last_period": periods[-1] if periods else None,
        "forecast": [float(v) for v in forecast],
    }


def m_decision_tree(data, params):
    from sklearn.tree import DecisionTreeRegressor, DecisionTreeClassifier, export_text

    rows = data["rows"]
    target = params["target"]
    features = params["features"]
    task = params.get("task", "regression")
    max_depth = int(params.get("max_depth", 3))
    df = _df(rows, [target] + features).dropna()
    X, y = df[features], df[target]
    Model = DecisionTreeClassifier if task == "classification" else DecisionTreeRegressor
    model = Model(max_depth=max_depth, random_state=42).fit(X, y)
    return {
        "n": int(len(df)),
        "task": task,
        "feature_importances": {f: float(v) for f, v in zip(features, model.feature_importances_)},
        "score": float(model.score(X, y)),
        "tree_text": export_text(model, feature_names=features),
    }


def m_random_forest(data, params):
    from sklearn.ensemble import RandomForestRegressor, RandomForestClassifier

    rows = data["rows"]
    target = params["target"]
    features = params["features"]
    task = params.get("task", "regression")
    n_estimators = int(params.get("n_estimators", 100))
    df = _df(rows, [target] + features).dropna()
    X, y = df[features], df[target]
    Model = RandomForestClassifier if task == "classification" else RandomForestRegressor
    model = Model(n_estimators=n_estimators, random_state=42).fit(X, y)
    return {
        "n": int(len(df)),
        "task": task,
        "n_estimators": n_estimators,
        "feature_importances": {f: float(v) for f, v in zip(features, model.feature_importances_)},
        "score": float(model.score(X, y)),
    }


def m_pca(data, params):
    from sklearn.decomposition import PCA
    from sklearn.preprocessing import StandardScaler

    rows = data["rows"]
    features = params["features"]
    df = _df(rows, features).dropna()
    Xs = StandardScaler().fit_transform(df[features].values)
    n_components = min(len(features), int(params.get("n_components", len(features))))
    model = PCA(n_components=n_components).fit(Xs)
    return {
        "n": int(len(df)),
        "explained_variance_ratio": [float(v) for v in model.explained_variance_ratio_],
        "cumulative_variance": [float(v) for v in model.explained_variance_ratio_.cumsum()],
        "components": [
            {f: float(v) for f, v in zip(features, comp)} for comp in model.components_
        ],
    }


def m_cohort(data, params):
    # 코호트 시작 시점(cohort_period) 대비 활동 시점(activity_period)까지의
    # 오프셋별 잔존율 매트릭스 — 실제 pandas 피벗 집계(간소화 아님, 다만
    # activity_period가 cohort_period와 같은 시간 단위여야 함).
    import pandas as pd

    rows = data["rows"]  # [{id, cohort_period, activity_period}]
    df = pd.DataFrame(rows)
    periods = sorted(df["cohort_period"].unique().tolist())
    period_index = {p: i for i, p in enumerate(periods)}
    df["offset"] = df["activity_period"].map(period_index) - df["cohort_period"].map(
        period_index
    )
    df = df[df["offset"] >= 0]
    cohort_sizes = df[df["offset"] == 0].groupby("cohort_period")["id"].nunique().to_dict()
    retention = {}
    for cohort, cohort_df in df.groupby("cohort_period"):
        size = cohort_sizes.get(cohort, 0)
        if not size:
            continue
        by_offset = cohort_df.groupby("offset")["id"].nunique()
        retention[str(cohort)] = {
            str(int(off)): float(n / size) for off, n in by_offset.items()
        }
    return {
        "cohort_sizes": {str(k): int(v) for k, v in cohort_sizes.items()},
        "retention": retention,
    }


def m_survival(data, params):
    from statsmodels.duration.survfunc import SurvfuncRight
    import numpy as np

    rows = data["rows"]  # [{duration, event}]
    durations = np.array([r["duration"] for r in rows], dtype=float)
    events = np.array([r["event"] for r in rows], dtype=int)
    sf = SurvfuncRight(durations, events)
    median = sf.quantile(0.5)
    return {
        "n": len(rows),
        "time_points": [float(v) for v in sf.surv_times],
        "survival_prob": [float(v) for v in sf.surv_prob],
        "median_survival": float(median) if median is not None and not math.isnan(median) else None,
    }


def m_market_basket(data, params):
    # 간소화: mlxtend(Apriori) 미설치 — pandas만으로 "쌍(pair) 단위" 지지도/
    # 신뢰도/향상도만 계산한다(3개 이상 조합의 완전한 itemset 마이닝은 아님).
    from itertools import combinations
    from collections import Counter

    transactions = data["transactions"]  # [[item, ...], ...]
    min_support = float(params.get("min_support", 0.05))
    n = len(transactions)
    item_counts = Counter(i for t in transactions for i in set(t))
    pair_counts = Counter()
    for t in transactions:
        for a, b in combinations(sorted(set(t)), 2):
            pair_counts[(a, b)] += 1

    rules = []
    for (a, b), cnt in pair_counts.items():
        support = cnt / n
        if support < min_support:
            continue
        conf_ab = cnt / item_counts[a]
        conf_ba = cnt / item_counts[b]
        lift = support / ((item_counts[a] / n) * (item_counts[b] / n))
        rules.append(
            {
                "item_a": a,
                "item_b": b,
                "support": support,
                "confidence_a_to_b": conf_ab,
                "confidence_b_to_a": conf_ba,
                "lift": lift,
            }
        )
    rules.sort(key=lambda r: r["lift"], reverse=True)
    return {"n_transactions": n, "simplified": "pairwise only, not full itemset mining", "rules": rules[:50]}


def m_rfm(data, params):
    # 고객별 recency/frequency/monetary가 이미 계산되어 들어온다고 가정
    # (원본 트랜잭션에서 이 3개를 뽑는 건 호출부의 파라미터 추출 LLM 몫).
    import pandas as pd

    rows = data["rows"]  # [{customer_id, recency, frequency, monetary}]
    df = pd.DataFrame(rows)

    def score(series, ascending):
        try:
            return pd.qcut(series.rank(method="first"), 5, labels=[1, 2, 3, 4, 5])
        except Exception:
            return pd.Series([3] * len(series), index=series.index)

    df["r_score"] = score(df["recency"], ascending=True).astype(int) if len(df) >= 5 else 3
    # recency: 작을수록(최근일수록) 좋음 -> 점수 반전
    if len(df) >= 5:
        df["r_score"] = 6 - df["r_score"]
    df["f_score"] = score(df["frequency"], ascending=False).astype(int) if len(df) >= 5 else 3
    df["m_score"] = score(df["monetary"], ascending=False).astype(int) if len(df) >= 5 else 3
    df["rfm_score"] = df["r_score"] + df["f_score"] + df["m_score"]

    def segment(row):
        s = row["rfm_score"]
        if s >= 13:
            return "핵심 우수고객"
        if s >= 10:
            return "우수고객"
        if s >= 7:
            return "일반고객"
        return "이탈위험고객"

    df["segment"] = df.apply(segment, axis=1)
    return {"customers": df.to_dict(orient="records")}


def m_pareto(data, params):
    rows = sorted(data["rows"], key=lambda r: r["value"], reverse=True)
    total = sum(r["value"] for r in rows) or 1
    cum = 0.0
    out = []
    cutoff_index = None
    for i, r in enumerate(rows):
        cum += r["value"]
        pct = cum / total
        out.append({"label": r["label"], "value": r["value"], "cumulative_pct": pct})
        if cutoff_index is None and pct >= 0.8:
            cutoff_index = i
    return {
        "items": out,
        "cutoff_index": cutoff_index,
        "top_20pct_item_count": (cutoff_index + 1) if cutoff_index is not None else len(rows),
        "total_items": len(rows),
    }


def m_outlier(data, params):
    rows = data["rows"]
    features = params["features"]
    method = params.get("method", "iqr")
    df = _df(rows, features).dropna()

    if method == "isolation_forest":
        from sklearn.ensemble import IsolationForest

        model = IsolationForest(random_state=42, contamination=float(params.get("contamination", 0.05)))
        preds = model.fit_predict(df[features].values)
        scores = model.decision_function(df[features].values)
        outlier_idx = [int(i) for i, p in enumerate(preds) if p == -1]
        return {"method_used": "isolation_forest", "outlier_indices": outlier_idx, "scores": [float(s) for s in scores]}

    outlier_idx = set()
    bounds = {}
    for f in features:
        q1, q3 = df[f].quantile(0.25), df[f].quantile(0.75)
        iqr = q3 - q1
        lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
        bounds[f] = [float(lo), float(hi)]
        outlier_idx.update(df.index[(df[f] < lo) | (df[f] > hi)].tolist())
    return {"method_used": "iqr", "outlier_indices": sorted(int(i) for i in outlier_idx), "bounds": bounds}


METHODS = {
    "linear_regression": m_linear_regression,
    "logistic_regression": m_logistic_regression,
    "kmeans": m_kmeans,
    "monte_carlo": m_monte_carlo,
    "ttest": m_ttest,
    "anova": m_anova,
    "chi_square": m_chi_square,
    "descriptive": m_descriptive,
    "correlation": m_correlation,
    "time_series": m_time_series,
    "decision_tree": m_decision_tree,
    "random_forest": m_random_forest,
    "pca": m_pca,
    "cohort": m_cohort,
    "survival": m_survival,
    "market_basket": m_market_basket,
    "rfm": m_rfm,
    "pareto": m_pareto,
    "outlier": m_outlier,
}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: run_analysis.py <payload.json path>", file=sys.stderr)
        return 2
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            payload = json.load(f)
        method = payload.get("method")
        fn = METHODS.get(method)
        if not fn:
            raise ValueError(f"알 수 없는 분석 방법: {method}")
        result = fn(payload.get("data", {}), payload.get("params", {}))
        sys.stdout.write(json.dumps(_round(result), ensure_ascii=False))
        return 0
    except Exception as e:
        # hwp_extract.py와 같은 규약: 실패는 stderr + 0이 아닌 종료코드로,
        # stdout은 성공 시에만 쓴다 — Node 쪽(runAnalysis.js)이 그걸로 판정한다.
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
