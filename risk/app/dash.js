/* 리스크 대시보드: 분석형 타일 격자(KPI·연도/월 추이·유형 누적막대·도넛·사업부문 누적막대·히트맵·깔때기·AI 제안 현황·최근 사건).
   - 외부 라이브러리·CDN 없이 SVG/HTML 로 직접 그린다. 모든 글자는 textContent/속성으로만 넣는다.
   - 서버는 사건·센싱 이슈의 원본 행만 주고(GET /api/dashboard), 연도 다중 선택·연도 비교 집계는 이 파일이 한다(연도를 바꿔도 서버를 다시 부르지 않아 부드럽다).
   - 연도 선택: 상단 공통 필터(기본=올해) + 타일마다 독립 선택(다중). 공통을 바꾸면 모든 타일이 공통 값으로 맞춰지고, 타일 개별 선택이 공통과 다르면 ‘개별’ 표시와 ‘공통으로 되돌리기’가 나온다.
   - 색: 유형 색은 ui.css 의 --ty-<유형id> 한 곳, 연도 색은 dash.css 의 --yr0..7(연도에 고정). 움직임은 prefers-reduced-motion 이면 꺼진다. */
(function () {
"use strict";
var NS = "http://www.w3.org/2000/svg", KEY = "rk-dash-v1";
var C = null, root = null, grid = null, kbox = null, noteEl = null, barEl = null, tipEl = null, D = null, loading = false, play = false, built = false, idx = 0, playTimer = null;
var S = { target: "case", common: null, card: {}, type: "", bu: "" }, TILES = [], PREV = {}, KPREV = {};
var reduce = false; try { reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function sv(tag, a, parent) { var e = document.createElementNS(NS, tag); Object.keys(a || {}).forEach(function (k) { if (a[k] != null) e.setAttribute(k, a[k]); }); if (parent) parent.appendChild(e); return e; }
function svText(parent, x, y, text, cls, anchor) { var t = sv("text", { x: x, y: y, class: "tx " + (cls || ""), "text-anchor": anchor || "start" }, parent); t.textContent = text; return t; }
var n0 = function (v) { return v == null ? "-" : String(Math.round(v)); };
var pctTxt = function (x) { return x == null ? "-" : (Math.round(x * 1000) / 10) + "%"; };
function nice(m) { m = Math.max(m, 2); if (m <= 4) return 4; var p = Math.pow(10, Math.floor(Math.log(m) / Math.LN10)), n = m / p, c = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10, r = c * p; return r % 2 ? r + 1 : r; }
function topRound(x, y, w, h0, r) { if (h0 <= 0) return ""; r = Math.min(r, h0, w / 2); return "M" + x + "," + (y + h0) + "V" + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y + "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + "V" + (y + h0) + "Z"; }

/* ── 저장(세션 단위). 접근할 수 없어도 기본값(올해)으로 정상 동작 */
var numArr = function (a) { return Array.isArray(a) ? a.map(Number).filter(function (n) { return isFinite(n) && n > 1900; }).sort(function (x, y) { return x - y; }) : []; };
function loadState() { try { var j = JSON.parse(sessionStorage.getItem(KEY) || "null"); if (!j || typeof j !== "object") return; S.target = j.target === "issue" ? "issue" : "case"; S.common = Array.isArray(j.common) ? numArr(j.common) : null; S.card = {}; Object.keys(j.card || {}).forEach(function (k) { if (Array.isArray(j.card[k])) S.card[k] = numArr(j.card[k]); }); S.type = typeof j.type === "string" ? j.type : ""; S.bu = typeof j.bu === "string" ? j.bu : ""; } catch (e) {} }
function saveState() { try { sessionStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
function sanitize() { var ok = {}; D.years.forEach(function (y) { ok[y] = 1; }); var keep = function (a) { return a.filter(function (y) { return ok[y]; }); };
  if (S.common == null) S.common = [D.cur]; else { var k = keep(S.common); S.common = (S.common.length && !k.length) ? [D.cur] : k; }
  Object.keys(S.card).forEach(function (key) { var k2 = keep(S.card[key]); if (S.card[key].length && !k2.length) delete S.card[key]; else S.card[key] = k2; }); }

/* ── 연도 선택 규칙: [] = 전체 기간 */
var sameSet = function (a, b) { return a.length === b.length && a.every(function (v, i) { return v === b[i]; }); };
var yrsOf = function (key) { return S.card[key] !== undefined ? S.card[key] : S.common; };
var indivOf = function (key) { return S.card[key] !== undefined && !sameSet(S.card[key], S.common); };
function yText(ys) { return !ys.length ? "전체 기간" : ys.length === 1 ? ys[0] + "년" : ys.length <= 3 ? ys.join("·") + "년" : ys.length + "개 연도(" + ys[0] + "–" + ys[ys.length - 1] + ")"; }
function yShort(ys) { return !ys.length ? "전체" : ys.length === 1 ? ys[0] + "년" : ys.length <= 2 ? ys.join("·") : ys.length + "개 연도"; }
var yrColor = function (y) { return "var(--yr" + (((y - 2023) % 8) + 8) % 8 + ")"; };
function setCommon(a) { S.common = a.slice().sort(function (x, y) { return x - y; }); S.card = {}; saveState(); buildBar(); drawAll(); }
function setCard(key, a) { a = a.slice().sort(function (x, y) { return x - y; }); if (sameSet(a, S.common)) delete S.card[key]; else S.card[key] = a; saveState(); var t = TILES.filter(function (x) { return x.key === key; })[0]; if (t) paintTile(t); }
function resetCard(key) { delete S.card[key]; saveState(); var t = TILES.filter(function (x) { return x.key === key; })[0]; if (t) paintTile(t); }
function setF(patch) { Object.keys(patch).forEach(function (k) { S[k] = patch[k] == null ? "" : patch[k]; }); saveState(); buildBar(); drawAll(); }
function toggleF(key, val) { var o = {}; o[key] = S[key] === val ? "" : val; setF(o); }
function yearClick(y, e) { var mod = e && (e.shiftKey || e.ctrlKey || e.metaKey);
  if (mod) { var cur = (S.common || []).slice(), i = cur.indexOf(y); if (i >= 0) { if (cur.length > 1) cur.splice(i, 1); } else cur.push(y); setCommon(cur); }
  else setCommon(sameSet(S.common, [y]) ? [] : [y]); }

/* ── 계열·집계 */
function seriesList() { var s = C.cfg.issueTypes.map(function (t) { return { key: t.id, name: t.name }; }); s.push({ key: "unclassified", name: "미분류·분류 보류" }); return s; }
var colorOf = function (key) { return "var(--ty-" + (key === "hold" ? "unclassified" : key) + ", var(--ty-etc))"; };
var keyT = function (t) { return t === "hold" ? "unclassified" : t; };
var avail = function (y) { return D.coverageStartYear != null && y >= D.coverageStartYear; };
var tName = function () { return S.target === "case" ? "사건" : "센싱 이슈"; };
/* rows(대상, 연도들, 건너뛸 필터): 연도(빈 배열=전체)·유형·사업부문 필터를 적용한 원본 행 */
function rows(target, ys, skip) { skip = skip || {}; var L = target === "case" ? D.cases : D.issues;
  return L.filter(function (r) { if (ys.length && ys.indexOf(r.y) < 0) return false; if (!skip.type && S.type && keyT(r.t) !== S.type) return false; if (!skip.bu && S.bu && (r.b || "none") !== S.bu) return false; return true; }); }
function tally(list) { var v = {}; seriesList().forEach(function (s) { v[s.key] = 0; }); var total = 0; list.forEach(function (r) { var k = keyT(r.t); v[k] = (v[k] || 0) + 1; total++; }); return { v: v, total: total, na: false }; }
var yearsShown = function (ys) { return ys.length ? ys : D.years; };

/* ── 툴팁(마우스·키보드 초점 모두) */
function bindTip() {
  if (!tipEl) { tipEl = h("div", "dtip"); tipEl.setAttribute("role", "tooltip"); document.body.appendChild(tipEl); }
  function hide() { tipEl.classList.remove("on"); }
  function put(x, y) { var w = tipEl.offsetWidth, hh = tipEl.offsetHeight, X = Math.min(Math.max(8, x + 14), window.innerWidth - w - 8), Y = y - hh - 12 < 8 ? y + 18 : y - hh - 12; tipEl.style.left = X + "px"; tipEl.style.top = Y + "px"; }
  root.addEventListener("mousemove", function (e) { var n = e.target.closest ? e.target.closest("[data-tip]") : null; if (!n || !root.contains(n)) return hide(); tipEl.textContent = n.getAttribute("data-tip"); tipEl.classList.add("on"); put(e.clientX, e.clientY); });
  root.addEventListener("mouseleave", hide);
  root.addEventListener("focusin", function (e) { var n = e.target.closest ? e.target.closest("[data-tip]") : null; if (!n) return; var r = n.getBoundingClientRect(); tipEl.textContent = n.getAttribute("data-tip"); tipEl.classList.add("on"); put(r.left + r.width / 2, r.top); });
  root.addEventListener("focusout", hide);
  window.addEventListener("scroll", hide, { passive: true });
}
function hit(node, label, tip, onclick) { node.setAttribute("tabindex", "0"); node.setAttribute("role", "button"); node.setAttribute("aria-label", label); node.setAttribute("data-tip", tip || label);
  if (onclick) { node.addEventListener("click", function (e) { onclick(e); }); node.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onclick(e); } }); } node.classList.add("hit"); return node; }

/* ── 부드러운 전환: 막대는 이전 길이에서 새 길이로, 선은 이전 경로에서 새 경로로 이어서 움직인다(동작 줄이기면 즉시) */
function morph(el, key, size, axis) { var prev = PREV[key]; PREV[key] = size; if (reduce || play || prev == null || !(size > 0)) return; el.style.animation = "none";
  el.style.transformBox = "fill-box"; el.style.transformOrigin = axis === "x" ? "0 50%" : "50% 100%"; el.style.transform = (axis === "x" ? "scaleX(" : "scaleY(") + (prev / size) + ")"; el.getBoundingClientRect();
  requestAnimationFrame(function () { el.style.transition = "transform .55s cubic-bezier(.2,.7,.2,1)"; el.style.transform = "none"; }); }

/* ── 연도 선택 컨트롤(다중 선택 체크박스). 상단 공통 필터와 타일별 컨트롤이 같은 컴포넌트 */
function yearCtl(cfg) {
  var w = h("div", "yctl"), ind = h("span", "ind", "개별"), btn = h("button", "ybtn"), pop = h("div", "kmenu ypop");
  ind.title = "공통 연도 필터와 다른 연도를 보고 있습니다"; btn.type = "button"; btn.setAttribute("aria-haspopup", "true"); btn.setAttribute("aria-expanded", "false"); pop.hidden = true; pop.setAttribute("role", "group"); pop.setAttribute("aria-label", "연도 선택(여러 개 선택 가능)");
  pop.addEventListener("click", function (e) { e.stopPropagation(); });
  function chk(label, on, fn) { var l = h("label"), c = h("input"); c.type = "checkbox"; c.checked = on; c.onchange = function () { fn(c.checked); }; l.appendChild(c); l.appendChild(document.createTextNode(label)); return l; }
  function build() { pop.textContent = ""; var ys = cfg.get();
    pop.appendChild(chk("전체 기간", ys.length === 0, function (on) { cfg.set(on ? [] : [D.cur]); sync(); }));
    pop.appendChild(h("hr")); D.years.slice().reverse().forEach(function (y) { pop.appendChild(chk(y + "년" + (avail(y) ? "" : (y < D.cur ? "  · 센싱 없음" : "")), ys.indexOf(y) >= 0, function (on) { var cur = cfg.get().slice(), i = cur.indexOf(y); if (on && i < 0) cur.push(y); if (!on && i >= 0) { if (cur.length > 1) cur.splice(i, 1); else { sync(); return; } } cfg.set(cur); sync(); })); });
    if (cfg.reset) { pop.appendChild(h("hr")); var r = h("button", "rst", "공통으로 되돌리기"); r.type = "button"; r.disabled = !cfg.indiv(); r.onclick = function () { cfg.reset(); pop.hidden = true; btn.setAttribute("aria-expanded", "false"); sync(); }; pop.appendChild(r); } }
  function sync() { btn.textContent = yShort(cfg.get()); btn.setAttribute("aria-label", "연도 선택: " + yText(cfg.get())); ind.hidden = !(cfg.indiv && cfg.indiv()); if (!pop.hidden) build(); }
  btn.onclick = function (e) { e.stopPropagation(); var open = pop.hidden; closeMenus(); if (open) { build(); pop.hidden = false; btn.setAttribute("aria-expanded", "true"); } };
  w.appendChild(ind); w.appendChild(btn); w.appendChild(pop); sync(); return { el: w, sync: sync };
}
function closeMenus() { [].forEach.call(document.querySelectorAll(".kmenu"), function (m) { m.hidden = true; var b = m.parentNode && m.parentNode.querySelector("button[aria-expanded]"); if (b) b.setAttribute("aria-expanded", "false"); }); }
document.addEventListener("click", closeMenus);

/* ── 표·CSV */
function csv(t) { var esc = function (v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }; return "﻿" + [t.head].concat(t.rows).map(function (r) { return r.map(esc).join(","); }).join("\r\n"); }
function tableEl(t) { var tb = h("table", "dtable"), th = h("tr"); t.head.forEach(function (x) { th.appendChild(h("th", null, x)); }); tb.appendChild(th); t.rows.forEach(function (r) { var tr = h("tr"); r.forEach(function (c, i) { tr.appendChild(h(i ? "td" : "th", null, c == null ? "집계 없음" : String(c))); }); tb.appendChild(tr); }); var w = h("div", "tscroll"); w.appendChild(tb); return w; }

/* ── 타일 틀(한 번 만들고 유지): 제목·부제는 선택 연도에 따라 바뀌고, 우상단에 연도 컨트롤과 ⋮ 메뉴 */
function makeTile(o) {
  var t = { key: o.key, o: o, asTable: false }, el = h("article", "tile s" + o.span); el.style.setProperty("--i", idx++);
  var hd = h("header", "th"), tt = h("div", "tt"), ctl = h("div", "tctl"), body = h("div", "tb"); hd.appendChild(tt); hd.appendChild(ctl);
  t.yc = yearCtl({ get: function () { return yrsOf(o.key); }, set: function (a) { setCard(o.key, a); }, indiv: function () { return indivOf(o.key); }, reset: function () { resetCard(o.key); } }); ctl.appendChild(t.yc.el);
  var mb = h("button", "kebab", "⋮"); mb.type = "button"; mb.setAttribute("aria-label", o.title(yrsOf(o.key)) + " 메뉴"); mb.setAttribute("aria-haspopup", "menu"); mb.setAttribute("aria-expanded", "false");
  var menu = h("div", "kmenu"); menu.hidden = true; menu.setAttribute("role", "menu");
  var i1 = h("button", null, "표로 보기"); i1.type = "button"; i1.setAttribute("role", "menuitem"); var i2 = h("button", null, "CSV로 저장"); i2.type = "button"; i2.setAttribute("role", "menuitem");
  i1.onclick = function () { t.asTable = !t.asTable; i1.textContent = t.asTable ? "차트로 보기" : "표로 보기"; closeMenus(); paintTile(t); };
  i2.onclick = function () { var d = o.table(yrsOf(o.key)), b = new Blob([csv(d)], { type: "text/csv;charset=utf-8" }), a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = (o.title(yrsOf(o.key)) || "tile").replace(/[^\w가-힣]+/g, "_") + ".csv"; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500); closeMenus(); };
  mb.onclick = function (e) { e.stopPropagation(); var open = menu.hidden; closeMenus(); menu.hidden = !open; mb.setAttribute("aria-expanded", String(open)); };
  menu.appendChild(i1); menu.appendChild(i2); var kw = h("div", "kwrap"); kw.appendChild(mb); kw.appendChild(menu); ctl.appendChild(kw);
  el.appendChild(hd); el.appendChild(body); grid.appendChild(el); t.el = el; t.body = body; t.tt = tt; TILES.push(t); return t;
}
function paintTile(t) {
  var ys = yrsOf(t.key), o = t.o; t.tt.textContent = ""; t.tt.appendChild(h("h3", null, o.title(ys))); var sb = o.sub ? o.sub(ys) : ""; if (sb) t.tt.appendChild(h("small", null, sb)); t.yc.sync();
  t.body.textContent = ""; try { if (t.asTable) t.body.appendChild(tableEl(o.table(ys))); else o.build(t.body, ys); } catch (e) { t.body.appendChild(h("div", "tempty", "표시 중 오류가 났습니다: " + e.message)); if (window.console) console.error(e); }
}

/* ── KPI(카운트업). 연도는 상단 공통 필터를 따른다. 증감은 단일 연도이고 전년 센싱 집계가 있을 때만, 여러 연도면 합계 + 연도별 값 */
function countTo(node, from, to, fmt, delay) {
  if (to == null) return; if (reduce || from === to) { node.textContent = fmt(to); return; }
  var t0 = null, dur = 700; node.textContent = fmt(from);
  function step(ts) { if (t0 == null) t0 = ts + delay; var p = Math.min(1, Math.max(0, (ts - t0) / dur)), e = 1 - Math.pow(1 - p, 3); node.textContent = fmt(from + (to - from) * e); if (p < 1) requestAnimationFrame(step); else node.textContent = fmt(to); }
  requestAnimationFrame(step);
}
function kpiTile(id, label, value, fmt, subLines, delta) {
  var t = h("article", "tile kpi"); t.style.setProperty("--i", idx++);
  t.appendChild(h("div", "kl", label)); var v = h("div", "kv2");
  if (value == null) { v.textContent = "집계 없음"; v.classList.add("na"); KPREV[id] = 0; } else { var from = play ? 0 : (KPREV[id] == null ? 0 : KPREV[id]); countTo(v, from, value, fmt, play ? 250 : 0); KPREV[id] = value; }
  t.appendChild(v);
  if (delta) { var d = h("div", "kd"), same = delta.abs === 0; d.appendChild(h("span", "ar", same ? "＝" : delta.abs > 0 ? "▲" : "▼")); d.appendChild(document.createTextNode(" " + delta.text)); t.appendChild(d); }
  (subLines || []).forEach(function (s) { t.appendChild(h("div", "ks", s)); }); kbox.appendChild(t); return t;
}
function drawKpis() {
  kbox.textContent = ""; var ys = S.common, cov = D.coverageStartYear, lbl = yText(ys), skip = { type: true, bu: true }, sa = ys.length ? ys.some(avail) : cov != null;
  var iss = rows("issue", ys, skip), cs = rows("case", ys, skip), sensed = iss.length, prom = iss.filter(function (r) { return r.st === "사건화"; }).length, rate = sensed ? prom / sensed : null;
  var single = ys.length === 1 && avail(ys[0] - 1), pv = null;
  if (single) { var pi = rows("issue", [ys[0] - 1], skip), pp = pi.filter(function (r) { return r.st === "사건화"; }).length; pv = { sensed: pi.length, prom: pp, rate: pi.length ? pp / pi.length : null }; }
  var dl = function (a, b, unit) { if (!pv || b == null) return null; var d = a - b; return { abs: d, text: (d > 0 ? "+" : "") + d + unit + (b ? " (" + (d > 0 ? "+" : "") + Math.round(d / b * 100) + "%)" : "") + " 전년 대비" }; };
  var noPrev = ys.length === 1 ? "전년 비교 없음" + (cov ? " (센싱 " + cov + "년 시작)" : "") : null;
  var perYear = function (fn) { var yy = yearsShown(ys).filter(avail).slice(-4); return yy.length > 1 ? [yy.map(function (y) { return y + ": " + fn(y); }).join(" · ")] : []; };
  kpiTile("k1", lbl + " 센싱", sa ? sensed : null, n0, sa ? [].concat(!pv && noPrev ? [noPrev] : [], ys.length !== 1 ? perYear(function (y) { return rows("issue", [y], skip).length; }) : []) : [], dl(sensed, pv && pv.sensed, "건"));
  kpiTile("k2", lbl + " 사건화", sa ? prom : null, n0, sa ? [].concat(!pv && noPrev ? [noPrev] : [], ["센싱 이슈 중 사건이 된 건"], ys.length !== 1 ? perYear(function (y) { return rows("issue", [y], skip).filter(function (r) { return r.st === "사건화"; }).length; }) : []) : [], dl(prom, pv && pv.prom, "건"));
  var rd = pv && pv.rate != null && rate != null ? { abs: rate - pv.rate, text: ((rate - pv.rate) > 0 ? "+" : "") + (Math.round((rate - pv.rate) * 1000) / 10) + "%p 전년 대비" } : null;
  kpiTile("k3", "전환율", sa && rate != null ? rate : null, function (v) { return (Math.round(v * 1000) / 10).toFixed(1) + "%"; }, sa ? [sensed + "건 중 " + prom + "건 사건화"] : [], rd);
  var open = cs.filter(function (c) { return c.s === "진행"; }), pilot = open.filter(function (c) { return c.src === "시범"; }).length;
  kpiTile("k4", "진행 중 사건", open.length, n0, [pilot ? "시범(초안) " + pilot + "건 포함" : lbl + " 시작 · 종결 전"]);
  var hi = iss.filter(function (r) { return r.st === "센싱됨" && r.lv === "높음"; }).length, hc = open.filter(function (c) { return c.lv === "높음"; }).length;
  kpiTile("k5", "위험도 높음", hi + hc, n0, ["대기 이슈 " + hi + " · 진행 사건 " + hc]);
}

/* ── 연도별 막대: 전 연도를 계속 보여주고 선택 연도를 강조. 막대를 누르면 공통 연도가 그 해로(Shift/Ctrl+클릭은 추가·제거) */
function barsYear(body, ys) {
  var items = D.years.map(function (y) { var n = rows(S.target, [y]).length; return { year: y, count: (S.target === "issue" && !avail(y) && !n) ? null : n }; });
  var W = Math.max(260, body.clientWidth || 420), H = 250, l = 34, r = 8, t = 26, b = 30, pw = W - l - r, ph = H - t - b;
  var max = nice(Math.max.apply(null, items.map(function (x) { return x.count || 0; }))), svg = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "chart", role: "group", "aria-label": "연도별 " + tName() + " 건수" }, body);
  [0, max / 2, max].forEach(function (g) { var y = t + ph - g / max * ph; sv("line", { x1: l, x2: W - r, y1: y, y2: y, class: g ? "grid" : "axis" }, svg); svText(svg, l - 6, y + 4, String(g), "mute", "end"); });
  var slot = pw / items.length, bw = Math.min(56, slot * .58);
  items.forEach(function (it, i) {
    var cx = l + slot * i + slot / 2, x = cx - bw / 2, sel = !ys.length || ys.indexOf(it.year) >= 0, g = sv("g", { class: "bg" + (sel ? "" : " dim") }, svg);
    if (it.count == null) { sv("rect", { x: x, y: t + ph - 30, width: bw, height: 30, rx: 4, class: "hatch" }, g); svText(g, cx, t + ph - 36, "집계 없음", "mute sm", "middle"); }
    else { var hh = it.count / max * ph, y = t + ph - hh, bar = sv("path", { d: topRound(x, y, bw, hh, 4), class: "gbar", style: "fill:var(--series-1);--d:" + i * 80 }, g); morph(bar, "yb|" + S.target + "|" + it.year, hh); svText(g, cx, y - 6, String(it.count), "val", "middle");
      hit(g, it.year + "년 " + tName() + " " + it.count + "건", it.year + "년\n" + tName() + " " + it.count + "건\n클릭: 공통 연도를 이 해로 (Shift/Ctrl+클릭: 추가·제거)", function (e) { yearClick(it.year, e); }); }
    svText(g, cx, H - 9, it.year + "년", "mute", "middle");
  });
}
function tblYear() { return { head: ["연도", tName() + " 건수"], rows: D.years.map(function (y) { var n = rows(S.target, [y]).length; return [y + "년", (S.target === "issue" && !avail(y) && !n) ? null : n]; }) }; }

