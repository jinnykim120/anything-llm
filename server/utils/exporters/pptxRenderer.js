// [auto-docu PPT 생성] 슬라이드 스펙(JSON)을 실제 .pptx 바이너리로 렌더링한다.
// AIbitat 에이전트 전용으로 만들어졌던 기존 PPTX 엔진
// (server/utils/agents/aibitat/plugins/create-files/pptx/*)의 렌더링 로직을
// 그대로 재사용하되, 에이전트/웹서치 없이 일반 REST 엔드포인트에서 바로 호출
//할 수 있게 뽑아낸 버전이다. 기존 파일들은 건드리지 않는다(원래의 범용
// "@agent PPT 만들어줘" 기능이 계속 동작해야 한다).
//
//   slideSpec = {
//     title, author?, theme?: "default"|"corporate"|"dark"|"minimal"|"creative",
//     slides: [
//       { layout: "title"|"section"|"content"|"blank",
//         title?, subtitle?,
//         content?: string[],                          // 불릿 — content/table/chart 중 하나만
//         table?: {headers, rows},
//         chart?: { type: "bar"|"line"|"pie", categories: string[],
//                    series: [{name, values: number[]}] },
//         notes? }
//     ]
//   }
const PptxGenJS = require("pptxgenjs");
const createFilesLib = require("../agents/aibitat/plugins/create-files/lib.js");
const {
  getTheme,
} = require("../agents/aibitat/plugins/create-files/pptx/themes.js");
const {
  renderTitleSlide,
  renderSectionSlide,
  renderBlankSlide,
} = require("../agents/aibitat/plugins/create-files/pptx/utils.js");
const { renderRichSlide } = require("./pptxLayouts");

/**
 * @param {{title:string, author?:string, theme?:string, slides:Array}} slideSpec
 * @returns {Promise<Buffer>}
 */
async function renderPptx(slideSpec) {
  const title = createFilesLib.stripInvalidXmlChars(
    slideSpec?.title || "Untitled"
  );
  const author = createFilesLib.stripInvalidXmlChars(slideSpec?.author || "");
  const theme = getTheme(slideSpec?.theme || "corporate");
  const slides = createFilesLib.stripInvalidXmlChars(
    Array.isArray(slideSpec?.slides) ? slideSpec.slides : []
  );

  const pptx = new PptxGenJS();
  pptx.title = title;
  if (author) pptx.author = author;
  pptx.company = "NEXUS";

  const totalSlideCount = slides.length;

  // 표지(타이틀) 슬라이드는 항상 첫 장으로 별도 생성 — 에이전트 버전과 동일한 동작.
  const titleSlide = pptx.addSlide();
  renderTitleSlide(titleSlide, pptx, { title, author }, theme, {
    branding: false,
  });

  slides.forEach((slideData, index) => {
    const slide = pptx.addSlide();
    const slideNumber = index + 1;
    const layout = slideData.layout || "content";

    switch (layout) {
      case "title":
      case "section":
        renderSectionSlide(
          slide,
          pptx,
          slideData,
          theme,
          slideNumber,
          totalSlideCount,
          { branding: false }
        );
        break;
      case "blank":
        renderBlankSlide(slide, pptx, theme, slideNumber, totalSlideCount, {
          branding: false,
        });
        break;
      default:
        // content/content2/stat/compare/timeline/quote/agenda — 글자 크기를
        // 내용에 맞춰 조절하는 자체 렌더러(pptxLayouts.js)가 담당한다.
        renderRichSlide(
          slide,
          pptx,
          slideData,
          theme,
          slideNumber,
          totalSlideCount
        );
        break;
    }
  });

  return await pptx.write({ outputType: "nodebuffer" });
}

module.exports = { renderPptx };
