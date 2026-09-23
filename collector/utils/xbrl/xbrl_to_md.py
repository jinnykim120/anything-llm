#!/usr/bin/env python3
"""[auto-docu] DART XBRL 원문 폴더 → 마크다운 재무제표.

PDF 로 파싱하면 표가 무너져 "매출액6,030,01911,957,422…"처럼 숫자만 이어 붙지만,
XBRL 에는 항목명·기간·연결/별도 구분이 숫자마다 붙어 있다. 이 스크립트는 표준
라이브러리(xml.etree)만으로 그것을 읽어 수집기가 그대로 받는 .md 로 바꾼다.

  python xbrl_to_md.py <XBRL 폴더> [출력.md]

산출물: 표지 메타(회사·보고서·기준일·단위) + 연결/별도 재무제표 표 + 사업부문별 표.
표 각 행은 "항목 | 기간별 값" 이라 열 이름과 값이 항상 함께 있다(검색·인용에 유리).
"""
import collections
import io
import os
import re
import sys
import xml.etree.ElementTree as ET

XBRLI = "{http://www.xbrl.org/2003/instance}"
LINK = "{http://www.xbrl.org/2003/linkbase}"
XLINK = "{http://www.w3.org/1999/xlink}"
XDI = "{http://xbrl.org/2006/xbrldi}"
CONS_AXIS = "ConsolidatedAndSeparateFinancialStatementsAxis"
CHR10 = chr(10)

# (역할 코드, 표 제목) — DART 표준 역할. 연결(…0/…10)과 별도(…5/…15)가 짝이다.
STATEMENTS = [
    ("D210000", "연결 재무상태표", "cons"),
    ("D431410", "연결 포괄손익계산서", "cons"),
    ("D520000", "연결 현금흐름표", "cons"),
    ("D610000", "연결 자본변동표", "cons"),
    ("D210005", "별도 재무상태표", "sep"),
    ("D431415", "별도 포괄손익계산서", "sep"),
]


def local(fragment):
    """'ifrs-full_Revenue' → 'Revenue' (접두어가 달라도 같은 개념을 찾기 위해)."""
    return fragment.split("_", 1)[1] if "_" in fragment else fragment


def find_files(folder):
    # 폴더 이름에 [ ] 가 있어(예: "[GS리테일]…") glob 은 패턴으로 오해하므로 os.walk 사용.
    all_files = [
        os.path.join(dp, f) for dp, _, fs in os.walk(folder) for f in fs
    ]
    inst = [p for p in all_files if p.endswith(".xbrl")]
    if not inst:
        raise SystemExit("*.xbrl 인스턴스 파일이 없습니다: " + folder)
    labs = [p for p in all_files if re.search(r"lab[-_]ko|ko[-_.]", os.path.basename(p), re.I) and p.endswith(".xml")]
    pres = [p for p in all_files if re.search(r"(^|[_-])pre[_.-]", os.path.basename(p), re.I) and p.endswith(".xml") and "dim" not in os.path.basename(p).lower()] or [
        p for p in all_files if re.search(r"pre", os.path.basename(p), re.I) and p.endswith(".xml")
    ]
    xsds = [p for p in all_files if p.endswith(".xsd")]
    return inst[0], labs, pres, xsds


def load_labels(paths):
    cl = collections.defaultdict(dict)
    for path in paths:
        root = ET.parse(path).getroot()
        locs = {l.get(XLINK + "label"): l.get(XLINK + "href", "").split("#")[-1] for l in root.iter(LINK + "loc")}
        labs = {
            l.get(XLINK + "label"): (l.get(XLINK + "role", "").rsplit("/", 1)[-1], (l.text or "").strip())
            for l in root.iter(LINK + "label")
        }
        for a in root.iter(LINK + "labelArc"):
            fr = locs.get(a.get(XLINK + "from"))
            to = labs.get(a.get(XLINK + "to"))
            if fr and to:
                cl[local(fr)][to[0]] = to[1]
    return cl


