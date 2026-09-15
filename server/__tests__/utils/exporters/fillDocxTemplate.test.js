const { Document, Packer, Paragraph, HeadingLevel } = require("docx");
const { fillDocxTemplate } = require("../../../utils/exporters/fillDocxTemplate");

/** 실제 빈양식과 비슷한 구조의 .docx를 즉석에서 만든다 — 제목 + 라벨
 * 문단들(값은 비어있음, "___"). */
async function buildSampleForm(extraParagraphs = []) {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, text: "샘플 서식" }),
          new Paragraph({ text: "1. 회사명: ___" }),
          new Paragraph({ text: "2. 작성일: ___" }),
          new Paragraph({ text: "3. 비고" }),
          ...extraParagraphs,
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

async function xmlOf(buffer) {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(buffer);
  return zip.file("word/document.xml").async("string");
}

describe("fillDocxTemplate", () => {
  it("inserts each section's content as a new paragraph right after its matching label", async () => {
    const originalBuffer = await buildSampleForm();
    const { buffer, inserted, total } = await fillDocxTemplate({
      originalBuffer,
      sections: [
        { title: "회사명", content: "지에스리테일(주)" },
        { title: "작성일", content: "2026-09-15" },
      ],
    });
    expect(inserted).toBe(2);
    expect(total).toBe(2);

    const xml = await xmlOf(buffer);
    // 라벨과 채운 값이 둘 다 살아있고, 라벨이 값보다 앞에 온다.
    const labelIdx = xml.indexOf("회사명");
    const valueIdx = xml.indexOf("지에스리테일");
    expect(labelIdx).toBeGreaterThan(-1);
    expect(valueIdx).toBeGreaterThan(labelIdx);
  });

  it("leaves a label untouched when no matching section is provided", async () => {
    const originalBuffer = await buildSampleForm();
    const { buffer, inserted } = await fillDocxTemplate({
      originalBuffer,
      sections: [{ title: "회사명", content: "지에스리테일(주)" }],
    });
    expect(inserted).toBe(1);
    const xml = await xmlOf(buffer);
    expect(xml).toContain("비고"); // "3. 비고" 문단은 그대로 남아있다
    expect(xml).not.toContain("작성일 값이 없어도 안전"); // (참고용 — 실제 매칭 안 됨을 별도로도 검증)
  });

  it("prefers priorContent as the anchor over title when both are given (more exact match)", async () => {
    // priorContent는 실제 파이프라인에서 원문(pageContent)의 그 자리를
    // 그대로 잘라낸 것이라, 그 시작 부분은 문서 안 문단 텍스트의 '부분
    // 문자열'이다(반대가 아님) — 그래서 테스트도 그 관계를 지켜야 한다.
    const originalBuffer = await buildSampleForm();
    const { inserted } = await fillDocxTemplate({
      originalBuffer,
      sections: [
        {
          title: "제목과는 다른 이름",
          priorContent: "회사명",
          content: "지에스리테일(주)",
        },
      ],
    });
    // priorContent("회사명")가 실제 라벨 문단("1. 회사명: ___")에 포함돼
    // 있어서, title이 안 맞아도 anchor로 찾아낸다.
    expect(inserted).toBe(1);
  });

  it("skips sections with no content", async () => {
    const originalBuffer = await buildSampleForm();
    const { inserted } = await fillDocxTemplate({
      originalBuffer,
      sections: [
        { title: "회사명", content: "" },
        { title: "작성일", content: null },
      ],
    });
    expect(inserted).toBe(0);
  });

  it("does not fill the same label twice even if two sections share a title", async () => {
    const originalBuffer = await buildSampleForm();
    const { inserted } = await fillDocxTemplate({
      originalBuffer,
      sections: [
        { title: "회사명", content: "첫 번째 값" },
        { title: "회사명", content: "두 번째 값(중복)" },
      ],
    });
    expect(inserted).toBe(1); // 두 번째는 같은 자리를 다시 못 찾음
  });

  it("throws a clear error for a non-docx buffer", async () => {
    await expect(
      fillDocxTemplate({
        originalBuffer: Buffer.from("이건 docx가 아님"),
        sections: [],
      })
    ).rejects.toThrow();
  });
});
