const { v4: uuidv4 } = require("uuid");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { resetMemory } = require("./commands/reset");
const { generateImage } = require("./commands/img");
const { convertToPromptHistory } = require("../helpers/chat/responses");
const { SlashCommandPresets } = require("../../models/slashCommandsPresets");
const { SystemPromptVariables } = require("../../models/systemPromptVariables");

const VALID_COMMANDS = {
  "/reset": resetMemory,
  "/img": generateImage,
};

async function grepCommand(message, user = null) {
  const userPresets = await SlashCommandPresets.getUserPresets(user?.id);
  const availableCommands = Object.keys(VALID_COMMANDS);

  // Check if the message starts with any built-in command
  for (let i = 0; i < availableCommands.length; i++) {
    const cmd = availableCommands[i];
    const re = new RegExp(`^(${cmd})`, "i");
    if (re.test(message)) {
      return cmd;
    }
  }

  // Replace all preset commands with their corresponding prompts
  // Allows multiple commands in one message
  let updatedMessage = message;
  for (const preset of userPresets) {
    // Match the command when it starts the message or follows a space (`lead`),
    // and is not part of a longer command (e.g. don't match /weather in /weatherman).
    // `lead` is captured so we can keep the space when swapping in the prompt.
    const regex = new RegExp(`(^|\\s)(${preset.command})(?![a-z0-9_-])`, "g");
    updatedMessage = updatedMessage.replace(
      regex,
      (_match, lead) => `${lead}${preset.prompt}`
    );
  }

  return updatedMessage;
}

/**
 * @description This function will do recursive replacement of all slash commands with their corresponding prompts.
 * @notice This function is used for API calls and is not user-scoped. THIS FUNCTION DOES NOT SUPPORT PRESET COMMANDS.
 * @returns {Promise<string>}
 */
async function grepAllSlashCommands(message) {
  const allPresets = await SlashCommandPresets.where({});

  // Replace all preset commands with their corresponding prompts
  // Allows multiple commands in one message
  let updatedMessage = message;
  for (const preset of allPresets) {
    // Match the command when it starts the message or follows a space (`lead`),
    // and is not part of a longer command (e.g. don't match /weather in /weatherman).
    // `lead` is captured so we can keep the space when swapping in the prompt.
    const regex = new RegExp(`(^|\\s)(${preset.command})(?![a-z0-9_-])`, "g");
    updatedMessage = updatedMessage.replace(
      regex,
      (_match, lead) => `${lead}${preset.prompt}`
    );
  }

  return updatedMessage;
}

async function recentChatHistory({
  user = null,
  workspace,
  thread = null,
  messageLimit = 20,
  apiSessionId = null,
}) {
  const rawHistory = (
    await WorkspaceChats.where(
      {
        workspaceId: workspace.id,
        user_id: user?.id || null,
        thread_id: thread?.id || null,
        api_session_id: apiSessionId || null,
        include: true,
      },
      messageLimit,
      { id: "desc" }
    )
  ).reverse();
  return { rawHistory, chatHistory: convertToPromptHistory(rawHistory) };
}

/**
 * Returns the base prompt for the chat with memories appended (when enabled).
 * Also does variable substitution on the prompt if there are any defined variables.
 * @param {Object|null} workspace - the workspace object
 * @param {Object|null} user - the user object
 * @param {{prompt?: string, rawHistory?: object[]}} [opts] - current user message + chat history, used for reranking injected memories
 * @returns {Promise<string>}
 */
async function chatPrompt(workspace, user = null, opts = {}) {
  const { SystemSettings } = require("../../models/systemSettings");
  const { promptWithMemories } = require("../memories");
  const basePrompt =
    workspace?.openAiPrompt ?? SystemSettings.saneDefaultSystemPrompt;
  const systemPrompt = await SystemPromptVariables.expandSystemPromptVariables(
    basePrompt,
    user?.id,
    workspace?.id
  );
  return promptWithMemories({
    systemPrompt,
    userId: user?.id ?? null,
    workspaceId: workspace?.id,
    prompt: opts.prompt ?? "",
    rawHistory: opts.rawHistory ?? [],
  });
}

