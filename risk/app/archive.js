/* 리스크 아카이브 탭: 사건 목록 · 사건 상세(사건 카드/확정, 단계별 자료, 업로드, 내장 이미지). index.html 이 mount() 로 붙인다.
   모든 글자는 textContent 로만 넣는다(자료 이름·카드 내용이 HTML 로 해석되지 않게). */
(function () {
"use strict";
var C = null, root = null, built = false;
var S = { sel: [], collapsed: {}, view: "list", id: null, detail: null, list: [], years: [], f: { year: "", type: "", bu: "", status: "", q: "", sort: "new" }, up: { kind: "case-doc", stage: "", log: [] } };

function h(tag, a, kids) {
  var e = document.createElement(tag); a = a || {};
  Object.keys(a).forEach(function (k) { var v = a[k]; if (v == null || v === false) return; if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else if (k.slice(0, 2) === "on") e[k] = v; else e.setAttribute(k, v === true ? "" : v); });
  (kids || []).forEach(function (c) { if (c == null || c === false) return; e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
  return e;
}
function req(p, o) {
  return fetch(p, o).then(function (r) {
    if (r.status === 401) { location.reload(); throw new Error("login"); }
    return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "오류"); return j; }, function () { if (!r.ok) throw new Error("오류 " + r.status); return {}; });
  });
}
var get = req;
function post(p, body) { return req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }); }
var nameOf = function (list, id) { var x = (list || []).filter(function (t) { return t.id === id; })[0]; return x ? x.name : id || ""; };
var kindName = function (id) { return nameOf(C.cfg.fileKinds, id); };
var stageName = function (id) { return nameOf(C.cfg.caseStages.concat(C.cfg.stageExtras || []), id); };
var fmtSize = function (n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : n >= 1024 ? Math.round(n / 1024) + "KB" : n + "B"; };
var ext = function (n) { var m = String(n).match(/\.([A-Za-z0-9]+)$/); return m ? m[1].toLowerCase() : "file"; };
var base = function (p) { return String(p || "").split("/").pop(); };
var dateText = function (c) { return c.startProvisional && c.startDate ? c.startDate.slice(0, 7) + " (최초 민원 접수일 미확정)" : c.startDate || c.startYear + "년 (월·일 미확정)"; };
var fdate = function (iso) { return iso ? String(iso).slice(0, 10) : ""; };
var fail = function (e) { if (e && e.message !== "login") alert(e.message); };
function typeTag(id, ai) { return id ? h("span", { class: "tp t-" + id }, [nameOf(C.cfg.issueTypes, id), ai ? " · AI 제안" : null]) : h("span", { class: "b", text: "유형 미지정" }); }
function opts(sel, list, cur, blank) {
  if (blank != null) sel.appendChild(h("option", { value: "", text: blank }));
  list.forEach(function (x) { var o = h("option", { value: x.id, text: x.name }); if (x.id === cur) o.selected = true; sel.appendChild(o); });
  return sel;
}
function selectBox(label, list, cur, blank, onchange) { var s = h("select", { "aria-label": label }); opts(s, list, cur, blank); s.onchange = function () { onchange(s.value); }; return s; }
function section(no, title, sub, extra) { return h("div", { class: "rs" }, [h("span", { class: "no", text: no }), h("div", { class: "hd" }, [h("h2", { text: title }), sub ? h("small", { text: sub }) : null]), extra || null]); }
var ico = function (el, name) { if (window.RiskUI) window.RiskUI.ic(el, name); return el; };
function reflect() { if (C && C.onChange) { try { C.onChange(); } catch (e) {} } }

/* ───────── 목록 ───────── */
function loadList() {
  var q = new URLSearchParams(); Object.keys(S.f).forEach(function (k) { if (S.f[k]) q.set(k, S.f[k]); });
  return get("/api/archive/cases?" + q).then(function (r) {
    S.list = r.cases;
    if (!S.f.year) { var ys = {}; r.cases.forEach(function (c) { ys[c.startYear] = 1; }); S.years = Object.keys(ys).sort().reverse(); }
  });
}
/* 유형 선택 바(전체 + 9개 유형 + 필요 시 미분류) → 아래 목록이 유형 그룹으로 나뉜다. 여러 개를 고르면 고른 유형마다 그룹이 세로로 나란히 나온다.
   사건은 주 유형 그룹에만 한 번 나오고, 부 유형은 사건 블록 안의 작은 유형 색 칩으로만 표시한다(그룹 중복 노출 없음). 유형 색은 ui.css 의 --ty-* 한 곳에서 가져온다. */
function gkey(c) { return C.cfg.issueTypes.some(function (t) { return t.id === c.typeId; }) ? c.typeId : "unclassified"; }
function groupDefs(counts) { var d = C.cfg.issueTypes.map(function (t) { return { id: t.id, name: t.name }; }); if (counts.unclassified || S.sel.indexOf("unclassified") >= 0) d.push({ id: "unclassified", name: "미분류" }); return d; }
function renderList() {
  S.view = "list"; stopPoll(); root.textContent = "";
  root.appendChild(h("div", { class: "ptitle" }, [h("div", { class: "pt" }, [h("h2", { text: "Archive" }), h("p", { text: "과거 리스크 사건을 사건 폴더 단위로 모아 둡니다. 폴더 이름은 시작연월이 앞에 붙은 ‘YYYY-MM_제목’(공백 없음)입니다." })]), h("span", { class: "ct", id: "aCount" })]));
  root.appendChild(h("div", { class: "tbar", id: "aTypeBar", role: "group", "aria-label": "리스크 유형 선택(여러 개 선택 가능)" }));
  var tools = h("div", { class: "atools" });
  var y = h("select", { "aria-label": "연도" }); y.appendChild(h("option", { value: "", text: "연도 전체" })); S.years.forEach(function (v) { var o = h("option", { value: v, text: v + "년" }); if (String(S.f.year) === String(v)) o.selected = true; y.appendChild(o); });
  y.onchange = function () { S.f.year = y.value; reload(); };
  tools.appendChild(y);
  tools.appendChild(selectBox("사업부문", C.cfg.businessUnits, S.f.bu, "사업부문 전체", function (v) { S.f.bu = v; reload(); }));
  tools.appendChild(selectBox("상태", [{ id: "진행", name: "진행" }, { id: "종결", name: "종결" }], S.f.status, "상태 전체", function (v) { S.f.status = v; reload(); }));
  var qi = h("input", { type: "search", placeholder: "제목·요약 검색", "aria-label": "검색", value: S.f.q }), t = null;
  qi.oninput = function () { clearTimeout(t); t = setTimeout(function () { S.f.q = qi.value.trim(); reload(); }, 300); };
  tools.appendChild(qi);
  tools.appendChild(selectBox("정렬", [{ id: "new", name: "시작일 최신순" }, { id: "old", name: "시작일 오래된순" }], S.f.sort, null, function (v) { S.f.sort = v; reload(); }));
  tools.appendChild(h("span", { class: "grow" }));
  tools.appendChild(ico(h("button", { class: "btn sec", type: "button", text: "서버 경로로 가져오기", onclick: importDlg }), "folder"));
  tools.appendChild(ico(h("button", { class: "btn", type: "button", text: "새 사건 폴더", onclick: createDlg }), "plus"));
  root.appendChild(tools);
  root.appendChild(h("div", { class: "agroups", id: "aCases" }));
  renderCards();
}
function reload() { return loadList().then(renderCards).catch(fail); }
function toggleSel(id) { var i = S.sel.indexOf(id); if (i >= 0) S.sel.splice(i, 1); else S.sel.push(id); renderCards(); }
function renderCards() {
  var box = document.getElementById("aCases"); if (!box) return; box.textContent = "";
  var counts = {}, by = {}; S.list.forEach(function (c) { var k = gkey(c); counts[k] = (counts[k] || 0) + 1; (by[k] = by[k] || []).push(c); });
  var defs = groupDefs(counts), bar = document.getElementById("aTypeBar"); bar.textContent = "";
  var all = h("button", { class: "chip tchip", type: "button", "aria-pressed": String(S.sel.length === 0), onclick: function () { S.sel = []; renderCards(); } }, ["전체 ", h("b", { text: String(S.list.length) })]); bar.appendChild(all);
  defs.forEach(function (g) { bar.appendChild(h("button", { class: "chip tchip t-" + g.id, type: "button", "aria-pressed": String(S.sel.indexOf(g.id) >= 0), title: "눌러서 선택·해제(여러 개 선택 가능)", onclick: function () { toggleSel(g.id); } }, [h("i"), g.name + " ", h("b", { text: String(counts[g.id] || 0) })])); });
  var shown = S.sel.length ? defs.filter(function (g) { return S.sel.indexOf(g.id) >= 0; }) : defs, total = shown.reduce(function (a, g) { return a + (counts[g.id] || 0); }, 0);
  var ct = document.getElementById("aCount"); if (ct) ct.textContent = S.sel.length ? "선택한 유형 " + shown.length + "개 · 사건 " + total + "건" : "전체 · 사건 " + total + "건";
  if (!S.list.length) { box.appendChild(h("div", { class: "empty", text: "조건에 맞는 사건이 없습니다." })); return; }
  shown.forEach(function (g) {
    var items = by[g.id] || [], open = !S.collapsed[g.id], run = items.filter(function (c) { return c.status === "진행"; }).length;
    var tog = h("button", { class: "atog", type: "button", "aria-expanded": String(open), onclick: function () { S.collapsed[g.id] = open; renderCards(); } }, [h("span", { class: "car", text: open ? "▾" : "▸" }), h("b", { text: g.name })]);
    var lab = h("div", { class: "alab" }, [tog, h("div", { class: "asum", text: items.length + "건" }), h("div", { class: "asum2", text: "진행 " + run + " · 종결 " + (items.length - run) })]);
    var blocks = h("div", { class: "ablocks" }); blocks.hidden = !open;
    if (!items.length) blocks.appendChild(h("div", { class: "aempty", text: "이 유형의 사건이 없습니다." }));
    items.forEach(function (c) {
      var subs = (c.typeTags || []).filter(function (id) { return id !== c.typeId; }).map(function (id) { return h("span", { class: "stag t-" + id, text: nameOf(C.cfg.issueTypes, id), title: "부 유형" }); });
      var badges = h("div", { class: "badges" }, [h("span", { class: "b", text: c.buId ? nameOf(C.cfg.businessUnits, c.buId) : "사업부문 미지정" }),
        c.isPilot ? h("span", { class: "b pilot", text: "시범" }) : c.source === "과거이력" ? h("span", { class: "b", text: "과거이력" }) : null,
        c.cardStatus ? h("span", { class: "b " + (c.cardStatus === "확정" ? "conf" : "draft"), text: "카드 " + c.cardStatus }) : null,
        h("span", { class: "b", text: c.status }), c.typeSource === "ai" ? h("span", { class: "b ai", text: "유형 AI 제안" }) : null,
        c.suspectCount ? h("span", { class: "b warn", text: "확인 필요 " + c.suspectCount }) : null]);
      blocks.appendChild(h("button", { class: "ablk t-" + g.id, type: "button", onclick: function () { openCase(c.id); } }, [h("div", { class: "fd", text: c.folderName }),
        h("div", { class: "m", text: (C.cfg.labels && C.cfg.labels.caseStartDate || "시작일") + " " + dateText(c) + " · 파일 " + c.fileCount + "개" }), badges, subs.length ? h("div", { class: "stags" }, [h("span", { class: "hint", text: "부 유형" })].concat(subs)) : null]));
    });
    box.appendChild(h("section", { class: "agrp t-" + g.id + (items.length ? "" : " empty-g") }, [lab, blocks]));
  });
}