/* ── 월별 추이(선): 연도 1개 = 사건·센싱 두 줄 / 여러 연도 = 연도마다 한 줄(연도 색·범례) */
function monthsOf(target, y) { var list = rows(target, [y]), v = []; for (var m = 1; m <= 12; m++) v.push(list.filter(function (r) { return r.m === m; }).length); return { v: v, unknown: list.filter(function (r) { return r.m == null; }).length, total: list.length, available: target === "case" || avail(y) || list.length > 0 }; }
function monthlySeries(ys) {
  if (ys.length === 1) { var y = ys[0], ser = [], c = monthsOf("case", y), s = monthsOf("issue", y); if (c.available) ser.push({ key: "case", name: "사건", v: c.v, c: "var(--series-1)", unk: c.unknown }); if (s.available) ser.push({ key: "issue", name: "센싱", v: s.v, c: "var(--series-2)", unk: 0 }); return { ser: ser, single: true, y: y, miss: s.available ? [] : [y] }; }
  var yy = yearsShown(ys), out = [], miss = []; yy.forEach(function (y) { var m = monthsOf(S.target, y); if (!m.available) { miss.push(y); return; } out.push({ key: "y" + y, name: y + "년", v: m.v, c: yrColor(y), unk: m.unknown, year: y }); }); return { ser: out, single: false, miss: miss };
}
function lineMonthly(body, ys) {
  var M = monthlySeries(ys), ser = M.ser, W = Math.max(280, body.clientWidth || 640), H = 250, l = 34, r = 78, t = 18, b = 30, pw = W - l - r, ph = H - t - b;
  var max = nice(Math.max.apply(null, [0].concat(ser.map(function (s) { return Math.max.apply(null, s.v); })))), svg = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "chart", role: "group", "aria-label": "월별 추이" }, body);
  [0, max / 2, max].forEach(function (g) { var y = t + ph - g / max * ph; sv("line", { x1: l, x2: W - r, y1: y, y2: y, class: g ? "grid" : "axis" }, svg); svText(svg, l - 6, y + 4, String(g), "mute", "end"); });
  var X = function (i) { return l + pw * (i / 11); }, Y = function (v) { return t + ph - v / max * ph; };
  for (var i = 0; i < 12; i++) svText(svg, X(i), H - 9, (i + 1) + "월", "mute sm", "middle");
  var vline = sv("line", { class: "vline", y1: t, y2: t + ph, x1: 0, x2: 0, opacity: 0 }, svg), ends = [];
  ser.forEach(function (s, si) {
    var dOf = function (vals) { return vals.map(function (v, k) { return (k ? "L" : "M") + X(k).toFixed(1) + "," + Y(v).toFixed(1); }).join(""); }, area = null;
    if (si === 0) area = sv("path", { class: "garea", style: "fill:" + s.c }, svg);
    var pathEl = sv("path", { class: "gline", pathLength: 1, style: "stroke:" + s.c }, svg), pts = s.v.map(function (v, k) { return sv("circle", { cx: X(k), r: 4.5, class: "gpt", style: "fill:" + s.c + ";--d:" + (k * 60 + 900) }, svg); });
    function paint(vals) { var d = dOf(vals); pathEl.setAttribute("d", d); if (area) area.setAttribute("d", d + "L" + X(11) + "," + (t + ph) + "L" + X(0) + "," + (t + ph) + "Z"); pts.forEach(function (c, k) { c.setAttribute("cy", Y(vals[k])); }); }
    paint(s.v); var pk = "ln|" + s.key, prev = PREV[pk]; PREV[pk] = s.v.slice();
    if (prev && prev.length === 12 && !reduce && !play) { pathEl.style.animation = "none"; pathEl.style.strokeDashoffset = 0; pts.forEach(function (c) { c.style.animation = "none"; c.style.opacity = 1; }); if (area) { area.style.animation = "none"; area.style.opacity = .13; }
      paint(prev); var t0 = null; requestAnimationFrame(function step(ts) { if (t0 == null) t0 = ts; var p = Math.min(1, (ts - t0) / 520), e = 1 - Math.pow(1 - p, 3); paint(s.v.map(function (v, k) { return prev[k] + (v - prev[k]) * e; })); if (p < 1) requestAnimationFrame(step); }); }
    ends.push({ s: s, y: Y(s.v[11]) });
  });
  ends.sort(function (a, b2) { return a.y - b2.y; }); for (var k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 16) ends[k].y = ends[k - 1].y + 16;
  ends.forEach(function (e) { sv("circle", { cx: W - r + 10, cy: e.y - 4, r: 4, style: "fill:" + e.s.c }, svg); svText(svg, W - r + 18, e.y, e.s.name, "sec", "start"); });
  for (var m = 0; m < 12; m++) (function (m) {
    var z = sv("rect", { x: X(m) - pw / 22, y: t, width: pw / 11, height: ph, class: "zone" }, svg), parts = [(M.single ? M.y + "년 " : "") + (m + 1) + "월"]; ser.forEach(function (s) { parts.push(s.name + " " + s.v[m] + "건"); });
    hit(z, parts.join(" · "), parts.join("\n")); var on = function () { vline.setAttribute("x1", X(m)); vline.setAttribute("x2", X(m)); vline.setAttribute("opacity", 1); }, off = function () { vline.setAttribute("opacity", 0); };
    z.addEventListener("mouseenter", on); z.addEventListener("mouseleave", off); z.addEventListener("focus", on); z.addEventListener("blur", off);
  })(m);
  var notes = [], unk = ser.filter(function (s) { return s.unk; }); if (unk.length) notes.push("월 미확정 사건(연도만 알고 있는 과거 사례)은 선에 포함되지 않습니다: " + unk.map(function (s) { return (M.single ? "" : s.name + " ") + s.unk + "건"; }).join(" · ") + ".");
  if (M.miss.length) notes.push(M.miss.join("·") + "년은 센싱 집계가 없어 " + (M.single ? "센싱 선을" : "선을") + " 그리지 않습니다.");
  if (!M.single) notes.push("연도마다 한 줄(대상: " + tName() + "). 연도 색은 연도에 고정되어 있습니다.");
  if (notes.length) body.appendChild(h("p", "tnote", notes.join(" ")));
}
function tblMonthly(ys) { var M = monthlySeries(ys), rws = []; for (var i = 0; i < 12; i++) rws.push([(i + 1) + "월"].concat(M.ser.map(function (s) { return s.v[i]; }))); return { head: ["월"].concat(M.ser.map(function (s) { return M.single ? (M.y + "년 " + s.name) : s.name; })), rows: rws }; }

