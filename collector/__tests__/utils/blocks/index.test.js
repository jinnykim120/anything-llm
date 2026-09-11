// [auto-docu markdown-ingestion] blocksToText() now renders GFM markdown
// (headings, table separators, normalized bullets) instead of flat text.
// See memory: markdown-ingestion-plan.
const { blocksToText } = require("../../../utils/blocks");

function block(overrides = {}) {
  return {
    text: "",
    page: null,
    bbox: null,
    page_width: 0,
    page_height: 0,
    section_path: null,
    block_type: "paragraph",
    ...overrides,
  };
}

describe("blocksToText — markdown rendering", () => {
  it("prefixes a heading with '#' x its own section_path depth", () => {
    const blocks = [
      block({
        block_type: "heading",
        text: "제1장 총칙",
        section_path: "제1장 총칙",
      }),
      block({
        block_type: "heading",
        text: "제3조 (효력)",
        section_path: "제1장 총칙 > 제3조 (효력)",
      }),
      block({ text: "본문 내용입니다.", section_path: "제1장 총칙 > 제3조 (효력)" }),
    ];
    expect(blocksToText(blocks)).toBe(
      "# 제1장 총칙\n\n## 제3조 (효력)\n\n본문 내용입니다."
    );
  });

  it("falls back to a single '#' when a heading has no section_path", () => {
    const blocks = [block({ block_type: "heading", text: "제목", section_path: null })];
    expect(blocksToText(blocks)).toBe("# 제목");
  });

  it("clamps heading depth to 6 for a very deep section_path", () => {
    const deep = Array.from({ length: 9 }, (_, i) => `레벨${i}`).join(" > ");
    const blocks = [block({ block_type: "heading", text: "깊은 제목", section_path: deep })];
    expect(blocksToText(blocks)).toBe("###### 깊은 제목");
  });

  it("leaves an already-GFM table (xlsx) untouched", () => {
    const table = "a | b\n--- | ---\n1 | 2";
    const blocks = [block({ block_type: "table", text: table })];
    expect(blocksToText(blocks)).toBe(table);
  });

  it("inserts a header separator row into a plain pipe table (docx/hwp)", () => {
    const blocks = [
      block({ block_type: "table", text: "이름 | 값\n사과 | 1\n바나나 | 2" }),
    ];
    expect(blocksToText(blocks)).toBe(
      "이름 | 값\n--- | ---\n사과 | 1\n바나나 | 2"
    );
  });

  it("normalizes a unicode-bullet list paragraph to markdown '-' bullets", () => {
    const blocks = [block({ text: "• 첫째\n• 둘째\n• 셋째" })];
    expect(blocksToText(blocks)).toBe("- 첫째\n- 둘째\n- 셋째");
  });

  it("leaves a plain paragraph with no bullets/heading/table untouched", () => {
    const blocks = [block({ text: "평범한 문단입니다." })];
    expect(blocksToText(blocks)).toBe("평범한 문단입니다.");
  });

  it("joins multiple blocks with a blank line, same as before", () => {
    const blocks = [block({ text: "첫 문단" }), block({ text: "둘째 문단" })];
    expect(blocksToText(blocks)).toBe("첫 문단\n\n둘째 문단");
  });

  it("drops blocks with empty/falsy text", () => {
    const blocks = [block({ text: "" }), block({ text: "내용" })];
    expect(blocksToText(blocks)).toBe("내용");
  });
});
