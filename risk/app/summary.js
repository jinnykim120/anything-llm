/* 종합 요약 보기: 사건의 결론 중심 요약을 보고 HTML·Word·PDF 로 내려받는다(근거 자료·출처는 넣지 않는다).
   아카이브 사건 상세와 사건 대응(진행 중 현황 보고 포함) 양쪽에서 같은 대화상자를 쓴다. 모든 글자는 textContent 로만 넣는다. */
(function () {
"use strict";
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
var dlg = null;
function ensure() { if (!dlg) { dlg = h("dialog", { id: "dlgSum", class: "wide" }, [h("form", { class: "md sumv", method: "dialog" })]); document.body.appendChild(dlg); } return dlg; }
function textBlock(t) {
  var lines = String(t || "").split("\n").filter(function (l) { return l.trim(); });
  if (!lines.length) return h("p", { class: "hint", text: "기록 없음" });
  if (lines.every(function (l) { return /^\s*-\s/.test(l); })) return h("ul", {}, lines.map(function (l) { return h("li", { text: l.replace(/^\s*-\s+/, "") }); }));
  return h("div", {}, lines.map(function (l) { return h("p", { text: l }); }));
}
function open(caseId, title, opt) {
  opt = opt || {};
  var d = ensure(), f = d.querySelector("form"); f.textContent = ""; f.onsubmit = null;
  var body = h("div", { class: "sumb" }), er = h("div", { class: "er" });
  var close = h("button", { class: "btn sec", type: "button", text: "닫기", onclick: function () { d.close(); } });
  f.appendChild(h("h3", { text: "종합 요약" })); f.appendChild(h("div", { class: "hint", text: title })); f.appendChild(body); f.appendChild(er); f.appendChild(h("div", { class: "ft" }, [close]));
  d.showModal();
  function done() { if (opt.onChange) { try { opt.onChange(); } catch (e) { /* 화면 갱신 실패는 무시 */ } } }
  function generate(btn) {
    btn.disabled = true; er.textContent = ""; body.textContent = ""; body.appendChild(h("p", { class: "hint", text: "AI가 요약을 만드는 중입니다… (보통 15~30초)" }));
    req("/api/respond/cases/" + caseId + "/summary/generate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(function () { done(); load(); }).catch(function (e) { er.textContent = e.message; load(); });
  }
  function load() {
    req("/api/respond/cases/" + caseId).then(function (c) {
      body.textContent = ""; var s = c.summary, confirmed = !!(s && s.status === "확정");
      var noData = !c.hasCard && !c.steps.some(function (x) { return x.note; });
      if (!s) {
        body.appendChild(h("p", { text: "이 사건의 종합 요약은 아직 없습니다. 사건 카드와 단계별 기록을 읽고 결론 중심으로 정리합니다. 근거 자료·출처는 요약에 넣지 않습니다." }));
        if (noData) body.appendChild(h("div", { class: "note bad", text: "요약할 자료가 없습니다. Archive 에서 ‘AI 분석’으로 사건 카드를 만들거나, 사건 대응에 단계별 기록을 남기면 만들 수 있습니다." }));
        var mk = h("button", { class: "btn", type: "button", text: "종합 요약 만들기", disabled: noData }); mk.onclick = function () { generate(mk); };
        body.appendChild(mk); body.appendChild(h("div", { class: "hint", text: "버튼을 누를 때만 AI를 호출합니다(예상 비용 약 $0.03~0.10)." }));
        return;
      }
      var cs = c.case, kind = cs.status === "종결" ? "종결 보고" : "진행 중 · 현황 보고";
      body.appendChild(h("div", { class: "badges" }, [h("span", { class: "b " + (confirmed ? "conf" : "ai"), text: confirmed ? "확정본" : "AI 초안 · 담당자 검토 필요" }), h("span", { class: "b", text: kind })]));
      var secs = [["사건 개요", textBlock(s.overview)]];
      var tl = h("div", {}, (s.timeline || []).length ? s.timeline.map(function (t) { return h("p", {}, [h("b", { text: t.stage + " " }), t.text]); }) : [h("p", { class: "hint", text: "기록 없음" })]);
      secs.push(["대응 경과", tl], ["주요 대응 내용", textBlock(s.actions)], ["원인 및 재발방지", textBlock(s.prevention)], [cs.status === "종결" ? "시사점" : "남은 과제·시사점", textBlock(s.lessons)]);
      secs.forEach(function (x) { body.appendChild(h("section", { class: "sums" }, [h("h4", { text: x[0] }), x[1]])); });
      var base = "/api/respond/cases/" + caseId + "/report";
      body.appendChild(h("div", { class: "sumdl" }, [h("b", { text: "내려받기" }), h("a", { class: "btn", href: base + ".html", text: "HTML" }), h("a", { class: "btn", href: base + ".docx", text: "Word" }), h("a", { class: "btn sec", href: base + ".pdf", text: "PDF" })]));
      body.appendChild(h("div", { class: "hint", text: "파일에는 근거 자료·출처가 들어가지 않습니다. " + (confirmed ? "" : "내용을 고치려면 사건 대응의 6단계(종결·보고)에서 편집·저장한 뒤 내려받으세요.") }));
      if (!confirmed) {
        var re = h("button", { class: "btn sec sm", type: "button", text: "새로 만들기" }), armed = false;
        re.onclick = function () { if (!armed) { armed = true; re.textContent = "한 번 더 누르면 지금 내용이 새로 바뀝니다 (AI 호출)"; return; } generate(re); };
        body.appendChild(re);
      }
    }).catch(function (e) { body.textContent = ""; er.textContent = e.message; });
  }
  load();
}
window.RiskSummary = { open: open };
})();
