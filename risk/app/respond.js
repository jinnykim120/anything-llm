/* Incident Response 탭: 진행 중 사건 목록 → 단계별 대응 기록(상태·담당자·일자·메모) · 제안 받기(버튼) · 종결 요약(Word/PDF).
   모든 글자는 textContent 로만 넣는다. index.html 이 mount() 로 붙인다. */
(function () {
"use strict";
var C = null, root = null;
var S = { view: "list", status: "진행", id: null, d: null, stage: null, list: [], busy: {} };
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
function post(p, b) { return req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) }); }
var ico = function (el, n) { if (window.RiskUI) window.RiskUI.ic(el, n); return el; };
var nameOf = function (list, id) { var x = (list || []).filter(function (t) { return t.id === id; })[0]; return x ? x.name : id || ""; };
function fail(e) { root.textContent = ""; root.appendChild(h("div", { class: "empty", text: "불러오지 못했습니다: " + e.message })); }
var dlg = null;
function openDlg(build) { if (!dlg) { dlg = h("dialog", { id: "dlgR" }, [h("form", { class: "md", method: "dialog" })]); document.body.appendChild(dlg); } var f = dlg.querySelector("form"); f.textContent = ""; f.onsubmit = null; build(f); dlg.showModal(); }
function closeDlg() { if (dlg) dlg.close(); }

/* ───────── 사건 지우기·목록에서 빼기 ───────── */
function sendToPast(id) { return post("/api/archive/cases/" + id + "/status", { status: "종결" }).then(function () { S.stage = null; return loadList().then(renderList); }).catch(fail); }
function deleteDlg(id, title, after) {
  openDlg(function (f) {
    f.appendChild(h("h3", { text: "사건 삭제" }));
    f.appendChild(h("p", { text: "‘" + title + "’ 사건을 삭제합니다. 사건 카드·단계 기록·종결 요약과 이 PC의 파일이 지워지고, NEXUS에 올린 파일도 함께 지웁니다." }));
    f.appendChild(h("div", { class: "hint", text: "복구용으로 DB 백업이 만들어지고 이 PC의 파일은 data/.trash 폴더에 보관됩니다(영구 삭제 아님). 센싱에서 사건화한 사건이면 센싱 목록으로 돌아갑니다. 이미 끝난 사건이 잘못 올라온 것이라면 삭제 대신 ‘과거 사건으로 보내기’를 쓰는 편이 안전합니다." }));
    var ci = h("input", { type: "text", placeholder: "삭제", autocomplete: "off", "aria-label": "확인 입력" }), er = h("div", { class: "er" }), ok = h("button", { class: "btn danger", type: "submit", text: "삭제", disabled: true });
    ci.oninput = function () { ok.disabled = ci.value.trim() !== "삭제"; };
    f.appendChild(h("label", {}, ["확인을 위해 ‘삭제’를 입력하세요", ci])); f.appendChild(er);
    f.appendChild(h("div", { class: "ft" }, [h("button", { class: "btn sec", type: "button", text: "취소", onclick: closeDlg }), ok]));
    f.onsubmit = function (e) { e.preventDefault(); ok.disabled = true; post("/api/archive/cases/" + id + "/delete", { confirm: "삭제" }).then(function (r) { closeDlg(); if (C.onChange) { try { C.onChange(); } catch (x) {} } after(r); }).catch(function (x) { er.textContent = x.message; ok.disabled = false; }); };
  });
}

