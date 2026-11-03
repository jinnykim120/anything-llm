/* 공용 UI 도우미: 얇은 선형 인라인 SVG 아이콘(외부 의존 없음). 아이콘은 글자 색(currentColor)을 따라가므로 라이트·다크 모두 정상이다. */
(function () {
"use strict";
var NS = "http://www.w3.org/2000/svg";
var P = {
  grid: '<rect x="3" y="3" width="7" height="9" rx="1.6"/><rect x="14" y="3" width="7" height="5" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/><rect x="3" y="16" width="7" height="5" rx="1.6"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.6"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
  shield: '<path d="M12 3l8 3v5.5c0 4.6-3.3 8.1-8 9.5-4.7-1.4-8-4.9-8-9.5V6z"/><path d="M12 8.5v4"/><path d="M12 16h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/>',
  download: '<path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  up: '<path d="M7 17L17 7"/><path d="M8 7h9v9"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  arrow: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/>'
};
function icon(name, size) {
  var s = document.createElementNS(NS, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", size || 16); s.setAttribute("height", size || 16); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.7"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false"); s.setAttribute("class", "ic"); s.innerHTML = P[name] || ""; return s;
}
/* 버튼 맨 앞에 아이콘을 붙인다(글자는 그대로 유지) */
function ic(el, name) { el.insertBefore(icon(name), el.firstChild); return el; }
window.RiskUI = { icon: icon, ic: ic };
})();
