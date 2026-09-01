// Minimal AnythingLLM API client for the eval harness.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const BASE = process.env.ALLM_BASE || "http://localhost:3001";

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
    const res = await fetch(`${BASE}/api${path}`, { method, headers, body: payload });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return json;
  }

  ping() { return fetch(`${BASE}/api/ping`).then((r) => r.ok); }

  listWorkspaces() { return this.#req("/v1/workspaces"); }

  async deleteWorkspace(slug) {
    try { await this.#req(`/v1/workspace/${slug}`, { method: "DELETE" }); } catch { /* ok if absent */ }
  }

  newWorkspace(name) { return this.#req("/v1/workspace/new", { method: "POST", body: { name } }); }

  updateWorkspace(slug, data) {
    return this.#req(`/v1/workspace/${slug}/update`, { method: "POST", body: data });
  }

  async uploadDoc(filePath) {
    const buf = await readFile(filePath);
    const fd = new FormData();
    // Node's undici FormData preserves a non-ASCII filename correctly (unlike
    // `curl -F` on a cp949 Windows box, which mojibakes it).
    fd.append("file", new Blob([buf]), basename(filePath));
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
      body: { message, mode },
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
