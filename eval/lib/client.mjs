// Minimal AnythingLLM API client for the eval harness.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import undici from "../../server/node_modules/undici/index.js";

const BASE = process.env.ALLM_BASE || "http://localhost:3001";
// [auto-docu] 서버 쪽 /v1/document/upload -> collector /process 는 이제
// documentProcessingAgent(60분, server/utils/collectorApi/index.js)를 쓴다 —
// 이 클라이언트가 그보다 먼저 포기하면 서버는 여전히 처리 중인데 여기서 먼저
// HeadersTimeoutError로 죽는다. 서버보다 여유 있게 90분으로 둔다.
const REQUEST_AGENT = new undici.Agent({
  headersTimeout: 90 * 60_000,
  bodyTimeout: 90 * 60_000,
});

export class AllmClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error("API key required (run: node eval/setup-key.mjs)");
    this.key = apiKey;
  }

  async #req(path, { method = "GET", body, form } = {}) {
    const headers = { Authorization: `Bearer ${this.key}` };
    let payload = body;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers,
      body: payload,
      dispatcher: REQUEST_AGENT,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return json;
  }

  ping() {
    return fetch(`${BASE}/api/ping`, { dispatcher: REQUEST_AGENT }).then((r) => r.ok);
  }

  listWorkspaces() { return this.#req("/v1/workspaces"); }

  listDocumentsFolder(folder = "custom-documents") {
    return this.#req(`/v1/documents/folder/${encodeURIComponent(folder)}?limit=all`);
  }

  async deleteWorkspace(slug) {
    try { await this.#req(`/v1/workspace/${slug}`, { method: "DELETE" }); } catch { /* ok if absent */ }
  }

  newWorkspace(name) { return this.#req("/v1/workspace/new", { method: "POST", body: { name } }); }

  updateWorkspace(slug, data) {
    return this.#req(`/v1/workspace/${slug}/update`, { method: "POST", body: data });
  }

  async uploadDoc(filePath, { metadata = null } = {}) {
    const buf = await readFile(filePath);
    const fd = new FormData();
    // Node's undici FormData preserves a non-ASCII filename correctly (unlike
    // `curl -F` on a cp949 Windows box, which mojibakes it).
    fd.append("file", new Blob([buf]), basename(filePath));
    if (metadata && typeof metadata === "object")
      fd.append("metadata", JSON.stringify(metadata));
    const json = await this.#req("/v1/document/upload", { method: "POST", form: fd });
    const doc = json?.documents?.[0];
    if (!doc?.location)
      throw new Error(
        `upload gave no location for ${filePath}: ${JSON.stringify(json).slice(0, 300)}`
      );
    return doc.location;
  }

  updateEmbeddings(slug, { adds = [], deletes = [] }) {
    return this.#req(`/v1/workspace/${slug}/update-embeddings`, {
      method: "POST",
      body: { adds, deletes },
    });
  }

  embed(slug, locations) {
    return this.#req(`/v1/workspace/${slug}/update-embeddings`, {
      method: "POST",
      body: { adds: locations },
    });
  }

  async vectorSearch(slug, query, { topN = 8, scoreThreshold = 0.0 } = {}) {
    const json = await this.#req(`/v1/workspace/${slug}/vector-search`, {
      method: "POST",
      body: { query, topN, scoreThreshold },
    });
    return json.results || [];
  }

  /** Grounded chat. mode "query" refuses when no context is retrieved. */
  async chat(slug, message, { mode = "query" } = {}) {
    const json = await this.#req(`/v1/workspace/${slug}/chat`, {
      method: "POST",
      // 질문마다 새 sessionId — 워크스페이스 채팅 기록(이전 평가 답변 포함)이
      // 검색·답변에 섞여 결과가 오염되는 것을 막는다.
      body: {
        message,
        mode,
        sessionId: `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    return {
      answer: json.textResponse || "",
      sources: json.sources || [],
      error: json.error || null,
    };
  }

  /** Returns the workspace object (the API wraps it in `{workspace: [ws]}`). */
  async getWorkspace(slug) {
    const json = await this.#req(`/v1/workspace/${slug}`);
    const ws = json?.workspace;
    return Array.isArray(ws) ? ws[0] : ws || null;
  }
}
