// markdown 표(GFM) 판별·분해 — markdownToDocx / markdownToXlsx 가 함께 쓴다.
// HTML 다운로드는 markdown-it 이 표를 읽기 때문에 앞뒤 "|" 가 없는 표나 "| - | - |"
// 같은 표도 그려지는데, 변환기가 이를 못 읽으면 Word·Excel 에서만 표가 사라진다.
// 그래서 markdown-it(GFM)이 표로 읽는 형태를 같게 받아들인다.

const SEP_CELL = /^:?-+:?$/;

/** "a | b" · "| a | b |" 를 셀 배열로. 이스케이프한 "\|" 는 셀 안의 문자로 둔다. */
function splitTableRow(line) {
  let text = String(line).trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (text[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += text[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** "|---|:--:|" · "--|--" · "| - | - |" 같은 구분줄인가 (셀 하나뿐이면 "|" 가 있어야 함). */
function isTableSeparator(line) {
  const text = String(line).trim();
  if (!text.includes("-")) return false;
  const cells = splitTableRow(text);
  if (cells.length === 1 && !text.includes("|")) return false;
  return cells.every((c) => SEP_CELL.test(c));
}

/** lines[i] 가 표의 헤더줄이고 바로 다음 줄이 구분줄인가 (열 수도 같아야 함). */
function isTableStart(lines, i) {
  const header = String(lines[i] || "").trim();
  if (!header || i + 1 >= lines.length) return false;
  if (!header.includes("|") || !isTableSeparator(lines[i + 1])) return false;
  return splitTableRow(header).length === splitTableRow(lines[i + 1]).length;
}

/**
 * 표를 읽어 행 배열(헤더 포함)과 다음 줄 위치를 돌려준다. 모든 행은 헤더의 열 수에 맞춘다.
 * @returns {{rows:string[][], next:number}}
 */
function readTable(lines, i) {
  const header = splitTableRow(lines[i]);
  const width = header.length;
  const rows = [header];
  let next = i + 2; // 헤더 + 구분줄
  while (next < lines.length) {
    const t = lines[next].trim();
    if (!t || !t.includes("|")) break;
    const cells = splitTableRow(t);
    while (cells.length < width) cells.push("");
    rows.push(cells.slice(0, width));
    next++;
  }
  return { rows, next };
}

module.exports = { splitTableRow, isTableSeparator, isTableStart, readTable };
