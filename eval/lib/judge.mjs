// LLM-as-judge for the answer-quality harness. Shells out to the Claude Code
// CLI (`claude -p`) — same backend the app uses, no API key. Scores a RAG
// answer against a reference on three axes, returns strict JSON.
//
//   EVAL_JUDGE_MODEL   default "claude-sonnet-5"
//   CLAUDE_CLI_BIN     default "claude"
//
// Caveat: with the default model the judge is the same model that generated the
// answer. Fine for regression tracking (does a change help/hurt); for an
// absolute read set EVAL_JUDGE_MODEL to a different model.

import { spawn } from "node:child_process";

const BIN = process.env.CLAUDE_CLI_BIN || "claude";
const MODEL = process.env.EVAL_JUDGE_MODEL || "claude-sonnet-5";
const TIMEOUT_MS = Number(process.env.EVAL_JUDGE_TIMEOUT_MS) || 180_000;

const SYSTEM = `You are a strict evaluator of a retrieval-augmented (RAG) system's answer.
You are given the user QUESTION, a list of EXPECTED KEY FACTS a complete answer must
convey, the SYSTEM ANSWER, and the RETRIEVED CONTEXT chunks the system was given
(numbered [0], [1], ...). Judge only against the retrieved context and expected facts —
never your own outside knowledge.

Score three axes from 0.0 to 1.0:
- faithfulness: is every factual claim in the SYSTEM ANSWER supported by the RETRIEVED
  CONTEXT? 1.0 = fully grounded, 0.0 = mostly unsupported/fabricated.
- completeness: what fraction of the EXPECTED KEY FACTS does the answer actually convey
  (in substance, wording may differ)?
- citation_accuracy: when the answer cites [n], does context chunk [n] support that
  sentence? 1.0 = all citations correct. If the answer makes claims but cites nothing,
  score 0.4. If the answer correctly refuses (no relevant context), score 1.0.

Respond with ONLY a JSON object, no prose, no code fence:
{"faithfulness": 0.0, "completeness": 0.0, "citation_accuracy": 0.0,
 "missing_facts": ["expected fact not covered", ...],
 "unsupported_claims": ["claim in answer with no context support", ...],
 "note": "one sentence"}`;

function buildPrompt({ question, expectFacts, answer, contexts }) {
  const facts = expectFacts.map((f, i) => `${i + 1}. ${f}`).join("\n");
  const ctx = contexts
    .map((t, i) => `[${i}] ${String(t).replace(/\s+/g, " ").trim().slice(0, 1200)}`)
    .join("\n\n");
  return `QUESTION:
${question}

EXPECTED KEY FACTS:
${facts}

SYSTEM ANSWER:
${answer || "(empty)"}

RETRIEVED CONTEXT:
${ctx || "(none)"}

Now output the JSON score.`;
}

function spawnJudge(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--model",
      MODEL,
      "--tools",
      "",
      "--settings",
      '{"disableAllHooks":true}',
      "--exclude-dynamic-system-prompt-sections",
      "--output-format",
      "json",
      "--system-prompt",
      SYSTEM,
    ];
    const child = spawn(BIN, args, {
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
    let out = "";
    let err = "";
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`judge timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(killer);
      reject(new Error(`claude CLI not runnable (${BIN}): ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      if (code !== 0)
        return reject(new Error(`judge exited ${code}: ${(err || out).slice(0, 300)}`));
      resolve(out);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseScore(raw) {
  let outer;
  try {
    outer = JSON.parse(raw.trim().split("\n").filter(Boolean).pop());
  } catch {
    throw new Error("judge: unparseable CLI envelope");
  }
  if (outer.is_error || outer.subtype !== "success")
    throw new Error(`judge error: ${outer.result || outer.subtype}`);
  const body = String(outer.result || "").replace(/```json\s*|\s*```/g, "");
  const m = body.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`judge: no JSON in response: ${body.slice(0, 200)}`);
  const s = JSON.parse(m[0]);
  const clamp = (x) => Math.max(0, Math.min(1, Number(x) || 0));
  return {
    faithfulness: clamp(s.faithfulness),
    completeness: clamp(s.completeness),
    citation_accuracy: clamp(s.citation_accuracy),
    missing_facts: Array.isArray(s.missing_facts) ? s.missing_facts : [],
    unsupported_claims: Array.isArray(s.unsupported_claims) ? s.unsupported_claims : [],
    note: String(s.note || ""),
  };
}

export const JUDGE_MODEL = MODEL;

export async function judge({ question, expectFacts, answer, contexts }) {
  const raw = await spawnJudge(buildPrompt({ question, expectFacts, answer, contexts }));
  return parseScore(raw);
}
