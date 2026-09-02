import { useEffect, useState } from "react";
import {
  CheckCircle,
  Warning,
  Lock,
  ArrowRight,
  Broom,
} from "@phosphor-icons/react";
import showToast from "@/utils/toast";
import Classification from "@/models/classification";

const SENS_LABEL = {
  general: "일반 범용",
  confidential: "격리·민감",
  uncertain: "판단 보류",
};
const CONFIRMABLE = ["general", "confidential"];

export default function DocRow({ doc, taxonomy, onConfirmed, reload }) {
  const cls = doc.classification;
  // Only a definite call pre-fills the select; "uncertain" / no proposal → the
  // human must pick.
  const initialSens = CONFIRMABLE.includes(cls?.sensitivity)
    ? cls.sensitivity
    : "";
  const [sensitivity, setSensitivity] = useState(initialSens);
  const [docType, setDocType] = useState(cls?.docType || "");
  const [domain, setDomain] = useState(cls?.domain || "");
  const [tags, setTags] = useState((cls?.tags || []).join(", "));
  const [saving, setSaving] = useState(false);
  const [moveTo, setMoveTo] = useState((doc.moveTargets || [])[0] || "");
  const [moving, setMoving] = useState(false);
  const [dedupeKeep, setDedupeKeep] = useState({}); // workspace slug -> docId to keep
  const [dedupingWs, setDedupingWs] = useState(null);

  useEffect(() => {
    if (!cls) return;
    setSensitivity(
      CONFIRMABLE.includes(cls.sensitivity) ? cls.sensitivity : ""
    );
    setDocType(cls.docType || "");
    setDomain(cls.domain || "");
    setTags((cls.tags || []).join(", "));
  }, [cls?.contentHash, cls?.updatedAt]);

  const confirmed = cls?.status === "confirmed";
  const uncertain = cls && cls.sensitivity === "uncertain";
  const confirmableOptions = (
    taxonomy?.sensitivity?.confirmable || CONFIRMABLE
  ).filter(Boolean);

  async function confirm() {
    if (!CONFIRMABLE.includes(sensitivity))
      return showToast("민감도를 먼저 지정하세요.", "error");
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

  async function move() {
    if (!moveTo) return;
    setMoving(true);
    const res = await Classification.move(
      doc.contentHash,
      doc.tierMismatch[0],
      moveTo
    );
    setMoving(false);
    if (res?.error) return showToast(`이동 실패: ${res.error}`, "error");
    showToast(`"${moveTo}"(으)로 이동함`, "success");
    reload?.();
  }

  // Collapse duplicate rows for this content_hash within one workspace down
  // to whichever one is selected (defaults to the newest).
  async function dedupe(workspaceSlug, docsInWs) {
    const keepDocId =
      dedupeKeep[workspaceSlug] || docsInWs[docsInWs.length - 1].docId;
    setDedupingWs(workspaceSlug);
    const res = await Classification.dedupe(
      doc.contentHash,
      workspaceSlug,
      keepDocId
    );
    setDedupingWs(null);
    if (res?.error) return showToast(`정리 실패: ${res.error}`, "error");
    showToast(`"${workspaceSlug}"에서 중복 ${res.removed}건 정리함`, "success");
    reload?.();
  }

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
            {(doc.duplicatesByWorkspace || []).length > 0 ? (
              <span className="ml-1 text-amber-500 inline-flex items-center gap-x-0.5">
                <Warning className="h-3 w-3" /> 중복 정리 필요
              </span>
            ) : (
              doc.duplicateCount > 1 && (
                <span className="ml-1 text-theme-text-secondary">
                  · 다른 워크스페이스에도 있음 ({doc.duplicateCount})
                </span>
              )
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
              : uncertain
                ? "bg-amber-500/15 text-amber-500"
                : cls
                  ? "bg-sky-500/15 text-sky-400"
                  : "bg-white/5 text-theme-text-secondary"
          }`}
        >
          {confirmed
            ? "확정"
            : uncertain
              ? "판단 보류"
              : cls
                ? "제안됨"
                : "미분류"}
        </span>
      </div>

      {!confirmed && doc.held && (
        <p className="text-[11px] text-amber-500 inline-flex items-center gap-x-1">
          <Lock className="h-3 w-3" weight="bold" />
          확정 전까지 <span className="font-semibold">격리·민감</span>으로 취급
          · 자동 라우팅 제외
        </p>
      )}

      {(doc.duplicatesByWorkspace || []).length > 0 && (
        <div className="flex flex-col gap-y-2 text-[11px] bg-amber-500/10 border border-amber-500/20 rounded-md px-2 py-1.5">
          {doc.duplicatesByWorkspace.map(({ workspace, docs }) => {
            const keepId = dedupeKeep[workspace] || docs[docs.length - 1].docId;
            return (
              <div key={workspace} className="flex flex-col gap-y-1">
                <span className="text-amber-500 font-semibold">
                  "{workspace}"에 같은 문서가 {docs.length}번 등록됨 — 하나만
                  남기고 정리하세요.
                </span>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {docs.map((dd) => (
                    <label
                      key={dd.docId}
                      className="flex items-center gap-x-1 text-theme-text-secondary cursor-pointer"
                    >
                      <input
                        type="radio"
                        name={`dedupe-${doc.contentHash}-${workspace}`}
                        checked={keepId === dd.docId}
                        onChange={() =>
                          setDedupeKeep((p) => ({
                            ...p,
                            [workspace]: dd.docId,
                          }))
                        }
                      />
                      {dd.filename} ·{" "}
                      {new Date(dd.createdAt).toLocaleString("ko-KR")}
                    </label>
                  ))}
                </div>
                <button
                  onClick={() => dedupe(workspace, docs)}
                  disabled={dedupingWs === workspace}
                  className="self-start inline-flex items-center gap-x-1 text-white bg-theme-button-primary hover:bg-theme-button-primary-hover px-2 py-1 rounded disabled:opacity-50"
                >
                  <Broom className="h-3 w-3" weight="bold" />
                  {dedupingWs === workspace
                    ? "정리 중…"
                    : `이 하나만 남기고 정리 (${docs.length - 1}건 제거)`}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {(doc.tierMismatch || []).length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] bg-red-500/10 border border-red-500/20 rounded-md px-2 py-1.5">
          <span className="text-red-400">
            {doc.tierMismatch[0]}(은)는 이 문서 티어와 맞지 않음.
          </span>
          {(doc.moveTargets || []).length > 0 ? (
            <>
              <select
                value={moveTo}
                onChange={(e) => setMoveTo(e.target.value)}
                className="bg-theme-settings-input-bg text-theme-text-primary rounded px-1.5 py-1 border border-white/10 outline-none"
              >
                {doc.moveTargets.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                onClick={move}
                disabled={moving || !moveTo}
                className="inline-flex items-center gap-x-1 text-white bg-theme-button-primary hover:bg-theme-button-primary-hover px-2 py-1 rounded disabled:opacity-50"
              >
                <ArrowRight className="h-3 w-3" weight="bold" />
                {moving ? "이동 중…" : "이동"}
              </button>
            </>
          ) : (
            <span className="text-theme-text-secondary">
              티어가 <b>{SENS_LABEL[cls?.sensitivity] || cls?.sensitivity}</b>인
              워크스페이스가 없음 — 워크스페이스 설정에서 tier를 지정하세요.
            </span>
          )}
        </div>
      )}

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
            className={`bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border outline-none ${
              CONFIRMABLE.includes(sensitivity)
                ? "border-white/10"
                : "border-amber-500/60"
            }`}
          >
            <option value="">— 선택 —</option>
            {confirmableOptions.map((v) => (
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
          disabled={saving || !CONFIRMABLE.includes(sensitivity)}
          className="flex items-center gap-x-1.5 text-xs font-semibold text-white bg-theme-button-primary hover:bg-theme-button-primary-hover px-3 py-1.5 rounded-md disabled:opacity-50"
        >
          <CheckCircle className="h-4 w-4" weight="bold" />
          {saving ? "저장 중…" : confirmed ? "재확정" : "확정"}
        </button>
      </div>
    </div>
  );
}
