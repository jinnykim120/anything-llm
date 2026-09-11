import { useEffect, useState } from "react";
import { CheckCircle, Warning, Broom, Trash } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import showToast from "@/utils/toast";
import Classification from "@/models/classification";
import paths from "@/utils/paths";

// [auto-docu v14 P4] sensitivity is dormant for the prototype — no tier
// routing, no held state. A classification is confirmed on the business axes
// (업무 분류 / 사업부 / 종류 / 분야 / 태그) alone.

export default function DocRow({
  doc,
  taxonomy,
  onConfirmed,
  reload,
  onTaxonomyUpdated,
}) {
  const cls = doc.classification;
  const [workType, setWorkType] = useState(cls?.workType || "");
  const [businessUnit, setBusinessUnit] = useState(cls?.businessUnit || "");
  const [docType, setDocType] = useState(cls?.docType || "");
  const [domain, setDomain] = useState(cls?.domain || "");
  const [tags, setTags] = useState((cls?.tags || []).join(", "));
  const [saving, setSaving] = useState(false);
  const [dedupeKeep, setDedupeKeep] = useState({}); // workspace slug -> docId to keep
  const [dedupingWs, setDedupingWs] = useState(null);
  const [addingDocType, setAddingDocType] = useState(false);
  const [newDocType, setNewDocType] = useState("");
  const [savingDocType, setSavingDocType] = useState(false);
  const [addingAxis, setAddingAxis] = useState(null);
  const [newAxisValue, setNewAxisValue] = useState("");
  const [savingAxis, setSavingAxis] = useState(false);
  const [deletingValue, setDeletingValue] = useState(null);

  useEffect(() => {
    if (!cls) return;
    setWorkType(cls.workType || "");
    setBusinessUnit(cls.businessUnit || "");
    setDocType(cls.docType || "");
    setDomain(cls.domain || "");
    setTags((cls.tags || []).join(", "));
  }, [cls?.contentHash, cls?.updatedAt]);

  const confirmed = cls?.status === "confirmed";
  const confirmedByLabel = cls?.confirmedByUser?.username
    ? cls.confirmedByUser.username
    : cls?.confirmedBy
      ? `사용자 #${cls.confirmedBy}`
      : null;
  const docTypeOptions = [
    ...new Set(
      [...(taxonomy?.doc_type?.suggested || []), docType].filter(Boolean)
    ),
  ];
  const domainOptions = [
    ...new Set(
      [...(taxonomy?.domain?.suggested || []), domain].filter(Boolean)
    ),
  ].sort((a, b) => String(a).localeCompare(String(b), "ko"));
  const workTypeOptions = [
    ...new Set(
      [...(taxonomy?.work_type?.suggested || []), workType].filter(Boolean)
    ),
  ];
  const businessUnitOptions = [
    ...new Set(
      [...(taxonomy?.business_unit?.suggested || []), businessUnit].filter(
        Boolean
      )
    ),
  ];

  async function confirm() {
    setSaving(true);
    const res = await Classification.confirm(doc.contentHash, {
      workType,
      businessUnit,
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

  const hasClassificationChanges =
    workType !== (cls?.workType || "") ||
    businessUnit !== (cls?.businessUnit || "") ||
    docType !== (cls?.docType || "") ||
    domain !== (cls?.domain || "") ||
    tags !== (cls?.tags || []).join(", ");

  function selectDocType(value) {
    if (value === "__custom__") {
      setAddingDocType(true);
      setNewDocType("");
      return;
    }
    setAddingDocType(false);
    setDocType(value);
  }

  async function addDocumentType() {
    const value = newDocType.replace(/\s+/g, " ").trim();
    if (!value) return showToast("추가할 문서 종류를 입력하세요.", "error");
    setSavingDocType(true);
    const res = await Classification.addDocType(value);
    setSavingDocType(false);
    if (res?.error) return showToast(`종류 추가 실패: ${res.error}`, "error");
    setDocType(res.value || value);
    setNewDocType("");
    setAddingDocType(false);
    onTaxonomyUpdated?.(res.taxonomy);
    showToast(`문서 종류 “${res.value || value}”를 추가했습니다.`, "success");
  }

  async function addAxisValue(axis) {
    const value = newAxisValue.replace(/\s+/g, " ").trim();
    if (!value) return showToast("추가할 항목을 입력하세요.", "error");
    setSavingAxis(true);
    const res = await Classification.addAxisValue(axis, value);
    setSavingAxis(false);
    if (res?.error)
      return showToast(`분류 항목 추가 실패: ${res.error}`, "error");
    if (axis === "workType") setWorkType(res.value || value);
    if (axis === "businessUnit") setBusinessUnit(res.value || value);
    if (axis === "domain") setDomain(res.value || value);
    setNewAxisValue("");
    setAddingAxis(null);
    onTaxonomyUpdated?.(res.taxonomy);
  }

  const AXIS_LABEL = {
    workType: "업무 분류",
    businessUnit: "사업부",
    domain: "분야",
  };

  async function removeAxisValue(axis, value, setValue) {
    const v = (value || "").trim();
    if (!v) return;
    if (
      !window.confirm(
        `${AXIS_LABEL[axis] || "분류"} 항목 “${v}”을(를) 삭제할까요?\n확정된 문서가 이 항목을 쓰고 있으면 삭제되지 않습니다.`
      )
    )
      return;
    setDeletingValue(`${axis}:${v}`);
    const res = await Classification.deleteAxisValue(axis, v);
    setDeletingValue(null);
    if (res?.error) return showToast(res.error, "error");
    if ((value || "") === v) setValue("");
    onTaxonomyUpdated?.(res.taxonomy);
    showToast(`“${v}” 분류 항목을 삭제했습니다.`, "success");
  }

  async function removeDocumentType(value) {
    const v = (value || "").trim();
    if (!v) return;
    if (
      !window.confirm(
        `문서 종류 “${v}”을(를) 삭제할까요?\n확정된 문서가 이 종류를 쓰고 있으면 삭제되지 않습니다.`
      )
    )
      return;
    setDeletingValue(`docType:${v}`);
    const res = await Classification.deleteDocType(v);
    setDeletingValue(null);
    if (res?.error) return showToast(res.error, "error");
    if ((docType || "") === v) setDocType("");
    onTaxonomyUpdated?.(res.taxonomy);
    showToast(`“${v}” 문서 종류를 삭제했습니다.`, "success");
  }

  function renderDeleteButton({ onClick, busy, title }) {
    return (
      <button
        type="button"
        title={title}
        onClick={onClick}
        disabled={busy}
        className="shrink-0 rounded-md border border-white/10 p-1.5 text-theme-text-secondary hover:text-red-400 hover:border-red-400/40 disabled:opacity-40"
      >
        <Trash className="h-3.5 w-3.5" />
      </button>
    );
  }

  function axisSelect(axis, value, setValue, options, allowCustom = true) {
    return (
      <>
        <div className="flex items-center gap-1">
          <select
            value={value}
            onChange={(event) => {
              if (event.target.value === "__custom__") {
                setAddingAxis(axis);
                setNewAxisValue("");
                return;
              }
              setValue(event.target.value);
            }}
            className="min-w-0 flex-1 bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none"
          >
            <option value="">— 선택 —</option>
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            {allowCustom && <option value="__custom__">＋ 직접 추가…</option>}
          </select>
          {!!value &&
            renderDeleteButton({
              busy: deletingValue === `${axis}:${value}`,
              title: `“${value}” 분류 항목 삭제`,
              onClick: () => removeAxisValue(axis, value, setValue),
            })}
        </div>
        {addingAxis === axis && (
          <div className="mt-1 flex gap-1">
            <input
              autoFocus
              value={newAxisValue}
              onChange={(event) => setNewAxisValue(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && addAxisValue(axis)}
              placeholder="새 항목"
              className="min-w-0 flex-1 bg-theme-settings-input-bg text-theme-text-primary text-xs rounded px-2 py-1.5 border border-white/10 outline-none"
            />
            <button
              type="button"
              onClick={() => addAxisValue(axis)}
              disabled={savingAxis}
              className="rounded bg-theme-button-primary px-2 text-[11px] text-white disabled:opacity-50"
            >
              추가
            </button>
          </div>
        )}
      </>
    );
  }

  const lowConfidence =
    typeof doc.parseConfidence === "number" && doc.parseConfidence < 0.6;

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
            {(doc.workspaces || []).map((w) => w.slug).join(", ")} ·{" "}
            {doc.parsePath || "?"}
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
            {(lowConfidence || doc.parsePath === "image-only") && (
              <span className="ml-1 text-amber-500 inline-flex items-center gap-x-0.5">
                <Warning className="h-3 w-3" />{" "}
                {doc.parsePath === "image-only"
                  ? "스캔 문서 · 비전 처리 대기"
                  : "파싱 신뢰도 낮음"}
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

      {confirmed && (
        <p className="text-[11px] text-theme-text-secondary">
          {confirmedByLabel && (
            <>
              확정자: <span className="font-semibold">{confirmedByLabel}</span>
            </>
          )}
          {confirmedByLabel && cls?.updatedAt && " · "}
          {cls?.updatedAt &&
            `확정 시각: ${new Date(cls.updatedAt).toLocaleString("ko-KR")}`}
        </p>
      )}

      {(doc.uploaders || []).length > 0 && (
        <p className="text-[11px] text-theme-text-secondary">
          업로드자:{" "}
          {doc.uploaders
            .map((u) =>
              [
                u.username || (u.userId ? `사용자 #${u.userId}` : null),
                u.orgUnit,
              ]
                .filter(Boolean)
                .join(" · ")
            )
            .join(", ")}
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

      {cls?.rationale && !confirmed && (
        <p className="text-[11px] text-theme-text-secondary italic border-l-2 border-white/10 pl-2">
          {cls.rationale}
        </p>
      )}

      {/* 필드 순서: 업무 분류 > 사업부 > 종류 > 분야 > 태그 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <label className="flex flex-col gap-y-1">
          <span className="text-[11px] text-theme-text-secondary">
            업무 분류
          </span>
          {axisSelect("workType", workType, setWorkType, workTypeOptions)}
        </label>
        <label className="flex flex-col gap-y-1">
          <span className="text-[11px] text-theme-text-secondary">사업부</span>
          {axisSelect(
            "businessUnit",
            businessUnit,
            setBusinessUnit,
            businessUnitOptions
          )}
        </label>
        <label className="flex flex-col gap-y-1">
          <span className="text-[11px] text-theme-text-secondary">종류</span>
          <div className="flex items-center gap-1">
            <select
              value={addingDocType ? "__custom__" : docType}
              onChange={(e) => selectDocType(e.target.value)}
              className="min-w-0 flex-1 bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none"
            >
              <option value="">— 선택 —</option>
              {docTypeOptions.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
              <option value="__custom__">＋ 문서 종류 직접 추가…</option>
            </select>
            {!!docType &&
              !addingDocType &&
              renderDeleteButton({
                busy: deletingValue === `docType:${docType}`,
                title: `“${docType}” 문서 종류 삭제`,
                onClick: () => removeDocumentType(docType),
              })}
          </div>
          {addingDocType && (
            <div className="flex gap-1">
              <input
                autoFocus
                value={newDocType}
                onChange={(e) => setNewDocType(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addDocumentType();
                }}
                placeholder="예: 점검보고서"
                className="min-w-0 flex-1 bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none"
              />
              <button
                type="button"
                onClick={addDocumentType}
                disabled={savingDocType}
                className="shrink-0 rounded-md bg-theme-button-primary px-2 text-[11px] font-semibold text-white disabled:opacity-50"
              >
                {savingDocType ? "추가 중…" : "추가"}
              </button>
            </div>
          )}
        </label>
        <label className="flex flex-col gap-y-1">
          <span className="text-[11px] text-theme-text-secondary">분야</span>
          {axisSelect("domain", domain, setDomain, domainOptions)}
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

      {doc.workspaces?.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-theme-text-secondary">문서함에서 확인:</span>
          {doc.workspaces.map((workspace) => {
            const search = new URLSearchParams();
            if (workType.trim()) search.set("work", workType.trim());
            if (businessUnit.trim()) search.set("unit", businessUnit.trim());
            search.set("hash", doc.contentHash);
            return (
              <Link
                key={workspace.slug}
                to={paths.workspace.library(workspace.slug, {
                  search: search.toString(),
                })}
                className="inline-flex items-center gap-x-1 rounded border border-blue-500 bg-blue-500 px-2 py-1 font-semibold text-white shadow-sm hover:border-blue-600 hover:bg-blue-600"
              >
                {workspace.slug} 열기
              </Link>
            );
          })}
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={confirm}
          disabled={saving}
          className="flex items-center gap-x-1.5 text-xs font-semibold text-white bg-theme-button-primary hover:bg-theme-button-primary-hover px-3 py-1.5 rounded-md disabled:opacity-50"
        >
          <CheckCircle className="h-4 w-4" weight="bold" />
          {saving
            ? "저장 중…"
            : confirmed && !hasClassificationChanges
              ? "변경 후 저장"
              : confirmed
                ? "변경 저장"
                : "확정"}
        </button>
      </div>
    </div>
  );
}