/* ───────── 목록 ───────── */
function loadList() { return req("/api/respond/cases?status=" + encodeURIComponent(S.status)).then(function (j) { S.list = j.cases; }); }
function renderList() {
  S.view = "list"; root.textContent = "";
  var seg = h("div", { class: "rseg", role: "group", "aria-label": "사건 상태" });
  ["진행", "종결"].forEach(function (s) { seg.appendChild(h("button", { type: "button", class: "chip", "aria-pressed": String(S.status === s), text: s === "진행" ? "진행 중 사건" : "종결 사건", onclick: function () { S.status = s; loadList().then(renderList).catch(fail); } })); });
  var bar = h("div", { class: "rbar" }, [seg, h("span", { class: "grow" }),
    ico(h("button", { class: "btn sec", type: "button", text: "Archive에서 새 사건 만들기", onclick: function () { C.nav("arch"); } }), "plus")]);
  root.appendChild(bar);
  if (!S.list.length) { root.appendChild(h("div", { class: "empty", text: S.status === "진행" ? "진행 중인 사건이 없습니다. Archive에서 사건을 만들거나, Sensing에서 이슈를 사건으로 올리면 여기에 나타납니다." : "종결한 사건이 아직 없습니다." })); return; }
  var g = h("div", { class: "rgrid" });
  S.list.forEach(function (c) {
    var dots = h("div", { class: "rdots", "aria-label": "단계 " + c.doneStages + "/" + c.totalStages + " 완료" });
    for (var i = 0; i < c.totalStages; i++) dots.appendChild(h("i", { class: i < c.doneStages ? "on" : "" }));
    var card = h("button", { class: "rcase", type: "button", onclick: function () { open(c.id); } }, [
      h("div", { class: "fd", text: c.folderName }),
      h("div", { class: "badges" }, [c.typeId ? h("span", { class: "b t-" + c.typeId, text: nameOf(C.cfg.issueTypes, c.typeId) }) : h("span", { class: "b", text: "유형 미분류" }),
        c.level ? h("span", { class: "b lv l-" + c.level, text: "위험도 " + c.level }) : null, c.activeStage ? h("span", { class: "b conf", text: "진행: " + nameOf(C.cfg.caseStages, c.activeStage) }) : null]),
      dots, h("div", { class: "m", text: "완료 " + c.doneStages + " / " + c.totalStages + " 단계" })]);
    var acts = h("div", { class: "racts" }, [S.status === "진행" ? h("button", { class: "lnk", type: "button", text: "과거 사건으로 보내기", title: "이미 끝난 사건이 잘못 올라온 경우: 이 목록에서 빼고 종결 사건으로 옮깁니다(자료는 그대로)", onclick: function () { sendToPast(c.id); } }) : null,
      h("button", { class: "lnk bad", type: "button", text: "삭제", onclick: function () { deleteDlg(c.id, c.title, function () { loadList().then(renderList); }); } })]);
    g.appendChild(h("div", { class: "rcw" }, [card, acts]));
  });
  root.appendChild(g);
}

/* ───────── 사건 화면 ───────── */
function open(id) { S.id = id; S.stage = null; return load().catch(fail); }
function load() { return req("/api/respond/cases/" + S.id).then(function (d) { S.d = d; if (!S.stage) { var a = d.steps.filter(function (s) { return s.state === "진행"; })[0] || d.steps.filter(function (s) { return s.state === "미착수"; })[0] || d.steps[d.steps.length - 1]; S.stage = a.id; } render(); }); }
function render() {
  S.view = "detail"; var d = S.d, c = d.case, closed = c.status === "종결"; root.textContent = "";
  root.appendChild(h("button", { class: "back", type: "button", text: "← 사건 목록", onclick: function () { loadList().then(renderList).catch(fail); } }));
  root.appendChild(h("div", { class: "rghero" }, [h("div", { class: "ey", text: c.folderName }), h("h1", { text: c.title }),
    h("div", { class: "badges", style: "position:relative;z-index:1" }, [c.typeId ? h("span", { class: "b t-" + c.typeId, text: nameOf(C.cfg.issueTypes, c.typeId) }) : h("span", { class: "b", text: "유형 미분류" }),
      h("span", { class: "b", text: c.buId ? nameOf(C.cfg.businessUnits, c.buId) : "사업부문 미지정" }), c.level ? h("span", { class: "b lv l-" + c.level, text: "위험도 " + c.level }) : null, h("span", { class: "b " + (closed ? "conf" : ""), text: c.status })]),
    h("div", { class: "hbtn" }, [h("button", { class: "btn sec", type: "button", text: "Archive에서 자료·카드 보기", onclick: function () { C.nav("arch"); } }),
      ico(h("button", { class: "btn", type: "button", text: closed ? "종합 요약·다운로드" : "현황 요약·다운로드", title: "지금까지의 내용을 요약해 보고 HTML·Word·PDF 로 내려받습니다(중간 현황 보고용, 근거 자료·출처 제외)", onclick: function () { window.RiskSummary.open(c.id, c.title, { onChange: function () { load(); } }); } }), "download"),
      closed ? null : h("button", { class: "btn sec", type: "button", text: "과거 사건으로 보내기", title: "이미 끝난 사건이 잘못 올라온 경우: 진행 중 목록에서 빼고 종결 사건으로 옮깁니다", onclick: function () { sendToPast(c.id); } }),
      h("button", { class: "btn sec", type: "button", text: "사건 삭제", onclick: function () { deleteDlg(c.id, c.title, function () { S.id = null; S.view = "list"; loadList().then(renderList); }); } })])]));
  var st = h("ol", { class: "rstep", role: "tablist", "aria-label": "대응 단계" });
  d.steps.forEach(function (s, i) {
    st.appendChild(h("li", {}, [h("button", { type: "button", role: "tab", class: "s-" + (s.state === "완료" ? "done" : s.state === "진행" ? "doing" : "todo"), "aria-selected": String(S.stage === s.id), onclick: function () { S.stage = s.id; render(); } },
      [h("span", { class: "no", text: s.state === "완료" ? "✓" : String(i + 1) }), h("b", { text: s.name }), h("small", { text: s.state })])]));
  });
  root.appendChild(st);
  var cur = d.steps.filter(function (s) { return s.id === S.stage; })[0];
  root.appendChild(stagePanel(cur, closed));
  if (cur.id === d.steps[d.steps.length - 1].id) root.appendChild(closePanel(d, closed));
}

