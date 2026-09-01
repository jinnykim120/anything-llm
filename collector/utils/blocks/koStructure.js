// [auto-docu P1c] Korean government-document structure — shared by every parser
// (Docling PDF/DOCX, the HWP/HWPX converter). Given a list of `blocks`
// (text + block_type), rebuild each block's `section_path`:
//
//   법령 (>=3 real 제N조 bodies)  →  "제N장 … > 제N조(제목)"  hierarchy
//   예규·지침·고시 (I./1./1.1. outline)  →  numeric-depth hierarchy
//   anything else  →  the generic heading stack (length heuristic)
//
// and drop running-footer / annotation noise. bbox/merge stays parser-side.

// --- 법령: 편 > 장 > 절 > 관 > 조 -------------------------------------------
const KO_UNIT_LEVEL = { 편: 1, 장: 2, 절: 3, 관: 4 };
const KO_CONTAINER_RE = /^제\s*\d+\s*(편|장|절|관)(?:\s|의|$)/;
const KO_ARTICLE_RE = /^(제\s*\d+\s*조(?:\s*의\s*\d+)?)\s*\(([^)]{1,80})\)/;
const KO_FOOTER_RE = /^법제처\s+\d+\s+국가법령정보센터$/;
const KO_HEADING_JUNK_RE =
  /^(\[[^\]]*\]|<[^>]*>|\d{4}\s*\.\s*\d+\s*\.\s*\d+\s*\.?\s*>?)$/;