/* ── 범례 */
function legend(list, onclick, selKey, counts) {
  var lg = h("div", "legend"); list.forEach(function (s) { if (counts && !counts[s.key]) return; var b = h("button", "lg2"); b.type = "button"; b.setAttribute("aria-pressed", String(selKey === s.key)); var i = h("i"); i.style.background = colorOf(s.key); if (s.key === "unclassified") i.classList.add("soft"); b.appendChild(i); b.appendChild(document.createTextNode(s.name)); b.onclick = function () { onclick(s.key); }; lg.appendChild(b); }); return lg;
}

/* ── 유형별 연도 구성(누적막대): 전 연도를 보여주고 선택 연도를 강조 */
function yearTally(y) { var list = rows(S.target, [y], { type: true }); if (S.target === "issue" && !avail(y) && !list.length) return { v: {}, total: 0, na: true }; return tally(list); }
function stackedYears(body, ys) {
  var years = D.years, data = years.map(function (y) { var c = yearTally(y); c.year = y; return c; }), ser = seriesList(), W = Math.max(280, body.clientWidth || 640), H = 280, l = 34, r = 8, t = 26, b = 30, pw = W - l - r, ph = H - t - b;
  var max = nice(Math.max.apply(null, [0].concat(data.map(function (x) { return x.total; })))), svg = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "chart", role: "group", "aria-label": "연도별 유형 구성" }, body), totals = {};
  [0, max / 2, max].forEach(function (g) { var y = t + ph - g / max * ph; sv("line", { x1: l, x2: W - r, y1: y, y2: y, class: g ? "grid" : "axis" }, svg); svText(svg, l - 6, y + 4, String(g), "mute", "end"); });
  var slot = pw / Math.max(1, data.length), bw = Math.min(64, slot * .6);
  data.forEach(function (row, i) {
    var cx = l + slot * i + slot / 2, x = cx - bw / 2, acc = 0, sel = !ys.length || ys.indexOf(row.year) >= 0; svText(svg, cx, H - 9, row.year + "년", "mute", "middle");
    if (row.na) { sv("rect", { x: x, y: t + ph - 30, width: bw, height: 30, rx: 4, class: "hatch" }, svg); svText(svg, cx, t + ph - 36, "집계 없음", "mute sm", "middle"); return; }
    var top = -1; ser.forEach(function (s, k) { if (row.v[s.key] > 0) top = k; });
    ser.forEach(function (s, k) {
      var v = row.v[s.key]; if (!v) return; if (sel) totals[s.key] = (totals[s.key] || 0) + v; var hh = v / max * ph, y = t + ph - acc - hh; acc += hh;
      var gap = hh > 4 ? 2 : 0, g = sv("g", { class: "seg" + (!sel ? " dim" : "") + (S.type && S.type !== s.key ? " dim" : "") }, svg), st = "fill:" + colorOf(s.key) + ";--d:" + (i * 90 + k * 25);
      var el2 = k === top ? sv("path", { d: topRound(x, y, bw, hh - gap, 4), class: "gbar" + (s.key === "unclassified" ? " soft" : ""), style: st }, g) : sv("rect", { x: x, y: y, width: bw, height: Math.max(0, hh - gap), class: "gbar" + (s.key === "unclassified" ? " soft" : ""), style: st }, g);
      morph(el2, "sy|" + S.target + "|" + row.year + "|" + s.key, Math.max(0, hh - gap));
      hit(g, row.year + "년 " + s.name + " " + v + "건", row.year + "년 · " + s.name + "\n" + v + "건 (" + Math.round(v / row.total * 100) + "%)\n클릭: 이 해·이 유형으로 좁히기", function () { S.type = s.key; setCommon([row.year]); });
    });
    svText(svg, cx, t + ph - acc - 6, String(row.total), "val", "middle");
  });
  body.appendChild(legend(ser, function (k) { toggleF("type", k); }, S.type, totals));
}
function tblStackedYears() { var ser = seriesList(); return { head: ["연도"].concat(ser.map(function (s) { return s.name; }), ["합계"]), rows: D.years.map(function (y) { var c = yearTally(y); return [y + "년"].concat(ser.map(function (s) { return c.na ? null : c.v[s.key]; }), [c.na ? null : c.total]); }) }; }

