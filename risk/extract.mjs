// 파일 읽기 도구(LLM 호출 없음): docx·pptx·xlsx 는 직접 풀어 텍스트를 뽑고(외부 라이브러리 없음), PDF 는 pdf-parse(있을 때)를 쓴다.
// Docling 은 쓰지 않는다. 개인정보 의심 점검, 이미지 크기 확인, 문서 내장 이미지 목록도 여기서 한다.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openZip } from "./zipread.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_ROOT = process.env.ARCHIVE_ROOT || "D:\\ai factory\\auto docu\\anything-llm";

export class Unsupported extends Error {}

const ent = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");

// ── docx: 문단은 줄, 표는 행 단위 ' | ' 구분
export function docxText(buf) {
  const z = openZip(buf), xml = z.readText("word/document.xml");
  if (xml == null) throw new Unsupported("word/document.xml 이 없습니다");
  const out = [], tables = []; let cur = null;
  const re = /<w:(tbl|tr|tc|p)(?=[\s>/])[^>]*?(\/?)>|<\/w:(tbl|tr|tc|p)>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br)\b[^>]*\/>/g;
  let m;
  const emit = (line) => { const t = tables.at(-1); if (t && t.cell) t.cell.paras.push(line); else out.push(line); };
  while ((m = re.exec(xml))) {
    if (m[1]) {
      if (m[2] === "/") { if (m[1] === "p") continue; }
      if (m[1] === "tbl") tables.push({ rows: [], row: null, cell: null });
      else if (m[1] === "tr") { const t = tables.at(-1); if (t) t.row = []; }
      else if (m[1] === "tc") { const t = tables.at(-1); if (t) t.cell = { paras: [] }; }
      else if (m[1] === "p") cur = "";
    } else if (m[3]) {
      if (m[3] === "p") { if (cur !== null) emit(cur.replace(/\s+/g, " ").trim()); cur = null; }
      else if (m[3] === "tc") { const t = tables.at(-1); if (t && t.cell) { (t.row ||= []).push(t.cell.paras.filter(Boolean).join(" ")); t.cell = null; } }
      else if (m[3] === "tr") { const t = tables.at(-1); if (t && t.row) { t.rows.push(t.row); t.row = null; } }
      else if (m[3] === "tbl") { const t = tables.pop(); const lines = t.rows.map((r) => r.join(" | ")).filter((l) => l.replace(/[|\s]/g, "")); for (const l of lines) emit(l); }
    } else if (m[4] !== undefined) { if (cur !== null) cur += ent(m[4]); }
    else if (m[5]) { if (cur !== null) cur += " "; }
  }
  return out.filter((l) => l !== "").join("\n");
}

// ── pptx: 슬라이드 순서대로 문단
export function pptxText(buf) {
  const z = openZip(buf);
  const slides = z.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  if (!slides.length) throw new Unsupported("슬라이드가 없습니다");
  const parts = [];
  slides.forEach((n, i) => {
    const xml = z.readText(n), lines = [];
    for (const pm of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\s[^>]*>([\s\S]*?)<\/a:p>/g)) {
      const s = [...(pm[1] ?? pm[2] ?? "").matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((x) => ent(x[1])).join("").replace(/\s+/g, " ").trim();
      if (s) lines.push(s);
    }
    parts.push(`[슬라이드 ${i + 1}]\n${lines.join("\n")}`);
  });
  return parts.join("\n\n");
}

// ── xlsx: 시트별 앞쪽 행만 (개인정보 점검용 머리글 포함)
const colIdx = (ref) => { let n = 0; for (const c of ref.replace(/\d+/g, "")) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };
const attr = (tag, name) => { const m = tag.match(new RegExp(`${name}="([^"]*)"`)); return m ? ent(m[1]) : null; };
export function xlsxPeek(buf, maxRows = 60) {
  const z = openZip(buf);
  const ss = [];
  const sst = z.readText("xl/sharedStrings.xml");
  if (sst) for (const si of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) ss.push([...si[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => ent(x[1])).join(""));
  const wb = z.readText("xl/workbook.xml") || "", rels = z.readText("xl/_rels/workbook.xml.rels") || "";
  const relMap = {}; for (const r of rels.matchAll(/<Relationship\b[^>]*>/g)) relMap[attr(r[0], "Id")] = attr(r[0], "Target");
  let sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((s) => ({ name: attr(s[0], "name"), target: relMap[attr(s[0], "r:id")] })).filter((s) => s.target);
  if (!sheets.length) sheets = z.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).map((n, i) => ({ name: `Sheet${i + 1}`, target: n.replace("xl/", "") }));
  return sheets.map((s) => {
    const xml = z.readText("xl/" + s.target.replace(/^\/?(xl\/)?/, "")) || "", rows = [];
    for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) break;
      const cells = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = cm[1], body = cm[2] || "", t = attr(a, "t"), r = attr(a, "r");
        let v = "";
        if (t === "s") v = ss[Number((body.match(/<v>([^<]*)<\/v>/) || [])[1])] ?? "";
        else if (t === "inlineStr") v = [...body.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => ent(x[1])).join("");
        else v = ent((body.match(/<v>([^<]*)<\/v>/) || [, ""])[1]);
        if (r) cells[colIdx(r)] = v;
      }
      rows.push(Array.from(cells, (c) => c ?? ""));
    }
    return { name: s.name, rows };
  });
}