/** Classify a block's leading text as a Korean legal structural marker. */
function koStructOf(rawText) {
  const s = String(rawText || "")
    .replace(/\s+/g, " ")
    .trim();
  const c = s.match(KO_CONTAINER_RE);
  if (c) return { level: KO_UNIT_LEVEL[c[1]], label: s.slice(0, 60).trim() };
  if (/^부칙(\s|<|$)/.test(s)) return { level: 2, label: "부칙" };
  const a = s.match(KO_ARTICLE_RE);
  if (a) {
    const after = s.slice(a[0].length).trim();
    // A run of "제N조(제목) 제M조(제목) …" is a table-of-contents line, not a body.
    if (/^제\s*\d+\s*조(?:\s*의\s*\d+)?\s*\(/.test(after)) return { toc: true };
    return {
      article: true,
      level: 5,
      label: `${a[1].replace(/\s+/g, "")}(${a[2].replace(/\s+/g, " ").trim()})`,
      hasBody: after.length > 0,
    };
  }
  return null;
}

// --- Outline numbering: I. / Ⅱ. / 1. / 1.1. / 1.2.1. ----------------------
const OUTLINE_ROMAN_RE = /^([IVXLC]{1,5}|[Ⅰ-Ⅻ])\.\s+\S/;
const OUTLINE_NUM_RE = /^(\d{1,2}(?:\.\d{1,2}){0,4})\.?\s+\S/;
const OUTLINE_KO_ORD_RE = /^([가-힣])\.\s+\S/; // 가. 나. 다.

/** Heading depth from an outline number, or null if the text isn't one. */
function outlineLevel(rawText) {
  const s = String(rawText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (OUTLINE_ROMAN_RE.test(s)) return 1;
  const n = s.match(OUTLINE_NUM_RE);
  if (n) return 1 + n[1].split(".").length; // "1."→2, "1.1."→3, "1.2.1."→4
  if (OUTLINE_KO_ORD_RE.test(s)) return 6;
  return null;
}

/**
 * [auto-docu] Borrowed from kordoc's `outline`: build a real heading tree for
 * report/award-style HWP where numbering restarts under each division.
 *
 * A numbered/roman heading often trails a rubric list —
 * "1. 경영성과 - 매출증가율 - 영업이익률 등". Keep just the name for the
 * section_path (only when what follows is clearly an enumeration, so a heading
 * that legitimately contains " - " is left alone).
 */
function trimHeadingLabel(rawText) {
  const s = String(rawText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (outlineLevel(s) == null) return s;
  const parts = s.split(/\s+[-–—]\s+/);
  if (parts.length < 2) return s;
  const tail = parts.slice(1).join(" - ");
  const isEnumeration = / [-–—] /.test(tail) || /\s등$/.test(tail);
  return isEnumeration ? parts[0].trim() : s;
}

// "1. 공통심사부문" / "2. 해당응모부문" — a numbered heading that names a
// division, not a section. Everything after it nests one level deeper, and its
// number does not collide with the sections' numbering.
const CONTAINER_TAIL_RE = /(부문|분야|부|편|장|절|관|본부|영역)$/;
function isContainerHeading(rawText) {
  const label = trimHeadingLabel(rawText);
  const m = label.match(/^\d{1,2}\.\s*(.+)$/);
  if (!m) return false;
  const name = m[1].trim();
  return name.length <= 12 && CONTAINER_TAIL_RE.test(name);
}

/**
 * Is this line a section heading? A heading is a SHORT line (headings are
 * titles, not sentences) whose text is a structural marker. The length gate is
 * what keeps a numbered body sentence ("1. 경영성과 — 매출은 …") from being
 * mistaken for the heading "1. 경영성과".
 */
function isHeadingText(rawText, maxLen = 80) {
  const t = String(rawText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > maxLen) return false;
  const k = koStructOf(t);
  if (k && (k.level != null || (k.article && !k.toc))) return true;
  return outlineLevel(t) != null;
}

/**
 * Parsers that emit a flat list of lines (HWP/HWPX, OCR) — fold them into
 * heading-aware `blocks`: a heading line becomes its own block; consecutive
 * body lines accumulate into one paragraph block until the next heading or a
 * blank line. `<표>` / `<그림>` placeholder lines are dropped.
 */
function groupLines(lines = [], mkBlock) {
  const out = [];
  let buf = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text)
      out.push({ ...mkBlock(text, out.length), block_type: "paragraph" });
    buf = [];
  };
  for (const raw of lines) {
    const line = String(raw || "").replace(/\s+$/, "");
    if (!line.trim() || /^\s*<(표|그림|그 림|table|image)>\s*$/i.test(line)) {
      flush();
      continue;
    }
    if (isHeadingText(line)) {
      flush();
      out.push({ ...mkBlock(line.trim(), out.length), block_type: "heading" });
    } else {
      buf.push(line.trim());
    }
  }
  flush();
  return out;
}

/**
 * Safety net for blocks that already exist (e.g. from an XML walker): promote a
 * short structural-marker block to `block_type: "heading"`. In-place.
 */
function markHeadings(blocks = []) {
  for (const b of blocks) {
    if (b.block_type === "heading" || b.block_type === "table") continue;
    if (isHeadingText(b.text)) b.block_type = "heading";
  }
  return blocks;
}

/**
 * Rebuild `section_path` on every block. Mutates blocks and may drop some
 * (running footers, ToC boilerplate); returns the resulting array.
 */
function buildSectionPaths(blocks = []) {
  const structs = blocks.map((b) => koStructOf(b.text));
  const koLegal = structs.filter((k) => k?.article && k.hasBody).length >= 3;

  if (koLegal) {
    const stack = [];
    const cleaned = [];
    let seenBody = false; // past the table of contents?
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      const s = b.text.replace(/\s+/g, " ").trim();
      if (KO_FOOTER_RE.test(s)) continue;
      const k = structs[i];
      if (k?.toc) {
        if (b.block_type === "heading") b.block_type = "paragraph";
      } else if (k && (!k.article || k.hasBody)) {
        while (stack.length && stack[stack.length - 1].level >= k.level)
          stack.pop();
        stack.push({ level: k.level, text: k.label });
        if (k.article) {
          b.block_type = "heading";
          seenBody = true;
        }
      } else if (b.block_type === "heading" && KO_HEADING_JUNK_RE.test(s)) {
        b.block_type = "paragraph";
      } else if (!seenBody) {
        b.section_path = null;
        cleaned.push(b);
        continue;
      }
      b.section_path = stack.map((x) => x.text).join(" > ") || null;
      cleaned.push(b);
    }
    return cleaned;
  }

  const stack = [];
  const anyOutline = blocks.some(
    (b) => b.block_type === "heading" && outlineLevel(b.text) != null
  );
  const kept = [];
  let prevLabel = null;
  for (const b of blocks) {
    // Drop the running page footer ("법제처  N  국가법령정보센터") here too —
    // the koLegal branch already does, but 예규/지침/고시 take this branch.
    if (KO_FOOTER_RE.test(b.text.replace(/\s+/g, " ").trim())) continue;
    let drop = false;
    if (b.block_type === "heading") {
      const t = b.text.replace(/\s+/g, " ").trim();
      if (KO_HEADING_JUNK_RE.test(t)) {
        b.block_type = "paragraph";
      } else {
        const label = trimHeadingLabel(t);
        if (label === prevLabel) {
          // The .hwp table flatten repeats a section's label on every row —
          // a heading identical to the last one is not a new section.
          drop = true;
        } else {
          prevLabel = label;
          const container = isContainerHeading(t);
          const num = label.match(OUTLINE_NUM_RE)?.[1] ?? null;
          const level = container
            ? 1
            : outlineLevel(label) ??
              (anyOutline ? 1 : label.length <= 24 ? 1 : 2);
          while (stack.length) {
            const top = stack[stack.length - 1];
            // A section never pops the division ("N. …부문") it sits under —
            // this is what lets "1. 경영성과" nest below "1. 공통심사부문"
            // instead of replacing it.
            if (top.container && !container) break;
            if (num && top.num) {
              // dotted child: "1.2.1" stays under "1" / "1.2" (prefix match)
              if (num !== top.num && `${num}.`.startsWith(`${top.num}.`)) break;
            } else if (top.level < level) {
              break;
            }
            stack.pop();
          }
          stack.push({ level, text: label, num, container });
        }
      }
    }
    if (drop) continue;
    b.section_path = stack.map((s) => s.text).join(" > ") || null;
    kept.push(b);
  }
  return kept;
}

module.exports = {
  koStructOf,
  outlineLevel,
  isHeadingText,
  groupLines,
  markHeadings,
  buildSectionPaths,
};
