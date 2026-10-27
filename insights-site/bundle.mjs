// site/ 전체(메인·주제·전망 페이지, 이미지, 폰트)를 HTML 파일 하나로 묶는다. 다른 컴퓨터에서 더블클릭으로 열 수 있다.
//   node insights-site/build.mjs --preview    # 먼저 site/ 를 만든다
//   node insights-site/bundle.mjs              # → insights-site/dist/NEXUS-Insight.html
// 파일 하나 안에서 페이지 이동(#/privacy 등)을 처리한다. 이미지는 줄여서(가로 1100px, 환경변수 IMG_MAX) 안에 넣는다.
// 서버가 없으므로 YouTube 영상은 원본 링크로 열린다.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { here } from "./lib.mjs";

const SITE = join(here, "site"), OUT_DIR = join(here, "dist"), OUT = join(OUT_DIR, "NEXUS-Insight.html");
if (!existsSync(join(SITE, "index.html"))) { console.error("site/ 가 없습니다. 먼저 node insights-site/build.mjs 를 실행하세요."); process.exit(1); }
const txt = (f) => readFileSync(join(SITE, f), "utf8");
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".woff2": "font/woff2" };
const uri = (file) => `data:${MIME[extname(file).toLowerCase()] || "application/octet-stream"};base64,${readFileSync(file).toString("base64")}`;

// ── 1) 이미지: 줄여서 data URI 로 (Pillow 가 없으면 원본 그대로)
const tmp = mkdtempSync(join(tmpdir(), "nx-img-"));
const py = [
  "import sys,os", "from PIL import Image",
  "src,out,mw=sys.argv[1],sys.argv[2],int(sys.argv[3])",
  "for f in os.listdir(src):",
  "    n=os.path.splitext(f)[0]",
  "    try:",
  "        im=Image.open(os.path.join(src,f))",
  "        if im.width>mw: im=im.resize((mw,round(im.height*mw/im.width)),Image.LANCZOS)",
  "        if im.mode=='P': im=im.convert('RGBA')",
  "        if im.mode in ('RGBA','LA') and im.getextrema()[-1][0]<255:",
  "            im.save(os.path.join(out,n+'.png'),optimize=True); continue",
  "        im.convert('RGB').save(os.path.join(out,n+'.jpg'),quality=82,optimize=True,progressive=True)",
  "    except Exception as ex: print('skip',f,ex)",
].join("\n");
const shrunk = spawnSync("python", ["-c", py, join(SITE, "media"), tmp, process.env.IMG_MAX || "1100"], { encoding: "utf8" });
const useShrunk = shrunk.status === 0;
if (!useShrunk) console.log("이미지를 줄이지 못해 원본을 넣습니다(Pillow 필요):", (shrunk.stderr || "").trim().split("\n").pop());
const mediaUri = {};
for (const f of readdirSync(join(SITE, "media"))) {
  const base = basename(f, extname(f)), alt = readdirSync(tmp).find((g) => basename(g, extname(g)) === base);
  mediaUri[`media/${f}`] = useShrunk && alt ? uri(join(tmp, alt)) : uri(join(SITE, "media", f));
}

// ── 2) 데이터: site-data.js 의 이미지 경로를 data URI 로 바꾼다
let data = txt("site-data.js").replace(/^window\.SITE_DATA=/, "").replace(/;\s*$/, "");
data = data.replace(/media\/[A-Za-z0-9._-]+/g, (m) => mediaUri[m] || m);
JSON.parse(data); // 깨졌는지 확인

// ── 3) 폰트·CSS·JS
const FONT = { FP: uri(join(SITE, "fonts", "PretendardVariable.woff2")), FO: uri(join(SITE, "fonts", "Outfit-latin-wght.woff2")) };
const fontTokens = (s) => s.split('url("fonts/PretendardVariable.woff2")').join('url("@@FP@@")').split('url("fonts/Outfit-latin-wght.woff2")').join('url("@@FO@@")');
const CSS = { common: fontTokens(txt("common.css")), ui: txt("ui-extra.css") };
const JS = { common: txt("common.js") };

