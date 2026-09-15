// [auto-docu 다른 파일 형태 다운로드] 초안(§06)/전사문서작성tool(§07) 결과의
// markdown을 실제 .docx 바이너리로 변환한다. LLM이 쓰는 markdown은 형태가
// 대체로 일정하다(제목/부제목 + 문단 + 목록 + 표 + **강조**) — 범용 markdown
// 파서가 아니라 이 프로젝트가 실제로 만들어내는 형태만 다루는 가벼운 변환기.
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
} = require("docx");

/** "**굵게**"를 굵은 TextRun으로, 나머지는 평문 TextRun으로 쪼갠다.
 * forceBold(표 헤더 행 등)면 굵게가 아닌 조각도 전부 굵게 만든다. */
function inlineRuns(text, forceBold = false) {
  const runs = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last)
      runs.push(
        new TextRun({ text: text.slice(last, m.index), bold: forceBold })
      );
    runs.push(new TextRun({ text: m[1], bold: true }));
    last = m.index + m[0].length;
  }
  if (last < text.length)
    runs.push(new TextRun({ text: text.slice(last), bold: forceBold }));
  return runs.length ? runs : [new TextRun({ text, bold: forceBold })];
}

/** "| a | b |" 형태의 표 줄을 셀 문자열 배열로. */
function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
}

function tableToDocx(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (cells, rowIndex) =>
        new TableRow({
          children: cells.map(
            (cell) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: inlineRuns(cell, rowIndex === 0),
                  }),
                ],
              })
          ),
        })
    ),
  });
}

/**
 * @param {string} markdown
 * @returns {(Paragraph|Table)[]}
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

    // 표: "|"로 시작하는 줄 + 그 다음 구분줄(---)이 이어지면 표로 간주.
    if (
      trimmed.startsWith("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const tableRows = [splitTableRow(trimmed)];
      i += 2; // 헤더 + 구분줄
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableRows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push(tableToDocx(tableRows));
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
      ][heading[1].length - 1];
      blocks.push(
        new Paragraph({ heading: level, children: inlineRuns(heading[2]) })
      );
      i++;
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      blocks.push(
        new Paragraph({
          bullet: { level: 0 },
          children: inlineRuns(bullet[1]),
        })
      );
      i++;
      continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      blocks.push(
        new Paragraph({
          children: inlineRuns(numbered[1]),
        })
      );
      i++;
      continue;
    }

    blocks.push(
      new Paragraph({ spacing: { after: 120 }, children: inlineRuns(trimmed) })
    );
    i++;
  }

  return blocks;
}

/**
 * @param {{title:string, markdown:string}} params
 * @returns {Promise<Buffer>}
 */
async function markdownToDocx({ title = "문서", markdown = "" }) {
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, text: title }),
          new Paragraph({ text: "" }),
          ...markdownToBlocks(markdown),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

module.exports = { markdownToDocx, markdownToBlocks };
