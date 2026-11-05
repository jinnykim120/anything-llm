// 엑셀/CSV 로 올린 협력사·품목 목록을 읽는다. 열 이름으로 '협력사 열'·'품목 열'·'채널 열'을 추측해 미리보기로 돌려주고,
// 담당자가 열을 확인·고친 뒤 이름만 추가한다(AI 호출 없음). 고객 개인정보가 섞인 파일을 올리지 않도록 이름 열만 쓴다.
import { xlsxPeek } from "./extract.mjs";

const SYN = {
  partner: /협력사|업체|거래처|제조사|제조원|공급사|납품|벤더|파트너|브랜드사|상호/,
  product: /상품명|품명|상품|품목|제품|아이템|카테고리|분류명/,
  channel: /채널|업태|사업부|판매처|판매채널/,
};
const MAX_ROWS = 3000, MAX_COLS = 12;

// 간단한 CSV 파서(따옴표·쉼표·줄바꿈). 한글 엑셀의 CSV 는 EUC-KR 인 경우가 많아 UTF-8 이 깨지면 EUC-KR 로 다시 읽는다.
export function parseCsv(buf) {
  let text = new TextDecoder("utf-8").decode(buf);
  if (text.includes("�")) { try { text = new TextDecoder("euc-kr").decode(buf); } catch { /* 그대로 */ } }
  text = text.replace(/^﻿/, "");
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; if (rows.length > MAX_ROWS + 20) break; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const nonEmpty = (r) => r.filter((c) => norm(c)).length;

function analyzeSheet(name, rawRows) {
  const rows = rawRows.map((r) => r.slice(0, MAX_COLS).map(norm));
  // 제목 행: 앞 10행 중 값이 2개 이상이고 숫자만 있지 않은 첫 행
  let h = rows.slice(0, 10).findIndex((r) => nonEmpty(r) >= 2 && r.some((c) => c && !/^[0-9.,\-\s]+$/.test(c)));
  if (h < 0) h = 0;
  const headers = (rows[h] || []).map((c, i) => c || `열 ${i + 1}`);
  const guess = { partner: -1, product: -1, channel: -1 }, used = new Set();
  for (const k of ["partner", "product", "channel"]) {
    const idx = headers.findIndex((t, i) => !used.has(i) && SYN[k].test(t));
    if (idx >= 0) { guess[k] = idx; used.add(idx); }
  }
  const data = rows.slice(h + 1).filter((r) => nonEmpty(r) > 0).slice(0, MAX_ROWS);
  return { name, headerRow: h + 1, headers, guess, rows: data, totalRows: data.length };
}

// 미리보기: 시트마다 제목·추측한 열·행(최대 3000행)을 돌려준다. 열을 고른 뒤의 추가는 화면이 이름 목록으로 /api/sensing/terms 에 보낸다.
export function previewFile(buf, filename = "") {
  const ext = String(filename).split(".").pop().toLowerCase();
  let sheets;
  if (ext === "xlsx") sheets = xlsxPeek(buf, MAX_ROWS + 20).map((s) => analyzeSheet(s.name, s.rows));
  else if (ext === "csv" || ext === "txt") sheets = [analyzeSheet("CSV", parseCsv(buf))];
  else throw Object.assign(new Error("엑셀(.xlsx)이나 CSV 파일만 올릴 수 있습니다(.xls 는 xlsx 로 저장해 올려 주세요)"), { code: 400 });
  sheets = sheets.filter((s) => s.totalRows > 0);
  if (!sheets.length) throw Object.assign(new Error("읽을 수 있는 행이 없습니다"), { code: 400 });
  return { sheets };
}