# [auto-docu XBRL 구형 포맷] 2022·2023년 공시(entry_point 방식)는 회사 고유 개념의
# 라벨만 로컬에 담아 배포하고, IFRS 표준 개념(Revenue, Assets 등)의 한글 라벨은
# DART 중앙 서버가 호스팅하는 외부 xsd에서만 제공해 로컬 파일만으로는 못 찾는다
# (신형 공시는 이 표준 라벨도 로컬에 포함돼 있어 문제없음). IFRS 표준 개념명은
# 연도와 무관하게 고정이므로, 자주 나오는 것만 최소한으로 대체한다.
STANDARD_LABELS_KO = {
    "Revenue": "수익(매출액)", "CostOfSales": "매출원가", "GrossProfit": "매출총이익",
    "ProfitLoss": "당기순이익(손실)", "OperatingIncomeLoss": "영업이익(손실)",
    "FinanceIncome": "금융수익", "FinanceCosts": "금융원가",
    "OtherGains": "기타이익", "OtherLosses": "기타손실",
    "TotalSellingGeneralAdministrativeExpenses": "판매비와관리비",
    "Assets": "자산", "CurrentAssets": "유동자산", "NoncurrentAssets": "비유동자산",
    "Liabilities": "부채", "CurrentLiabilities": "유동부채", "NoncurrentLiabilities": "비유동부채",
    "Equity": "자본", "IssuedCapital": "자본금", "CapitalSurplus": "자본잉여금",
    "RetainedEarnings": "이익잉여금",
    "CashAndCashEquivalents": "현금및현금성자산", "Inventories": "재고자산",
    "PropertyPlantAndEquipment": "유형자산", "InvestmentProperty": "투자부동산",
    "RightofuseAssets": "사용권자산",
    "OtherCurrentAssets": "기타유동자산", "OtherNonCurrentAssets": "기타비유동자산",
    "OtherCurrentFinancialAssets": "기타유동금융자산",
    "OtherNoncurrentFinancialAssets": "기타비유동금융자산",
    "OtherCurrentLiabilities": "기타유동부채", "OtherNonCurrentLiabilities": "기타비유동부채",
    "OtherCurrentFinancialLiabilities": "기타유동금융부채",
    "OtherNoncurrentFinancialLiabilities": "기타비유동금융부채",
    "CurrentProvisions": "유동충당부채", "NoncurrentProvisions": "비유동충당부채",
    "NoncurrentLeaseLiabilities": "비유동리스부채",
    "CurrentTaxLiabilities": "당기법인세부채",
    "DeferredTaxAssets": "이연법인세자산", "DeferredTaxLiabilities": "이연법인세부채",
    "OtherComprehensiveIncome": "기타포괄손익",
    "OtherComprehensiveIncomeThatWillBeReclassifiedToProfitOrLossNetOfTax":
        "당기손익으로 재분류되는 세후기타포괄손익",
    "OtherComprehensiveIncomeThatWillNotBeReclassifiedToProfitOrLossNetOfTax":
        "당기손익으로 재분류되지 않는 세후기타포괄손익",
    "OtherComprehensiveIncomeLossAccumulatedAmount": "기타포괄손익누계액",
    "BasicEarningsLossPerShare": "기본주당이익(손실)",
    "CashFlowsFromUsedInOperatingActivities": "영업활동현금흐름",
    "CashFlowsFromUsedInInvestingActivities": "투자활동현금흐름",
    "CashFlowsFromUsedInFinancingActivities": "재무활동현금흐름",
    "EffectOfExchangeRateChangesOnCashAndCashEquivalents": "현금및현금성자산의 환율변동효과",
    "InterestPaidClassifiedAsOperatingActivities": "영업활동으로 분류된 이자지급",
    "ProceedsFromShortTermBorrowings": "단기차입금의 차입",
    "ProceedsFromLongTermBorrowings": "장기차입금의 차입",
    "DividendsPaidClassifiedAsFinancingActivities": "재무활동으로 분류된 배당금지급",
    "AcquisitionOfTreasuryShares": "자기주식의 취득",
    "DispositionOfTreasuryShares": "자기주식의 처분",
    "EquityAtBeginningOfPeriod": "기초자본",
}


