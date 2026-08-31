// [auto-docu] LLM provider that shells out to the Claude Code CLI in headless
// mode (`claude -p`). Uses the machine's existing Claude subscription — no API
// key, no separate billing. Swap to the built-in `anthropic` / `gemini`
// provider (LLM_PROVIDER + key) when an API account is ready.
//
//   .env:  LLM_PROVIDER='claudecli'
//          CLAUDE_CLI_BIN=claude                  (path to the CLI)
//          CLAUDE_CLI_MODEL=claude-sonnet-5       (or an alias)
//          CLAUDE_CLI_TIMEOUT_MS=180000
//          CLAUDE_CLI_TOKEN_LIMIT=200000
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const {
  LLMPerformanceMonitor,
} = require("../../helpers/chat/LLMPerformanceMonitor");
const {
  writeResponseChunk,
  clientAbortedHandler,
  formatChatHistory,
} = require("../../helpers/chat/responses");

class ClaudeCliLLM {
  constructor(embedder = null, modelPreference = null) {
    this.className = "ClaudeCliLLM";
    this.bin = process.env.CLAUDE_CLI_BIN || "claude";
    this.model =
      modelPreference || process.env.CLAUDE_CLI_MODEL || "claude-sonnet-5";
    this.timeout = Number(process.env.CLAUDE_CLI_TIMEOUT_MS) || 180_000;
    this.embedder = embedder ?? new NativeEmbedder();
    this.defaultTemp = 0.7; // `claude -p` has no temperature knob; kept for the interface
    this.#log(`initialized (bin=${this.bin}, model=${this.model})`);
  }