// ── 4) 페이지: 외부 파일 참조를 자리표시자로 바꾼다 (조립은 열릴 때 한다)
const TITLES = {}, PAGES = {};
for (const f of readdirSync(SITE).filter((x) => x.endsWith(".html"))) {
  const name = f.replace(/\.html$/, "");
  let h = fontTokens(txt(f));
  TITLES[name] = (h.match(/<title>([^<]*)<\/title>/) || [, "NEXUS Insight"])[1];
  h = h.replace(/<link rel="stylesheet" href="common\.css[^"]*">/, "@@CSS_COMMON@@")
       .replace(/<link rel="stylesheet" href="ui-extra\.css[^"]*">/, "@@CSS_UI@@")
       .replace(/<script src="site-data\.js[^"]*"><\/script>/, "@@DATA@@")
       .replace(/<script src="common\.js[^"]*"><\/script>/, "@@JS_COMMON@@")
       .split("(window.__HASH||location.hash)").join("(window.__HASH||location.hash)") // 이미 치환된 경우 대비
       .split("location.hash.slice(1)").join("(window.__HASH||location.hash).slice(1)");
  // 파일 하나 안에서는 location.hash 대입 대신 해당 위치로 스크롤한다
  h = h.replace('location.hash = "#method";', 'var m = document.getElementById("method"); if (m) m.scrollIntoView({ behavior: "smooth" });');
  if (/src="(common|site-data)|href="(common|ui-extra)/.test(h)) console.log("경고: 치환되지 않은 외부 참조가 있습니다:", f);
  PAGES[name] = h;
}

// ── 5) 껍데기 HTML (iframe 하나 + 라우터)
const lit = (v) => JSON.stringify(v).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");
const shell = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEXUS Insight</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style>
</head><body>
<iframe id="f" title="NEXUS Insight"></iframe>
<script>
(function () {
  "use strict";
  var PAGES = ${lit(PAGES)}, TITLES = ${lit(TITLES)};
  var CSS = ${lit(CSS)}, JS = ${lit(JS)}, FONT = ${lit(FONT)};
  var DATA = ${lit(data)};
  var f = document.getElementById("f");
  var HOOK = "document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');" +
    "if(/^[a-z0-9-]+\\\\.html(#.*)?$/.test(h)){e.preventDefault();parent.postMessage({go:h},'*');}" +
    "else if(h.charAt(0)==='#'&&h.length>1){e.preventDefault();var t=document.getElementById(decodeURIComponent(h.slice(1)));if(t)t.scrollIntoView({behavior:'smooth'});}},true);";
  function sub(h, token, text) { return h.split(token).join(text); }
  function assemble(name, hash) {
    var h = PAGES[name];
    h = sub(h, "@@CSS_COMMON@@", "<style>" + CSS.common + "</style>");
    h = sub(h, "@@CSS_UI@@", "<style>" + CSS.ui + "</style>");
    h = sub(h, "@@DATA@@", "<script>window.SITE_DATA=" + DATA + ";<\\/script>");
    h = sub(h, "@@JS_COMMON@@", "<script>" + JS.common + "<\\/script>");
    h = sub(h, "@@FP@@", FONT.FP); h = sub(h, "@@FO@@", FONT.FO);
    h = sub(h, "</head>", "<script>window.__HASH=" + JSON.stringify(hash || "") + ";<\\/script></head>");
    return sub(h, "</body>", "<script>" + HOOK + "<\\/script></body>");
  }
  function route() {
    var m = (location.hash || "").match(/^#\\/([a-z0-9-]+)(?:\\/(.*))?$/), name = m && PAGES[m[1]] ? m[1] : "index";
    document.title = (TITLES[name] || "NEXUS Insight");
    f.srcdoc = assemble(name, m && m[2] ? decodeURIComponent(m[2]) : "");
  }
  window.addEventListener("message", function (e) {
    if (e.source !== f.contentWindow || !e.data || typeof e.data.go !== "string") return;
    var m = e.data.go.match(/^([a-z0-9-]+)\\.html(?:#(.*))?$/); if (!m) return;
    location.hash = m[1] === "index" ? "#/" : "#/" + m[1] + (m[2] ? "/" + m[2] : "");
  });
  f.addEventListener("load", function () { try { var t = f.contentDocument.title; if (t) document.title = t; } catch (e) {} });
  window.addEventListener("hashchange", route); route();
})();
</script>
</body></html>`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, shell);
rmSync(tmp, { recursive: true, force: true });
console.log(`dist/NEXUS-Insight.html  ${(shell.length / 1024 / 1024).toFixed(1)}MB · 페이지 ${Object.keys(PAGES).length} · 이미지 ${Object.keys(mediaUri).length}`);
