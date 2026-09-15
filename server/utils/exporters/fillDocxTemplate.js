// [auto-docu 빈양식 채우기 2단계] 원본 .docx 서식에 그대로 값을 써서
// 내려주는 기능 — 1단계(구조화된 콘텐츠만 HTML로)의 후속.
//
// 접근 방식: word/document.xml을 파싱해서 절대 있는 XML을 고치지 않고,
// 각 필드의 라벨 문단을 찾아 그 "바로 뒤에 새 문단을 추가"만 한다 — 기존
// 런(run)/서식을 쪼개거나 바꾸지 않으므로 원본 서식이 깨질 위험이 훨씬
// 적다. HWP는 쓰기 라이브러리가 이 프로젝트에 전혀 없어 지원하지 않는다
// (읽기만 가능) — 이 모듈은 DOCX 전용이다.
const JSZip = require("jszip");
const fs = require("fs");

function escapeXml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function plainText(paragraphXml) {
  return [...paragraphXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
    .map((m) => m[1])
    .join("");
}

/** 채워 넣을 내용을 새 <w:p> 문단으로 — 줄바꿈은 <w:br/>로 처리한다. */
function makeFilledParagraph(text) {
  const lines = String(text || "").split(/\r?\n/);
  const runXml = lines
    .map(
      (line, i) =>
        (i > 0 ? "<w:br/>" : "") +
        `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`
    )
    .join("");
  return `<w:p><w:r>${runXml}</w:r></w:p>`;
}

/**
 * @param {Buffer} originalBuffer 원본 .docx 파일 바이트
 * @param {{title:string, priorContent?:string, content:string}[]} sections
 * @returns {Promise<{buffer:Buffer, inserted:number, total:number}>}
 */
async function fillDocxTemplate({ originalBuffer, sections = [] }) {
  const zip = await JSZip.loadAsync(originalBuffer);
  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) throw new Error("유효한 DOCX 파일이 아닙니다.");
  let xml = await docXmlFile.async("string");

  const paragraphs = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
  const paraTexts = paragraphs.map(plainText);

  let inserted = 0;
  for (const section of sections) {
    if (!section?.content) continue;
    // priorContent(작년 절 그대로 잘라낸 원문)가 있으면 그 시작 부분이 더
    // 정확한 앵커 — 없으면(빈양식은 대개 없음) 절 제목으로 찾는다.
    const anchorCandidates = [
      section.priorContent ? section.priorContent.slice(0, 20).trim() : null,
      String(section.title || "").trim(),
    ].filter(Boolean);

    const paraIndex = paraTexts.findIndex((text) =>
      anchorCandidates.some((anchor) => anchor && text.includes(anchor))
    );
    if (paraIndex === -1) continue;

    const original = paragraphs[paraIndex];
    const filled = original + makeFilledParagraph(section.content);
    xml = xml.replace(original, filled);
    // 같은 라벨이 문서에 두 번 나오는 걸 방지 — 이미 쓴 자리는 다시 안 씀.
    paragraphs[paraIndex] = filled;
    paraTexts[paraIndex] = "";
    inserted++;
  }

  zip.file("word/document.xml", xml);
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return { buffer, inserted, total: sections.length };
}

async function fillDocxTemplateFromPath({ originalFilePath, sections = [] }) {
  const originalBuffer = fs.readFileSync(originalFilePath);
  return fillDocxTemplate({ originalBuffer, sections });
}

module.exports = { fillDocxTemplate, fillDocxTemplateFromPath };
