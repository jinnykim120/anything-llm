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

    const out = { chunks: [], metas: [] };
    let buf = [];
    let bufLen = 0;

    const flush = () => {
      if (!buf.length) return;
      const text = buf.map((b) => b.text).join("\n\n");
      out.chunks.push(`${header}${text}`);
      out.metas.push(TextSplitter.#chunkMetaFromBlocks(buf));
      buf = [];
      bufLen = 0;
    };

    for (const block of blocks) {
      const blockText = block.text.trim();
      // A single oversized block: split it, each piece keeps this block's meta.
      if (blockText.length > maxSize) {
        flush();
        const pieces = await this.#splitter.rawSplit(blockText);
        for (const piece of pieces) {
          out.chunks.push(`${header}${piece}`);
          out.metas.push(TextSplitter.#chunkMetaFromBlocks([block]));
        }
        continue;
      }
      // Keep a chunk on a single page so its bbox is unambiguous.
      const crossesPage =
        buf.length &&
        block.page != null &&
        buf[buf.length - 1].page != null &&
        block.page !== buf[buf.length - 1].page;
      if (crossesPage || bufLen + blockText.length > maxSize) flush();
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
    };
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
      meta.bbox = JSON.stringify(
        [
          Math.min(...boxes.map((x) => x[0])),
          Math.min(...boxes.map((x) => x[1])),
          Math.max(...boxes.map((x) => x[2])),
          Math.max(...boxes.map((x) => x[3])),
        ].map((n) => Math.round(n * 100) / 100)
      );
    }
    const types = [...new Set(blocks.map((b) => b.block_type).filter(Boolean))];
    meta.page = firstPage || 0;
    meta.page_end = lastPage && lastPage !== firstPage ? lastPage : 0;
    meta.anchor = blocks[0].anchor ?? "";
    meta.page_width = blocks[0].page_width || 0;
    meta.page_height = blocks[0].page_height || 0;
    meta.section_path = blocks.find((b) => b.section_path)?.section_path ?? "";
    meta.block_type = types.length === 1 ? types[0] : types.length ? "mixed" : "";
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