// ── pdf: 있을 때만(수집기의 pdf-parse). 없으면 지원 안 함으로 처리해 '보관만'
let _pdf;
function pdfLib() {
  if (_pdf !== undefined) return _pdf;
  for (const base of [here, join(ARCHIVE_ROOT, "collector")]) {
    try { _pdf = createRequire(join(base, "noop.js"))("pdf-parse/lib/pdf-parse.js"); return _pdf; } catch { /* 다음 후보 */ }
  }
  return (_pdf = null);
}
async function pdfText(buf) {
  const lib = pdfLib();
  if (!lib) throw new Unsupported("PDF 텍스트 추출기(pdf-parse)를 찾을 수 없습니다");
  // 쪽 번호를 본문에 표시한다([쪽 N]) — 사건 카드의 근거 위치(쪽)를 남기기 위함
  const render = (pd) => pd.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((tc) => {
    let last, t = ""; for (const it of tc.items) { if (last === it.transform[5] || !last) t += it.str; else t += "\n" + it.str; last = it.transform[5]; }
    return `[쪽 ${(pd.pageIndex ?? 0) + 1}]\n${t}`;
  });
  const r = await lib(buf, { pagerender: render });
  const text = String(r.text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return text.replace(/\[쪽 \d+\]\s*/g, "").trim() ? text : "";   // 글자가 하나도 없는 PDF(스캔본)는 빈 문자열
}
function plainText(buf) {
  let s = buf.toString("utf8");
  if ((s.match(/\uFFFD/g) || []).length > 3) { try { s = new TextDecoder("euc-kr").decode(buf); } catch { /* utf8 유지 */ } }
  return s.replace(/^\uFEFF/, "");
}
const tsv = (rows) => rows.map((r) => r.join(" | ")).filter((l) => l.replace(/[|\s]/g, "")).join("\n");

// ── 통합: 텍스트 추출. 결과 {text, rows?}  rows 는 표 형식(xlsx/csv)의 머리글 점검용
export async function extractText(buf, ext, limits = {}) {
  ext = ext.toLowerCase();
  if (ext === "docx") return { text: docxText(buf) };
  if (ext === "pptx") return { text: pptxText(buf) };
  if (ext === "pdf") return { text: await pdfText(buf) };
  if (ext === "txt" || ext === "md") return { text: plainText(buf).trim() };
  if (ext === "csv") { const t = plainText(buf), rows = t.split(/\r?\n/).slice(0, limits.xlsxRows || 60).map((l) => l.split(",")); return { text: tsv(rows), rows: [rows] }; }
  if (ext === "xlsx") { const sheets = xlsxPeek(buf, limits.xlsxRows || 60); return { text: sheets.map((s) => `[시트 ${s.name}]\n${tsv(s.rows)}`).join("\n\n"), rows: sheets.map((s) => s.rows) }; }
  throw new Unsupported(`지원하지 않는 형식(.${ext})`);
}

// ── 개인정보 점검
const PHONE = /(?<!\d)(?:01[016789]|0[2-6][1-5]?)[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g;
const RRN = /(?<!\d)\d{6}[-\s]?[1-4]\d{6}(?!\d)/g;
const MAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const ADDR = /[가-힣]{2,}(?:특별시|광역시|시|도)\s?[가-힣]{1,}(?:구|군|시)\s?[가-힣0-9]+(?:로|길|동|읍|면)\s?\d[\d-]*(?:\s?번지)?/g;
export function piiScan(text, rows, rules) {
  const phones = (text.match(PHONE) || []).length, rrn = (text.match(RRN) || []).length, why = [];
  if (rrn >= (rules.piiRrnThreshold ?? 3)) why.push(`주민등록번호 형태 ${rrn}건`);
  if (phones >= (rules.piiPhoneThreshold ?? 5)) why.push(`전화번호 형태 ${phones}건`);
  if (rows) {
    const words = rules.piiHeaderWords || [];
    for (const sh of rows) for (const r of sh.slice(0, 5)) { const hit = r.find((c) => words.some((w) => String(c).toLowerCase().includes(w))); if (hit) { why.push(`표 머리글에 개인정보 항목("${String(hit).slice(0, 12)}")`); break; } }
  }
  return why;
}
export const nameLooksPii = (name, ext, rules) => (rules.piiNameExts || []).includes(ext) && (rules.piiNameWords || []).some((w) => name.includes(w));
export function scrubString(s) { return s.replace(PHONE, "[개인정보]").replace(RRN, "[개인정보]").replace(MAIL, "[개인정보]").replace(ADDR, "[개인정보]"); }
export function scrubDeep(v) {
  if (typeof v === "string") return scrubString(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]));
  return v;
}

// ── 이미지 크기(헤더만 읽음)
export function sniffImage(b) {
  try {
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const t = b[i + 1];
        if (t >= 0xc0 && t <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(t)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
    if (b.toString("ascii", 0, 3) === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
      const f = b.toString("ascii", 12, 16);
      if (f === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (f === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    }
  } catch { /* 모르면 null */ }
  return { w: null, h: null };
}

// ── 문서 내장 이미지(docx word/media, pptx ppt/media, xlsx xl/media)
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
export function embeddedMedia(buf, ext) {
  const dir = { docx: "word/media/", pptx: "ppt/media/", xlsx: "xl/media/" }[ext.toLowerCase()];
  if (!dir) return [];
  const z = openZip(buf);
  return z.names.filter((n) => n.startsWith(dir) && IMG_EXT.test(n)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((n) => { const data = z.read(n); return { entry: n, name: n.slice(dir.length), data, ...sniffImage(data) }; });
}
export const readLimits = () => JSON.parse(readFileSync(join(here, "config", "analysis.json"), "utf8"));
