const prisma = require("../utils/prisma");
const slugifyModule = require("slugify");
const { v4: uuidv4 } = require("uuid");
const truncate = require("truncate");

const WorkspaceThread = {
  defaultName: "새로운 채팅",
  writable: ["name"],

  /**
   * The default Slugify module requires some additional mapping to prevent downstream issues
   * if the user is able to define a slug externally. We have to block non-escapable URL chars
   * so that is the slug is rendered it doesn't break the URL or UI when visited.
   * @param  {...any} args - slugify args for npm package.
   * @returns {string}
   */
  slugify: function (...args) {
    slugifyModule.extend({
      "+": " plus ",
      "!": " bang ",
      "@": " at ",
      "*": " splat ",
      ".": " dot ",
      ":": "",
      "~": "",
      "(": "",
      ")": "",
      "'": "",
      '"': "",
      "|": "",
    });
    return slugifyModule(...args);
  },

  new: async function (workspace, userId = null, data = {}) {
    try {
      const thread = await prisma.workspace_threads.create({
        data: {
          name: data.name ? String(data.name) : this.defaultName,
          slug: data.slug
            ? this.slugify(data.slug, { lowercase: true })
            : uuidv4(),
          user_id: userId ? Number(userId) : null,
          workspace_id: workspace.id,
        },
      });

      return { thread, message: null };
    } catch (error) {
      console.error(error.message);
      return { thread: null, message: error.message };
    }
  },

  update: async function (prevThread = null, data = {}) {
    if (!prevThread) throw new Error("No thread id provided for update");

    const validData = {};
    Object.entries(data).forEach(([key, value]) => {
      if (!this.writable.includes(key)) return;
      validData[key] = value;
    });

    if (Object.keys(validData).length === 0)
      return { thread: prevThread, message: "No valid fields to update!" };

    try {
      const thread = await prisma.workspace_threads.update({
        where: { id: prevThread.id },
        data: validData,
      });
      return { thread, message: null };
    } catch (error) {
      console.error(error.message);
      return { thread: null, message: error.message };
    }
  },

  get: async function (clause = {}) {
    try {
      const thread = await prisma.workspace_threads.findFirst({
        where: clause,
      });

      return thread || null;
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  delete: async function (clause = {}) {
    try {
      const { WorkspaceChats } = require("./workspaceChats");
      // thread_id has no FK relation so chats don't cascade-delete with the thread.
      const threads = await prisma.workspace_threads.findMany({
        where: clause,
        select: { id: true },
      });
      if (threads.length > 0)
        await WorkspaceChats.delete({
          thread_id: { in: threads.map((thread) => thread.id) },
        });

      await prisma.workspace_threads.deleteMany({
        where: clause,
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  where: async function (
    clause = {},
    limit = null,
    orderBy = null,
    include = null
  ) {
    try {
      const results = await prisma.workspace_threads.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
        ...(include !== null ? { include } : {}),
      });
      return results;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  // Will fire on first message (included or not) for a thread and rename the thread based on the prompt.
  autoRenameThread: async function ({
    workspace = null,
    thread = null,
    user = null,
    prompt = null,
    onRename = null,
  }) {
    if (!workspace || !thread || !prompt) return false;
    // Keep compatibility with threads created before the archive UI changed
    // the placeholder from "Thread" to the user-facing Korean label.
    if (![this.defaultName, "Thread"].includes(thread.name)) return false;

    const { WorkspaceChats } = require("./workspaceChats");
    const chatCount = await WorkspaceChats.count({
      workspaceId: workspace.id,
      user_id: user?.id || null,
      thread_id: thread.id,
    });
    if (chatCount !== 1) return { renamed: false, thread };
    const fallbackTitle = truncate(
      String(prompt).replace(/\s+/g, " ").trim(),
      28
    );
    const keywordTitle = await this.keywordTitle(prompt);
    const { thread: updatedThread } = await this.update(thread, {
      name: keywordTitle || fallbackTitle,
    });

    onRename?.(updatedThread);
    return true;
  },

  // Ask the workspace LLM to compress a first-message prompt down to a short
  // keyword phrase for the thread list (vs. showing the raw question verbatim).
  // Best-effort — callers fall back to a truncated prompt if this fails.
  keywordTitle: async function (prompt) {
    try {
      const { getLLMProvider } = require("../utils/helpers");
      const llm = getLLMProvider();
      const { textResponse } = await llm.getChatCompletion(
        [
          {
            role: "system",
            content:
              "다음 사용자 질문을 대화 목록에 표시할 짧은 제목으로 바꿔라. " +
              "질문의 핵심 키워드나 키워드 구만 남기고 조사/어미/군더더기는 제거해라. " +
              "2~6개 단어, 최대 20자. 설명이나 따옴표 없이 제목 텍스트만 답하라.",
          },
          { role: "user", content: String(prompt).slice(0, 500) },
        ],
        { temperature: 0 }
      );
      const title = String(textResponse || "")
        .replace(/^["'“”]+|["'“”]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return title ? truncate(title, 28) : null;
    } catch (e) {
      console.error("WorkspaceThread.keywordTitle failed:", e.message);
      return null;
    }
  },
};

module.exports = { WorkspaceThread };