def ko(cl, key, prefer=("label", "terseLabel")):
    d = cl.get(key, {})
    for p in prefer:
        if d.get(p):
            return d[p]
    if key in STANDARD_LABELS_KO:
        return STANDARD_LABELS_KO[key]
    return next(iter(d.values()), key)


def load_instance(path):
    root = ET.parse(path).getroot()
    ctx = {}
    for c in root.iter(XBRLI + "context"):
        per = c.find(XBRLI + "period")
        inst = per.find(XBRLI + "instant")
        if inst is not None:
            period = ("I", inst.text.strip())
        else:
            period = ("D", per.find(XBRLI + "startDate").text.strip(), per.find(XBRLI + "endDate").text.strip())
        dims = tuple(sorted(
            (m.get("dimension").split(":")[-1], (m.text or "").strip().split(":")[-1])
            for m in c.iter(XDI + "explicitMember")
        ))
        ctx[c.get("id")] = (period, dims)
    facts = collections.defaultdict(list)  # local concept -> [(period, dims, unit, text)]
    for el in root:
        cr = el.get("contextRef")
        if not cr or not el.get("unitRef"):
            continue
        name = el.tag[1:].split("}")[1]
        p, d = ctx[cr]
        facts[name].append((p, d, el.get("unitRef"), (el.text or "").strip()))
    return root, ctx, facts


def presentation_tree(pre_paths, role_uri):
    for path in pre_paths:
        root = ET.parse(path).getroot()
        for pl in root.iter(LINK + "presentationLink"):
            if pl.get(XLINK + "role") != role_uri:
                continue
            lc = {l.get(XLINK + "label"): local(l.get(XLINK + "href", "").split("#")[-1]) for l in pl.iter(LINK + "loc")}
            kids = collections.defaultdict(list)
            has_parent = set()
            for a in pl.iter(LINK + "presentationArc"):
                kids[a.get(XLINK + "from")].append((float(a.get("order", "0")), a.get(XLINK + "to")))
                has_parent.add(a.get(XLINK + "to"))
            out = []

            def walk(label, depth):
                out.append((depth, lc[label]))
                for _, k in sorted(kids[label]):
                    walk(k, depth + 1)

            for r in [l for l in lc if l not in has_parent]:
                walk(r, 0)
            return out
    return []


def fmt(unit, text, decimals_hint=None):
    """금액(KRW)은 백만원, 그 밖의 단위(주당·주식수·비율)는 원값 그대로."""
    if not re.fullmatch(r"-?\d+(\.\d+)?", text or ""):
        return ""
    if unit and "KRW" in unit.upper() and "share" not in unit.lower():
        v = float(text) / 1e6
        return f"{v:,.0f}"
    if re.fullmatch(r"-?\d+", text):
        return f"{int(text):,}"
    return text


def period_label(p):
    if p[0] == "I":
        return p[1] + " 현재"
    s, e = p[1], p[2]
    return f"{s}~{e}"


def build_statement(title, role_uri, cl, pre_paths, facts, want_dim, periods):
    rows = presentation_tree(pre_paths, role_uri)
    if not rows:
        return None
    dim = () if want_dim is None else want_dim
    out = [f"### {title}", "", "| 항목 | " + " | ".join(period_label(p) for p in periods) + " |",
           "|---|" + "---|" * len(periods)]
    n = 0
    for depth, c in rows:
        vals = []
        for p in periods:
            hit = [(u, t) for (pp, dd, u, t) in facts.get(c, []) if pp == p and dd == dim]
            vals.append(fmt(*hit[0]) if hit else "")
        if any(vals):
            out.append("| " + ("· " * max(0, depth - 1)) + ko(cl, c).replace("|", "/") + " | " + " | ".join(vals) + " |")
            n += 1
    return "\n".join(out) if n else None


