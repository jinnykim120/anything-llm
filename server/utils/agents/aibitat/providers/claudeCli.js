const Provider = require("./ai-provider.js");
const InheritMultiple = require("./helpers/classes.js");
const UnTooled = require("./helpers/untooled.js");
const { ClaudeCliLLM } = require("../../../AiProviders/claudeCli");

/**
 * The agent provider for the Claude Code CLI (`claude -p`) backend.
 * The CLI has no OpenAI-compatible tool-calling, so this always runs through
 * the UnTooled (prompt-based) function-calling path.
 */
class ClaudeCliProvider extends InheritMultiple([Provider, UnTooled]) {
  model;

  constructor(config = {}) {
    super();
    this.providerTag = "claudecli";
    this.llm = new ClaudeCliLLM(null, config.model);
    this.model = config.model || this.llm.model;
    this.verbose = true;
    this._client = null;
  }

  get client() {
    return null;
  }

  // No SDK client to bind an abort signal to.
  abortableClients() {
    return [];
  }

  get supportsAgentStreaming() {
    return true;
  }

  // `claude -p --tools ""` cannot do native OpenAI tool calling.
  async supportsNativeToolCalling() {
    return false;
  }

  async #handleFunctionCallChat({ messages = [] }) {
    return await this.llm.agentComplete(messages);
  }

  async #handleFunctionCallStream({ messages = [] }) {
    return this.llm.agentStream(messages);
  }

  async stream(messages, functions = [], eventHandler = null) {
    return await UnTooled.prototype.stream.call(
      this,
      messages,
      functions,
      this.#handleFunctionCallStream.bind(this),
      eventHandler
    );
  }

  async complete(messages, functions = []) {
    return await UnTooled.prototype.complete.call(
      this,
      messages,
      functions,
      this.#handleFunctionCallChat.bind(this)
    );
  }

  /**
   * Cost basis is the machine's Claude subscription, not per-token — stub to 0.
   * @param {object} _usage
   * @returns {number}
   */
  getCost(_usage) {
    return 0;
  }
}

module.exports = ClaudeCliProvider;