/* ── 유형 비중 도넛(선택 연도 합산) */
function donut(body, ys) {
  var ser = seriesList(), list = rows(S.target, ys, { type: true }), c = tally(list), cnt = c.v, total = c.total, box = h("div", "donut-box"), dw = h("div", "donut"); box.appendChild(dw);
  if (!total) { body.appendChild(h("div", "tempty", "해당 조건의 " + tName() + "이(가) 없습니다." + (S.target === "issue" ? " (센싱 집계가 없는 연도일 수 있습니다)" : ""))); return; }
  var svg = sv("svg", { viewBox: "0 0 42 42", class: "dsvg", role: "group", "aria-label": "유형 비중" }, dw), off = 0;
  sv("circle", { cx: 21, cy: 21, r: 15.9155, fill: "none", class: "dtrack", "stroke-width": 5 }, svg);
  ser.forEach(function (s, k) { var v = cnt[s.key] || 0; if (!v) return; var len = v / total * 100, gap = len > 3 ? .7 : 0, ci = sv("circle", { cx: 21, cy: 21, r: 15.9155, fill: "none", "stroke-width": 5, "stroke-dashoffset": -off, transform: "rotate(-90 21 21)", class: "garc" + (S.type && S.type !== s.key ? " dim" : "") + (s.key === "unclassified" ? " soft" : ""), style: "stroke:" + colorOf(s.key) + ";--len:" + (len - gap).toFixed(2) + ";--d:" + k * 70 }, svg); hit(ci, s.name + " " + v + "건", s.name + "\n" + v + "건 (" + Math.round(len) + "%)\n클릭: 이 유형으로 좁히기", function () { toggleF("type", s.key); }); off += len; });
  var ctr = h("div", "dctr"); ctr.appendChild(h("b", null, String(total))); ctr.appendChild(h("span", null, tName() + " · " + yShort(ys))); dw.appendChild(ctr);
  var ul = h("ul", "dlist"); ser.forEach(function (s) { var v = cnt[s.key] || 0; if (!v) return; var li = h("li"), bt = h("button"); bt.type = "button"; bt.setAttribute("aria-pressed", String(S.type === s.key)); var i = h("i"); i.style.background = colorOf(s.key); if (s.key === "unclassified") i.classList.add("soft"); bt.appendChild(i); bt.appendChild(h("span", "nm", s.name)); bt.appendChild(h("span", "ct", String(v))); bt.appendChild(h("span", "pc", Math.round(v / total * 100) + "%")); bt.onclick = function () { toggleF("type", s.key); }; li.appendChild(bt); ul.appendChild(li); }); box.appendChild(ul); body.appendChild(box);
}
function tblDonut(ys) { var ser = seriesList(), c = tally(rows(S.target, ys, { type: true })); return { head: ["유형", "건수", "비중"], rows: ser.map(function (s) { return [s.name, c.v[s.key] || 0, c.total ? Math.round((c.v[s.key] || 0) / c.total * 100) + "%" : "-"]; }) }; }

