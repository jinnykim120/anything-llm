import { useEffect, useState } from "react";
import { CheckCircle, Warning } from "@phosphor-icons/react";
import showToast from "@/utils/toast";
import Classification from "@/models/classification";

const SENS_LABEL = { general: "일반 범용", confidential: "격리·민감" };

export default function DocRow({ doc, taxonomy, onConfirmed }) {
  const cls = doc.classification;
  const [sensitivity, setSensitivity] = useState(
    cls?.sensitivity && cls.sensitivity !== "unclassified"
      ? cls.sensitivity
      : "confidential"
  );
  const [docType, setDocType] = useState(cls?.docType || "");
  const [domain, setDomain] = useState(cls?.domain || "");
  const [tags, setTags] = useState((cls?.tags || []).join(", "));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!cls) return;
    if (cls.sensitivity && cls.sensitivity !== "unclassified")
      setSensitivity(cls.sensitivity);
    setDocType(cls.docType || "");
    setDomain(cls.domain || "");
    setTags((cls.tags || []).join(", "));
  }, [cls?.contentHash, cls?.updatedAt]);

  const confirmed = cls?.status === "confirmed";

  async function confirm() {
    setSaving(true);
    const res = await Classification.confirm(doc.contentHash, {
      sensitivity,
      docType: docType.trim(),
      domain: domain.trim(),
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
    setSaving(false);
    if (res?.error) return showToast(`확정 실패: ${res.error}`, "error");
    showToast("분류 확정됨", "success");
    onConfirmed(res.classification);
  }

  const lowConfidence =
    typeof doc.parseConfidence === "number" && doc.parseConfidence < 0.6;

  return (
    <div className="bg-theme-bg-primary border border-white/10 rounded-lg p-4 flex flex-col gap-y-3">
      <div className="flex items-start justify-between gap-x-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-theme-text-primary truncate">
            {doc.title}
          </p>
          <p className="text-[11px] text-theme-text-secondary mt-0.5">
            {(doc.workspaces || [])
              .map((w) => (w.tier ? `${w.slug} (${w.tier})` : w.slug))
              .join(", ")}{" "}
            · {doc.parsePath || "?"}
            {doc.duplicateCount > 1 && (
              <span className="ml-1 text-amber-500">
                · 중복 {doc.duplicateCount}
              </span>
            )}
            {lowConfidence && (
              <span className="ml-1 text-amber-500 inline-flex items-center gap-x-0.5">
                <Warning className="h-3 w-3" /> 파싱 신뢰도 낮음
              </span>
            )}
            {(doc.tierMismatch || []).length > 0 && (
              <span className="ml-1 text-red-400 inline-flex items-center gap-x-0.5 font-semibold">
                <Warning className="h-3 w-3" /> 티어 불일치:{" "}
                {doc.tierMismatch.join(", ")}
              </span>
            )}
          </p>
        </div>
        <span
          className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full ${
            confirmed
              ? "bg-green-500/15 text-green-500"
              : cls
                ? "bg-sky-500/15 text-sky-400"
                : "bg-white/5 text-theme-text-secondary"
          }`}
        >
          {confirmed ? "확정" : cls ? "제안됨" : "미분류"}
        </span>
      </div>

      {cls?.rationale && !confirmed && (
        <p className="text-[11px] text-theme-text-secondary italic border-l-2 border-white/10 pl-2">
          {cls.rationale}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        <label className="flex flex-col gap-y-1">
          <span className="text-[11px] text-theme-text-secondary">민감도</span>
          <select
            value={sensitivity}
            onChange={(e) => setSensitivity(e.target.value)}
            className="bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none"
          >
            {(taxonomy?.sensitivity?.values || ["general", "confidential"])
              .filter((v) => v !== "unclassified")
              .map((v) => (
                <option key={v} value={v}>
                  {SENS_LABEL[v] || v}
                </option>
              ))}
          </select>
        </label>
        <label className="flex flex-col gap-y-1">
          <span className="text-[11px] text-theme-text-secondary">종류</span>
          <input
            list={`doctype-${doc.contentHash}`}
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            className="bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none"
          />
          <datalist id={`doctype-${doc.contentHash}`}>
            {(taxonomy?.doc_type?.suggested || []).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-y-1">
          <span className="text-[11px] text-theme-text-secondary">분야</span>
          <input
            list={`domain-${doc.contentHash}`}
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none"
          />
          <datalist id={`domain-${doc.contentHash}`}>
            {(taxonomy?.domain?.suggested || []).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-y-1">
          <span className="text-[11px] text-theme-text-secondary">
            태그 (쉼표)
          </span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none"
          />
        </label>
      </div>

      <div className="flex justify-end">
        <button
          onClick={confirm}
          disabled={saving}
          className="flex items-center gap-x-1.5 text-xs font-semibold text-white bg-theme-button-primary hover:bg-theme-button-primary-hover px-3 py-1.5 rounded-md disabled:opacity-50"
        >
          <CheckCircle className="h-4 w-4" weight="bold" />
          {saving ? "저장 중…" : confirmed ? "재확정" : "확정"}
        </button>
      </div>
    </div>
  );
}
