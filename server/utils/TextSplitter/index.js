/**
 * @typedef {object} DocumentMetadata
 * @property {string} id - eg; "123e4567-e89b-12d3-a456-426614174000"
 * @property {string} url - eg; "file://example.com/index.html"
 * @property {string} title - eg; "example.com/index.html"
 * @property {string} docAuthor - eg; "no author found"
 * @property {string} description - eg; "No description found."
 * @property {string} docSource - eg; "URL link uploaded by the user."
 * @property {string} chunkSource - eg; link://https://example.com
 * @property {string} published - ISO 8601 date string
 * @property {number} wordCount - Number of words in the document
 * @property {string} pageContent - The raw text content of the document
 * @property {number} token_count_estimate - Number of tokens in the document
 */

function isNullOrNaN(value) {
  if (value === null) return true;
  return isNaN(value);
}

class TextSplitter {
  #splitter;

  /**
   * Creates a new TextSplitter instance.
   * @param {Object} config
   * @param {string} [config.chunkPrefix = ""] - Prefix to be added to the start of each chunk.
   * @param {number} [config.chunkSize = 1000] - The size of each chunk.
   * @param {number} [config.chunkOverlap = 20] - The overlap between chunks.
   * @param {Object} [config.chunkHeaderMeta = null] - Metadata to be added to the start of each chunk - will come after the prefix.
   */
  constructor(config = {}) {
    this.config = config;
    this.#splitter = this.#setSplitter(config);
  }

  log(text, ...args) {
    console.log(`\x1b[35m[TextSplitter]\x1b[0m ${text}`, ...args);
  }

  /**
   *  Does a quick check to determine the text chunk length limit.
   * Embedder models have hard-set limits that cannot be exceeded, just like an LLM context
   * so here we want to allow override of the default 1000, but up to the models maximum, which is
   * sometimes user defined.
   */
  static determineMaxChunkSize(preferred = null, embedderLimit = 1000) {
    const prefValue = isNullOrNaN(preferred)
      ? Number(embedderLimit)
      : Number(preferred);
    const limit = Number(embedderLimit);
    if (prefValue > limit)
      console.log(
        `\x1b[43m[WARN]\x1b[0m Text splitter chunk length of ${prefValue} exceeds embedder model max of ${embedderLimit}. Will use ${embedderLimit}.`
      );
    return prefValue > limit ? limit : prefValue;
  }

  /**
   *  Creates a string of metadata to be prepended to each chunk.
   * @param {DocumentMetadata} metadata - Metadata to be prepended to each chunk.
   * @returns {{[key: ('title' | 'published' | 'source')]: string}} Object of metadata that will be prepended to each chunk.
   */
  static buildHeaderMeta(metadata = {}) {
    if (!metadata || Object.keys(metadata).length === 0) return null;
    const PLUCK_MAP = {
      title: {
        as: "sourceDocument",
        pluck: (metadata) => {
          return metadata?.title || null;
        },
      },
      published: {
        as: "published",
        pluck: (metadata) => {
          return metadata?.published || null;
        },
      },
      chunkSource: {
        as: "source",
        pluck: (metadata) => {
          const validPrefixes = ["link://", "youtube://"];
          // If the chunkSource is a link or youtube link, we can add the URL
          // as its source in the metadata so the LLM can use it for context.
          // eg prompt: Where did you get this information? -> answer: "from https://example.com"
          if (
            !metadata?.chunkSource || // Exists
            !metadata?.chunkSource.length || // Is not empty
            typeof metadata.chunkSource !== "string" || // Is a string
            !validPrefixes.some(
              (prefix) => metadata.chunkSource.startsWith(prefix) // Has a valid prefix we respect
            )
          )
            return null;

          // We know a prefix is present, so we can split on it and return the rest.
          // If nothing is found, return null and it will not be added to the metadata.
          let source = null;
          for (const prefix of validPrefixes) {
            source = metadata.chunkSource.split(prefix)?.[1] || null;
            if (source) break;
          }

          return source;
        },
      },
    };

    const pluckedData = {};
    Object.entries(PLUCK_MAP).forEach(([key, value]) => {
      if (!(key in metadata)) return; // Skip if the metadata key is not present.
      const pluckedValue = value.pluck(metadata);
      if (!pluckedValue) return; // Skip if the plucked value is null/empty.
      pluckedData[value.as] = pluckedValue;
    });

    return pluckedData;
  }

