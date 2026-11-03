# 'GS리테일 이슈 분류(9개 유형).xlsx' → data/seed/past-cases.json
#   python -X utf8 -I seed/extract-past-cases.py "<xlsx 경로>" [출력 json 경로]
# 연도만 있는 자료이므로 날짜를 추측하지 않는다(year 만 저장). 셀 안의 사례는 최상위 쉼표(괄호 밖)와 ' / ' 로 나눈다.
import json, re, sys, os
import openpyxl

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "seed", "past-cases.json")
tax = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config", "taxonomy.json"), encoding="utf-8"))
type_by_name = {t["name"]: t["id"] for t in tax["issueTypes"]}
# 사업부문 접두(별칭 → id). '인사∙총무' 처럼 6개에 없는 접두는 사업부문 null + 접두 원문 보존.
alias = {a: b["id"] for b in tax["businessUnits"] for a in b["aliases"]}
PREFIX = re.compile(r"^\s*((?:PBU>개발사업)|[A-Za-z]+|[가-힣∙·]+)\s*\)\s*")
KNOWN_PREFIX = set(alias) | {"인사∙총무"}

def split_top(s):
    """괄호 밖 쉼표·' / ' 로 분리."""
    parts, buf, depth, i = [], "", 0, 0
    while i < len(s):
        c = s[i]
        if c in "([（": depth += 1
        elif c in ")]）": depth = max(0, depth - 1)
        if depth == 0 and (c == "," or s[i:i+3] == " / "):
            parts.append(buf); buf = ""; i += 3 if c == " " else 1; continue
        buf += c; i += 1
    parts.append(buf)
    return [p.strip() for p in parts if p.strip()]

wb = openpyxl.load_workbook(src, data_only=True)
ws = wb.worksheets[0]
rows = [r for r in ws.iter_rows(values_only=True)]
# 헤더: '구분' 행의 연도 열
hdr_i = next(i for i, r in enumerate(rows) if r[1] == "구분")
years = {}
for ci, v in enumerate(rows[hdr_i]):
    m = re.search(r"(\d{2})\s*년", str(v or ""))
    if m: years[ci] = 2000 + int(m.group(1))
cur_type = None
cases, order = [], 0
for ri in range(hdr_i + 1, len(rows)):
    r = rows[ri]
    if r[1]:
        name = re.sub(r"^\s*\d+\.\s*", "", str(r[1])).strip()
        cur_type = name
    if not cur_type: continue
    for ci, yr in years.items():
        cell = r[ci] if ci < len(r) else None
        if cell is None or str(cell).strip() in ("", "-"): continue
        raw = str(cell).strip(); cur_bu = None; cur_bu_raw = None
        for seg in split_top(raw):
            m = PREFIX.match(seg)
            if m and m.group(1) in KNOWN_PREFIX:
                cur_bu_raw = m.group(1); cur_bu = alias.get(cur_bu_raw); seg = seg[m.end():].strip()
            if not seg: continue
            order += 1
            review = []
            if cur_bu is None: review.append("사업부문 미확인" if cur_bu_raw is None else f"사업부문 매핑 없음({cur_bu_raw})")
            if cur_type not in type_by_name: review.append("유형 매핑 없음")
            cases.append({
                "seedId": f"past-{yr}-{order:03d}",
                "year": yr, "title": seg, "typeId": type_by_name.get(cur_type), "typeRaw": cur_type,
                "buId": cur_bu, "buRaw": cur_bu_raw, "rawCell": raw, "sheetRow": ri + 1, "review": review,
            })
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
json.dump({"source": os.path.basename(src), "dateNote": "연도만 있음(월·일 미확정)", "cases": cases}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("cases", len(cases))
