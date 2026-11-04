// NEXUS 연결 한 곳. 리스크 PC(Windows) → Mac 의 NEXUS 서버로 네트워크 호출한다.
//   설정: config/nexus.json  { baseUrl, workspace, keyFile, archiveRoot(이 PC 에 NEXUS 가 있을 때의 폴더, 로컬 대체용), caCert }
//   API 키: secrets/nexus-key.txt (한 줄, git 에 올리지 않는다). 환경변수 NEXUS_API_KEY 가 있으면 그 값이 우선한다.
//   점검:  node nexus.mjs --check     (접속·키·워크스페이스를 읽기 전용으로 확인)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
function cfg() { try { return JSON.parse(readFileSync(join(here, "config", "nexus.json"), "utf8")); } catch { return {}; } }
export const archiveRoot = () => process.env.ARCHIVE_ROOT || cfg().archiveRoot || "";
export const caCert = () => { const p = process.env.NODE_EXTRA_CA_CERTS || cfg().caCert || ""; return p && existsSync(p) ? p : ""; };
export const baseUrl = () => String(process.env.NEXUS_URL || cfg().baseUrl || "").replace(/\/+$/, "");
export const workspace = () => process.env.NEXUS_WORKSPACE || cfg().workspace || "";
export function apiKey() {
  if (process.env.NEXUS_API_KEY) return process.env.NEXUS_API_KEY.trim();
  const f = cfg().keyFile || "secrets/nexus-key.txt", p = isAbsolute(f) ? f : join(here, f);
  try { return readFileSync(p, "utf8").trim(); } catch { return ""; }
}
export const configured = () => !!(baseUrl() && apiKey());

// 잠금 폴더용 클라이언트 ID(이 PC 전용, secrets/nexus-client.txt). NEXUS 는 이 ID 별로 폴더를 열어 준다(기본 8시간).
export function clientId() {
  const p = join(here, "secrets", "nexus-client.txt");
  try { const v = readFileSync(p, "utf8").trim(); if (/^[A-Za-z0-9_-]{16,64}$/.test(v)) return v; } catch { /* 새로 만든다 */ }
  const v = "risk-" + randomBytes(16).toString("hex"); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, v + "\n"); return v;
}
// 공통 호출: 오류는 짧은 메시지로(키는 절대 출력하지 않는다)
export async function call(path, { method = "GET", body, headers = {}, timeoutMs = 30000 } = {}) {
  if (!baseUrl()) throw new Error("NEXUS 주소(baseUrl)가 설정되지 않았습니다 (config/nexus.json)");
  const key = apiKey(); if (!key) throw new Error("NEXUS API 키가 없습니다 (secrets/nexus-key.txt)");
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const r = await fetch(baseUrl() + path, { method, headers: { Authorization: `Bearer ${key}`, "X-Nexus-Client": clientId(), ...(body && !isForm ? { "content-type": "application/json" } : {}), ...headers }, body: body ? (isForm ? body : JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* json 아님 */ }
  if (!r.ok) throw new Error(`NEXUS ${r.status}: ${String(j?.error || j?.message || text).slice(0, 160)}`);
  return j ?? text;
}
export const ping = () => fetch(baseUrl() + "/api/ping", { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null);
export const auth = () => call("/api/v1/auth");
export const workspaces = () => call("/api/v1/workspaces").then((j) => (j.workspaces || []).map((w) => ({ slug: w.slug, name: w.name })));

// ── 사건용 잠금 폴더(리스크관리): 원본 저장 + Mac 에서 파싱. 폴더 이름·비밀번호는 secrets/nexus-folder.json.
const folderCfg = () => { try { return JSON.parse(readFileSync(join(here, "secrets", "nexus-folder.json"), "utf8")); } catch { return {}; } };
export const caseFolder = () => folderCfg().folder || cfg().caseFolder || "";
let unlockedAt = 0;
export async function ensureUnlocked() {   // 7시간마다(NEXUS 기본 유효 8시간) 다시 연다
  const f = folderCfg(); if (!f.folder || !f.password) throw new Error("사건 폴더 설정이 없습니다 (secrets/nexus-folder.json)");
  if (Date.now() - unlockedAt < 7 * 3600e3) return;
  await call(`/api/nexus/folders/${encodeURIComponent(f.folder)}/unlock`, { method: "POST", body: { password: f.password } });
  unlockedAt = Date.now();
}
export const listCaseDocs = async () => { await ensureUnlocked(); return call(`/api/v1/documents/folder/${encodeURIComponent(caseFolder())}`); };
// 파일을 사건 폴더에 올리고 Mac 이 파싱한 결과(본문 포함)를 돌려받는다. sub 를 주면 그 이름의 하위 폴더(사건별)로 옮겨 둔다.
// 확인된 NEXUS 동작: 하위 폴더로 직접 업로드하면 500 이라 '부모 폴더에 올린 뒤 move-files 로 이동'한다. 하위 폴더는 API 로 지울 수 없다(NEXUS 는 최상위 폴더만 삭제).
const subCreated = new Set();
export async function uploadCaseDoc(name, buffer, { sub = "", mime = "application/octet-stream", timeoutMs = 180000 } = {}) {
  await ensureUnlocked();
  const fd = new FormData(); fd.append("file", new Blob([buffer], { type: mime }), name);
  const r = await call(`/api/v1/document/upload/${encodeURIComponent(caseFolder())}`, { method: "POST", body: fd, timeoutMs });
  if (!r?.success || !r.documents?.length) throw new Error("NEXUS 업로드 실패: " + String(r?.error || "응답 없음").slice(0, 160));
  const d = r.documents[0]; let location = d.location;
  if (sub) {
    const dir = `${caseFolder()}/${sub.replace(/[\/:*?"<>|]/g, "")}`;
    if (!subCreated.has(dir)) { try { await call("/api/v1/document/create-folder", { method: "POST", body: { name: dir } }); } catch (e) { if (!/already exists/i.test(e.message)) throw e; } subCreated.add(dir); }
    const to = `${dir}/${location.split("/").pop()}`;
    await call("/api/v1/document/move-files", { method: "POST", body: { files: [{ from: location, to }] } }); location = to;
  }
  return { location, id: d.id, title: d.title, text: String(d.pageContent || ""), wordCount: d.wordCount, tokenCount: d.token_count_estimate ?? d.tokenCount };
}
export const listCaseSub = async (sub) => { await ensureUnlocked(); return call(`/api/v1/documents/folder/${encodeURIComponent(caseFolder() + "/" + sub)}`); };
export const removeCaseDocs = async (locations) => { await ensureUnlocked(); return call("/api/v1/system/remove-documents", { method: "DELETE", body: { names: locations } }); };

// 명령줄 점검
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--ca")) process.stdout.write(caCert());
  else if (process.argv.includes("--check")) {
    const ok = (b) => (b ? "OK " : "실패");
    console.log("주소:", baseUrl() || "(없음)", "| 워크스페이스:", workspace() || "(미설정)", "| 키:", apiKey() ? "있음" : "없음");
    const p = await ping(); console.log(ok(p?.online), "서버 응답(ping)");
    if (apiKey() && p?.online) {
      try { await auth(); console.log(ok(true), "API 키 인증"); const ws = await workspaces(); console.log(ok(true), "워크스페이스", ws.length + "개:", ws.map((w) => `${w.slug}(${w.name})`).join(", ") || "(없음)"); const c = await listCaseDocs(); console.log(ok(true), `사건 폴더 "${caseFolder()}" 열기·조회 — 문서 ${c.totalCount ?? (c.documents || []).length}개`); } catch (e) { console.log(ok(false), e.message); }
    }
  }
}

