/* 피드·주제 페이지 공용: 요소 생성, 매슨리(masonry) 그리드, 이미지 핀, 영상, 모달 (textContent 만 사용) */
window.NX = (function () {
  "use strict";
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  var grids = [], roRaf, ro = window.ResizeObserver ? new ResizeObserver(function () { cancelAnimationFrame(roRaf); roRaf = requestAnimationFrame(function () { grids.forEach(function (g) { g.layout(); }); }); }) : null;
  function Grid(container) {
    var g = { box: container, items: [] };
    container.classList.add("grid");
    g.add = function (node, opt) {
      opt = opt || {}; node.classList.add("card");
      if (opt.open) {
        node.classList.add("click"); node.setAttribute("tabindex", "0"); node.setAttribute("role", node.tagName === "A" ? "link" : "button");
        node.addEventListener("click", function (e) { e.preventDefault(); opt.open(); });
        node.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opt.open(); } });
      } else if (node.tagName === "A") node.classList.add("click");
      g.items.push({ node: node, span: opt.span || 1, kind: opt.kind || null, meta: opt.meta || null });
      container.appendChild(node); if (ro) ro.observe(node);
    };
    g.layout = function () {
      var GAP = 20, W = container.clientWidth, minW = W < 560 ? W : 280;
      var cols = Math.max(1, Math.floor((W + GAP) / (minW + GAP))), cw = (W - (cols - 1) * GAP) / cols, hs = [];
      for (var i = 0; i < cols; i++) hs.push(0);
      g.items.forEach(function (it) {
        if (it.node.classList.contains("hide")) return;
        var span = Math.min(it.span, cols), c = 0;
        if (span === 1) { for (var k = 1; k < cols; k++) if (hs[k] < hs[c]) c = k; }
        else { var best = Infinity; for (var j = 0; j <= cols - span; j++) { var m = 0; for (var s = 0; s < span; s++) m = Math.max(m, hs[j + s]); if (m < best) { best = m; c = j; } } }
        it.node.style.width = (span * cw + (span - 1) * GAP) + "px";
        var y = 0; for (var s2 = 0; s2 < span; s2++) y = Math.max(y, hs[c + s2]);
        it.node.style.transform = "translate(" + (c * (cw + GAP)) + "px," + y + "px)";
        var h = it.node.offsetHeight; for (var s3 = 0; s3 < span; s3++) hs[c + s3] = y + h + GAP;
      });
      container.style.height = Math.max.apply(null, hs) + "px";
    };
    g.filter = function (kind) { g.items.forEach(function (it) { it.node.classList.toggle("hide", !!kind && it.kind !== kind); }); g.layout(); };
    g.filterBy = function (fn) { var n = 0; g.items.forEach(function (it) { var ok = fn(it); if (ok && it.kind !== "empty") n++; it.node.classList.toggle("hide", !ok); }); g.layout(); return n; };
    grids.push(g); return g;
  }
  function relayout() { grids.forEach(function (g) { g.layout(); }); }
  var raf; window.addEventListener("resize", function () { cancelAnimationFrame(raf); raf = requestAnimationFrame(relayout); });
  // 이미지가 하나씩 들어오는 동안은 위치 이동 애니메이션을 끈다(카드가 흘러다니는 것 방지); 로딩이 끝나면 켠다
  window.addEventListener("load", function () { relayout(); setTimeout(function () { grids.forEach(function (g) { g.box.classList.add("anim"); }); }, 400); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);

  /* 이미지 위에 제목을 얹은 카드. o: {tag, title, sub, src|art(node), credit, big, play} */
  function pin(o) {
    var n = el(o.href ? "a" : "article", "pin" + (o.big ? " lg" : "") + (o.fit === "contain" ? " contain" : ""));
    if (o.href) n.href = o.href;
    var box = el("div", "imgbox");
    if (o.art) box.appendChild(o.art);
    else if (o.src) {
      var im = el("img"); im.src = o.src; im.alt = ""; if (o.h) im.style.height = o.h + "px"; if (o.pos) im.style.objectPosition = o.pos;
      im.addEventListener("load", relayout); im.addEventListener("error", function () { im.style.display = "none"; box.style.minHeight = "220px"; relayout(); });
      box.appendChild(im);
    }
    box.appendChild(el("div", "shade")); n.appendChild(box);
    if (o.tag) n.appendChild(el("span", "ptag", o.tag));
    if (o.credit) n.appendChild(el("span", "credit", o.credit));
    if (o.play) n.appendChild(el("span", "play"));
    var cap = el("div", "cap"); cap.appendChild(el("h3", null, o.title)); if (o.sub) cap.appendChild(el("p", null, o.sub)); n.appendChild(cap);
    return n;
  }

  function ytBox(id) {
    var b = el("div", "ytbox"), f = el("iframe");
    f.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(id) + "?autoplay=1&rel=0";
    f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen"; f.allowFullscreen = true; f.title = "YouTube video player"; f.referrerPolicy = "strict-origin-when-cross-origin";
    b.appendChild(f); return b;
  }

  /* ---------- modal ---------- */
  var scrim = document.getElementById("scrim"), sheet = document.getElementById("sheet"), lastFocus = null;
  function close() { scrim.classList.remove("on"); sheet.replaceChildren(); document.body.style.overflow = ""; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  scrim.addEventListener("click", function (e) { if (e.target === scrim) close(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && scrim.classList.contains("on")) close(); });
  function sources(list, ids) {
    var w = el("div"); if (!ids || !ids.length) return w;
    w.appendChild(el("h4", null, "근거"));
    ids.forEach(function (id) {
      var s = (list || []).filter(function (x) { return x.id === id; })[0]; if (!s) return;
      var d = el("div", "src"); d.appendChild(el("b", null, s.title)); d.appendChild(el("div", "m", s.publisher + " · " + s.date));
      if (s.url) { var a = el("a", null, "원문 보기 ↗"); a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer"; var p = el("div"); p.style.marginTop = "4px"; p.appendChild(a); d.appendChild(p); }
      w.appendChild(d);
    });
    return w;
  }
  /* o: {title, paras[], facts[], image, credit, videoId, videoUrl, cites[], sources[], note} */
  function openSheet(o) {
    lastFocus = document.activeElement; sheet.replaceChildren();
    var x = el("button", "x", "×"); x.setAttribute("aria-label", "닫기"); x.onclick = close; sheet.appendChild(x);
    if (o.videoId) sheet.appendChild(ytBox(o.videoId));
    else if (o.image) { var im = el("img", "hero"); im.src = o.image; im.alt = ""; sheet.appendChild(im); }
    var inner = el("div", "inner"); inner.appendChild(el("h2", null, o.title));
    (o.paras || []).forEach(function (p) { inner.appendChild(el("p", null, p)); });
    if (o.facts && o.facts.length) { inner.appendChild(el("h4", null, "핵심 숫자")); var ul = el("ul"); o.facts.forEach(function (f) { ul.appendChild(el("li", null, f)); }); inner.appendChild(ul); }
    if (o.videoUrl) { var a = el("a", null, "YouTube에서 열기 ↗"); a.href = o.videoUrl; a.target = "_blank"; a.rel = "noopener noreferrer"; var p2 = el("p"); p2.style.fontSize = "14px"; p2.appendChild(a); inner.appendChild(p2); }
    if (o.note) inner.appendChild(el("div", "note", o.note));
    if (o.credit) inner.appendChild(el("p", "hint", "이미지 출처: " + o.credit));
    inner.appendChild(sources(o.sources, o.cites)); sheet.appendChild(inner);
    scrim.classList.add("on"); document.body.style.overflow = "hidden"; x.focus();
  }
  return { el: el, Grid: Grid, relayout: relayout, pin: pin, ytBox: ytBox, openSheet: openSheet };
})();