/* ───────── 새 사건 폴더 ───────── */
var dlg = null;
function ensureDlg() { if (dlg) return dlg; dlg = h("dialog", { id: "dlgA" }, [h("form", { class: "md", method: "dialog", id: "dlgAForm" })]); document.body.appendChild(dlg); return dlg; }
function openDlg(build, wide) { var d = ensureDlg(), f = d.querySelector("form"); f.textContent = ""; f.onsubmit = null; d.className = wide ? "wide" : ""; build(f); d.showModal(); return d; }
function closeDlg() { ensureDlg().close(); }
function lab(text, node) { return h("label", { text: text }, [node]); }
function createDlg() {
  openDlg(function (f) {
    f.appendChild(h("h3", { text: "새 사건 폴더 만들기" }));
    var ti = h("input", { type: "text", maxlength: "200", placeholder: "예: 제조사 표기 오류 및 이물 발견(A사)" }), dt = h("input", { type: "date" });
    var ty = opts(h("select"), C.cfg.issueTypes, "", "유형 선택(필수)"), bu = opts(h("select"), C.cfg.businessUnits, "", "미지정 (담당자가 선택)"), lv = opts(h("select"), C.cfg.levels, "", "미지정");
    var sm = h("textarea", { maxlength: "2000", placeholder: "한두 줄 요약(선택)" });
    f.appendChild(lab("사건 제목 (필수)", ti)); f.appendChild(lab((C.cfg.labels && C.cfg.labels.caseStartDate || "시작일") + " (필수)", dt));
    f.appendChild(lab("리스크 유형 (필수)", ty)); f.appendChild(lab("사업부문 (담당자가 선택)", bu)); f.appendChild(lab("위험도", lv)); f.appendChild(lab("요약", sm));
    f.appendChild(h("div", { class: "hint", text: "폴더 이름은 ‘시작연월_제목’(공백 없음)으로 자동 만들어집니다." }));
    var er = h("div", { class: "er" }), ok = h("button", { class: "btn", type: "submit", text: "폴더 만들기" }); ico(ok, "plus");
    f.appendChild(er); f.appendChild(h("div", { class: "ft" }, [h("button", { class: "btn sec", type: "button", text: "취소", onclick: closeDlg }), ok]));
    f.onsubmit = function (e) {
      e.preventDefault(); if (!ti.value.trim()) { er.textContent = "제목을 입력하세요"; return; } if (!dt.value) { er.textContent = "시작일을 입력하세요"; return; } if (!ty.value) { er.textContent = "유형을 선택하세요"; return; }
      ok.disabled = true;
      post("/api/archive/cases", { title: ti.value, startDate: dt.value, typeId: ty.value, buId: bu.value || undefined, level: lv.value || undefined, summary: sm.value }).then(function (d) { closeDlg(); reflect(); S.id = d.case.id; S.detail = d; S.view = "detail"; renderDetail(); }).catch(function (x) { er.textContent = x.message; ok.disabled = false; });
    };
  });
}

/* ───────── 상세 ───────── */
function openCase(id) { S.id = id; S.view = "detail"; S.up.log = []; return loadDetail().catch(fail); }
function loadDetail() { return get("/api/archive/cases/" + S.id).then(function (d) { S.detail = d; renderDetail(); }); }
function renderDetail() {
  var d = S.detail, c = d.case; root.textContent = "";
  root.appendChild(h("button", { class: "back", type: "button", text: "← 사건 목록", onclick: function () { reload().then(renderList).catch(fail); } }));
  var hero = h("div", { class: "rghero" }, [h("div", { class: "ey", text: c.folderName }), h("h1", { text: c.title }),
    h("div", { class: "badges", style: "position:relative;z-index:1" }, [typeTag(c.typeId, c.typeSource === "ai"), h("span", { class: "b", text: c.buId ? nameOf(C.cfg.businessUnits, c.buId) : "사업부문 미지정" }),
      c.level ? h("span", { class: "b lv l-" + c.level, text: "위험도 " + c.level }) : null, h("span", { class: "b", text: c.status }),
      c.isPilot ? h("span", { class: "b pilot", text: "시범 · 초안" }) : null, d.card.status ? h("span", { class: "b " + (d.card.status === "확정" ? "conf" : "draft"), text: "카드 " + d.card.status }) : null]),
    h("div", { class: "hbtn" }, [ico(h("a", { class: "btn sec", href: "/api/archive/cases/" + c.id + "/zip", text: "전체 다운로드 (zip)" }), "download"),
      ico(h("button", { class: "btn", type: "button", text: d.card.card ? "AI 분석 — 새로 만들기" : "AI 분석", onclick: analyzeDlg }), "check")])]);
  root.appendChild(hero);
  root.appendChild(h("div", { class: "aipanel", id: "aiPanel" }));
  AN.last = null; AN.state = null; startPoll();
  root.appendChild(section("01", "사건 카드", "문서에서 뽑은 사건 요약입니다. 초안은 담당자가 확인한 뒤 확정합니다."));
  root.appendChild(cardSection(d));
  root.appendChild(section("02", "사건 자료", "단계 하위폴더별로 묶여 있습니다. 전체 다운로드(zip)에도 같은 구조로 들어갑니다.", h("span", { class: "ct", text: "파일 " + d.files.filter(function (f) { return f.kind !== "ignore"; }).length + "개" })));
  root.appendChild(uploadBox(d));
  if (d.imports && d.imports.length) root.appendChild(h("p", { class: "src-note", text: "서버 경로에서 가져옴: " + d.imports.map(function (i) { return i.path + " (" + i.files + "개 · " + fmtSize(i.bytes || 0) + " · " + fdate(i.at) + ")"; }).join(" / ") }));
  root.appendChild(filesView(d));
  root.appendChild(section("03", "문서 내장 이미지", "문서 안에서 꺼낸 그림입니다. 다른 자료와 같은 이미지가 아니면 사건 자료로 연결할 수 있습니다.", h("span", { class: "ct", text: d.embedded.length + "장" })));
  root.appendChild(embeddedView(d));
  root.appendChild(h("p", { class: "src-note" }, ["확정 비밀번호는 기본적으로 접속 비밀번호와 같으며 따로 바꿀 수 있습니다. ", h("button", { class: "lg", type: "button", text: "확정 비밀번호 설정", onclick: pwDlg })]));
}
function saveClass(body) { return post("/api/cases/" + S.id + "/classify", body).then(function () { reflect(); return loadDetail(); }).catch(function (e) { fail(e); loadDetail(); }); }

