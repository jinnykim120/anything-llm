/* Sensing 탭: 센싱 범위 보기 · 협력사/취급 품목 목록(직접 추가, 엑셀 업로드) · 내부 신호 직접 등록.
   모든 글자는 textContent 로만 넣는다. index.html 이 mount() 로 붙인다. */
(function () {
"use strict";
var C = null, built = false;
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
var dlg = null;
function openDlg(build, wide) { if (!dlg) { dlg = h("dialog", { id: "dlgSS" }, [h("form", { class: "md", method: "dialog" })]); document.body.appendChild(dlg); } var f = dlg.querySelector("form"); f.textContent = ""; f.onsubmit = null; dlg.className = wide ? "wide" : ""; build(f); dlg.showModal(); }
function closeDlg() { if (dlg) dlg.close(); }
function opts(sel, list, blank) {
  if (blank != null) { var o0 = h("option", { text: blank }); o0.value = ""; sel.appendChild(o0); }
  list.forEach(function (x) { var str = typeof x === "string", id = str ? x : (x.id != null ? x.id : x[0]), name = str ? x : (x.name || x[1] || id); var o = h("option", { text: name }); o.value = id; sel.appendChild(o); });
  return sel;
}
function lab(t, n) { return h("label", { text: t }, [n]); }

/* ───────── 내부 신호 등록 ───────── */
function internalDlg(S) {
  openDlg(function (f) {
    f.appendChild(h("h3", { text: "내부 신호 직접 등록" }));
    f.appendChild(h("div", { class: "hint", text: "웹 센싱으로는 안 잡히는 VOC·점포·시스템·인사 이슈를 담당자가 직접 올립니다. 등록하면 센싱 목록에 나타나고, 다른 이슈와 같이 사건으로 올리거나 보류할 수 있습니다." }));
    var ti = h("input", { type: "text", maxlength: "200", placeholder: "예: 동일 상품 이물 민원 3회째 접수" }), sm = h("textarea", { maxlength: "4000", placeholder: "무슨 일인지(언제·어디서·누가·어떤 규모) 적어 주세요" });
    var dt = h("input", { type: "date" }), sg = opts(h("select"), S.signals, null);
    var ty = opts(h("select"), C.cfg.issueTypes, "유형 선택(선택)"), bu = opts(h("select"), C.cfg.businessUnits, "사업부문(선택)"), lv = opts(h("select"), ["높음", "중간", "낮음"], "위험도(선택)");
    f.appendChild(lab("제목 (필수)", ti)); f.appendChild(lab("내용", sm)); f.appendChild(lab("발생일 (모르면 비워 두세요)", dt));
    f.appendChild(lab("최초 인지 경로 (회사가 이 일을 처음 알게 된 경로)", sg)); f.appendChild(lab("리스크 유형", ty)); f.appendChild(lab("사업부문", bu)); f.appendChild(lab("위험도", lv));
    var er = h("div", { class: "er" }), ok = h("button", { class: "btn", type: "submit", text: "등록" });
    f.appendChild(er); f.appendChild(h("div", { class: "ft" }, [h("button", { class: "btn sec", type: "button", text: "취소", onclick: closeDlg }), ok]));
    f.onsubmit = function (e) {
      e.preventDefault(); if (!ti.value.trim()) { er.textContent = "제목을 입력하세요"; return; } ok.disabled = true;
      post("/api/sensing/internal", { title: ti.value, summary: sm.value, occurredAt: dt.value || undefined, signal: sg.value, typeId: ty.value || undefined, buId: bu.value || undefined, level: lv.value || undefined })
        .then(function () { closeDlg(); if (C.onChange) { try { C.onChange(); } catch (x) {} } }).catch(function (x) { er.textContent = x.message; ok.disabled = false; });
    };
  });
}

/* ───────── 엑셀 업로드 ───────── */
function excelDlg(file, reload) {
  openDlg(function (f) {
    f.appendChild(h("h3", { text: "엑셀로 목록 추가" })); var body = h("div", { class: "xlb" }, [h("p", { class: "hint", text: "‘" + file.name + "’ 를 읽는 중…" })]); f.appendChild(body);
    var er = h("div", { class: "er" }); f.appendChild(er); f.appendChild(h("div", { class: "ft" }, [h("button", { class: "btn sec", type: "button", text: "닫기", onclick: closeDlg })]));
    fetch("/api/sensing/terms/preview?name=" + encodeURIComponent(file.name), { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "오류 " + r.status); return j; }); })
      .then(function (pv) { show(body, er, pv, reload); }).catch(function (e) { body.textContent = ""; er.textContent = e.message; });
  }, true);
}
function show(body, er, pv, reload) {
  body.textContent = "";
  var shSel = h("select", { "aria-label": "시트" }); pv.sheets.forEach(function (s, i) { var o = h("option", { text: s.name + " (" + s.totalRows + "행)" }); o.value = String(i); shSel.appendChild(o); });
  var pSel = h("select", { "aria-label": "협력사 열" }), qSel = h("select", { "aria-label": "품목 열" }), cSel = h("select", { "aria-label": "채널 열" });
  var info = h("div", { class: "hint" }), tb = h("div", { class: "xlt" }), go = h("button", { class: "btn", type: "button", text: "목록에 추가" });
  body.appendChild(h("p", { class: "hint", text: "열 이름으로 협력사·품목 열을 추측했습니다. 맞는지 확인하고 고친 뒤 추가하세요. 이름 열만 사용하며 다른 열(담당자 등)은 저장하지 않습니다." }));
  body.appendChild(h("div", { class: "xlsel" }, [lab("시트", shSel), lab("협력사·제조사 열", pSel), lab("취급 품목 열", qSel), lab("판매 채널 열(선택)", cSel)])); body.appendChild(info); body.appendChild(tb); body.appendChild(h("div", { class: "ft" }, [go]));
  function sheet() { return pv.sheets[Number(shSel.value)]; }
  function fill(sel, s, guess) { sel.textContent = ""; var o = h("option", { text: "사용 안 함" }); o.value = "-1"; sel.appendChild(o); s.headers.forEach(function (t, i) { var oo = h("option", { text: (i + 1) + "열 · " + t }); oo.value = String(i); sel.appendChild(oo); }); sel.value = String(guess); }
  function names(s, idx) { if (idx < 0) return []; var seen = {}, out = []; s.rows.forEach(function (r) { var v = String(r[idx] || "").trim(); if (v.length >= 2 && !seen[v.toLowerCase()]) { seen[v.toLowerCase()] = 1; out.push(v); } }); return out; }
  function refresh() {
    var s = sheet(), p = names(s, Number(pSel.value)), q = names(s, Number(qSel.value));
    info.textContent = "추가될 후보: 협력사 " + p.length + "개 · 품목 " + q.length + "개 (이미 있는 이름은 건너뜁니다)";
    tb.textContent = ""; var tbl = h("table", { class: "impt" }); tbl.appendChild(h("thead", {}, [h("tr", {}, s.headers.map(function (t) { return h("th", { text: t }); }))]));
    var tbd = h("tbody"); s.rows.slice(0, 6).forEach(function (r) { tbd.appendChild(h("tr", {}, s.headers.map(function (_, i) { return h("td", { text: String(r[i] || "") }); }))); }); tbl.appendChild(tbd); tb.appendChild(tbl);
    go.disabled = !p.length && !q.length;
  }
  function setSheet() { var s = sheet(); fill(pSel, s, s.guess.partner); fill(qSel, s, s.guess.product); fill(cSel, s, s.guess.channel); refresh(); }
  shSel.onchange = setSheet; pSel.onchange = refresh; qSel.onchange = refresh; setSheet();
  go.onclick = function () {
    var s = sheet(), pi = Number(pSel.value), qi = Number(qSel.value), ci = Number(cSel.value), jobs = [];
    [["partner", pi], ["product", qi]].forEach(function (k) {
      if (k[1] < 0) return; var groups = {};
      s.rows.forEach(function (r) { var v = String(r[k[1]] || "").trim(); if (v.length < 2) return; var ch = ci >= 0 ? String(r[ci] || "").trim() : ""; (groups[ch] = groups[ch] || []).push(v); });
      Object.keys(groups).forEach(function (ch) { jobs.push({ kind: k[0], channel: ch, names: groups[ch] }); });
    });
    go.disabled = true; er.textContent = ""; var added = { partner: 0, product: 0 }, skipped = 0;
    jobs.reduce(function (pr, j) { return pr.then(function () { return post("/api/sensing/terms", { kind: j.kind, names: j.names, channel: j.channel, source: "엑셀" }).then(function (r) { added[j.kind] += r.added; skipped += r.skipped; }); }); }, Promise.resolve())
      .then(function () { body.textContent = ""; body.appendChild(h("p", { class: "ok", text: "추가했습니다 — 협력사 " + added.partner + "개, 품목 " + added.product + "개 (이미 있거나 너무 짧은 이름 " + skipped + "개는 건너뜀)" })); reload(); })
      .catch(function (e) { er.textContent = e.message; go.disabled = false; });
  };
}