  /**
   * Apply the chunk prefix to the text if it is present.
   * @param {string} text - The text to apply the prefix to.
   * @returns {string} The text with the embedder model prefix applied.
   */
  #applyPrefix(text = "") {
    if (!this.config.chunkPrefix) return text;
    return `${this.config.chunkPrefix}${text}`;
  }

  /**
   * Creates a string of metadata to be prepended to each chunk.
   * Will additionally prepend a prefix to the text if it was provided (requirement for some embedders).
   * @returns {string} The text with the embedder model prefix applied.
   */
  stringifyHeader() {
    let content = "";
    if (!this.config.chunkHeaderMeta) return this.#applyPrefix(content);
    Object.entries(this.config.chunkHeaderMeta).map(([key, value]) => {
      if (!key || !value) return;
      content += `${key}: ${value}\n`;
    });

    if (!content) return this.#applyPrefix(content);
    return this.#applyPrefix(
      `<document_metadata>\n${content}</document_metadata>\n\n`
    );
  }

  /**
   * Sets the splitter to use a defined config passes to other subclasses.
   * @param {Object} config
   * @param {string} [config.chunkPrefix = ""] - Prefix to be added to the start of each chunk.
   * @param {number} [config.chunkSize = 1000] - The size of each chunk.
   * @param {number} [config.chunkOverlap = 20] - The overlap between chunks.
   */
  #setSplitter(config = {}) {
    // if (!config?.splitByFilename) {// TODO do something when specific extension is present? }
    return new RecursiveSplitter({
      chunkSize: isNaN(config?.chunkSize) ? 1_000 : Number(config?.chunkSize),
      chunkOverlap: isNaN(config?.chunkOverlap)
        ? 20
        : Number(config?.chunkOverlap),
      chunkHeader: this.stringifyHeader(),
    });
  }

  async splitText(documentText) {
    return this.#splitter._splitText(documentText);
  }

  /**
   * [auto-docu P1a] Block-aware split. When the parsed document carries `blocks`
   * (page/bbox/section-tagged units from pdf.js or Docling), pack consecutive
   * blocks into retrieval-sized chunks WITHOUT splitting across a block, and
   * carry each chunk's location metadata. Falls back to the flat splitText when
   * there are no blocks (other file types not yet upgraded).
   *
   * @param {{pageContent?: string, blocks?: Array<object>}} documentData
   * @returns {Promise<{chunks: string[], metas: object[]}>}
   */
  async splitDocument(documentData = {}) {
    const blocks = Array.isArray(documentData.blocks)
      ? documentData.blocks.filter((b) => b?.text?.trim())
      : [];

    if (!blocks.length) {
      const chunks = await this.splitText(documentData.pageContent || "");
      return { chunks, metas: chunks.map(() => TextSplitter.emptyChunkMeta()) };
    }

    // Block-aware chunks stay paragraph-sized (not filled to the embedder max) so
    // each chunk maps to a tight bbox for citation highlighting and retrieves
    // precisely. Never exceed the configured/embedder limit. Overridable via
    // BLOCK_CHUNK_TARGET_CHARS.
    const configuredMax = isNaN(this.config?.chunkSize)
      ? 1_000
      : Number(this.config.chunkSize);
    const target = Number(process.env.BLOCK_CHUNK_TARGET_CHARS) || 1_200;
    const maxSize = Math.min(configuredMax, Math.max(target, 400));
    const header = this.stringifyHeader();

    // [auto-docu P1a'] Cheap Contextual Retrieval: prepend the chunk's own
    // section path + page to what gets embedded, so a chunk ranks for queries
    // about its section even when the section title isn't in the chunk body.
    // (The LLM-generated version — Anthropic's method — is a later upgrade once a
    // fast LLM is available; the local one is too slow per-chunk at ingest.)
    const contextLine = (meta) => {
      const bits = [];
      if (meta.section_path) bits.push(meta.section_path);
      if (meta.page) bits.push(`p.${meta.page}`);
      return bits.length ? `context: ${bits.join(" — ")}\n\n` : "";
    };

    const out = { chunks: [], metas: [] };
    let buf = [];
    let bufLen = 0;

    const flush = () => {
      if (!buf.length) return;
      const text = buf.map((b) => b.text).join("\n\n");
      const meta = TextSplitter.#chunkMetaFromBlocks(buf);
      meta.chunk_index = out.metas.length;
      out.chunks.push(`${header}${contextLine(meta)}${text}`);
      out.metas.push(meta);
      buf = [];
      bufLen = 0;
    };

    for (const block of blocks) {
      const blockText = block.text.trim();
      // A single oversized block: split it, each piece keeps this block's meta.
      if (blockText.length > maxSize) {
        flush();
        const baseMeta = TextSplitter.#chunkMetaFromBlocks([block]);
        // [auto-docu] A split of a big table would leave every piece after the
        // first with rows but no column names. Repeat the header row on each.
        const tableHeader =
          block.block_type === "table"
            ? TextSplitter.#tableHeaderLine(blockText)
            : "";
        const pieces = await this.#splitter.rawSplit(blockText);
        for (const [pi, piece] of pieces.entries()) {
          const meta = { ...baseMeta, chunk_index: out.metas.length };
          const body =
            tableHeader && pi > 0 && !piece.startsWith(tableHeader)
              ? `${tableHeader}\n${piece}`
              : piece;
          out.chunks.push(`${header}${contextLine(meta)}${body}`);
          out.metas.push(meta);
        }
        continue;
      }
      // Keep a chunk on a single page so its bbox is unambiguous.
      const crossesPage =
        buf.length &&
        block.page != null &&
        buf[buf.length - 1].page != null &&
        block.page !== buf[buf.length - 1].page;
      // [auto-docu] Start a fresh chunk at each section/article heading so a
      // chunk maps to one 조/절/outline node — tighter citations and a tighter
      // highlight. The bufLen gate lets a bare chapter/section heading fold into
      // the first article beneath it instead of becoming its own stub chunk.
      const startsSection =
        bufLen > 40 &&
        block.block_type === "heading" &&
        (block.section_path || "") !== (buf[0].section_path || "");
      if (crossesPage || startsSection || bufLen + blockText.length > maxSize)
        flush();
      buf.push(block);
      bufLen += blockText.length + 2;
    }
    flush();
    return out;
  }

  /**
   * The chunk-location fields, as STABLE SCALAR TYPES that every chunk carries
   * (0 / "" = unknown). Vector DBs infer a fixed column type from the first row,
   * and a workspace mixes doc types (PDF with bbox, txt without) — so the shape
   * must be identical for every chunk regardless of parser. `bbox` is a JSON
   * string so the column is always a string; the frontend JSON.parses it.
   *
   * `bbox` holds a JSON array of per-region rects — `[[x0,y0,x1,y1], ...]` — on
   * the chunk's first page. Usually one rect (the blocks form a single column
   * run); more when there's a vertical gap. The frontend also accepts the legacy
   * single-rect `[x0,y0,x1,y1]` shape.
   */
  static emptyChunkMeta() {
    return {
      page: 0,
      page_end: 0,
      bbox: "",
      anchor: "",
      page_width: 0,
      page_height: 0,
      section_path: "",
      block_type: "",
      // [auto-docu] 0-based position of this chunk within its document, in
      // reading order. Lets whole-section retrieval re-assemble a section's
      // chunks in order without relying on the vector DB's row order.
      chunk_index: 0,
    };
  }

  /**
   * The header of a `|`-joined table block — the first row, plus a markdown
   * separator row if the source had one. "" when it doesn't look like a table.
   */
  static #tableHeaderLine(text = "") {
    const lines = String(text).split("\n");
    if (lines.length < 2 || !lines[0].includes("|")) return "";
    const isSep = /^[\s|:-]+$/.test(lines[1]);
    return isSep ? `${lines[0]}\n${lines[1]}` : lines[0];
  }

  /**
   * Fold a page's block rects into the fewest rects that still bound them
   * tightly: sort top-to-bottom, then merge any rect that starts within a line's
   * gap of the running bottom AND overlaps horizontally. A chunk that stays in
   * one section collapses to a single rect; a vertical gap yields two.
   */
  static #mergeRects(boxes = []) {
    const GAP = 9; // pt — a little more than a line's leading
    const round = (r) => r.map((n) => Math.round(n * 100) / 100);
    const sorted = [...boxes].sort((a, b) => a[1] - b[1]);
    const out = [];
    for (const b of sorted) {
      const cur = out[out.length - 1];
      const overlapX = cur && b[0] < cur[2] && b[2] > cur[0];
      if (cur && overlapX && b[1] <= cur[3] + GAP) {
        cur[0] = Math.min(cur[0], b[0]);
        cur[1] = Math.min(cur[1], b[1]);
        cur[2] = Math.max(cur[2], b[2]);
        cur[3] = Math.max(cur[3], b[3]);
      } else {
        out.push([...b]);
      }
    }
    // A chunk broken into many disjoint pieces (a long section the parser
    // didn't sub-divide) is effectively "this whole region" — collapse it.
    if (out.length > 6)
      return [
        round([
          Math.min(...out.map((r) => r[0])),
          Math.min(...out.map((r) => r[1])),
          Math.max(...out.map((r) => r[2])),
          Math.max(...out.map((r) => r[3])),
        ]),
      ];
    return out.map(round);
  }

  /** Collapse a run of blocks into one chunk's location metadata. */
  static #chunkMetaFromBlocks(blocks = []) {
    const meta = TextSplitter.emptyChunkMeta();
    if (!blocks.length) return meta;
    const firstPage = blocks.find((b) => b.page != null)?.page ?? 0;
    const lastPage =
      [...blocks].reverse().find((b) => b.page != null)?.page ?? firstPage;
    const boxes = blocks
      .filter(
        (b) =>
          Array.isArray(b.bbox) && b.bbox.length === 4 && b.page === firstPage
      )
      .map((b) => b.bbox);
    if (boxes.length) {
      meta.bbox = JSON.stringify(TextSplitter.#mergeRects(boxes));
    }
    const types = [...new Set(blocks.map((b) => b.block_type).filter(Boolean))];
    meta.page = firstPage || 0;
    meta.page_end = lastPage && lastPage !== firstPage ? lastPage : 0;
    meta.anchor = blocks[0].anchor ?? "";
    meta.page_width = blocks[0].page_width || 0;
    meta.page_height = blocks[0].page_height || 0;
    // Deepest path among the chunk's blocks — a child path contains its parent
    // as a prefix, so the longest string is the most specific (handles a chunk
    // that opens with a bare 장 heading then an article body).
    meta.section_path =
      blocks
        .map((b) => b.section_path)
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)[0] ?? "";
    meta.block_type =
      types.length === 1 ? types[0] : types.length ? "mixed" : "";
    return meta;
  }
}

