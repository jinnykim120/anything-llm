// [auto-docu P4] One-pass document classifier. Uses the workspace LLM
// (claudecli today, Gemini Enterprise later) to propose sensitivity / doc_type
// / domain / tags from the document's first pages + source metadata.
//
// The proposal is stored as `status: "proposed"` — a human confirms or
// reclassifies it in the review screen before it takes effect.

const { getLLMProvider } = require("../helpers");
const {
  taxonomy,
  normalizeSensitivity,
  DOC_TYPE,
  DOMAIN,
} = require("./taxonomy");
const { safeJsonParse } = require("../http");

const SYSTEM = `You classify Korean corporate / government documents for an internal archive.
Return a JSON object and nothing else. Judge only from the text and source given.

sensitivity — one of "general" | "confidential" | "uncertain":
${taxonomy()
  .sensitivity.rule.map((r) => "  - " + r)
  .join("\n")}
  - "uncertain" means genuinely not enough signal to decide — a human will
    decide. Do NOT use it as a lazy default; only when the document really
    could plausibly be either.

doc_type — the document kind. Prefer one of:
  ${DOC_TYPE.suggested.join(", ")}
  (use another short Korean label only if none fit)

domain — the subject area. Prefer one of:
  ${DOMAIN.suggested.join(", ")}
  (use another short Korean label only if none fit)

tags — 2 to 5 short Korean keywords.

Respond with ONLY:
{"sensitivity":"general|confidential|uncertain","doc_type":"...","domain":"...","tags":["..."],
 "rationale":"one Korean sentence explaining the sensitivity call"}`;

function buildPrompt({ title, docSource, parsePath, text }) {
  const body = String(text || "")
    .replace(/<document_metadata>[\s\S]*?<\/document_metadata>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);
  return `제목: ${title || "(없음)"}
출처: ${docSource || "(불명)"}
파싱경로: ${parsePath || "(불명)"}

본문(발췌):
${body}

위 문서를 분류해서 JSON으로만 답하세요.`;
}

/**
 * @param {{title?:string, text:string, docSource?:string, parsePath?:string}} doc
 * @returns {Promise<{sensitivity:string, doc_type:string, domain:string, tags:string[], rationale:string, model:string}>}
 */
async function classifyDocument(doc = {}) {
  if (!doc.text || doc.text.trim().length < 20)
    throw new Error("classifyDocument: document text is empty");

  const llm = getLLMProvider();
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: buildPrompt(doc) },
  ];
  const { textResponse } = await llm.getChatCompletion(messages, {
    temperature: 0,
  });

  const match = String(textResponse || "").match(/\{[\s\S]*\}/);
  const parsed = match ? safeJsonParse(match[0], null) : null;
  if (!parsed)
    throw new Error(
      `classifier returned no JSON: ${String(textResponse).slice(0, 200)}`
    );

  const clean = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
  return {
    sensitivity: normalizeSensitivity(parsed.sensitivity),
    doc_type: clean(parsed.doc_type) || "기타",
    domain: clean(parsed.domain) || "기타",
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.map(clean).filter(Boolean).slice(0, 5)
      : [],
    rationale: String(parsed.rationale || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300),
    model: llm.model || llm.className || "unknown",
  };
}

module.exports = { classifyDocument };