// We use this util function to deduplicate sources from similarity searching
// if the document is already pinned.
// Eg: You pin a csv, if we RAG + full-text that you will get the same data
// points both in the full-text and possibly from RAG - result in bad results
// even if the LLM was not even going to hallucinate.
function sourceIdentifier(sourceDocument) {
  if (!sourceDocument?.title || !sourceDocument?.published) return uuidv4();
  return `title:${sourceDocument.title}-timestamp:${sourceDocument.published}`;
}

// [auto-docu 후속질문] performSimilaritySearch only ever embeds the literal
// current message — it has no idea what "그중 A는"/"위 내용" refers to. When
// there IS prior conversation, rewrite the follow-up into a standalone
// question (using recent history) so retrieval isn't blind to the topic.
// Falls back to the raw message on any failure, and passes an already-
// standalone message through unchanged (the model is told to do that itself,
// which also means the caller can skip the extra safety-net search whenever
// the rewrite comes back identical — see stream.js).
async function condenseFollowupQuery({
  message,
  chatHistory = [],
  LLMConnector,
}) {
  if (!chatHistory.length || !message?.trim()) return message;

  const recentTurns = chatHistory.slice(-6); // last ~3 exchanges — enough context, keeps this cheap
  const transcript = recentTurns
    .map(
      (turn) =>
        `${turn.role === "assistant" ? "Assistant" : "User"}: ${String(turn.content || "").slice(0, 800)}`
    )
    .join("\n\n");

  const system = [
    "대화 기록을 참고해서 사용자의 마지막 질문을 그 자체만 봐도 완전히 이해되는 독립적인 질문으로 다시 쓴다.",
    "마지막 질문이 이미 독립적이면(이전 대화를 몰라도 이해되면) 그대로 반환한다.",
    "새로운 사실을 추가하거나 질문의 의도·범위를 바꾸지 않는다 — 대화에서 가리키는 대상(그것, 위 내용, A 등)을 구체적인 명사로 풀어쓰기만 한다.",
    "출력은 재작성된 질문 문장 하나만. 설명, 인용부호, 접두사 없이.",
  ].join("\n");
  const user = `## 대화 기록\n${transcript}\n\n## 마지막 질문\n${message}`;

  try {
    const { textResponse } = await LLMConnector.getChatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.1 }
    );
    const rewritten = String(textResponse || "")
      .trim()
      .replace(/^["']|["']$/g, "");
    return rewritten || message;
  } catch (e) {
    console.error(
      "[condenseFollowupQuery] failed, falling back to the raw message:",
      e.message
    );
    return message;
  }
}

// [auto-docu 후속질문] 보완 로직 — additive merge of a secondary search on top
// of a primary one, same "append only what's new, never reorder" philosophy
// as pgvector's own #mergeLexicalAdditions (just one level up: this combines
// two full performSimilaritySearch results instead of two internal candidate
// sets). Used to fold the raw-message search in as a safety net alongside
// the condensed-query search — catches cases where the rewrite drifted or
// missed something the literal phrasing would have found.
function mergeFollowupSearchResults(primary, secondary, topN) {
  const chunkKey = (source) =>
    source?.id ||
    `${source?.doc_id || ""}:${(source?.text || "").slice(0, 40)}`;
  const seen = new Set((primary.sources || []).map(chunkKey));
  const contextTexts = [...(primary.contextTexts || [])];
  const sources = [...(primary.sources || [])];

  const secondarySources = secondary.sources || [];
  for (let i = 0; i < secondarySources.length && sources.length < topN; i++) {
    const key = chunkKey(secondarySources[i]);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(secondarySources[i]);
    contextTexts.push(secondary.contextTexts?.[i]);
  }
  return { contextTexts, sources };
}

module.exports = {
  sourceIdentifier,
  condenseFollowupQuery,
  mergeFollowupSearchResults,
  recentChatHistory,
  chatPrompt,
  grepCommand,
  grepAllSlashCommands,
  VALID_COMMANDS,
};
