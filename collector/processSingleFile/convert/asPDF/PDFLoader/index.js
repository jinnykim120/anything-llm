const fs = require("fs").promises;

// [auto-docu P1a] pdf.js gives every text run a position (transform + width/height).
// Upstream throws that away and only keeps item.str. We keep it so downstream can
// carry per-chunk page numbers and bounding boxes (goal 2: citation -> highlight in
// the original). bbox convention below is PDF points, TOP-LEFT origin, matching PDF
// viewers and Docling's BoundingBox — so P1b (Docling) can fill the same shape later.
const LINE_Y_TOLERANCE = 2; // points; items within this Y delta are the same line

class PDFLoader {
  constructor(filePath, { splitPages = true } = {}) {
    this.filePath = filePath;
    this.splitPages = splitPages;
  }

  async load() {
    const buffer = await fs.readFile(this.filePath);
    const { getDocument, version } = await this.getPdfJS();

    const pdf = await getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;

    const meta = await pdf.getMetadata().catch(() => null);
    const documents = [];

    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();

      if (content.items.length === 0) {
        continue;
      }

      // pdf.js API drifted: newer takes {scale}, the bundled v1.10.100 takes a
      // positional scale. Fall back to the MediaBox (page.view) either way.
      let pageWidth = 0;
      let pageHeight = 0;
      try {
        const vp =
          page.getViewport?.({ scale: 1.0 }) || page.getViewport?.(1.0) || null;
        pageWidth = Number(vp?.width) || 0;
        pageHeight = Number(vp?.height) || 0;
      } catch {
        /* try view next */
      }
      if (!pageHeight && Array.isArray(page.view) && page.view.length === 4) {
        pageWidth = Math.abs(page.view[2] - page.view[0]);
        pageHeight = Math.abs(page.view[3] - page.view[1]);
      }

      const { text, lines } = this.#extractPage(content.items, pageHeight);

      documents.push({
        pageContent: text.trim(),
        lines, // [{ text, bbox: [x0, y0, x1, y1] }]  top-left origin, PDF points
        pageWidth,
        pageHeight,
        metadata: {
          source: this.filePath,
          pdf: {
            version,
            info: meta?.info,
            metadata: meta?.metadata,
            totalPages: pdf.numPages,
          },
          loc: { pageNumber: i },
        },
      });
    }

    if (this.splitPages) {
      return documents;
    }

    if (documents.length === 0) {
      return [];
    }

    return [
      {
        pageContent: documents.map((doc) => doc.pageContent).join("\n\n"),
        metadata: {
          source: this.filePath,
          pdf: {
            version,
            info: meta?.info,
            metadata: meta?.metadata,
            totalPages: pdf.numPages,
          },
        },
      },
    ];
  }

  /**
   * Group a page's text items into lines, preserving the joined-text behavior
   * upstream relied on and additionally emitting a bbox per line.
   * @param {Array} items pdf.js text content items
   * @param {number} pageHeight for flipping Y to a top-left origin
   */
  #extractPage(items, pageHeight) {
    /** @type {{ yBaseline: number, parts: {str:string,x0:number,x1:number,yTop:number,yBot:number}[] }[]} */
    const rows = [];
    for (const item of items) {
      if (!("str" in item)) continue;
      const x = item.transform?.[4] ?? 0;
      const yBaseline = item.transform?.[5] ?? 0;
      const h = item.height ?? Math.abs(item.transform?.[3] ?? 0) ?? 0;
      const w = item.width ?? 0;
      const part = {
        str: item.str,
        x0: x,
        x1: x + w,
        // flip to top-left origin
        yTop: pageHeight ? pageHeight - (yBaseline + h) : yBaseline,
        yBot: pageHeight ? pageHeight - yBaseline : yBaseline + h,
      };
      const row = rows.find(
        (r) => Math.abs(r.yBaseline - yBaseline) <= LINE_Y_TOLERANCE
      );
      if (row) row.parts.push(part);
      else rows.push({ yBaseline, parts: [part] });
    }

    // reading order: top of page first (smaller yTop), then left-to-right
    rows.sort((a, b) => b.yBaseline - a.yBaseline);
    const lines = [];
    const textChunks = [];
    for (const row of rows) {
      row.parts.sort((a, b) => a.x0 - b.x0);
      const lineText = row.parts
        .map((p) => p.str)
        .join("")
        .trim();
      if (!lineText) continue;
      const bbox = [
        Math.min(...row.parts.map((p) => p.x0)),
        Math.min(...row.parts.map((p) => p.yTop)),
        Math.max(...row.parts.map((p) => p.x1)),
        Math.max(...row.parts.map((p) => p.yBot)),
      ].map((n) => Math.round(n * 100) / 100);
      lines.push({ text: lineText, bbox });
      textChunks.push(lineText);
    }
    return { text: textChunks.join("\n"), lines };
  }

  async getPdfJS() {
    try {
      const pdfjs = await import("pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js");
      return { getDocument: pdfjs.getDocument, version: pdfjs.version };
    } catch (e) {
      console.error(e);
      throw new Error(
        "Failed to load pdf-parse. Please install it with eg. `npm install pdf-parse`."
      );
    }
  }
}

module.exports = PDFLoader;
