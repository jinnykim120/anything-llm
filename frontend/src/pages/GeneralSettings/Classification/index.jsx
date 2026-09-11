import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import Sidebar from "@/components/SettingsSidebar";
import ArchiveSidebar from "@/components/ArchiveSidebar";
import { isMobile } from "react-device-detect";
import * as Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";
import { Funnel, Sparkle, ArrowClockwise } from "@phosphor-icons/react";
import CTAButton from "@/components/lib/CTAButton";
import showToast from "@/utils/toast";
import Classification from "@/models/classification";
import DocRow from "./DocRow";
import paths from "@/utils/paths";

const UNCLASSIFIED_LABEL = "미분류";

// [auto-docu v14 P4] sensitivity is dormant — a document is "reviewed" once the
// business axes are confirmed.
function needsClassificationReview(doc) {
  const classification = doc?.classification;
  return (
    !classification ||
    classification.status !== "confirmed" ||
    !classification.workType ||
    !classification.businessUnit ||
    !classification.docType ||
    !classification.domain
  );
}

export default function ClassificationReview() {
  const [searchParams] = useSearchParams();
  const workspaceSlug = searchParams.get("workspace");
  const [loading, setLoading] = useState(true);
  const [proposing, setProposing] = useState(false);
  const [docs, setDocs] = useState([]);
  const [taxonomy, setTaxonomy] = useState(null);
  const [selectedHashes, setSelectedHashes] = useState(() => new Set());
  const [bulkValues, setBulkValues] = useState({
    workType: "",
    businessUnit: "",
    docType: "",
    domain: "",
  });
  const [bulkSaving, setBulkSaving] = useState(false);
  const [filters, setFilters] = useState({
    query: "",
    workType: "all",
    businessUnit: "all",
    docType: "all",
    domain: "all",
    status: "all",
    // 기본값: 미확정 문서를 위로, 그 안에서 최신순.
    sort: "review",
  });

  async function load() {
    const [d, t] = await Promise.all([
      Classification.documents(workspaceSlug),
      Classification.taxonomy(),
    ]);
    setDocs(d);
    setTaxonomy(t);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [workspaceSlug]);

  async function proposeAll() {
    setProposing(true);
    const res = await Classification.propose(null, workspaceSlug);
    setProposing(false);
    if (res?.error) return showToast(`분류 실패: ${res.error}`, "error");
    showToast(`${res.proposed}건 분류 제안 완료`, "success");
    load();
  }

  function toggleSelected(hash) {
    setSelectedHashes((current) => {
      const next = new Set(current);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

  async function confirmSelected() {
    if (!selectedHashes.size)
      return showToast("확정할 문서를 선택하세요.", "error");
    if (
      !bulkValues.workType.trim() &&
      !bulkValues.businessUnit.trim() &&
      !bulkValues.docType.trim() &&
      !bulkValues.domain.trim()
    )
      return showToast("일괄 적용할 분류값을 하나 이상 지정하세요.", "error");
    setBulkSaving(true);
    const result = await Classification.confirmBulk([...selectedHashes], {
      ...(bulkValues.workType.trim()
        ? { workType: bulkValues.workType.trim() }
        : {}),
      ...(bulkValues.businessUnit.trim()
        ? { businessUnit: bulkValues.businessUnit.trim() }
        : {}),
      ...(bulkValues.docType.trim()
        ? { docType: bulkValues.docType.trim() }
        : {}),
      ...(bulkValues.domain.trim() ? { domain: bulkValues.domain.trim() } : {}),
      tags: [],
    });
    setBulkSaving(false);
    if (result?.error)
      return showToast(`일괄 확정 실패: ${result.error}`, "error");
    showToast(`${result.confirmed || 0}건 일괄 확정 완료`, "success");
    setSelectedHashes(new Set());
    await load();
  }

  async function deleteSelected() {
    if (!selectedHashes.size) return;
    if (
      !window.confirm(
        `${selectedHashes.size}개 문서를 모든 작업공간에서 삭제할까요?`
      )
    )
      return;
    setBulkSaving(true);
    const result = await Classification.deleteDocuments([...selectedHashes]);
    setBulkSaving(false);
    if (result?.error) return showToast(`삭제 실패: ${result.error}`, "error");
    showToast(`${result.deleted || 0}건 삭제 완료`, "success");
    setSelectedHashes(new Set());
    await load();
  }

  const pending = docs.filter(needsClassificationReview).length;

  const filterOptions = useMemo(() => {
    return {
      workTypes: [
        ...new Set([
          ...(taxonomy?.work_type?.suggested || []),
          ...docs.map((doc) => doc.classification?.workType).filter(Boolean),
          ...(docs.some((doc) => !doc.classification?.workType)
            ? [UNCLASSIFIED_LABEL]
            : []),
        ]),
      ].sort((a, b) => String(a).localeCompare(String(b), "ko")),
      businessUnits: [
        ...new Set([
          ...(taxonomy?.business_unit?.suggested || []),
          ...docs
            .map((doc) => doc.classification?.businessUnit)
            .filter(Boolean),
          ...(docs.some((doc) => !doc.classification?.businessUnit)
            ? [UNCLASSIFIED_LABEL]
            : []),
        ]),
      ].sort((a, b) => String(a).localeCompare(String(b), "ko")),
      docTypes: [
        ...new Set([
          ...(taxonomy?.doc_type?.suggested || []),
          ...docs.map((doc) => doc.classification?.docType).filter(Boolean),
          ...(docs.some((doc) => !doc.classification?.docType)
            ? [UNCLASSIFIED_LABEL]
            : []),
        ]),
      ].sort((a, b) => String(a).localeCompare(String(b), "ko")),
      domains: [
        ...new Set([
          ...(taxonomy?.domain?.suggested || []),
          ...docs.map((doc) => doc.classification?.domain).filter(Boolean),
          ...(docs.some((doc) => !doc.classification?.domain)
            ? [UNCLASSIFIED_LABEL]
            : []),
        ]),
      ].sort((a, b) => String(a).localeCompare(String(b), "ko")),
    };
  }, [docs, taxonomy]);

  const visibleDocs = useMemo(() => {
    const filtered = docs.filter((doc) => {
      const classification = doc.classification;
      const searchText = [
        doc.title,
        doc.docSource,
        classification?.docType || UNCLASSIFIED_LABEL,
        classification?.workType || UNCLASSIFIED_LABEL,
        classification?.businessUnit || UNCLASSIFIED_LABEL,
        classification?.domain || UNCLASSIFIED_LABEL,
        ...(classification?.tags || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("ko-KR");
      const status = needsClassificationReview(doc)
        ? "unclassified"
        : classification?.status === "confirmed"
          ? "confirmed"
          : classification
            ? "proposed"
            : "unclassified";

      return (
        (!filters.query ||
          searchText.includes(
            filters.query.trim().toLocaleLowerCase("ko-KR")
          )) &&
        (filters.workType === "all" ||
          (filters.workType === UNCLASSIFIED_LABEL
            ? !classification?.workType
            : classification?.workType === filters.workType)) &&
        (filters.businessUnit === "all" ||
          (filters.businessUnit === UNCLASSIFIED_LABEL
            ? !classification?.businessUnit
            : classification?.businessUnit === filters.businessUnit)) &&
        (filters.docType === "all" ||
          (filters.docType === UNCLASSIFIED_LABEL
            ? !classification?.docType
            : classification?.docType === filters.docType)) &&
        (filters.domain === "all" ||
          (filters.domain === UNCLASSIFIED_LABEL
            ? !classification?.domain
            : classification?.domain === filters.domain)) &&
        (filters.status === "all" || status === filters.status)
      );
    });

    const dateOf = (doc) =>
      new Date(
        doc.classification?.updatedAt || doc.updatedAt || doc.createdAt || 0
      ).getTime();

    return filtered.sort((a, b) => {
      if (filters.sort === "review") {
        // 미확정(검수 필요) 문서를 위로, 그 안에서는 최신순.
        const needsRank = (doc) => (needsClassificationReview(doc) ? 0 : 1);
        if (needsRank(a) !== needsRank(b)) return needsRank(a) - needsRank(b);
        return dateOf(b) - dateOf(a);
      }

      if (filters.sort === "title")
        return String(a.title || "").localeCompare(String(b.title || ""), "ko");

      if (filters.sort === "status") {
        const statusRank = (doc) =>
          doc.classification?.status === "confirmed"
            ? 2
            : doc.classification
              ? 1
              : 0;
        return statusRank(a) - statusRank(b);
      }

      return filters.sort === "oldest"
        ? dateOf(a) - dateOf(b)
        : dateOf(b) - dateOf(a);
    });
  }, [docs, filters]);

  const visibleHashes = visibleDocs.map((doc) => doc.contentHash);
  const allVisibleSelected =
    visibleHashes.length > 0 &&
    visibleHashes.every((hash) => selectedHashes.has(hash));

  function toggleAllVisible() {
    setSelectedHashes((current) => {
      const next = new Set(current);
      if (allVisibleSelected)
        visibleHashes.forEach((hash) => next.delete(hash));
      else visibleHashes.forEach((hash) => next.add(hash));
      return next;
    });
  }

  function updateFilter(name, value) {
    setFilters((current) => ({ ...current, [name]: value }));
  }

  function resetFilters() {
    setFilters({
      query: "",
      workType: "all",
      businessUnit: "all",
      docType: "all",
      domain: "all",
      status: "all",
      sort: "review",
    });
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      {workspaceSlug ? (
        <ArchiveSidebar
          slug={workspaceSlug}
          view="management"
          activeManagement="classification"
        />
      ) : (
        <Sidebar />
      )}
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16">
          {workspaceSlug && (
            <Link
              to={paths.workspace.chat(workspaceSlug)}
              className="mb-4 inline-flex items-center gap-2 text-xs font-medium text-theme-text-secondary hover:text-theme-text-primary"
            >
              ← 작업 화면으로 돌아가기
            </Link>
          )}
          <div className="w-full flex flex-col gap-y-1 pb-6 border-white/10 border-b-2">
            <div className="flex gap-x-4 items-center">
              <p className="text-lg leading-6 font-bold text-theme-text-primary">
                문서 분류 검수
              </p>
            </div>
            <p className="text-xs leading-[18px] font-base text-theme-text-secondary">
              아카이브의 문서를 업무 분류 · 사업부 · 종류 · 분야 · 태그로
              분류합니다. LLM이 제안한 분류를 검토하고 확정하세요. 문서 종류는
              사이드바의 업무별 뷰 필터(전체 / 실적 / 법규 / 대외)와 연결됩니다.
            </p>
          </div>

          <div className="flex items-center gap-x-3 my-4">
            <CTAButton
              onClick={proposeAll}
              disabled={proposing || pending === 0}
            >
              <Sparkle className="h-4 w-4" weight="bold" />
              {proposing ? "분류 중…" : `미확정 ${pending}건 분류 제안`}
            </CTAButton>
            <button
              onClick={load}
              className="ml-auto flex items-center gap-x-1.5 text-xs text-theme-text-secondary hover:text-theme-text-primary"
            >
              <ArrowClockwise className="h-4 w-4" /> 새로고침
            </button>
          </div>

          {!loading && docs.length > 0 && (
            <div className="mb-4 rounded-lg border border-white/10 bg-theme-bg-primary p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-x-1.5 text-xs font-semibold text-theme-text-primary">
                  <Funnel className="h-4 w-4" />
                  분류 필터
                  <span className="font-normal text-theme-text-secondary">
                    {visibleDocs.length}/{docs.length}건
                  </span>
                </div>
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-theme-text-secondary">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    disabled={!visibleDocs.length}
                    aria-label="현재 필터 결과 전체 선택"
                  />
                  현재 필터 결과 전체 선택
                </label>
                <button
                  type="button"
                  onClick={resetFilters}
                  className="text-[11px] text-theme-text-secondary hover:text-theme-text-primary"
                >
                  필터 초기화
                </button>
              </div>
              {selectedHashes.size > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-blue-500/20 bg-blue-500/5 p-2">
                  <span className="text-[11px] font-semibold text-theme-text-primary">
                    {selectedHashes.size}건 선택
                  </span>
                  <select
                    value={bulkValues.workType}
                    onChange={(e) =>
                      setBulkValues((v) => ({ ...v, workType: e.target.value }))
                    }
                    aria-label="일괄 확정 업무 분류"
                    className="w-28 bg-theme-settings-input-bg text-theme-text-primary text-xs rounded px-2 py-1 border border-white/10"
                  >
                    <option value="">업무 분류(선택)</option>
                    {filterOptions.workTypes.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                  <select
                    value={bulkValues.businessUnit}
                    onChange={(e) =>
                      setBulkValues((v) => ({
                        ...v,
                        businessUnit: e.target.value,
                      }))
                    }
                    aria-label="일괄 확정 사업부"
                    className="w-28 bg-theme-settings-input-bg text-theme-text-primary text-xs rounded px-2 py-1 border border-white/10"
                  >
                    <option value="">사업부(선택)</option>
                    {filterOptions.businessUnits.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                  <select
                    value={bulkValues.docType}
                    onChange={(e) =>
                      setBulkValues((v) => ({ ...v, docType: e.target.value }))
                    }
                    aria-label="일괄 확정 문서 종류"
                    className="w-28 bg-theme-settings-input-bg text-theme-text-primary text-xs rounded px-2 py-1 border border-white/10"
                  >
                    <option value="">종류 선택(선택)</option>
                    {filterOptions.docTypes.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                  <select
                    value={bulkValues.domain}
                    onChange={(e) =>
                      setBulkValues((v) => ({ ...v, domain: e.target.value }))
                    }
                    aria-label="일괄 확정 분야"
                    className="w-28 bg-theme-settings-input-bg text-theme-text-primary text-xs rounded px-2 py-1 border border-white/10"
                  >
                    <option value="">분야 선택(선택)</option>
                    {filterOptions.domains.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={confirmSelected}
                    disabled={bulkSaving}
                    className="rounded bg-theme-button-primary px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                  >
                    {bulkSaving ? "처리 중…" : "선택 문서 일괄 확정"}
                  </button>
                  <button
                    type="button"
                    onClick={deleteSelected}
                    disabled={bulkSaving}
                    className="rounded bg-red-600 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                  >
                    선택 문서 삭제
                  </button>
                </div>
              )}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <input
                  value={filters.query}
                  onChange={(e) => updateFilter("query", e.target.value)}
                  placeholder="문서명·파일명·종류·분야 검색"
                  aria-label="분류 검수 문서 검색"
                  className="bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none sm:col-span-2 lg:col-span-2"
                />
                <select
                  value={filters.workType}
                  onChange={(e) => updateFilter("workType", e.target.value)}
                  aria-label="업무 분류 필터"
                  className="bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none"
                >
                  <option value="all">업무 분류: 전체</option>
                  {filterOptions.workTypes.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <select
                  value={filters.businessUnit}
                  onChange={(e) => updateFilter("businessUnit", e.target.value)}
                  aria-label="사업부 필터"
                  className="bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none"
                >
                  <option value="all">사업부: 전체</option>
                  {filterOptions.businessUnits.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <select
                  value={filters.docType}
                  onChange={(e) => updateFilter("docType", e.target.value)}
                  aria-label="문서 종류 필터"
                  className="bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none"
                >
                  <option value="all">종류: 전체</option>
                  {filterOptions.docTypes.map((value) => (
                    <option key={value} value={value}>
                      종류: {value}
                    </option>
                  ))}
                </select>
                <select
                  value={filters.domain}
                  onChange={(e) => updateFilter("domain", e.target.value)}
                  aria-label="분야 필터"
                  className="bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none"
                >
                  <option value="all">분야: 전체</option>
                  {filterOptions.domains.map((value) => (
                    <option key={value} value={value}>
                      분야: {value}
                    </option>
                  ))}
                </select>
                <select
                  value={filters.status}
                  onChange={(e) => updateFilter("status", e.target.value)}
                  aria-label="검수 상태 필터"
                  className="bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none"
                >
                  <option value="all">상태: 전체</option>
                  <option value="unclassified">미분류</option>
                  <option value="proposed">제안됨</option>
                  <option value="confirmed">확정</option>
                </select>
                <select
                  value={filters.sort}
                  onChange={(e) => updateFilter("sort", e.target.value)}
                  aria-label="문서 정렬"
                  className="bg-theme-settings-input-bg text-theme-text-primary text-xs rounded-md px-2 py-1.5 border border-white/10 outline-none"
                >
                  <option value="review">정렬: 미확정 먼저</option>
                  <option value="latest">정렬: 최신순</option>
                  <option value="oldest">정렬: 오래된순</option>
                  <option value="status">정렬: 검수 상태순</option>
                  <option value="title">정렬: 문서명순</option>
                </select>
              </div>
            </div>
          )}

          {loading ? (
            <Skeleton.default
              height={90}
              count={4}
              baseColor="var(--theme-bg-primary)"
              highlightColor="var(--theme-bg-secondary)"
              className="mb-3"
            />
          ) : docs.length === 0 ? (
            <p className="text-sm text-theme-text-secondary py-8">
              아카이브에 문서가 없습니다.
            </p>
          ) : visibleDocs.length === 0 ? (
            <p className="text-sm text-theme-text-secondary py-8">
              선택한 필터에 해당하는 문서가 없습니다.
            </p>
          ) : (
            <div className="flex flex-col gap-y-3">
              {visibleDocs.map((doc) => (
                <div key={doc.contentHash} className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selectedHashes.has(doc.contentHash)}
                    onChange={() => toggleSelected(doc.contentHash)}
                    aria-label={`${doc.title} 선택`}
                    className="mt-5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <DocRow
                      doc={doc}
                      taxonomy={taxonomy}
                      reload={load}
                      onTaxonomyUpdated={setTaxonomy}
                      onConfirmed={(cls) =>
                        setDocs((prev) =>
                          prev.map((d) =>
                            d.contentHash === doc.contentHash
                              ? { ...d, classification: cls }
                              : d
                          )
                        )
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