function cardSection(d) {
  var c = d.case, cd = d.card, card = cd.card, L = C.cfg.labels || {};
  var wrap = h("div", { class: "cardgrid" }), left = h("div", { class: "card" }), right = h("div", { class: "card" });
  var tySel = selectBox("리스크 유형", C.cfg.issueTypes, c.typeId, "유형 미지정", function (v) { if (v) saveClass({ typeId: v }); });
  var buSel = selectBox("사업부문", C.cfg.businessUnits, c.buId, "미지정", function (v) { saveClass({ buId: v || null }); });
  var tyRow = h("dd", {}, [tySel, " ", c.typeSource === "ai" ? h("span", { class: "b ai", title: c.aiType && c.aiType.why || "", text: "AI 제안 (확인 전)" }) : null]);
  var buRow = h("dd", {}, [buSel, " ", c.aiBu && !c.buId ? h("span", { class: "hint", title: c.aiBu.why || "", text: "AI 힌트: " + nameOf(C.cfg.businessUnits, c.aiBu.id) + " — 담당자가 선택합니다" }) : null]);
  var sd = card && card.start_date, ed = card && card.end_date;
  var kv = h("dl", { class: "kv" }, [
    h("dt", { text: L.caseStartDate || "시작일" }), startDateCell(c, sd),
    h("dt", { text: "종료일" }), h("dd", { text: c.endDate || (ed && ed.value) || "진행 중" + (ed && ed.basis ? " (" + ed.basis + ")" : "") }),
    h("dt", { text: "리스크 유형" }), tyRow, h("dt", { text: "사업부문" }), buRow,
    h("dt", { text: "위험도" }), h("dd", {}, [c.level ? h("span", { class: "b lv l-" + c.level, text: c.level }) : card && card.risk_level && card.risk_level.value ? h("span", { class: "b ai", text: "AI 제안 · " + card.risk_level.value }) : "미지정", card && card.risk_level && card.risk_level.reasoning ? h("div", { class: "hint", text: card.risk_level.reasoning }) : null]),
    h("dt", { text: "진행 단계" }), h("dd", { text: c.stageId ? stageName(c.stageId) : "-" }),
    h("dt", { text: "출처" }), h("dd", { text: c.source + (c.isPilot ? " (초안 · 담당자 검토 전)" : "") })]);
  left.appendChild(h("div", { class: "row", style: "justify-content:space-between;margin-bottom:12px" }, [h("h3", { style: "margin:0;font-size:19px", text: "사건 정보" }),
    d.card.status ? h("span", { class: "b " + (cd.status === "확정" ? "conf" : "draft"), text: cd.status === "확정" ? "확정 · " + cd.by + " · " + fdate(cd.at) : "초안" }) : h("span", { class: "b", text: "카드 없음" })]));
  if (d.evidenceCount) left.appendChild(h("div", { class: "row", style: "margin:-4px 0 10px" }, [ico(h("a", { class: "btn sec sm", href: "/api/archive/cases/" + c.id + "/zip?evidence=1", title: "이 카드가 근거로 인용한 파일만 한 번에 받습니다", text: "근거 파일 모아 받기 (" + d.evidenceCount + "개)" }), "download")]));
  left.appendChild(kv);
  var summary = card ? card.summary : c.summary;
  left.appendChild(h("p", { class: "sumtxt", text: summary || "요약이 아직 없습니다. ‘AI 분석’ 버튼으로 자료에서 사건 카드를 만들 수 있습니다." }));
  if (card && card.timeline && card.timeline.length) {
    left.appendChild(h("div", { class: "subh", text: "타임라인" }));
    left.appendChild(h("ul", { class: "tline" }, card.timeline.map(function (t) { return h("li", {}, [h("span", { class: "d", text: t.date || "날짜 미상" }), t.event, srcLink(t)]); })));
  }
  if (card && card.stage_actions) {
    var sa = C.cfg.caseStages.map(function (s) { return { s: s, a: card.stage_actions[s.id] || [] }; }).filter(function (x) { return x.a.length; });
    if (sa.length) {
      left.appendChild(h("div", { class: "subh", text: "단계별 조치" }));
      left.appendChild(h("ul", { class: "tline" }, [].concat.apply([], sa.map(function (x) { return x.a.map(function (a) { return h("li", {}, [h("span", { class: "d", text: x.s.name }), (a.date ? a.date + " · " : "") + (a.action || ""), srcLink(a)]); }); }))));
    }
  }
  if (card && card._meta) {
    var mt = card._meta, im = mt.images || {};
    left.appendChild(h("div", { class: "note info", text: "AI 분석 초안 · " + fdate(mt.generatedAt) + (im.read != null ? " · 이미지 " + im.read + "장 읽음" + (im.failed ? " · 읽지 못함 " + im.failed + "장" : "") : "") + (mt.mergedImageFacts ? " · 이미지에서 확인된 사실 " + mt.mergedImageFacts + "건을 자동 병합" : "") + ". 담당자가 확인한 뒤 확정하세요." }));
  }
  if (card) left.appendChild(confirmBox(d));
  wrap.appendChild(left);
  function list(title, items, cls, fmt) { if (!items || !items.length) return; right.appendChild(h("div", { class: "subh", text: title })); right.appendChild(h("ul", { class: "pts" + (cls ? " " + cls : "") }, items.map(function (x) { return h("li", {}, fmt ? fmt(x) : [x]); }))); }
  if (card) {
    list("법적 쟁점", card.legal_issues, "", function (x) { return [x.issue, " ", srcLink(x)]; });
    var p = card.parties || {}, pb = [];
    [["internal_departments", "내부 부서"], ["partners_and_third_parties", "협력사·제3자"], ["agencies", "관계 기관"]].forEach(function (k) { (p[k[0]] || []).forEach(function (n) { pb.push(h("span", { class: "b", title: k[1], text: n })); }); });
    if (pb.length) { right.appendChild(h("div", { class: "subh", text: "관련 부서·협력사·기관" })); right.appendChild(h("div", { class: "badges" }, pb)); }
    list("금액·수량", card.figures, "", function (x) { return [h("b", { text: (x.label || "") + ": " }), String(x.value == null ? "" : x.value), x.needs_review ? h("span", { class: "b warn", text: x.vision_derived ? "검수 필요 · 이미지 판독" : "검수 필요" }) : null, " ", srcLink(x)]; });
    list("이미지에서 보강된 사실", card.filled_from_embedded_images, "", function (x) { return [h("b", { text: x.item + ": " }), x.fact, " ", srcLink(x)]; });
    list("문서 간 불일치", card.inconsistencies, "warn", function (x) { var out = [h("b", { text: x.item + ": " })]; (x.values || []).forEach(function (v, i) { if (i) out.push(" / "); out.push(String(v.value), " ", srcLink(v)); }); return out; });
    list("문서에 없음", card.not_in_documents, "mute");
    list("불확실", card.uncertainties, "warn", txtItem);
    list("검수 필요", card.review_flags, "warn", txtItem);
    list("메모", card.notes, "mute");
  } else right.appendChild(h("div", { class: "empty", text: "사건 카드가 아직 없습니다. 자료를 올린 뒤 ‘AI 분석’ 버튼으로 만들 수 있습니다." }));
  wrap.appendChild(right);
  return wrap;
}
function confirmBox(d) {
  var cd = d.card, box = h("div", { class: "cfm" }), er = h("div", { class: "er hint", style: "color:var(--hi);min-height:16px" });
  box.appendChild(h("div", { class: "subh", text: cd.status === "확정" ? "확정됨" : "카드 확정" }));
  var nm = h("input", { type: "text", placeholder: "확정자 이름", maxlength: "40", "aria-label": "확정자 이름" }), pw = h("input", { type: "password", placeholder: "확정 비밀번호", autocomplete: "off", "aria-label": "확정 비밀번호" });
  function go(path, label, body) { var b = h("button", { class: "btn" + (cd.status === "확정" ? " sec" : ""), type: "button", text: label }); ico(b, cd.status === "확정" ? "undo" : "check"); b.onclick = function () { er.textContent = ""; b.disabled = true; post("/api/archive/cases/" + S.id + path, body()).then(function () { reflect(); return loadDetail(); }).catch(function (e) { er.textContent = e.message; b.disabled = false; }); }; return b; }
  if (cd.status === "확정") {
    box.appendChild(h("div", { class: "note info", text: cd.by + " 님이 " + fdate(cd.at) + "에 확정했습니다. 내용을 고치려면 초안으로 되돌린 뒤 다시 확정합니다." }));
    box.appendChild(h("div", { class: "r2" }, [nm, pw, go("/card/reopen", "초안으로 되돌리기", function () { return { name: nm.value, password: pw.value }; })]));
  } else {
    box.appendChild(h("div", { class: "note", text: "초안입니다. 내용을 검토한 뒤 확정하세요. 확정하려면 확정자 이름과 확정 비밀번호를 입력해야 합니다." }));
    box.appendChild(h("div", { class: "r2" }, [nm, pw, go("/card/confirm", "카드 확정", function () { return { name: nm.value, password: pw.value }; })]));
  }
  box.appendChild(er);
  if (cd.history && cd.history.length) box.appendChild(h("ul", { class: "hist" }, cd.history.map(function (x) { return h("li", { text: fdate(x.at) + " · " + x.action + " · " + x.by + (x.note ? " (" + x.note + ")" : "") }); })));
  return box;
}