function stagePanel(s, closed) {
  var box = h("section", { class: "rpanel" });
  box.appendChild(h("div", { class: "rph" }, [h("h2", { text: s.name }), h("p", { text: s.desc })]));
  var stSel = h("select", { "aria-label": "상태", disabled: closed }); ["미착수", "진행", "완료"].forEach(function (x) { var o = h("option", { text: x }); o.value = x; if (x === s.state) o.selected = true; stSel.appendChild(o); });
  var ow = h("input", { type: "text", maxlength: "40", placeholder: "담당자", value: s.owner, "aria-label": "담당자", disabled: closed }), dt = h("input", { type: "date", value: s.date, "aria-label": "일자", disabled: closed });
  var note = h("textarea", { placeholder: "이 단계에서 한 일·결정·확인한 사실을 적습니다. 종결 요약의 근거가 됩니다.", "aria-label": "메모", disabled: closed }); note.value = s.note;
  var msg = h("span", { class: "hint" }), save = ico(h("button", { class: "btn", type: "button", text: "저장", disabled: closed }), "check");
  function doSave() { save.disabled = true; return post("/api/respond/cases/" + S.id + "/steps/" + s.id, { state: stSel.value, owner: ow.value, date: dt.value || undefined, note: note.value }).then(function () { return req("/api/respond/cases/" + S.id); }).then(function (d) { S.d = d; render(); }).catch(function (e) { msg.textContent = e.message; save.disabled = false; }); }
  save.onclick = doSave;
  box.appendChild(h("div", { class: "rform" }, [h("label", {}, ["상태", stSel]), h("label", {}, ["담당자", ow]), h("label", {}, ["일자", dt]), h("label", { class: "wide" }, ["메모", note]), h("div", { class: "rsave" }, [save, msg])]));
  if (s.files.length) box.appendChild(h("div", { class: "rfiles" }, [h("b", { text: "이 단계 자료" })].concat(s.files.map(function (f) { return h("a", { href: "/api/archive/cases/" + S.id + "/files/" + f.id + "/download", text: f.name, title: "내려받기" }); }))));
  else box.appendChild(h("div", { class: "hint", text: "이 단계로 분류된 자료가 없습니다. 자료는 Archive의 사건 상세에서 올리고 단계를 지정하면 여기에 보입니다." }));
  box.appendChild(suggestBox(s, closed, note));
  return box;
}