/* ── 유형 분석: 유형별 연도 구성 + 유형 비중을 한 카드(하나의 연도 범위)로 묶고 가운데 선으로만 구분 */
function typeCombo(body, ys) {
  var wrap = h("div", "tpair"), a = h("div", "tpane"), d = h("div", "tdiv"), b = h("div", "tpane");
  d.setAttribute("aria-hidden", "true"); wrap.appendChild(a); wrap.appendChild(d); wrap.appendChild(b); body.appendChild(wrap);
  stackedYears(a, ys); donut(b, ys);
}
function buList() { return C.cfg.businessUnits.map(function (b) { return { id: b.id, name: b.name }; }).concat([{ id: "none", name: "미지정" }]); }
function buTally(ys) { return buList().map(function (b) { var list = rows(S.target, ys, { bu: true, type: true }).filter(function (r) { return (r.b || "none") === b.id; }), c = tally(list); c.id = b.id; c.name = b.name; return c; }).filter(function (r) { return r.id !== "none" || r.total > 0; }); }
function stackedBu(body, ys) {
  var data = buTally(ys), ser = seriesList(), W = Math.max(280, body.clientWidth || 640), rowH = 34, H = data.length * rowH + 14, l = 92, r = 44, pw = W - l - r;
  var max = Math.max.apply(null, [1].concat(data.map(function (x) { return x.total; }))), svg = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "chart", role: "group", "aria-label": "사업부문별 유형 구성" }, body), totals = {};
  data.forEach(function (row, i) {
    var y = 6 + i * rowH, bh = 20, lab = svText(svg, l - 10, y + bh / 2 + 4, row.name, "sec" + (S.bu === row.id ? " selbu" : ""), "end"); hit(lab, row.name + " " + row.total + "건", row.name + "\n" + row.total + "건\n클릭: 이 사업부문으로 좁히기", function () { toggleF("bu", row.id); });
    sv("rect", { x: l, y: y, width: pw, height: bh, rx: 4, class: "trk" }, svg); var acc = 0, topk = -1; ser.forEach(function (s, k) { if (row.v[s.key] > 0) topk = k; });
    ser.forEach(function (s, k) { var v = row.v[s.key]; if (!v) return; totals[s.key] = (totals[s.key] || 0) + v; var w = v / max * pw, x = l + acc; acc += w; var gap = w > 4 ? 2 : 0;
      var g = sv("g", { class: "seg" + (S.type && S.type !== s.key ? " dim" : "") + (S.bu && S.bu !== row.id ? " dim" : "") }, svg), st = "fill:" + colorOf(s.key) + ";--d:" + (i * 60 + k * 20);
      var rc = sv("rect", { x: x, y: y, width: Math.max(0, w - gap), height: bh, rx: k === topk ? 4 : 0, class: "gbarh" + (s.key === "unclassified" ? " soft" : ""), style: st }, g); morph(rc, "bu|" + S.target + "|" + row.id + "|" + s.key, Math.max(0, w - gap), "x");
      hit(g, row.name + " · " + s.name + " " + v + "건", row.name + " · " + s.name + "\n" + v + "건 (" + Math.round(v / row.total * 100) + "%)\n클릭: 이 조합으로 좁히기", function () { S.type = s.key; setF({ bu: row.id === "none" ? "" : row.id }); }); });
    svText(svg, l + acc + 8, y + bh / 2 + 4, String(row.total), "val", "start");
  });
  body.appendChild(legend(ser, function (k) { toggleF("type", k); }, S.type, totals));
}
function tblBu(ys) { var ser = seriesList(); return { head: ["사업부문"].concat(ser.map(function (s) { return s.name; }), ["합계"]), rows: buTally(ys).map(function (r) { return [r.name].concat(ser.map(function (s) { return r.v[s.key]; }), [r.total]); }) }; }