// Wrapper for Langchain default RecursiveCharacterTextSplitter class.
class RecursiveSplitter {
  constructor({ chunkSize, chunkOverlap, chunkHeader = null }) {
    const {
      RecursiveCharacterTextSplitter,
    } = require("@langchain/textsplitters");
    this.log(`Will split with`, {
      chunkSize,
      chunkOverlap,
      chunkHeader: chunkHeader ? `${chunkHeader?.slice(0, 50)}...` : null,
    });
    this.chunkHeader = chunkHeader;
    this.engine = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
    });
  }

  log(text, ...args) {
    console.log(`\x1b[35m[RecursiveSplitter]\x1b[0m ${text}`, ...args);
  }

  async _splitText(documentText) {
    if (!this.chunkHeader) return this.engine.splitText(documentText);
    const strings = await this.engine.splitText(documentText);
    const documents = await this.engine.createDocuments(strings, [], {
      chunkHeader: this.chunkHeader,
    });
    return documents
      .filter((doc) => !!doc.pageContent)
      .map((doc) => doc.pageContent);
  }

  /**
   * [auto-docu P1a] Split raw text with no header applied — the caller (splitDocument)
   * prepends the header itself so it can pair chunks with block metadata.
   */
  async rawSplit(text) {
    return this.engine.splitText(text);
  }
}

module.exports.TextSplitter = TextSplitter;