/* ───────── 자료(단계별 묶음) ───────── */
var COLORS = [["--conv", "--conv-s"], ["--teal", "--teal-s"], ["--corp", "--corp-s"], ["--home", "--home-s"], ["--super", "--super-s"], ["--hi", "--hi-s"]];
function groupsOf(d) {
  var g = d.stages.map(function (s, i) { return { id: s.id, no: String(i + 1).padStart(2, "0"), name: s.name, c: COLORS[i % COLORS.length] }; });
  (d.stageExtras || []).forEach(function (s) { g.push({ id: s.id, no: "종합", name: s.name + " (전 과정 요약 자료)", c: ["--mid", "--mid-s"] }); });
  g.push({ id: "procedure-ref", no: "참고", name: "절차참고 — 이 사건의 사실관계와 섞지 않는 일반 절차·가이드", c: ["--low", "--low-s"] });
  g.push({ id: "keep-only", no: "보관", name: "보관만 — 분석·AI 전송 없이 저장만", c: ["--etc", "--etc-s"] });
  g.push({ id: "unassigned", no: "—", name: "단계 미지정", c: ["--etc", "--etc-s"] });
  return g;
}
function filesView(d) {
  var wrap = h("div"), files = d.files, all = groupsOf(d);
  all.concat([{ id: "ignore", no: "무시", name: "무시로 표시한 파일(내려받기·zip 제외)", c: ["--etc", "--etc-s"] }]).forEach(function (g) {
    var items = files.filter(function (f) { return f.group === g.id; });
    if (g.id === "ignore" && !items.length) return;
    var grp = h("div", { class: "fgrp" + (items.length ? "" : " empty-g"), style: "--tc:var(" + g.c[0] + ");--tcs:var(" + g.c[1] + ")" }, [
      h("div", { class: "gh" }, [h("span", { class: "n", text: g.no }), h("span", { text: g.name }), h("span", { class: "c", text: items.length + "개" })])]);
    if (!items.length) grp.appendChild(h("div", { class: "frw" }, [h("span"), h("span", { class: "hint", text: "비어 있음" }), h("span")]));
    items.forEach(function (f) { grp.appendChild(fileRow(f, d)); });
    wrap.appendChild(grp);
  });
  return wrap;
}
function patchFile(f, body) { return post("/api/archive/cases/" + S.id + "/files/" + f.id, body).then(loadDetail).catch(function (e) { fail(e); loadDetail(); }); }
function fileRow(f, d) {
  var row = h("div", { class: "frw" }), e = ext(f.name);
  row.appendChild(h("div", { class: "ic " + e, text: e.toUpperCase().slice(0, 4) }));
  var aiPct = f.aiStage && typeof f.aiStage.confidence === "number" ? " " + Math.round(f.aiStage.confidence * 100) + "%" : "";
  row.appendChild(h("div", { class: "nm" }, [h("a", { href: "/api/archive/cases/" + S.id + "/files/" + f.id + "/download", title: f.relPath + " — 내려받기", text: f.name }),
    h("div", { class: "sub" }, [fmtSize(f.size), h("span", { class: "b kind", text: kindName(f.kind) }), f.kindSource === "auto" ? h("span", { class: "b ai", title: "파일 이름·형식 규칙으로 자동 분류했습니다. 종류를 바꾸면 담당자 지정이 됩니다.", text: "자동 분류" }) : null,
      f.piiState === "suspect" ? h("span", { class: "b warn", text: "개인정보 의심" }) : null,
      f.stage && f.stageSource === "ai" ? h("span", { class: "b ai", title: f.aiStage && f.aiStage.why || "", text: "단계 AI 제안" + aiPct }) : null,
      f.dupOf ? h("span", { class: "b hold", text: "중복" }) : null, f.note ? h("span", { text: f.note }) : null])]));
  var ed = h("div", { class: "ed" });
  ed.appendChild(selectBox("단계", d.stages.concat(d.stageExtras || []), f.stage || "", "단계 미지정", function (v) { patchFile(f, { stage: v || null }); }));
  ed.appendChild(selectBox("종류", d.fileKinds, f.kind, null, function (v) { patchFile(f, { kind: v }); }));
  if (f.stage && f.stageSource === "ai") ed.appendChild(h("button", { class: "btn sec sm", type: "button", text: "단계 확인", onclick: function () { patchFile(f, { confirmStage: true }); } }));
  row.appendChild(ed);
  if (f.piiState === "suspect") {
    row.appendChild(h("div", { class: "warnbox note bad" }, ["개인정보가 들어 있을 수 있는 파일입니다(" + (f.piiNote || "고객 명단 형식") + "). 보관만 하며 AI 분석에는 보내지 않습니다. 개인정보가 아니라면 분석을 허용할 수 있습니다. ",
      h("button", { class: "btn sec", type: "button", text: "개인정보 아님 (분석 허용)", onclick: function () { patchFile(f, { pii: "cleared" }); } })]));
  }
  if (f.suspectOtherCase) {
    row.appendChild(h("div", { class: "warnbox note bad" }, ["다른 사건 문서로 의심됩니다. 이 사건에 쓸 문서인지 확인하세요. (AI 분석이 내용을 읽고 판정했거나, 같은 파일이 다른 사건에 있는 경우입니다) ",
      h("button", { class: "btn sec", type: "button", text: "이 사건 문서가 맞음", onclick: function () { patchFile(f, { suspectOtherCase: false, kind: "case-doc" }); } }), " ",
      h("button", { class: "btn sec", type: "button", text: "무시로 표시", onclick: function () { patchFile(f, { suspectOtherCase: false, kind: "ignore" }); } })]));
  }
  return row;
}