/* ── 히트맵(행=유형, 열=연도 또는 사업부문). 순차 단일 색상 6단계, 값은 칸 안에 숫자로도 표시 */
function heat(body, cols, onCell) {
  var ser = seriesList().filter(function (s) { return s.key !== "unclassified" || cols.some(function (c) { return !c.na && c.v[s.key] > 0; }); }), max = 1;
  cols.forEach(function (c) { if (!c.na) ser.forEach(function (s) { max = Math.max(max, c.v[s.key] || 0); }); });
  var tb = h("table", "hm"), hr = h("tr"); hr.appendChild(h("th")); cols.forEach(function (c) { hr.appendChild(h("th", "ch", c.label)); }); tb.appendChild(hr);
  ser.forEach(function (s, ri) {
    var tr = h("tr"), th = h("th", "rh"), i = h("i"); i.style.background = colorOf(s.key); th.appendChild(i); th.appendChild(document.createTextNode(s.name)); tr.appendChild(th);
    cols.forEach(function (c, ci) { var v = c.na ? null : c.v[s.key], td = h("td"); td.style.setProperty("--d", ri * 2 + ci);
      if (v == null) { td.className = "na hc"; td.textContent = "–"; td.setAttribute("title", "집계 없음"); }
      else { var step = v === 0 ? 0 : Math.min(6, Math.max(1, Math.ceil(v / max * 6))); td.className = "hc h" + step + (S.type === s.key && onCell.sel(c) ? " sel" : ""); td.textContent = v ? String(v) : "";
        hit(td, c.label + " · " + s.name + " " + v + "건", c.label + " · " + s.name + "\n" + v + "건\n클릭: 이 조합으로 좁히기", function () { onCell.go(c, s.key); }); }
      tr.appendChild(td); }); tb.appendChild(tr);
  });
  var w = h("div", "tscroll"); w.appendChild(tb); body.appendChild(w);
  var lg = h("div", "hlegend"); lg.appendChild(h("span", null, "적음")); for (var k = 1; k <= 6; k++) lg.appendChild(h("i", "hc h" + k)); lg.appendChild(h("span", null, "많음")); body.appendChild(lg);
}
function heatYearCols(ys) { return yearsShown(ys).map(function (y) { var c = yearTally(y); c.label = y + "년"; c.year = y; return c; }); }
function heatYear(body, ys) { heat(body, heatYearCols(ys), { sel: function (c) { return S.common.length === 1 && S.common[0] === c.year; }, go: function (c, k) { S.type = k; setCommon([c.year]); } }); }
function heatBu(body, ys) { var cols = buTally(ys).map(function (c) { c.label = c.name; return c; }); heat(body, cols, { sel: function (c) { return c.id === S.bu; }, go: function (c, k) { S.type = k; setF({ bu: c.id === "none" ? "" : c.id }); } }); }
function tblHeatYear(ys) { var ser = seriesList(); return { head: ["유형"].concat(heatYearCols(ys).map(function (c) { return c.label; })), rows: ser.map(function (s) { return [s.name].concat(heatYearCols(ys).map(function (c) { return c.na ? null : c.v[s.key]; })); }) }; }

