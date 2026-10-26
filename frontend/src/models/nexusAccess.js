// [NEXUS 폴더 잠금] 폴더 비밀번호·관리자 API 호출.
import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

async function call(path, { method = "GET", body } = {}) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: baseHeaders(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: res.ok && data?.success !== false,
      status: res.status,
      message: data?.message || data?.error || null,
      data,
    };
  } catch (e) {
    return { ok: false, status: 0, message: e.message, data: {} };
  }
}

const enc = encodeURIComponent;

const NexusAccess = {
  access: () => call("/nexus/access"),
  folders: () => call("/nexus/folders"),
  unlock: (name, password) =>
    call(`/nexus/folders/${enc(name)}/unlock`, {
      method: "POST",
      body: { password },
    }),
  relock: (name) =>
    call(`/nexus/folders/${enc(name)}/lock`, { method: "POST" }),
  changePassword: (name, currentPassword, newPassword) =>
    call(`/nexus/folders/${enc(name)}/password`, {
      method: "POST",
      body: { currentPassword, newPassword },
    }),
  removeLock: (name, currentPassword) =>
    call(`/nexus/folders/${enc(name)}/remove-lock`, {
      method: "POST",
      body: { currentPassword },
    }),
  adminLogin: (password) =>
    call("/nexus/admin/login", { method: "POST", body: { password } }),
  adminLogout: () => call("/nexus/admin/logout", { method: "POST" }),
  adminOverview: () => call("/nexus/admin/overview"),
  adminFolders: () => call("/nexus/admin/folders"),
  adminLockFolder: (name, password) =>
    call(`/nexus/admin/folders/${enc(name)}/lock`, {
      method: "POST",
      body: { password },
    }),
  adminChats: ({ q = "", client = "", offset = 0, limit = 30 } = {}) => {
    const qs = new URLSearchParams({ limit, offset });
    if (q) qs.set("q", q);
    if (client) qs.set("client", client);
    return call(`/nexus/admin/chats?${qs.toString()}`);
  },
  adminReset: (name, newPassword) =>
    call(`/nexus/folders/${enc(name)}/admin-reset`, {
      method: "POST",
      body: { newPassword: newPassword || null },
    }),
};

export default NexusAccess;