  #log(text, ...args) {
    console.log(`\x1b[38;5;208m[ClaudeCLI]\x1b[0m ${text}`, ...args);
  }

  streamingEnabled() {
    return "streamGetChatCompletion" in this;
  }

  static promptWindowLimit() {
    return Number(process.env.CLAUDE_CLI_TOKEN_LIMIT) || 200_000;
  }
  promptWindowLimit() {
    return ClaudeCliLLM.promptWindowLimit();
  }

  async isValidChatCompletionModel(_ = "") {
    return true;
  }

  #generateContent({ userPrompt, attachments = [] }) {
    // `claude -p` takes plain text only — describe any images rather than send them.
    if (!attachments.length) return { content: userPrompt };
    const names = attachments.map((a) => a.name || "attachment").join(", ");
    return {
      content: `${userPrompt}\n\n[첨부: ${names} — 텍스트 전용 백엔드라 이미지는 전달되지 않음]`,
    };
  }

  #appendContext(contextTexts = []) {
    if (!contextTexts?.length) return "";
    return (
      "\nContext:\n" +
      contextTexts
        .map((text, i) => `[CONTEXT ${i}]:\n${text}\n[END CONTEXT ${i}]\n\n`)
        .join("")
    );
  }

  constructPrompt({
    systemPrompt = "",
    contextTexts = [],
    chatHistory = [],
    userPrompt = "",
    attachments = [],
  }) {
    const system = {
      role: "system",
      content: `${systemPrompt}${this.#appendContext(contextTexts)}`,
    };
    return [
      system,
      ...formatChatHistory(chatHistory, this.#generateContent, "spread"),
      { role: "user", ...this.#generateContent({ userPrompt, attachments }) },
    ];
  }

  /** messages[] → { system, prompt } for the CLI (no messages array on `-p`). */
  #flatten(messages = []) {
    const system = messages.find((m) => m.role === "system")?.content || "";
    const turns = messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        const who = m.role === "assistant" ? "Assistant" : "User";
        const body =
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((c) => c.text || "").join("")
              : String(m.content ?? "");
        return `${who}: ${body}`;
      });
    // Last turn is the current user message; the model replies as Assistant.
    return { system, prompt: `${turns.join("\n\n")}\n\nAssistant:` };
  }

  #baseArgs(system, format) {
    const args = [
      "-p",
      "--model",
      this.model,
      "--tools",
      "", // pure text generation — no tool use
      "--settings",
      '{"disableAllHooks":true}',
      "--exclude-dynamic-system-prompt-sections",
      "--output-format",
      format,
    ];
    if (system) args.push("--system-prompt", system);
    if (format === "stream-json")
      args.push("--verbose", "--include-partial-messages");
    return args;
  }

  /** Spawn `claude -p`, feed the prompt on stdin, return { stdout, code }. */
  #spawn(args, promptStdin) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      });
      let out = "";
      let err = "";
      const killer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`claude -p timed out after ${this.timeout}ms`));
      }, this.timeout);
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => {
        clearTimeout(killer);
        reject(
          new Error(`claude CLI not runnable (${this.bin}): ${e.message}`)
        );
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        if (code !== 0)
          return reject(
            new Error(`claude -p exited ${code}: ${(err || out).slice(0, 300)}`)
          );
        resolve(out);
      });
      child.stdin.write(promptStdin);
      child.stdin.end();
    });
  }

  async getChatCompletion(messages = null, _opts = {}) {
    const { system, prompt } = this.#flatten(messages);
    const result = await LLMPerformanceMonitor.measureAsyncFunction(
      this.#spawn(this.#baseArgs(system, "json"), prompt).then((raw) => {
        let j;
        try {
          j = JSON.parse(raw.trim().split("\n").filter(Boolean).pop());
        } catch {
          throw new Error(`claude -p returned unparseable output`);
        }
        if (j.is_error || j.subtype !== "success")
          throw new Error(`claude -p error: ${j.result || j.subtype}`);
        return {
          content: j.result || "",
          usage: {
            prompt_tokens:
              (j.usage?.input_tokens || 0) +
              (j.usage?.cache_read_input_tokens || 0) +
              (j.usage?.cache_creation_input_tokens || 0),
            completion_tokens: j.usage?.output_tokens || 0,
            total_tokens: 0,
            duration: (j.duration_ms || 0) / 1000,
          },
        };
      })
    );

    if (!result.output.content?.length)
      throw new Error(`ClaudeCLI::getChatCompletion response was empty.`);

    const u = result.output.usage;
    return {
      textResponse: result.output.content,
      metrics: {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        total_tokens: u.prompt_tokens + u.completion_tokens,
        outputTps: u.duration ? u.completion_tokens / u.duration : 0,
        duration: u.duration,
        model: this.model,
        provider: this.className,
        timestamp: new Date(),
      },
    };
  }

  /** An async generator over `claude -p --output-format stream-json` events. */
  async *#streamEvents(args, promptStdin) {
    const child = spawn(this.bin, args, {
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), this.timeout);
    child.stdin.write(promptStdin);
    child.stdin.end();

    let buf = "";
    try {
      for await (const chunk of child.stdout) {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            evt.type === "stream_event" &&
            evt.event?.type === "content_block_delta" &&
            evt.event.delta?.type === "text_delta"
          ) {
            yield { text: evt.event.delta.text };
          } else if (evt.type === "result") {
            yield {
              done: true,
              usage: {
                prompt_tokens:
                  (evt.usage?.input_tokens || 0) +
                  (evt.usage?.cache_read_input_tokens || 0) +
                  (evt.usage?.cache_creation_input_tokens || 0),
                completion_tokens: evt.usage?.output_tokens || 0,
                duration: (evt.duration_ms || 0) / 1000,
              },
              error: evt.is_error ? evt.result : null,
            };
          }
        }
      }
    } finally {
      clearTimeout(killer);
      child.kill();
    }
  }

  async streamGetChatCompletion(messages = null, _opts = {}) {
    const { system, prompt } = this.#flatten(messages);
    const generator = this.#streamEvents(
      this.#baseArgs(system, "stream-json"),
      prompt
    );
    return LLMPerformanceMonitor.measureStream({
      func: Promise.resolve(generator),
      messages,
      runPromptTokenCalculation: true,
      modelTag: this.model,
      provider: this.className,
    });
  }

  handleStream(response, stream, responseProps) {
    const { uuid = uuidv4(), sources = [] } = responseProps;
    return new Promise(async (resolve) => {
      let fullText = "";
      let usage = { prompt_tokens: 0, completion_tokens: 0 };

      const handleAbort = () => {
        stream?.endMeasurement(usage);
        clientAbortedHandler(resolve, fullText);
      };
      response.on("close", handleAbort);

      try {
        for await (const evt of stream) {
          if (evt?.text) {
            fullText += evt.text;
            writeResponseChunk(response, {
              uuid,
              sources,
              type: "textResponseChunk",
              textResponse: evt.text,
              close: false,
              error: false,
            });
          }
          if (evt?.done) {
            usage = { ...usage, ...evt.usage };
            if (evt.error) throw new Error(evt.error);
            writeResponseChunk(response, {
              uuid,
              sources,
              type: "textResponseChunk",
              textResponse: "",
              close: true,
              error: false,
            });
            response.removeListener("close", handleAbort);
            stream?.endMeasurement(usage);
            resolve(fullText);
            return;
          }
        }
        // stream ended without a result event
        response.removeListener("close", handleAbort);
        stream?.endMeasurement(usage);
        resolve(fullText);
      } catch (error) {
        writeResponseChunk(response, {
          uuid,
          sources: [],
          type: "textResponseChunk",
          textResponse: "",
          close: true,
          error: `ClaudeCLI:streaming - ${error?.message || error}`,
        });
        response.removeListener("close", handleAbort);
        stream?.endMeasurement(usage);
        resolve(fullText);
      }
    });
  }

  /**
   * Raw text completion for the agent (aibitat) provider — no perf monitor
   * wrapper, returns the plain string. `messages` is aibitat's message array.
   */
  async agentComplete(messages = []) {
    const { system, prompt } = this.#flatten(messages);
    const raw = await this.#spawn(this.#baseArgs(system, "json"), prompt);
    let j;
    try {
      j = JSON.parse(raw.trim().split("\n").filter(Boolean).pop());
    } catch {
      throw new Error("claude -p returned unparseable output");
    }
    if (j.is_error || j.subtype !== "success")
      throw new Error(`claude -p error: ${j.result || j.subtype}`);
    return j.result || "";
  }

  /**
   * OpenAI-shaped streaming generator for the agent (aibitat) UnTooled path.
   * Yields `{ choices: [{ delta: { content } }] }` chunks.
   */
  async *agentStream(messages = []) {
    const { system, prompt } = this.#flatten(messages);
    for await (const evt of this.#streamEvents(
      this.#baseArgs(system, "stream-json"),
      prompt
    )) {
      if (evt?.text) {
        yield { choices: [{ delta: { content: evt.text } }] };
      } else if (evt?.done) {
        if (evt.error) throw new Error(evt.error);
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      }
    }
  }

  async getModelCapabilities() {
    return {
      tools: false,
      reasoning: true,
      imageGeneration: false,
      vision: false, // text-only via the CLI
    };
  }

  async embedTextInput(textInput) {
    return await this.embedder.embedTextInput(textInput);
  }
  async embedChunks(textChunks = []) {
    return await this.embedder.embedChunks(textChunks);
  }

  async compressMessages(promptArgs = {}, rawHistory = []) {
    const { messageArrayCompressor } = require("../../helpers/chat");
    const messageArray = this.constructPrompt(promptArgs);
    return await messageArrayCompressor(this, messageArray, rawHistory);
  }
}

module.exports = { ClaudeCliLLM };