/* ── 깔때기(선택 연도 합산) */
function funnelData(ys) {
  var fi = rows("issue", ys), fc = rows("case", ys), sensed = fi.length, pending = fi.filter(function (r) { return r.st === "센싱됨"; }).length, held = fi.filter(function (r) { return r.st === "보류"; }).length, promoted = fi.filter(function (r) { return r.st === "사건화"; }).length;
  return { sensed: sensed, pending: pending, held: held, promoted: promoted, closed: fc.filter(function (c) { return c.src === "센싱" && c.s === "종결"; }).length, rate: sensed ? promoted / sensed : null,
    manual: fc.filter(function (c) { return c.src === "수동"; }).length, past: fc.filter(function (c) { return c.src === "과거이력"; }).length, pilot: fc.filter(function (c) { return c.src === "시범"; }).length, available: ys.length ? (ys.some(avail) || sensed > 0) : D.coverageStartYear != null };
}
function funnel(body, ys) {
  var f = funnelData(ys), other = f.manual + f.past + f.pilot;
  if (!f.available) { body.appendChild(h("div", "tempty", "센싱 집계 없음 — 센싱 시작(" + (D.coverageStartYear || "-") + "년) 이전입니다.")); body.appendChild(h("p", "tnote", "센싱 외 사건(수동·과거이력·시범): " + other + "건")); return; }
  var steps = [["센싱", f.sensed, "수집된 이슈"], ["검토 완료", f.sensed - f.pending, "분류 대기를 벗어난 이슈(사건화 + 보류)"], ["사건화", f.promoted, "사건으로 올린 건"], ["종결", f.closed, "종결된 사건"]], base = Math.max(1, f.sensed);
  var wrap = h("div", "fn"); steps.forEach(function (s, i) { var row = h("div", "fr"); row.appendChild(h("span", "fl", s[0])); var tr = h("div", "ftr"), fill = h("div", "ff f" + i); fill.style.width = Math.max(s[1] ? 2 : 0, s[1] / base * 100) + "%"; fill.style.setProperty("--d", i * 100); tr.appendChild(fill); row.appendChild(tr); row.appendChild(h("span", "fv", String(s[1]))); hit(row, s[0] + " " + s[1] + "건", s[0] + " " + s[1] + "건\n" + s[2]); wrap.appendChild(row); }); body.appendChild(wrap);
  var rt = h("div", "frate"); rt.appendChild(h("b", null, pctTxt(f.rate))); rt.appendChild(h("span", null, "전환율 (센싱 → 사건화)")); body.appendChild(rt);
  body.appendChild(h("p", "tnote", "보류 " + f.held + "건(사유 기록) · 센싱 외 사건 " + other + "건(수동 " + f.manual + " · 과거이력 " + f.past + (f.pilot ? " · 시범 " + f.pilot + " 초안" : "") + ")"));
}
function tblFunnel(ys) { var f = funnelData(ys); return { head: ["단계", "건수"], rows: f.available ? [["센싱", f.sensed], ["분류 대기", f.pending], ["보류", f.held], ["사건화", f.promoted], ["종결", f.closed], ["전환율", pctTxt(f.rate)]] : [["센싱", null]] }; }

/* ── AI 제안 현황(건수는 선택 연도, 일치율은 전체 기간 누적) */
function aiData(ys) { var fi = rows("issue", ys); return { unc: fi.filter(function (r) { return r.unc; }).length, hold: fi.filter(function (r) { return r.t === "hold"; }).length }; }
function aiTile(body, ys) {
  var a = D.accuracy, st = aiData(ys), w = h("div", "mini3");
  function m(v, l, s) { var d = h("div", "m3"); d.appendChild(h("b", null, v)); d.appendChild(h("span", null, l)); if (s) d.appendChild(h("small", null, s)); w.appendChild(d); }
  m(a.overall.n ? Math.round(a.overall.rate * 100) + "%" : "측정 전", "AI 유형 일치율", a.overall.n ? "전체 기간 · 확정 " + a.overall.n + "건 중 " + a.overall.match + "건 일치" : "담당자가 확정한 AI 제안이 아직 없습니다");
  m(String(st.unc), "AI 제안 미확인", yShort(ys) + " · 담당자 확인 전"); m(String(st.hold), "분류 보류", yShort(ys) + " · AI 확신 낮음"); body.appendChild(w);
}
function tblAi(ys) { var a = D.accuracy, st = aiData(ys); return { head: ["항목", "값"], rows: [["AI 유형 일치율(전체 기간)", a.overall.n ? Math.round(a.overall.rate * 100) + "%" : "측정 전"], ["담당자 확정 건수(전체 기간)", a.overall.n], ["AI 제안 미확인(" + yShort(ys) + ")", st.unc], ["분류 보류(" + yShort(ys) + ")", st.hold]] }; }

/* ── 최근 사건(선택 연도) */
function recentList(ys) { return rows("case", ys).slice().sort(function (a, b) { var ka = (a.d || (a.y + "-00-00")) + String(a.id).padStart(8, "0"), kb = (b.d || (b.y + "-00-00")) + String(b.id).padStart(8, "0"); return ka < kb ? 1 : ka > kb ? -1 : 0; }).slice(0, 6); }
function recent(body, ys) {
  var list = recentList(ys); if (!list.length) { body.appendChild(h("div", "tempty", "선택한 조건의 사건이 없습니다.")); return; }
  var ul = h("ul", "rlist"); list.forEach(function (c) {
    var li = h("li"), b = h("button"); b.type = "button"; var d = h("i"); d.style.background = colorOf(keyT(c.t || "unclassified")); b.appendChild(d);
    var tx = h("span", "rt"); tx.appendChild(h("b", null, c.title)); tx.appendChild(h("small", null, (c.d || c.y + "년 (월·일 미확정)") + " · " + (c.t && c.t !== "unclassified" ? C.typeName(c.t) : "유형 미지정") + (c.b ? " · " + C.buName(c.b) : ""))); b.appendChild(tx);
    var bd = h("span", "rb"); if (c.src === "시범") bd.appendChild(h("span", "b pilot", "시범")); bd.appendChild(h("span", "b " + (c.s === "종결" ? "conf" : "draft"), c.s)); b.appendChild(bd); b.onclick = function () { C.nav("arch"); }; li.appendChild(b); ul.appendChild(li); });
  body.appendChild(ul);
}
function tblRecent(ys) { return { head: ["사건", "시작일", "유형", "상태"], rows: recentList(ys).map(function (c) { return [c.title, c.d || c.y + "년", c.t && c.t !== "unclassified" ? C.typeName(c.t) : "", c.s]; }) }; }