function suggestBox(s, closed, note) {
  var box = h("div", { class: "rsug" }), head = h("div", { class: "rsh" }, [h("b", { text: "제안 받기" }), h("span", { class: "hint", text: "버튼을 누를 때만 AI를 호출합니다. 제안은 참고용이며 채택은 담당자가 정합니다." })]);
  var btn = ico(h("button", { class: "btn sec", type: "button", text: s.suggestion ? "다시 제안 받기" : "제안 받기", disabled: closed || !!S.busy["s" + s.id], onclick: function () { confirmAI("‘" + s.name + "’ 단계 제안", "같은 유형의 과거 사건과 이 사건의 카드·기록을 읽고 3~5개 제안을 만듭니다. 예상 비용 약 $0.03~0.10", function () {
    S.busy["s" + s.id] = true; render(); return post("/api/respond/cases/" + S.id + "/steps/" + s.id + "/suggest").then(function () { S.busy["s" + s.id] = false; return load(); }).catch(function (e) { S.busy["s" + s.id] = false; render(); alert(e.message); }); }); } }), "check");
  head.appendChild(btn); box.appendChild(head);
  if (S.busy["s" + s.id]) { box.appendChild(h("div", { class: "hint", text: "AI가 제안을 만드는 중입니다… (1~2분)" })); return box; }
  if (!s.suggestion) { box.appendChild(h("div", { class: "hint", text: "아직 받은 제안이 없습니다." })); return box; }
  var ul = h("ul", { class: "rsl" });
  s.suggestion.items.forEach(function (it) {
    var trust = it.trust === "past" ? h("span", { class: "b conf", text: "당사 과거사건 · 확인됨" }) : h("span", { class: "b hold", text: "AI 일반 제안 · 근거 미확인" });
    var add = h("button", { class: "btn sec sm", type: "button", text: "메모에 추가", disabled: closed, onclick: function () { note.value = (note.value ? note.value.replace(/\s*$/, "\n") : "") + "- " + it.text; note.focus(); add.textContent = "추가됨"; add.disabled = true; } });
    ul.appendChild(h("li", {}, [h("div", { class: "tx", text: it.text }), it.why ? h("div", { class: "why", text: it.why }) : null, h("div", { class: "src" }, [trust, it.caseTitle ? h("span", { class: "hint", text: "근거: #" + it.caseId + " " + it.caseTitle }) : null, add])]));
  });
  box.appendChild(ul); box.appendChild(h("div", { class: "hint", text: (s.suggestion.at || "").slice(0, 16).replace("T", " ") + " 제안 · 저장을 눌러야 메모가 보관됩니다" }));
  return box;
}
function confirmAI(title, desc, go) {
  openDlg(function (f) {
    f.appendChild(h("h3", { text: title })); f.appendChild(h("p", { text: desc })); f.appendChild(h("div", { class: "hint", text: "누르기 전에는 AI를 호출하지 않습니다." }));
    var ok = h("button", { class: "btn", type: "submit", text: "시작" });
    f.appendChild(h("div", { class: "ft" }, [h("button", { class: "btn sec", type: "button", text: "취소", onclick: closeDlg }), ok]));
    f.onsubmit = function (e) { e.preventDefault(); closeDlg(); go(); };
  });
}