/* ───────── 업로드 ───────── */
function uploadBox(d) {
  var box = h("div", { class: "upl", id: "upBox" });
  var ks = opts(h("select", { "aria-label": "파일 종류" }), d.fileKinds, S.up.kind), ss = opts(h("select", { "aria-label": "단계" }), d.stages.concat(d.stageExtras || []), S.up.stage, "단계 미지정");
  ks.onchange = function () { S.up.kind = ks.value; }; ss.onchange = function () { S.up.stage = ss.value; };
  var fi = h("input", { type: "file", multiple: true, hidden: true }), di = h("input", { type: "file", hidden: true });
  di.setAttribute("webkitdirectory", ""); di.setAttribute("directory", "");
  fi.onchange = function () { start([].map.call(fi.files, function (f) { return { file: f, rel: f.name }; })); fi.value = ""; };
  di.onchange = function () { start([].map.call(di.files, function (f) { return { file: f, rel: (f.webkitRelativePath || f.name).split("/").slice(1).join("/") || f.name }; })); di.value = ""; };
  box.appendChild(h("div", { class: "opts" }, [h("b", { text: "자료 올리기" }), h("label", {}, ["종류", ks]), h("label", {}, ["단계", ss]),
    ico(h("button", { class: "btn", type: "button", text: "파일 선택", onclick: function () { fi.click(); } }), "upload"), ico(h("button", { class: "btn sec", type: "button", text: "폴더 선택", onclick: function () { di.click(); } }), "folder"), fi, di]));
  box.appendChild(h("div", { class: "hint", text: "여기로 파일이나 폴더를 끌어다 놓아도 됩니다. ‘보관만’을 고르면 읽기·분석·AI 전송 없이 저장만 합니다(고객 명단 등). 같은 파일(해시 동일)은 ‘보관만’으로 표시되고, 이름이 같고 확장자만 다른 판본은 큰 파일을 기본으로 둡니다." }));
  box.appendChild(h("div", { class: "ulist", id: "upLog" }));
  box.ondragover = function (e) { e.preventDefault(); box.classList.add("drag"); };
  box.ondragleave = function () { box.classList.remove("drag"); };
  box.ondrop = function (e) {
    e.preventDefault(); box.classList.remove("drag");
    var ents = [].map.call(e.dataTransfer.items || [], function (it) { return it.webkitGetAsEntry && it.webkitGetAsEntry(); }).filter(Boolean);
    if (!ents.length) { start([].map.call(e.dataTransfer.files, function (f) { return { file: f, rel: f.name }; })); return; }
    Promise.all(ents.map(function (en) { return readEntry(en, "").then(function (list) { return en.isDirectory ? list.map(function (x) { return { file: x.file, rel: x.rel.split("/").slice(1).join("/") || x.file.name }; }) : list; }); })).then(function (a) { start([].concat.apply([], a)); });
  };
  renderUp(box.querySelector("#upLog"));
  return box;
}
function readEntry(en, path) {
  return new Promise(function (res) {
    if (en.isFile) { en.file(function (f) { res([{ file: f, rel: path + f.name }]); }, function () { res([]); }); }
    else if (en.isDirectory) {
      var rd = en.createReader(), all = [];
      (function more() { rd.readEntries(function (es) { if (!es.length) { Promise.all(all).then(function (a) { res([].concat.apply([], a)); }); return; } es.forEach(function (x) { all.push(readEntry(x, path + en.name + "/")); }); more(); }, function () { res([]); }); })();
    } else res([]);
  });
}
function renderUp(box) {
  box = box || document.getElementById("upLog"); if (!box) return; box.textContent = "";
  S.up.log.forEach(function (u) {
    var line = h("div", { class: "u" + (u.state === "실패" ? " err" : "") }, [h("b", { text: u.name }), h("span", { text: u.state + (u.err ? ": " + u.err : "") })]);
    if (u.res) {
      (u.res.dedupe || []).forEach(function (n) { line.appendChild(h("span", { class: "b hold", text: n.type === "same-hash" ? "같은 파일: " + n.with + " → 보관만" : "같은 문서의 다른 판본: " + n.keep + " 기준, " + n.demoted + " 보관만" })); });
      (u.res.warnings || []).forEach(function (w) { line.appendChild(h("span", { class: "b warn", text: "다른 사건에 같은 파일: " + w.case + " / " + w.name })); });
    }
    box.appendChild(line);
  });
  if (S.up.log.length) box.appendChild(h("div", { class: "hint", text: "다른 사건 문서인지는 ‘AI 분석’ 때 내용을 읽고 판정합니다(올릴 때는 같은 파일인지만 확인합니다)." }));
}
function start(items) {
  if (!items.length) return; var id = S.id, kind = S.up.kind, stage = S.up.stage, seq = Promise.resolve();
  items.forEach(function (it) {
    var u = { name: it.rel || it.file.name, state: "대기" }; S.up.log.push(u);
    seq = seq.then(function () {
      u.state = "올리는 중…"; renderUp();
      var qs = new URLSearchParams({ name: it.file.name, relPath: it.rel || it.file.name, kind: kind }); if (stage) qs.set("stage", stage);
      return fetch("/api/archive/cases/" + id + "/files?" + qs, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: it.file })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "오류 " + r.status); return j; }); })
        .then(function (r) { u.state = "완료"; u.res = r; }).catch(function (e) { u.state = "실패"; u.err = e.message; });
    }).then(function () { renderUp(); });
  });
  seq.then(function () { if (S.view === "detail" && S.id === id) { var keep = S.up.log; return loadDetail().then(function () { S.up.log = keep; renderUp(); }); } });
}

/* ───────── 내장 이미지 ───────── */
function embeddedView(d) {
  if (!d.embedded.length) return h("div", { class: "empty", text: "이 사건에는 문서 내장 이미지 목록이 없습니다." });
  var g = h("div", { class: "egrid" });
  d.embedded.forEach(function (e) {
    var url = "/api/archive/cases/" + S.id + "/embedded/" + encodeURIComponent(e.name) + "/image";
    var th = h("button", { class: "th", type: "button", "aria-label": e.name + " 크게 보기", onclick: function () { previewDlg(e, url); } }, [h("img", { src: url, alt: e.name, loading: "lazy" })]);
    var act = e.linkedFileId ? h("span", { class: "b conf", text: "사건 자료로 연결됨" }) : e.duplicate ? h("span", { class: "b hold", text: "중복 · " + (e.duplicate.kind === "case-file" ? "사건 파일 " : "다른 내장 이미지 ") + (e.duplicate.name || "") }) :
      h("button", { class: "btn sec", type: "button", text: "사건 자료로 연결", onclick: function () { post("/api/archive/cases/" + S.id + "/embedded/" + encodeURIComponent(e.name) + "/link").then(loadDetail).catch(fail); } });
    g.appendChild(h("div", { class: "ei" }, [th, h("div", { class: "bd2" }, [h("div", { class: "badges" }, [e.docType ? h("span", { class: "b", text: e.docType }) : null, e.readability ? h("span", { class: "b", text: "판독 " + e.readability }) : null]),
      h("div", { class: "s", text: (e.sourceDoc || "") + " · " + e.name }), e.keyFacts && e.keyFacts[0] ? h("div", { class: "k", text: e.keyFacts[0] }) : null, act])]));
  });
  return g;
}
function previewDlg(e, url) {
  openDlg(function (f) {
    f.appendChild(h("h3", { text: e.name })); f.appendChild(h("img", { class: "prev", src: url, alt: e.name }));
    f.appendChild(h("div", { class: "hint", text: (e.sourceDoc || "") + (e.shotDate ? " · " + e.shotDate : "") }));
    if (e.keyFacts && e.keyFacts.length) f.appendChild(h("ul", { class: "pts" }, e.keyFacts.map(function (k) { return h("li", { text: k }); })));
    f.appendChild(h("div", { class: "ft" }, [h("button", { class: "btn sec", type: "button", text: "닫기", onclick: closeDlg })]));
  }, true);
}

/* ───────── 확정 비밀번호 설정 ───────── */
function pwDlg() {
  get("/api/settings/confirm-password").then(function (info) {
    openDlg(function (f) {
      f.appendChild(h("h3", { text: "확정 비밀번호 설정" }));
      f.appendChild(h("div", { class: "note info", text: info.custom ? "지금은 접속 비밀번호와 따로 정한 확정 비밀번호를 쓰고 있습니다." : "지금은 접속 비밀번호와 같은 값을 쓰고 있습니다." }));
      var cu = h("input", { type: "password", autocomplete: "off" }), nx = h("input", { type: "password", autocomplete: "off", placeholder: "6자 이상" }), er = h("div", { class: "er" });
      f.appendChild(lab("현재 확정 비밀번호", cu)); f.appendChild(lab("새 확정 비밀번호", nx)); f.appendChild(er);
      function done(msg) { closeDlg(); alert(msg); }
      var ok = h("button", { class: "btn", type: "submit", text: "변경" }), rs = h("button", { class: "btn sec", type: "button", text: "접속 비밀번호와 같게 되돌리기", onclick: function () { post("/api/settings/confirm-password", { current: cu.value, reset: true }).then(function () { done("접속 비밀번호와 같게 되돌렸습니다."); }).catch(function (x) { er.textContent = x.message; }); } });
      f.appendChild(h("div", { class: "ft" }, [rs, h("button", { class: "btn sec", type: "button", text: "닫기", onclick: closeDlg }), ok]));
      f.onsubmit = function (e) { e.preventDefault(); post("/api/settings/confirm-password", { current: cu.value, next: nx.value }).then(function () { done("확정 비밀번호를 바꿨습니다."); }).catch(function (x) { er.textContent = x.message; }); };
    });
  }).catch(fail);
}

