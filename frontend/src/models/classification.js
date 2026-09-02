import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

// [auto-docu P4] Document classification review screen API.
const Classification = {
  taxonomy: async () => {
    return await fetch(`${API_BASE}/classification/taxonomy`, {
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((res) => res.taxonomy || null)
      .catch((e) => {
        console.error(e);
        return null;
      });
  },

  documents: async () => {
    return await fetch(`${API_BASE}/classification/documents`, {
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((res) => res.documents || [])
      .catch((e) => {
        console.error(e);
        return [];
      });
  },

  // contentHash omitted → classify everything not yet confirmed.
  propose: async (contentHash = null) => {
    return await fetch(`${API_BASE}/classification/propose`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify(contentHash ? { contentHash } : {}),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { error: e.message };
      });
  },

  confirm: async (contentHash, { sensitivity, docType, domain, tags }) => {
    return await fetch(`${API_BASE}/classification/${contentHash}/confirm`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ sensitivity, docType, domain, tags }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { error: e.message };
      });
  },

  move: async (contentHash, fromWorkspace, toWorkspace) => {
    return await fetch(`${API_BASE}/classification/${contentHash}/move`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ fromWorkspace, toWorkspace }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { error: e.message };
      });
  },

  // Collapse duplicate rows for this content_hash within one workspace down
  // to keepDocId.
  dedupe: async (contentHash, workspace, keepDocId) => {
    return await fetch(`${API_BASE}/classification/${contentHash}/dedupe`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ workspace, keepDocId }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { error: e.message };
      });
  },
};

export default Classification;
