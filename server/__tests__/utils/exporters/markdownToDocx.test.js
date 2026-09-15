const { markdownToDocx, markdownToBlocks } = require("../../../utils/exporters/markdownToDocx");
const { Paragraph, Table } = require("docx");

/** markdown 블록을 실제 .docx로 패키징해서, 그 안의 word/document.xml에
 * 텍스트가 살아있는지 확인한다 — docx 라이브러리 내부 구조에 의존하지 않고
 * "실제로 열어보면 이 글자가 있는가"를 검증하는 방식. */
async function renderedXmlContains(markdown, needle) {
  const buf = await markdownToDocx({ title: "t", markdown });
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("word/document.xml").async("string");
  return xml.includes(needle);
}

describe("markdownToBlocks", () => {
  it("converts headings (# through ####) to Paragraph blocks", () => {
    const blocks = markdownToBlocks("# 제목1\n## 제목2\n### 제목3\n#### 제목4");
    expect(blocks).toHaveLength(4);
    expect(blocks.every((b) => b instanceof Paragraph)).toBe(true);
  });

  it("converts a bullet list to one Paragraph per item", () => {
    const blocks = markdownToBlocks("- 항목1\n- 항목2\n* 항목3");
    expect(blocks).toHaveLength(3);
  });

  it("parses a table into exactly one Table block", () => {
    const blocks = markdownToBlocks("| 구분 | 값 |\n| --- | --- |\n| A | 1 |");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBeInstanceOf(Table);
  });

  // [auto-docu 회귀 테스트] 표 헤더 행의 텍스트가 굵게 처리하려다 통째로
  // 사라졌던 실제 버그 — TextRun을 만들고 그 결과의 .text를 다시 읽어
  // 재조립하려 한 게 원인이었다(TextRun엔 그런 public 필드가 없음).
  it("keeps a table's header-row text when rendered (regression: bold rewrite used to drop it)", async () => {
    const md = "| 구분 | 값 |\n| --- | --- |\n| A | 1 |";
    expect(await renderedXmlContains(md, "구분")).toBe(true);
    expect(await renderedXmlContains(md, "값")).toBe(true);
  });

  it("does not misdetect a plain paragraph containing '|' as a table (no separator line follows)", () => {
    const blocks = markdownToBlocks("A | B는 표가 아니라 그냥 문장입니다.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBeInstanceOf(Paragraph);
  });

  it("skips blank lines", () => {
    const blocks = markdownToBlocks("문단1\n\n\n문단2");
    expect(blocks).toHaveLength(2);
  });
});

describe("markdownToDocx", () => {
  it("produces a valid zip (docx) buffer starting with the PK signature", async () => {
    const buf = await markdownToDocx({
      title: "테스트",
      markdown: "# 제목\n\n내용입니다.",
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 2).toString()).toBe("PK");
  });

  it("does not throw on empty markdown", async () => {
    const buf = await markdownToDocx({ title: "빈 문서", markdown: "" });
    expect(buf.length).toBeGreaterThan(0);
  });
});