/* ───────── 근거(출처) 링크: 카드의 ‘근거: 파일’을 눌러 내려받거나(이미지·PDF 는 새 탭 미리보기) 열 수 있다 ───────── */
var clipTxt = function (t, n) { t = String(t || ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
function evBadge(text, title, cls) { return h("span", { class: "b " + (cls || "warn"), title: title || "", text: text }); }
function txtItem(x) { return typeof x === "string" ? [x] : [x && x.text || "", " ", srcLink(x)]; }
function srcLink(x) {
  if (!x || typeof x !== "object") return null;
  var s = x.src || x.src_resolved, raw = x.source_file || (typeof x.source === "string" ? x.source : "");
  var wrap = h("span", { class: "s ev" });
  if (!s) return raw ? h("span", { class: "s ev" }, [h("span", { text: "근거: " + base(raw) }), evBadge("근거 파일 미확인", "카드에 적힌 파일 이름과 맞는 파일이 이 사건에 없습니다")]) : null;
  if (s.kind === "file" && s.file_id && s.status !== "missing") {
    var e = s.ext || ext(s.name || s.rel || ""), inline = /^(png|jpe?g|gif|webp|pdf)$/.test(e);
    var href = "/api/archive/cases/" + S.id + "/files/" + s.file_id + "/download" + (inline ? "?inline=1" : "");
    var tip = [s.loc ? "위치: " + s.loc : "", s.quote ? "인용: “" + s.quote + "”" : "", s.status === "name-matched" ? "파일 이름으로 연결한 근거" : "", inline ? "새 탭에서 열기" : "내려받기"].filter(Boolean).join(" · ");
    wrap.appendChild(h("a", { class: "src", href: href, target: inline ? "_blank" : null, rel: "noopener", title: tip, text: "근거: " + (s.name || base(s.rel)) }));
    if (s.loc) wrap.appendChild(h("span", { class: "evq", text: " " + s.loc }));
    if (s.quote) wrap.appendChild(h("span", { class: "evq", text: " “" + clipTxt(s.quote, 48) + "”" }));
    if (s.status === "quote-unverified") wrap.appendChild(evBadge("인용 미확인", "AI 가 적은 인용문이 원문에서 확인되지 않았습니다. 파일을 열어 확인하세요"));
    if (s.fileKind === "keep-only") wrap.appendChild(evBadge("보관만 파일", "AI 분석에는 쓰지 않는 보관용 파일입니다", "hold"));
    if (s.fileKind === "ignore") wrap.appendChild(evBadge("무시 파일", "무시로 표시된 파일입니다"));
    if (s.otherCase) wrap.appendChild(evBadge("다른 사건 의심", "다른 사건 문서로 의심되는 파일입니다"));
    return wrap;
  }
  if (s.kind === "embedded" && s.exists !== false) {
    wrap.appendChild(h("a", { class: "src", href: "/api/archive/cases/" + S.id + "/embedded/" + encodeURIComponent(s.embedded) + "/image", target: "_blank", rel: "noopener", title: "문서 안의 그림 — 새 탭에서 열기", text: "근거: " + (s.doc || "") + " 내장 " + (s.name || s.embedded) }));
    return wrap;
  }
  wrap.appendChild(h("span", { text: "근거: " + base(s.raw || s.rel || raw || "") }));
  wrap.appendChild(evBadge(s.status === "missing" ? "파일 없음" : "근거 미확인", s.status === "missing" ? "근거로 적힌 파일이 사건에서 삭제되었습니다" : "AI 가 적은 근거 파일을 이 사건에서 찾지 못했습니다(링크 없음)"));
  return wrap;
}

/* ───────── 시작일(최초 민원 접수일) 확정 ───────── */
function startDateCell(c, sd) {
  var kids = [dateText(c)];
  if (c.startProvisional) kids.push(" ", h("span", { class: "b hold", text: "미확정" }));
  if (sd && sd.basis) kids.push(h("div", { class: "hint", text: sd.basis + (sd.conflict ? " · 문서 간 날짜 충돌" : "") }));
  if (sd && sd.candidates && sd.candidates.length) sd.candidates.forEach(function (cd) { kids.push(h("div", { class: "hint" }, [(cd.date || "") + " ", srcLink(cd)])); });
  var ai = sd && sd.value && sd.value !== c.startDate ? sd.value : null;
  if (c.startProvisional || ai) {
    var box = h("div", { class: "stbox" }), di = h("input", { type: "date", "aria-label": "최초 민원 접수일", value: c.startProvisional ? "" : c.startDate || "" });
    if (ai) box.appendChild(h("button", { class: "btn sec sm", type: "button", text: "문서의 날짜 " + ai + " 로 확정", onclick: function () { setStart(ai); } }));
    box.appendChild(di);
    box.appendChild(h("button", { class: "btn sec sm", type: "button", text: "직접 입력해 확정", onclick: function () { if (!di.value) { alert("날짜를 선택하세요"); return; } setStart(di.value); } }));
    kids.push(box);
  }
  return h("dd", {}, kids);
}
function setStart(date) { post("/api/archive/cases/" + S.id + "/start-date", { date: date }).then(function () { reflect(); return loadDetail(); }).catch(fail); }

/* ───────── AI 분석: 진행 패널 · 확인창 ───────── */
var AN = { timer: null, last: null, state: null };
var money = function (n) { return "$" + (Math.round((n || 0) * 100) / 100).toFixed(2); };
function stopPoll() { if (AN.timer) { clearInterval(AN.timer); AN.timer = null; } }
function startPoll() {
  stopPoll(); var id = S.id;
  function tick() {
    get("/api/archive/cases/" + id + "/analysis").then(function (st) {
      if (S.view !== "detail" || S.id !== id) { stopPoll(); return; }
      var prev = AN.last; AN.last = st.active ? st.active.status : st.latest ? st.latest.status : null; AN.state = st; renderPanel();
      var live = st.active && (st.active.status === "대기" || st.active.status === "실행 중");
      if (!live) { stopPoll(); if (prev === "대기" || prev === "실행 중") loadDetail().catch(fail); }
    }).catch(function () { stopPoll(); });
  }
  tick(); AN.timer = setInterval(tick, 2000);
}
function runAct(path, ask) { if (ask && !confirm(ask)) return; post("/api/archive/cases/" + S.id + path).then(function () { AN.last = null; startPoll(); }).catch(fail); }
function renderPanel() {
  var box = document.getElementById("aiPanel"); if (!box || !AN.state) return; box.textContent = "";
  var st = AN.state, r = st.active || st.latest, steps = st.steps || [], head = h("div", { class: "aihead" }, [h("h3", { text: "AI 분석" })]);
  box.appendChild(head);
  if (!r) { box.appendChild(h("div", { class: "hint", text: "아직 AI 분석을 한 적이 없습니다. 위의 ‘AI 분석’ 버튼을 누르면 읽을 파일과 예상 비용을 먼저 보여 드립니다. 누르기 전에는 AI 를 호출하지 않습니다." })); return; }
  var live = r.status === "대기" || r.status === "실행 중", paused = r.status === "일시중지", failed = r.status === "실패";
  head.appendChild(h("span", { class: "b " + (r.status === "완료" ? "conf" : live ? "new" : paused || r.status === "취소" ? "hold" : "warn"), text: r.status }));
  if (live) head.appendChild(h("button", { class: "btn sec sm", type: "button", text: "취소", onclick: function () { runAct("/analyze/cancel", "분석을 취소할까요? 이미 읽은 이미지 결과는 보존됩니다."); } }));
  if (paused || failed) head.appendChild(h("button", { class: "btn sm", type: "button", text: paused ? "이어서 실행" : "다시 시도 (이어서)", onclick: function () { runAct("/analyze/resume"); } }));
  if (paused) head.appendChild(h("button", { class: "btn sec sm", type: "button", text: "취소", onclick: function () { runAct("/analyze/cancel", "분석을 취소할까요?"); } }));
  if (live || paused || failed) box.appendChild(h("ul", { class: "asteps" }, steps.map(function (s, i) { var cls = i + 1 < r.step ? "done" : i + 1 === r.step ? "cur" : ""; return h("li", { class: cls }, [(cls === "done" ? "✓ " : "") + (i + 1) + ". " + s]); })));
  if (live && r.total > 0) box.appendChild(h("div", { class: "abar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(r.done / r.total * 100)) }, [h("i", { style: "width:" + Math.round(r.done / r.total * 100) + "%" })]));
  if (r.message && r.status !== "완료") box.appendChild(h("div", { class: "hint", text: (r.stepLabel ? r.stepLabel + " · " : "") + r.message }));
  if (paused && r.pausedReason) box.appendChild(h("div", { class: "note", text: r.pausedReason }));
  if (failed && r.error) box.appendChild(h("div", { class: "note bad", text: "실패: " + r.error + " — 이미 끝낸 단계의 결과는 보존되어 있어 ‘다시 시도’는 남은 단계만 이어서 합니다." }));
  if (r.status === "완료") box.appendChild(h("div", { class: "note info", text: r.message }));
  var meta = [h("span", {}, ["AI 호출 ", h("b", { text: r.calls + "회" })]), h("span", {}, ["토큰 입력 ", h("b", { text: (r.tokens.in || 0).toLocaleString("ko-KR") }), " · 출력 ", h("b", { text: (r.tokens.out || 0).toLocaleString("ko-KR") })]), h("span", {}, ["비용(추정) ", h("b", { text: money(r.costUsd) })])];
  if (r.estimate) meta.push(h("span", { text: "분석 전 예상 " + money(r.estimate.low) + " ~ " + money(r.estimate.high) }));
  if (r.createdAt) meta.push(h("span", { text: "요청 " + String(r.createdAt).replace("T", " ").slice(0, 16) + " (UTC)" }));
  box.appendChild(h("div", { class: "aimeta" }, meta));
  if (r.files && (r.status === "완료" || paused || failed)) box.appendChild(h("div", { class: "hint", text: "읽은 파일: 문서 " + r.files.text.length + "개 · 이미지 " + r.files.images.length + "장 · 문서 속 그림 " + r.files.embedded.length + "장 / 보관만 " + r.files.keepOnly.length + "개 · 개인정보 의심(제외) " + r.files.piiHold.length + "개" }));
  if (st.history && st.history.length > 1) box.appendChild(h("details", { class: "aihist" }, [h("summary", { text: "분석 이력 (" + st.history.length + ")" }), h("ul", {}, st.history.map(function (x) { return h("li", { text: String(x.createdAt).replace("T", " ").slice(0, 16) + " · " + x.status + " · 호출 " + x.calls + "회 · " + money(x.costUsd) + (x.options && x.options.images === false ? " · 이미지 제외" : "") }); }))]));
}
function detailsList(title, arr, fmt) {
  if (!arr || !arr.length) return null;
  return h("details", {}, [h("summary", { text: title + " (" + arr.length + ")" }), h("ul", {}, arr.map(function (x) { return h("li", { text: fmt(x) }); }))]);
}
function analyzeDlg() {
  var d0 = S.detail, hasCard = !!d0.card.card, confirmed = d0.card.status === "확정";
  openDlg(function (f) {
    f.classList.add("adlg");
    f.appendChild(h("h3", { text: hasCard ? "AI 분석 — 새로 만들기" : "AI 분석" }));
    var body = h("div", { style: "display:grid;gap:12px" }, [h("div", { class: "hint", text: "읽을 파일을 점검하는 중입니다…(점검 단계에서는 AI 를 호출하지 않습니다)" })]); f.appendChild(body);
    var er = h("div", { class: "er" }), ok = h("button", { class: "btn", type: "submit", text: "분석 시작" }); ok.disabled = true; ico(ok, "check");
    f.appendChild(er); f.appendChild(h("div", { class: "ft" }, [h("button", { class: "btn sec", type: "button", text: "닫기", onclick: closeDlg }), ok]));
    var imgOn = h("input", { type: "checkbox" }); imgOn.checked = true;
    f.onsubmit = function (e) {
      e.preventDefault(); ok.disabled = true; er.textContent = "";
      post("/api/archive/cases/" + S.id + "/analyze", { images: imgOn.checked, fresh: hasCard }).then(function () { closeDlg(); AN.last = null; startPoll(); }).catch(function (x) { er.textContent = x.message; ok.disabled = false; });
    };
    get("/api/archive/cases/" + S.id + "/analyze/plan").then(function (p) {
      body.textContent = ""; var c = p.counts;
      if (confirmed) body.appendChild(h("div", { class: "note bad", text: "확정된 카드입니다. 다시 분석하려면 먼저 사건 카드에서 ‘초안으로 되돌리기’를 하세요." }));
      if (p.activeRun) body.appendChild(h("div", { class: "note bad", text: "이 사건은 이미 분석이 진행 중이거나 일시중지 상태입니다. 위 진행 패널에서 이어서 실행하거나 취소하세요." }));
      if (hasCard && !confirmed) body.appendChild(h("div", { class: "note", text: "이미 있는 사건 카드(초안)는 새 결과로 바뀝니다. 담당자가 정한 유형·단계·종류 값은 그대로 유지됩니다." }));
      body.appendChild(h("dl", { class: "kv" }, [
        h("dt", { text: "읽을 문서" }), h("dd", { text: c.text + "개 (약 " + c.textChars.toLocaleString("ko-KR") + "자)" }),
        h("dt", { text: "읽을 이미지" }), h("dd", { text: "사건 이미지 " + c.images + "장 + 문서 속 그림 " + c.embedded + "장" + (c.imagesCached ? " · 이미 읽은 " + c.imagesCached + "장은 다시 읽지 않음" : "") + (c.capped ? " · 상한 초과 " + c.capped + "장은 이번에 제외" : "") }),
        h("dt", { text: "보관만" }), h("dd", { text: c.keepOnly + "개 — 저장만 하고 AI 는 읽지 않음" }),
        h("dt", { text: "개인정보 의심" }), h("dd", { text: c.piiHold + "개 — 분석에서 제외(AI 에 보내지 않음)" }),
        h("dt", { text: "읽지 않는 그림" }), h("dd", { text: c.excludedEmbedded + "장 — 로고·아이콘·중복" })]));
      [detailsList("개인정보 의심으로 제외되는 파일", p.piiHold, function (x) { return x.rel + " — " + (x.pii || ""); }), detailsList("보관만 파일", p.keepOnly, function (x) { return x.rel + " — " + (x.reason || ""); }),
        detailsList("절차참고로 제안되는 파일(이름에 프로세스·가이드)", p.procedureSuggest, function (x) { return x.rel; }), detailsList("읽지 않는 문서 속 그림", p.excludedEmbedded, function (x) { return x.doc + " › " + x.name + " — " + x.reason; })].forEach(function (n) { if (n) body.appendChild(n); });
      var lbl = h("label", { class: "chk" }, [imgOn, h("span", { text: "이미지 읽기 — 사건 이미지와 문서 속 그림을 Claude 비전으로 읽습니다(기본 켜짐). 끄면 이미지는 저장만 하고 비용이 줄어듭니다." })]);
      if (!c.imagesToRead) { imgOn.checked = false; imgOn.disabled = true; lbl.appendChild(h("span", { class: "hint", text: " (읽을 이미지가 없습니다)" })); }
      body.appendChild(lbl);
      var estB = h("b"), estC = h("span"), est = h("div", { class: "est" }, [h("span", { text: "예상 비용" }), estB, estC]);
      function upd() { var e = imgOn.checked ? p.estimate.withImages : p.estimate.withoutImages; estB.textContent = money(e.low) + " ~ " + money(e.high); estC.textContent = "AI 호출 약 " + e.calls + "회" + (imgOn.checked ? " · 이미지 " + e.images + "장 비전 포함" : " · 이미지는 저장만"); }
      imgOn.onchange = upd; upd(); body.appendChild(est);
      body.appendChild(h("details", {}, [h("summary", { text: "예상 비용은 어떻게 계산했나요?" }), h("p", { class: "hint", text: p.pricing.basis })]));
      body.appendChild(h("div", { class: "hint", text: "고객 명단 등 보관만·개인정보 의심 파일은 AI 에 보내지 않습니다. 이미지 속 개인정보(이름·연락처·주소)는 [개인정보]로 가려서 읽도록 지시하고, 카드에도 남기지 않습니다. ‘분석 시작’을 누르기 전에는 AI 를 호출하지 않습니다." }));
      ok.disabled = confirmed || !!p.activeRun || (!c.text && !c.imagesToRead);
      if (!c.text && !c.imagesToRead) body.appendChild(h("div", { class: "note bad", text: "읽을 수 있는 자료가 없습니다. 보관만·개인정보 의심·무시 파일뿐이거나 지원하지 않는 형식입니다." }));
    }).catch(function (e) { body.textContent = ""; body.appendChild(h("div", { class: "note bad", text: e.message })); });
  }, true);
}

/* ───────── 서버 경로로 가져오기 ───────── */
function importDlg() {
  openDlg(function (f) {
    f.classList.add("adlg");
    f.appendChild(h("h3", { text: "서버 경로로 가져오기" }));
    f.appendChild(h("div", { class: "hint", text: "이 서버 PC가 읽을 수 있는 폴더의 절대 경로를 입력합니다(예: D:\\ai factory\\리스크자료). 사건 폴더 하나를 입력하면 사건 1건, 사건 폴더가 여러 개 들어 있는 상위 폴더를 입력하면 하위 폴더마다 사건 후보가 됩니다. 미리보기는 파일을 복사하지 않고, 가져오기는 AI 를 호출하지 않습니다(분석은 사건 상세의 ‘AI 분석’ 버튼에서)." }));
    var roots = h("div", { class: "hint", text: "허용된 경로를 확인하는 중…" });
    get("/api/archive/import/config").then(function (c) { roots.textContent = "허용된 경로: " + (c.roots.length ? c.roots.join(" , ") : "(없음 — 서버의 config/import.json 의 allowedImportRoots 에 추가하세요)") + " — 이 경로 밖은 읽지 않습니다."; }).catch(function () { roots.textContent = ""; });
    var pi = h("input", { type: "text", placeholder: "D:\\ai factory\\…", "aria-label": "서버 경로", autocomplete: "off" }), ms = h("select", { "aria-label": "구분" });
    [["auto", "자동 감지"], ["single", "이 폴더 하나가 사건 1건"], ["parent", "하위 폴더가 각각 사건"]].forEach(function (o) { ms.appendChild(h("option", { value: o[0], text: o[1] })); });
    var out = h("div"), er = h("div", { class: "er" }), pb = h("button", { class: "btn", type: "submit", text: "미리보기" }); ico(pb, "folder");
    f.appendChild(roots); f.appendChild(lab("서버 경로", pi)); f.appendChild(lab("구분", ms)); f.appendChild(er); f.appendChild(out);
    f.appendChild(h("div", { class: "ft" }, [h("button", { class: "btn sec", type: "button", text: "닫기", onclick: closeDlg }), pb]));
    f.onsubmit = function (e) { e.preventDefault(); er.textContent = ""; out.textContent = ""; pb.disabled = true; post("/api/archive/import/preview", { path: pi.value, mode: ms.value }).then(function (r) { renderPreview(out, r, pi.value); }).catch(function (x) { er.textContent = x.message; }).then(function () { pb.disabled = false; }); };
  }, true);
}
function renderPreview(out, r, path) {
  out.textContent = "";
  out.appendChild(h("div", { class: "note info", text: (r.mode === "parent" ? "하위 폴더 " + r.candidates.length + "개를 사건 후보로 찾았습니다." : "이 폴더를 사건 1건으로 가져옵니다.") + (r.detectedMode !== r.mode ? " (자동 감지 결과: " + (r.detectedMode === "parent" ? "상위 폴더" : "사건 폴더") + ")" : "") + " 아직 파일은 복사되지 않았습니다." }));
  var tb = h("table", { class: "impt" }), body = h("tbody"), rows = [];
  tb.appendChild(h("thead", {}, [h("tr", {}, ["", "폴더", "사건 제목", "시작연월", "파일 · 용량 · 분류 추정"].map(function (t) { return h("th", { text: t }); }))]));
  r.candidates.forEach(function (c) {
    var chk = h("input", { type: "checkbox", "aria-label": c.name + " 선택" }); chk.checked = !c.imported && c.files > 0 && r.candidates.length === 1;
    var ti = h("input", { type: "text", value: c.title, maxlength: "200", "aria-label": "사건 제목" }), ym = h("input", { type: "month", value: c.ym || "", "aria-label": "시작연월" });
    var act = c.imported ? h("select", { "aria-label": "이미 가져온 폴더 처리" }, [h("option", { value: "skip", text: "건너뜀" }), h("option", { value: "merge", text: "병합(새 파일만 추가)" })]) : null;
    if (act) act.onchange = function () { chk.checked = act.value === "merge"; };
    var g = c.rules, sk = c.skipped, sm = h("div", { class: "impsum" }, [h("span", { class: "b", text: "문서 " + (g.text + g.procedure) }), h("span", { class: "b", text: "이미지 " + g.image }), g.procedure ? h("span", { class: "b", text: "절차참고 추정 " + g.procedure }) : null,
      g.pii ? h("span", { class: "b warn", text: "개인정보 의심 " + g.pii }) : null, g.keep ? h("span", { class: "b hold", text: "보관만 추정 " + g.keep }) : null, sk.symlinks ? h("span", { class: "b warn", text: "링크 " + sk.symlinks + "개 제외" }) : null, sk.large ? h("span", { class: "b warn", text: "500MB 초과 " + sk.large + "개 제외" }) : null,
      c.imported ? h("span", { class: "b hold", text: "이미 가져옴 · 사건 #" + c.imported.caseId }) : null]);
    var tr = h("tr", {}, [h("td", {}, [chk]), h("td", {}, [h("div", { class: "nm", text: c.name }), c.ymSource === "file-date" ? h("div", { class: "hint", text: "폴더 이름에 연월이 없어 파일 수정일로 임시 추정" }) : null, act]), h("td", {}, [ti]), h("td", {}, [ym]),
      h("td", {}, [h("div", { text: c.files + "개 · " + fmtSize(c.bytes) }), sm])]);
    body.appendChild(tr); rows.push({ c: c, chk: chk, ti: ti, ym: ym, act: act });
  });
  tb.appendChild(body); out.appendChild(tb);
  var go = h("button", { class: "btn", type: "button", text: "선택한 폴더 가져오기" }), res = h("div", { class: "impres" }); ico(go, "upload");
  go.onclick = function () {
    var sel = rows.filter(function (x) { return x.chk.checked && (!x.c.imported || x.act.value === "merge"); });
    if (!sel.length) { alert("가져올 폴더를 선택하세요(이미 가져온 폴더는 ‘병합’을 골라야 합니다)"); return; }
    go.disabled = true; var seq = Promise.resolve();
    sel.forEach(function (x) {
      var line = h("div", { text: x.c.name + " — 가져오는 중…" }); res.appendChild(line);
      seq = seq.then(function () {
        return post("/api/archive/import/run", { path: path, key: x.c.key, title: x.ti.value, ym: x.ym.value || undefined, action: x.c.imported ? "merge" : "new" }).then(function (rr) {
          line.className = "ok"; line.textContent = "✔ " + x.c.name + " → 파일 " + rr.added + "개 가져옴" + (rr.existingSkipped ? " (기존 " + rr.existingSkipped + "개 그대로)" : "") + (rr.errors.length ? " · 실패 " + rr.errors.length + "개" : "") + " ";
          line.appendChild(h("button", { class: "btn sec sm", type: "button", text: "사건 열기", onclick: function () { closeDlg(); openCase(rr.caseId); } }));
        }).catch(function (e) { line.className = "er2"; line.textContent = "✘ " + x.c.name + " — " + e.message; });
      });
    });
    seq.then(function () { go.disabled = false; reflect(); reload(); });
  };
  out.appendChild(h("div", { class: "ft", style: "margin-top:12px" }, [go])); out.appendChild(res);
}

/* ───────── 진입 ───────── */
window.RiskArchive = {
  mount: function (ctx) {
    C = ctx; root = document.getElementById("archRoot");
    if (S.view === "detail" && S.id) { loadDetail().catch(fail); return; }
    loadList().then(renderList).catch(function (e) { root.textContent = "아카이브를 불러오지 못했습니다: " + e.message; });
  }
};
})();
