// Regression test for the 2026-09-11 "claude -p exited 1" bug: a rate-limit
// (session-limit) response from `claude -p --output-format json` still
// prints a well-formed JSON envelope on stdout, but the process exits
// non-zero. The provider must surface the real `result` text (and tag the
// error RATE_LIMITED) instead of a truncated "claude -p exited 1: {...}" dump.
const { EventEmitter } = require("events");

jest.mock("child_process", () => ({ spawn: jest.fn() }));
jest.mock("../../../../utils/EmbeddingEngines/native", () => ({
  NativeEmbedder: jest.fn().mockImplementation(() => ({})),
}));

const { spawn } = require("child_process");
const { ClaudeCliLLM } = require("../../../../utils/AiProviders/claudeCli");

/** A fake child process good enough for #spawn: emits stdout data then close. */
function fakeChild({ stdout = "", stderr = "", code = 0 }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: jest.fn(), end: jest.fn() };
  child.kill = jest.fn();
  // Defer so the caller's own listener registration (child.stdout.on(...) etc,
  // done synchronously right after spawn() returns) runs first.
  process.nextTick(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

// The exact envelope captured from a real rate-limited run (trimmed to the
// fields the provider actually reads).
const RATE_LIMIT_ENVELOPE = JSON.stringify({
  duration_api_ms: 0,
  stop_reason: "stop_sequence",
  session_id: "f347117d-189c-459e-b841-5b3e3385028f",
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  is_error: true,
  subtype: "success",
  api_error_status: 429,
  result: "You've hit your session limit · resets 1:20pm (Asia/Seoul)",
  type: "result",
});

describe("ClaudeCliLLM rate-limit handling", () => {
  beforeEach(() => {
    spawn.mockReset();
    jest.spyOn(require("fs"), "writeFileSync").mockImplementation(() => {});
    jest.spyOn(require("fs"), "unlink").mockImplementation((_f, cb) => cb?.());
  });

  it("getChatCompletion surfaces the real rate-limit message, not a truncated dump", async () => {
    spawn.mockImplementation(() =>
      fakeChild({ stdout: RATE_LIMIT_ENVELOPE, code: 1 })
    );
    const llm = new ClaudeCliLLM();

    await expect(
      llm.getChatCompletion([
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ])
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: expect.stringContaining("session limit"),
    });
  });

  it("agentComplete surfaces the same rate-limit error", async () => {
    spawn.mockImplementation(() =>
      fakeChild({ stdout: RATE_LIMIT_ENVELOPE, code: 1 })
    );
    const llm = new ClaudeCliLLM();

    await expect(llm.agentComplete([{ role: "user", content: "hi" }])).rejects.toMatchObject(
      { code: "RATE_LIMITED" }
    );
  });

  it("a non-zero exit with unparseable output still falls back to the raw dump", async () => {
    spawn.mockImplementation(() =>
      fakeChild({ stdout: "not json", stderr: "boom", code: 1 })
    );
    const llm = new ClaudeCliLLM();

    await expect(
      llm.getChatCompletion([{ role: "user", content: "hi" }])
    ).rejects.toMatchObject({ message: expect.stringContaining("claude -p exited 1") });
  });

  it("a clean exit (code 0) still throws when the envelope itself reports is_error", async () => {
    const envelope = JSON.stringify({
      is_error: true,
      subtype: "error_max_turns",
      result: "something else went wrong",
    });
    spawn.mockImplementation(() => fakeChild({ stdout: envelope, code: 0 }));
    const llm = new ClaudeCliLLM();

    await expect(
      llm.getChatCompletion([{ role: "user", content: "hi" }])
    ).rejects.toMatchObject({
      message: expect.stringContaining("something else went wrong"),
    });
  });

  it("a normal successful completion still works", async () => {
    const envelope = JSON.stringify({
      is_error: false,
      subtype: "success",
      result: "안녕하세요",
      usage: { input_tokens: 10, output_tokens: 5 },
      duration_ms: 500,
    });
    spawn.mockImplementation(() => fakeChild({ stdout: envelope, code: 0 }));
    const llm = new ClaudeCliLLM();

    const res = await llm.getChatCompletion([{ role: "user", content: "hi" }]);
    expect(res.textResponse).toBe("안녕하세요");
  });
});
