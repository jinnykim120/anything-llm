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

  addDocType: async (value) => {
    return await fetch(`${API_BASE}/classification/taxonomy/doc-type`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ value }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { error: e.message };
      });
  },

  addAxisValue: async (axis, value) => {
    return await fetch(`${API_BASE}/classification/taxonomy/axis`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ axis, value }),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },

  documents: async (workspace = null) => {
    const query = workspace
      ? `?workspace=${encodeURIComponent(workspace)}`
      : "";
    return await fetch(`${API_BASE}/classification/documents${query}`, {
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
  propose: async (contentHash = null, workspace = null) => {
    const body = {
      ...(contentHash ? { contentHash } : {}),
      ...(workspace ? { workspace } : {}),
    };
    return await fetch(`${API_BASE}/classification/propose`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify(body),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { error: e.message };
      });
  },

  confirm: async (
    contentHash,
    { sensitivity, workType, businessUnit, docType, domain, tags }
  ) => {
    return await fetch(`${API_BASE}/classification/${contentHash}/confirm`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        sensitivity,
        workType,
        businessUnit,
        docType,
        domain,
        tags,
      }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { error: e.message };
      });
  },

  confirmBulk: async (
    contentHashes,
    { sensitivity, workType, businessUnit, docType, domain, tags }
  ) => {
    return await fetch(`${API_BASE}/classification/confirm-bulk`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        contentHashes,
        sensitivity,
        workType,
        businessUnit,
        docType,
        domain,
        tags,
      }),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },

  deleteDocuments: async (contentHashes) => {
    return await fetch(`${API_BASE}/classification/documents`, {
      method: "DELETE",
      headers: baseHeaders(),
      body: JSON.stringify({ contentHashes }),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
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

  moveType: async (contentHash, docType) => {
    return await fetch(`${API_BASE}/classification/${contentHash}/type`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ docType }),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
  },

  moveTypes: async (contentHashes, docType) => {
    return await fetch(`${API_BASE}/classification/types`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ contentHashes, docType }),
    })
      .then((res) => res.json())
      .catch((e) => ({ error: e.message }));
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