def statement_periods(rows, facts, dim, kind):
    """이 표의 개념들이 값을 가진 기간 중, 가장 최근 4개(기간형) 또는 2개(시점형)."""
    seen = collections.Counter()
    for _, c in rows:
        for (p, d, u, t) in facts.get(c, []):
            if d == dim and re.fullmatch(r"-?\d+(\.\d+)?", t or ""):
                seen[p] += 1
    if not seen:
        return []
    inst = sorted([p for p in seen if p[0] == "I"], key=lambda p: p[1], reverse=True)
    dur = sorted([p for p in seen if p[0] == "D"], key=lambda p: (p[2], p[1]), reverse=True)
    # 기간형: 같은 길이 묶음이 서로 다른 해에 있으면 함께 보이도록 최근 4개
    return (inst[:2] if inst and not dur else []) or (dur[:4] if dur else inst[:2]) if kind else []


def segment_tables(cl, facts):
    """사업부문(SegmentsAxis)별 표 — 연결 기준. 행이 충분한(>=4) 기간만, 최근 2개."""
    by_concept = collections.defaultdict(lambda: collections.defaultdict(dict))  # concept -> period -> segment label -> (unit, text)
    for c, items in facts.items():
        for (p, d, u, t) in items:
            if p[0] != "D" or not re.fullmatch(r"-?\d+", t or ""):
                continue
            dims = dict(d)
            if len(d) == 2 and dims.get(CONS_AXIS) == "ConsolidatedMember" and "SegmentsAxis" in dims:
                seg = re.sub(r"\s*\[구성요소\]\s*$", "", ko(cl, dims["SegmentsAxis"]))
                by_concept[c][p].setdefault(seg, (u, t))  # 같은 사업부의 중복 멤버 ID 는 라벨로 합침
    concepts = [c for c, per in by_concept.items() if any(len(m) >= 3 for m in per.values())]
    if not concepts:
        return ""
    rows_by_period = collections.Counter(p for c in concepts for p in by_concept[c])
    periods = sorted([p for p, n in rows_by_period.items() if n >= 4], key=lambda p: (p[2], p[1]), reverse=True)[:2]
    out = []
    for p in periods:
        members = []
        for c in concepts:
            for m in by_concept[c].get(p, {}):
                if m not in members:
                    members.append(m)
        out.append(
            f"### 사업부문별 (연결, {period_label(p)})\n\n| 항목 | "
            + " | ".join(m.replace("|", "/") for m in members)
            + " |\n|---|"
            + "---|" * len(members)
        )
        for c in sorted(concepts, key=lambda c: -sum(len(v) for v in by_concept[c].values())):
            row = [fmt(*by_concept[c].get(p, {}).get(m, (None, ""))) for m in members]
            if any(row):
                out.append("| " + ko(cl, c).replace("|", "/") + " | " + " | ".join(row) + " |")
        # [auto-docu XBRL] 비중(%)은 원문에 별도 항목으로 없는 경우가 많다(공식 답이
        # "편의점 4,470,737백만원으로 전체의 74.1%"처럼 비중까지 요구한 게 이유였다).
        # 매출(Revenue) 행에서 각 부문 금액 / 합계로 직접 계산해 같은 표 아래에 덧붙인다
        # — 새 사실을 만드는 게 아니라 원문의 두 숫자를 나누는 것뿐이라 근거 문제가 없다.
        revenue_concept = next((c for c in concepts if local(c) == "Revenue"), None)
        if revenue_concept:
            vals = {
                m: parse_amount(*by_concept[revenue_concept].get(p, {}).get(m, (None, "")))
                for m in members
            }
            total = sum(v for v in vals.values() if v is not None)
            if total:
                pct_row = [
                    f"{vals[m] / total * 100:.1f}%" if vals.get(m) is not None else ""
                    for m in members
                ]
                out.append("| 매출 비중(계산값) | " + " | ".join(pct_row) + " |")
        out.append("")
    return CHR10.join(out)