/* ── 틀 만들기·다시 그리기 */
function buildFrames() {
  idx = 0; TILES = []; grid.textContent = ""; grid.className = "dgrid" + (play ? " play" : "");
  kbox = h("div", "kgrid"); grid.appendChild(kbox); drawKpis();
  var tn = function () { return tName(); };
  [{ key: "year", span: 5, title: function () { return "연도별 " + tn(); }, sub: function (ys) { return "선택 연도 강조 · " + yShort(ys) + " (막대를 누르면 공통 연도가 바뀝니다)"; }, build: barsYear, table: tblYear },
   { key: "monthly", span: 7, title: function (ys) { return ys.length === 1 ? ys[0] + "년 월별 추이" : "월별 추이 · 연도 비교"; }, sub: function (ys) { return ys.length === 1 ? "사건 · 센싱" : yText(ys) + " · " + tn() + " · 연도마다 한 줄"; }, build: lineMonthly, table: tblMonthly },
   { key: "typeCombo", span: 12, title: function () { return "유형 분석"; }, sub: function (ys) { return tn() + " · 왼쪽: 연도별 유형 구성(선택 연도 강조) · 오른쪽: 유형 비중(" + yShort(ys) + (ys.length > 1 ? " 합산" : "") + ")"; }, build: typeCombo, table: tblStackedYears },
   { key: "bu", span: 6, title: function () { return "사업부문별 유형 구성"; }, sub: function (ys) { return yText(ys) + (ys.length > 1 ? " 합산" : "") + " · " + tn(); }, build: stackedBu, table: tblBu },
   { key: "funnel", span: 6, title: function () { return "센싱 → 사건화 깔때기"; }, sub: function (ys) { return yText(ys) + (ys.length > 1 ? " 합산" : "") + " · 전환율은 센싱 대비 사건화"; }, build: funnel, table: tblFunnel },
   { key: "heatYear", span: 5, title: function () { return "연도 × 유형"; }, sub: function (ys) { return "선택 연도만 · " + tn() + " · 칸을 누르면 좁혀집니다"; }, build: heatYear, table: tblHeatYear },
   { key: "heatBu", span: 7, title: function () { return "사업부문 × 유형"; }, sub: function (ys) { return yText(ys) + (ys.length > 1 ? " 합산" : "") + " · " + tn(); }, build: heatBu, table: tblBu },
   { key: "ai", span: 4, title: function () { return "AI 유형 제안 현황"; }, sub: function (ys) { return "센싱 이슈 · " + yShort(ys); }, build: aiTile, table: tblAi },
   { key: "recent", span: 8, title: function () { return "최근 사건"; }, sub: function (ys) { return yText(ys) + " · 누르면 리스크 아카이브로 이동"; }, build: recent, table: tblRecent }].forEach(makeTile);
  noteEl = h("p", "gnote"); grid.appendChild(noteEl);
  TILES.forEach(paintTile); drawNote();
  if (play) { clearTimeout(playTimer); playTimer = setTimeout(function () { grid.classList.remove("play"); play = false; }, 3200); }
}
function drawNote() { var cov = D.coverageStartYear; noteEl.textContent = "집계 기준: 사건=시작일(최초 민원 접수일), 센싱=기사 게재일. 과거 연도(" + (cov ? "~" + (cov - 1) + "년" : "센싱 시작 전") + ")는 센싱 기록이 없어 ‘집계 없음’으로 표시합니다. 연도는 상단 공통 필터가 모든 카드에 적용되고, 카드마다 따로 고르면 ‘개별’로 표시됩니다(상단 공통 필터를 바꾸면 개별 선택은 공통 값으로 맞춰집니다). 출처가 ‘시범’인 사건(초안)도 통계에 포함됩니다." + (S.target === "issue" ? " 센싱 이슈의 유형 건수에는 AI 제안값도 포함되며, 담당자 확인 전 건수는 ‘AI 제안 미확인’으로 따로 표시됩니다." : ""); }
function drawAll() { drawKpis(); TILES.forEach(paintTile); drawNote(); }

/* ── 상단 공통 필터(연도는 다중 선택, 기본=올해) */
function buildBar() {
  barEl.textContent = ""; var cfg = C.cfg;
  function sel(label, key, list, blank) { var s = h("select"); s.setAttribute("aria-label", label); var o = h("option", null, blank); o.value = ""; s.appendChild(o); list.forEach(function (x) { var p = h("option", null, x[1]); p.value = x[0]; if (String(x[0]) === String(S[key])) p.selected = true; s.appendChild(p); }); s.onchange = function () { var p = {}; p[key] = s.value; setF(p); }; var w = h("label", "fsel"); w.appendChild(h("span", null, label)); w.appendChild(s); return w; }
  var seg = h("div", "seg2"); [["case", "사건"], ["issue", "센싱"]].forEach(function (t) { var b = h("button", null, t[1]); b.type = "button"; b.setAttribute("aria-pressed", String(S.target === t[0])); b.onclick = function () { S.target = t[0]; saveState(); buildBar(); drawAll(); }; seg.appendChild(b); });
  barEl.appendChild(h("span", "tlab", "차트 대상")); barEl.appendChild(seg);
  var yw = h("label", "fsel"); yw.appendChild(h("span", null, "연도(공통)")); var yc = yearCtl({ get: function () { return S.common; }, set: function (a) { setCommon(a); } }); yw.appendChild(yc.el); barEl.appendChild(yw);
  barEl.appendChild(sel("유형", "type", cfg.issueTypes.map(function (t) { return [t.id, t.name]; }).concat([["unclassified", "미분류"]]), "전체"));
  barEl.appendChild(sel("사업부문", "bu", cfg.businessUnits.map(function (b) { return [b.id, b.name]; }), "전체"));
  if (S.type || S.bu || !sameSet(S.common, [D.cur]) || Object.keys(S.card).length) { var r = h("button", "reset", "필터 해제"); r.type = "button"; r.onclick = function () { S.type = ""; S.bu = ""; S.card = {}; setCommon([D.cur]); }; barEl.appendChild(r); }
}
function load(fresh) {
  if (!root || loading) return Promise.resolve(); loading = true;
  return C.api("/api/dashboard").then(function (d) {
    D = d; sanitize(); saveState(); buildBar();
    if (fresh || !built) { play = !!fresh && !reduce; PREV = {}; KPREV = {}; built = true; buildFrames(); } else drawAll();
    if (C.onData) C.onData({ home: d.home });
  }).catch(function (e) { grid.textContent = "대시보드를 불러오지 못했습니다: " + e.message; }).then(function () { loading = false; });
}
var rt = null; window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { if (root && D && !root.closest("[hidden]")) { play = false; drawAll(); } }, 220); });
window.RiskDash = {
  mount: function (ctx) { C = ctx; root = ctx.root; root.textContent = ""; loadState(); var hd = h("div", "dhead"), tt = h("div", "pt"); tt.appendChild(h("h2", null, "Dashboard")); tt.appendChild(h("p", null, "시작일 기준 · 연도는 위에서 여러 개를 고를 수 있고 카드마다 따로 고를 수도 있습니다 · 막대·칸·범례를 누르면 그 조건으로 좁혀집니다")); hd.appendChild(tt); barEl = h("div", "dbar"); hd.appendChild(barEl); root.appendChild(hd); grid = h("div", "dgrid"); root.appendChild(grid); bindTip(); },
  show: function () { return load(true); },
  refresh: function () { return load(false); }
};
})();