/* ───────── 패널 ───────── */
function chipList(list, kind, reload) {
  var box = h("div", { class: "tchips" });
  if (!list.length) { box.appendChild(h("span", { class: "hint", text: kind === "partner" ? "아직 등록한 협력사가 없습니다. 이름을 입력하거나 엑셀로 올려 주세요." : "추가한 품목이 없습니다." })); return box; }
  list.forEach(function (t) {
    var c = h("span", { class: "tchip" + (t.custom ? "" : " def"), title: (t.channel ? t.channel + " · " : "") + (t.source || "") }, [t.name]);
    if (t.custom) c.appendChild(h("button", { type: "button", "aria-label": t.name + " 삭제", text: "×", onclick: function () { post("/api/sensing/terms/remove", { kind: kind, name: t.name }).then(reload).catch(function (e) { alert(e.message); }); } }));
    box.appendChild(c);
  });
  return box;
}
function termBox(kind, title, desc, data, reload) {
  var list = kind === "partner" ? data.partners : data.products, custom = list.filter(function (t) { return t.custom; }), defs = list.filter(function (t) { return !t.custom; });
  var ta = h("textarea", { placeholder: kind === "partner" ? "협력사·제조사 이름 (쉼표나 줄바꿈으로 여러 개)" : "취급 품목 이름 (쉼표나 줄바꿈으로 여러 개)", "aria-label": title + " 추가", rows: "2" });
  var chSel = opts(h("select", { "aria-label": "판매 채널" }), (data.channels || []).map(function (c) { return { id: c.name, name: c.name }; }), "채널 미지정");
  var add = h("button", { class: "btn sm", type: "button", text: "추가" }), msg = h("span", { class: "hint" });
  add.onclick = function () {
    var ns = ta.value.split(/[,\n]/).map(function (x) { return x.trim(); }).filter(Boolean); if (!ns.length) return; add.disabled = true;
    post("/api/sensing/terms", { kind: kind, names: ns, channel: chSel.value }).then(function (r) { msg.textContent = r.added + "개 추가" + (r.skipped ? " (" + r.skipped + "개는 이미 있거나 너무 짧음)" : ""); ta.value = ""; add.disabled = false; reload(); }).catch(function (e) { msg.textContent = e.message; add.disabled = false; });
  };
  var fi = h("input", { type: "file", accept: ".xlsx,.csv", hidden: true }); fi.onchange = function () { if (fi.files[0]) excelDlg(fi.files[0], reload); fi.value = ""; };
  var up = h("button", { class: "btn sec sm", type: "button", text: "엑셀로 올리기", onclick: function () { fi.click(); } });
  var cyc = data.cycle[kind] ? "목록이 많으면 오래 검색하지 않은 순으로 돌려 가며 검색합니다(한 바퀴 약 " + data.cycle[kind] + "회차)." : "";
  var kids = [h("h4", { text: title + " " + list.length + "개" }), h("div", { class: "hint", text: desc + " " + cyc }), chipList(custom, kind, reload), h("div", { class: "trow" }, [ta, chSel, add, up, fi]), msg];
  if (kind === "product") kids.push(h("details", {}, [h("summary", { text: "기본 품목 " + defs.length + "개 보기" }), chipList(defs, kind, reload)]));
  return h("div", { class: "tbox" }, kids);
}
function panel(root, data, reload) {
  root.textContent = "";
  root.appendChild(h("div", { class: "rs" }, [h("span", { class: "no", text: "03" }), h("div", { class: "hd" }, [h("h2", { text: "센싱 범위 · 목록" }), h("small", { text: "우리 회사에 직접 이슈나 문제가 될 수 있는 것만 찾습니다. 협력사·품목 목록을 채울수록 해당 업체·품목의 이슈를 더 자주 확인합니다." })])]));
  var areas = h("div", { class: "tchips" }, data.areas.map(function (a) { return h("span", { class: "tchip def" + (a.on === false ? " off" : ""), title: a.desc, text: a.name }); }));
  var scopeBox = h("div", { class: "tbox" }, [h("h4", { text: "찾는 분야 " + data.areas.filter(function (a) { return a.on !== false; }).length + "개" }), areas,
    h("details", {}, [h("summary", { text: "각 분야 설명·제외 기준 보기" }), h("ul", {}, data.areas.map(function (a) { return h("li", {}, [h("b", { text: a.name + ": " }), a.desc]); })), h("p", { class: "hint", text: "제외: " + data.exclude.join(" / ") })]),
    h("div", { class: "hint", text: "분야·제외 기준은 설정 파일(config/sensing.json)에서 바꿉니다. 판매 채널: " + data.channels.map(function (c) { return c.name; }).join(" · ") + "." })]);
  root.appendChild(h("div", { class: "tgrid" }, [scopeBox, termBox("partner", "협력사·제조사", "우리와 거래하는 업체. 위생·분쟁·사고·행정처분 소식을 업체 이름으로 찾습니다.", data, reload), termBox("product", "취급 품목", "홈쇼핑·편의점·슈퍼에서 파는 품목. 회수·표시 오류 같은 안전 소식을 품목 이름으로 찾습니다.", data, reload)]));
}

window.RiskSensSet = {
  mount: function (ctx) {
    C = ctx; var pane = document.getElementById("p-sens"); if (!pane) return;
    var root = document.getElementById("sSet"); if (!root) { root = h("div", { id: "sSet" }); pane.appendChild(root); }
    function reload() { return req("/api/sensing/config").then(function (d) { d.channels = d.channels || []; window.__sensData = d; panel(root, d, reload); }).catch(function (e) { root.textContent = ""; root.appendChild(h("div", { class: "empty", text: "센싱 범위를 불러오지 못했습니다: " + e.message })); }); }
    var bar = pane.querySelector(".ptitle"); if (bar && !document.getElementById("sRegBtn")) {
      var b = h("button", { class: "btn", type: "button", id: "sRegBtn", text: "내부 신호 직접 등록", title: "웹으로는 안 잡히는 VOC·점포·시스템·인사 이슈를 직접 올립니다", onclick: function () { req("/api/sensing/config").then(function (d) { internalDlg(d); }).catch(function (e) { alert(e.message); }); } });
      if (window.RiskUI) window.RiskUI.ic(b, "plus"); bar.appendChild(b);
    }
    reload();
  }
};
})();