/* ───────── 종결 ───────── */
function closePanel(d, closed) {
  var box = h("section", { class: "rpanel rclose" }), sm = d.summary, confirmed = sm && sm.status === "확정";
  box.appendChild(h("div", { class: "rph" }, [h("h2", { text: "종결 요약" }), h("p", { text: "단계별 기록과 사건 카드로 종결 보고서 초안을 만듭니다. 담당자가 고친 뒤 확정하면 사건이 종결되고 Archive에 보관됩니다." })]));
  if (!d.hasCard) box.appendChild(h("div", { class: "hint warn", text: "사건 카드가 없습니다. Archive에서 ‘AI 분석’을 먼저 하면 요약이 더 정확해집니다. 단계별 메모만으로도 만들 수 있습니다." }));
  if (!sm) {
    box.appendChild(ico(h("button", { class: "btn", type: "button", text: "종결 요약 초안 만들기", disabled: !!S.busy.sum, onclick: function () { confirmAI("종결 요약 초안", "사건 카드와 단계별 메모를 읽고 개요·경과·대응·재발방지·시사점 초안을 만듭니다. 예상 비용 약 $0.03~0.10", genSummary); } }), "check"));
    if (S.busy.sum) box.appendChild(h("div", { class: "hint", text: "AI가 요약을 만드는 중입니다… (1~2분)" }));
    return box;
  }
  var f = { overview: area("사건 개요", sm.overview, confirmed), actions: area("주요 대응 내용", sm.actions, confirmed), prevention: area("원인 및 재발방지", sm.prevention, confirmed), lessons: area("시사점", sm.lessons, confirmed) }, tl = [];
  box.appendChild(f.overview.w);
  var tw = h("div", { class: "rtl" }, [h("b", { text: "대응 경과" })]);
  (sm.timeline || []).forEach(function (t) { var ta = h("textarea", { "aria-label": t.stage + " 내용", disabled: confirmed }); ta.value = t.text; tl.push({ stage: t.stage, ta: ta }); tw.appendChild(h("label", {}, [t.stage, ta])); });
  if (!tl.length) tw.appendChild(h("div", { class: "hint", text: "기록 없음" }));
  box.appendChild(tw); box.appendChild(f.actions.w); box.appendChild(f.prevention.w); box.appendChild(f.lessons.w);
  var msg = h("span", { class: "hint" });
  function body() { return { overview: f.overview.t.value, actions: f.actions.t.value, prevention: f.prevention.t.value, lessons: f.lessons.t.value, timeline: tl.map(function (x) { return { stage: x.stage, text: x.ta.value }; }) }; }
  var dl = h("div", { class: "rdl" }, [ico(h("a", { class: "btn sec", href: "/api/respond/cases/" + S.id + "/report.docx", text: "Word 다운로드" }), "download"), ico(h("a", { class: "btn sec", href: "/api/respond/cases/" + S.id + "/report.pdf", text: "PDF 다운로드" }), "download")]);
  if (confirmed) {
    box.appendChild(h("div", { class: "hint ok", text: "확정됨 · " + (sm.by || "") + " · " + (sm.confirmedAt || "").slice(0, 10) + " — 사건이 종결되어 Archive에 보관되었습니다." })); box.appendChild(dl); return box;
  }
  box.appendChild(h("div", { class: "hint", text: "다운로드 파일에는 저장된 내용이 들어갑니다. 고친 뒤에는 먼저 ‘요약 저장’을 누르세요. 확정 전 파일에는 ‘초안’ 표시가 붙습니다." }));
  var saveB = ico(h("button", { class: "btn sec", type: "button", text: "요약 저장" }), "check");
  saveB.onclick = function () { saveB.disabled = true; post("/api/respond/cases/" + S.id + "/summary", body()).then(function (x) { S.d = x; msg.textContent = "저장했습니다"; saveB.disabled = false; }).catch(function (e) { msg.textContent = e.message; saveB.disabled = false; }); };
  var fin = ico(h("button", { class: "btn", type: "button", text: "확정하고 종결", onclick: function () { post("/api/respond/cases/" + S.id + "/summary", body()).then(function () { finDlg(); }).catch(function (e) { msg.textContent = e.message; }); } }), "check");
  var re = h("button", { class: "btn sec", type: "button", text: "초안 다시 만들기", onclick: function () { confirmAI("종결 요약 다시 만들기", "지금 고친 내용은 사라지고 새 초안으로 바뀝니다. 예상 비용 약 $0.03~0.10", genSummary); } });
  box.appendChild(h("div", { class: "rsave" }, [saveB, fin, re, msg])); box.appendChild(dl);
  return box;
}
function area(label, val, ro) { var t = h("textarea", { "aria-label": label, disabled: ro }); t.value = val || ""; return { t: t, w: h("label", { class: "rarea" }, [label, t]) }; }
function genSummary() { S.busy.sum = true; render(); return post("/api/respond/cases/" + S.id + "/summary/generate").then(function (d) { S.busy.sum = false; S.d = d; render(); }).catch(function (e) { S.busy.sum = false; render(); alert(e.message); }); }
function finDlg() {
  openDlg(function (f) {
    f.appendChild(h("h3", { text: "종결 확정" })); f.appendChild(h("p", { text: "확정하면 사건이 종결되고 이 요약이 보관됩니다. 확정 비밀번호와 이름을 입력하세요." }));
    var nm = h("input", { type: "text", maxlength: "40", placeholder: "확정자 이름" }), pw = h("input", { type: "password", placeholder: "확정 비밀번호", autocomplete: "off" }), er = h("div", { class: "er" });
    f.appendChild(h("label", {}, ["확정자", nm])); f.appendChild(h("label", {}, ["확정 비밀번호", pw])); f.appendChild(er);
    var ok = h("button", { class: "btn", type: "submit", text: "확정하고 종결" });
    f.appendChild(h("div", { class: "ft" }, [h("button", { class: "btn sec", type: "button", text: "취소", onclick: closeDlg }), ok]));
    f.onsubmit = function (e) { e.preventDefault(); ok.disabled = true; post("/api/respond/cases/" + S.id + "/summary/confirm", { name: nm.value, password: pw.value }).then(function (d) { closeDlg(); S.d = d; if (C.onChange) { try { C.onChange(); } catch (x) {} } render(); }).catch(function (x) { er.textContent = x.message; ok.disabled = false; }); };
  });
}

window.RiskRespond = {
  mount: function (ctx) {
    C = ctx; root = document.getElementById("respRoot");
    if (S.view === "detail" && S.id) { load().catch(fail); return; }
    loadList().then(renderList).catch(fail);
  }
};
})();