def parse_amount(unit, text):
    if not unit or not text or not re.fullmatch(r"-?\d+(\.\d+)?", text):
        return None
    return float(text)


def entity_info(facts, roots):
    """표지 정보(회사명·기준일) — 파일/폴더 이름에서 얻는다."""
    return {}


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    folder = sys.argv[1]
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    inst_path, lab_paths, pre_paths, xsd_paths = find_files(folder)
    cl = load_labels(lab_paths)
    _, ctx, facts = load_instance(inst_path)
    # [auto-docu XBRL 구형 포맷] 역할(role) 설명문("[D210000] 재무상태표...")은
    # xsd의 roleType 요소에 있는데, 옛 공시(2022·2023년, dart_entry_point 방식)는
    # 그 정의를 로컬 xsd 대신 DART 서버가 호스팅하는 외부 xsd에서만 import 해서
    # 로컬 파일만 봐서는 못 찾는다. 대신 DART는 역할 URI 자체 끝에 항상
    # ".../role-D210000" 식으로 코드를 박아 두므로(신형·구형 공통), 프레젠테이션
    # 링크베이스가 실제로 쓰는 role URI에서 직접 코드를 뽑는다 — roleType 정의
    # 유무와 무관하게 항상 동작한다.
    role_by_code = {}
    for path in pre_paths:
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError:
            continue
        for pl in root.iter(LINK + "presentationLink"):
            uri = pl.get(XLINK + "role", "")
            m = re.search(r"role-(D\d+[a-z]?)$", uri)
            if m:
                role_by_code.setdefault(m.group(1), uri)
    name = os.path.basename(os.path.normpath(folder))
    m = re.search(r"\[(.+?)\](.*?)\(원문XBRL\)\((\d{4}\.\d{2}\.\d{2})\)", name)
    company, report, filed = (m.group(1), m.group(2).replace("_IFRS", "").strip(), m.group(3)) if m else (name, "", "")
    ends = sorted({p[-1] for items in facts.values() for (p, d, u, t) in items})
    latest = ends[-1] if ends else ""
    year = latest[:4]
    half = {"03": "1분기", "06": "반기", "09": "3분기", "12": "사업연도(연간)"}.get(latest[5:7], "")
    lines = [
        f"# [{company}] {year}년 {half} 재무제표 (XBRL 원문, {report})".replace("  ", " "),
        "",
        f"- 회사: {company}",
        f"- 보고서: {report} (공시일 {filed})",
        f"- 기준일(최신): {latest} ({year}년 {half})",
        "- 단위: 백만원 (주당 값·주식 수는 원값 그대로)",
        "- 구분: 연결 재무제표와 별도 재무제표, 사업부문별 실적을 각각 표로 제공",
        "- 출처: DART 전자공시 XBRL 원문 — 항목명·기간·연결/별도 구분이 값마다 붙은 구조화 데이터",
        "",
    ]
    for code, title, kind in STATEMENTS:
        uri = role_by_code.get(code)
        if not uri:
            continue
        dim = ((CONS_AXIS, "ConsolidatedMember"),) if kind == "cons" else ((CONS_AXIS, "SeparateMember"),)
        rows = presentation_tree(pre_paths, uri)
        periods = statement_periods(rows, facts, dim, True)
        if not periods:
            continue
        table = build_statement(title, uri, cl, pre_paths, facts, dim, periods)
        if table:
            lines += [f"## {title}", "", table.split("\n", 1)[1].lstrip("\n"), ""]
    seg = segment_tables(cl, facts)
    if seg:
        lines += ["## 사업부문별 실적", "", seg]
    text = "\n".join(lines).rstrip() + "\n"
    out = sys.argv[2] if len(sys.argv) > 2 else None
    if out:
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        print(f"wrote {out} ({len(text):,} chars, {text.count(chr(10))} lines)")
    else:
        print(text)


if __name__ == "__main__":
    main()
