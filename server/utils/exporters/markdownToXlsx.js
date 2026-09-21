// [auto-docu XLSX 내보내기] 초안(§06)/전사문서작성tool(§07)/자료 추출하기(§08)
// 결과의 markdown을 실제 .xlsx 바이너리로 변환한다. markdownToDocx.js와 같은
// 원칙 — 범용 markdown 파서가 아니라 이 프로젝트가 실제로 만들어내는 형태
// (제목/부제목 + 문단 + 목록 + 표 + **강조**)만 다루는 가벼운 변환기.
// 자료 추출하기 결과는 "문서 × 필드" 표 하나가 전부인 경우가 대부분이라,
// 그 표를 실제 엑셀 셀(수식·필터 가능한 구조)로 그대로 옮기는 게 핵심 용도.
const ExcelJS = require("exceljs");

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/\*\*([^*]+)\*\*/g, "$1"));
}

function isTableSeparator(line) {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
}

function stripInlineMarkdown(text) {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1");
}

/**
 * markdown을 순서대로 훑으며 표/제목/문단 블록으로 나눈다.
 * @returns {Array<{type:"table", rows:string[][]} | {type:"heading", level:number, text:string} | {type:"text", text:string}>}
 */
function markdownToBlocks(markdown = "") {
  const lines = String(markdown || "").split(/\r?\n/);
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    if (
      trimmed.startsWith("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const tableRows = [splitTableRow(trimmed)];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableRows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", rows: tableRows });
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        text: stripInlineMarkdown(heading[2]),
      });
      i++;
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      blocks.push({
        type: "text",
        text: `• ${stripInlineMarkdown(bullet[1])}`,
      });
      i++;
      continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      blocks.push({ type: "text", text: stripInlineMarkdown(numbered[1]) });
      i++;
      continue;
    }

    blocks.push({ type: "text", text: stripInlineMarkdown(trimmed) });
    i++;
  }

  return blocks;
}

const HEADING_FONT_SIZE = { 1: 16, 2: 14, 3: 12, 4: 11 };

/**
 * 임의의 JSON(통계 계산 결과 등)을 시트 행으로 펼친다 — 스칼라는 "항목 | 값",
 * 객체 배열은 헤더가 있는 표, 중첩 객체는 "a.b.c" 경로 키로 평탄화.
 * @returns {Array<Array<string|number|boolean|null>>}
 */
function jsonToRows(data) {
  const rows = [];
  const isScalar = (v) => v === null || typeof v !== "object";
  const walk = (value, path) => {
    if (isScalar(value)) {
      rows.push([path || "값", value]);
    } else if (Array.isArray(value)) {
      if (!value.length) return;
      if (value.every(isScalar)) {
        rows.push([path || "값", ...value]);
      } else if (value.every((v) => v && !Array.isArray(v) && isScalar(v) === false)) {
        const headers = [...new Set(value.flatMap((v) => Object.keys(v)))];
        if (path) rows.push([path]);
        rows.push(headers);
        value.forEach((v) =>
          rows.push(
            headers.map((h) =>
              isScalar(v[h]) ? v[h] : JSON.stringify(v[h])
            )
          )
        );
        rows.push([]);
      } else {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
      }
    } else {
      for (const [k, v] of Object.entries(value))
        walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(data, "");
  return rows;
}

function addExtraSheet(workbook, { name = "추가", rows, json }) {
  const sheet = workbook.addWorksheet(String(name).slice(0, 31));
  const data = Array.isArray(rows) ? rows : jsonToRows(json);
  data.forEach((cells, r) =>
    cells.forEach((value, c) => {
      const cell = sheet.getCell(r + 1, c + 1);
      cell.value = value ?? "";
      if (r === 0) cell.font = { bold: true };
    })
  );
  sheet.columns.forEach((col) => {
    col.width = 24;
  });
}

/**
 * @param {{title:string, markdown:string, extraSheets?:Array<{name:string, rows?:any[][], json?:any}>}} params
 * @returns {Promise<Buffer>}
 */
async function markdownToXlsx({ title = "문서", markdown = "", extraSheets = [] }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("결과", {
    views: [{ state: "frozen", ySplit: 0 }],
  });

  let row = 1;
  const titleCell = sheet.getCell(row, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, size: 18 };
  row += 2;

  // 시트당 필터(autoFilter)는 한 범위만 걸 수 있어, 가장 큰 표(대개 핵심
  // 결과 표 — 자료 추출하기의 "문서 × 필드" 표 등)에만 적용한다.
  let largestTableFilter = null;

  for (const block of markdownToBlocks(markdown)) {
    if (block.type === "heading") {
      const cell = sheet.getCell(row, 1);
      cell.value = block.text;
      cell.font = { bold: true, size: HEADING_FONT_SIZE[block.level] || 11 };
      row += 1;
      continue;
    }

    if (block.type === "text") {
      sheet.getCell(row, 1).value = block.text;
      row += 1;
      continue;
    }

    if (block.type === "table") {
      const colCount = Math.max(...block.rows.map((r) => r.length));
      const startRow = row;
      block.rows.forEach((cells, rowIndex) => {
        cells.forEach((value, colIndex) => {
          const cell = sheet.getCell(startRow + rowIndex, colIndex + 1);
          const trimmedValue = String(value ?? "").trim();
          const asNumber = Number(trimmedValue.replace(/,/g, ""));
          const isNumeric =
            trimmedValue !== "" &&
            !Number.isNaN(asNumber) &&
            /^-?[\d,]+(\.\d+)?%?$/.test(trimmedValue);
          cell.value = isNumeric ? asNumber : value;
          if (rowIndex === 0) {
            cell.font = { bold: true };
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FFE8EEFB" },
            };
          }
        });
      });
      if (
        block.rows.length > 1 &&
        colCount > 0 &&
        (!largestTableFilter || block.rows.length > largestTableFilter.size)
      ) {
        largestTableFilter = {
          size: block.rows.length,
          from: { row: startRow, column: 1 },
          to: { row: startRow + block.rows.length - 1, column: colCount },
        };
      }
      row = startRow + block.rows.length + 1;
      continue;
    }
  }

  // 헤더 행에 필터를 걸어 엑셀에서 바로 정렬·필터할 수 있게 한다.
  if (largestTableFilter) {
    sheet.autoFilter = {
      from: largestTableFilter.from,
      to: {
        row: largestTableFilter.from.row,
        column: largestTableFilter.to.column,
      },
    };
  }

  sheet.columns.forEach((col) => {
    col.width = 22;
  });

  for (const extra of Array.isArray(extraSheets) ? extraSheets : []) {
    if (extra && (extra.rows || extra.json !== undefined))
      addExtraSheet(workbook, extra);
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = { markdownToXlsx, markdownToBlocks, jsonToRows };
