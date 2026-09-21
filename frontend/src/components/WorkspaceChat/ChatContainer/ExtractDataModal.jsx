import { useEffect, useMemo, useState } from "react";
import {
  CaretDown,
  CaretRight,
  CircleNotch,
  FileDoc,
  FileHtml,
  FileXls,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import Modal, {
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@/components/lib/Modal";
import Workspace from "@/models/workspace";
import Classification from "@/models/classification";
import showToast from "@/utils/toast";
import { downloadDraftHtml } from "./DraftPanel/exporters";

// [auto-docu 자료 추출하기] RAG 유사도검색이 아니라, 사용자가 정확히 고른
// 문서 집합을 전부 훑어(exhaustive) 요청한 항목을 뽑는다. DocRegen 폴더
// 트리와 같은 원리(문서함 = classification의 workType 그룹)를 여기서도
// 다시 계산한다 — DocRegen의 폴더 트리 자체가 그 화면의 큰 컴포넌트 안에
// 박혀 있어 그대로 import할 수 없어서, workType 단위(하위 businessUnit
// 단위까지는 생략)로 간단히 재구성했다(판단: 완전한 폴더 위젯을 뽑아내는
// 리팩터보다 이 정도 재사용 범위가 지금 가치 대비 비용이 낮다고 봄).
function docContentHashOf(doc) {
  try {
    return JSON.parse(doc?.metadata || "{}").content_hash || null;
  } catch {
    return null;
  }
}

export default function ExtractDataModal({ workspace, onClose }) {
  const [scope, setScope] = useState(null); // "upload" | "archive" | "both"
  const [fields, setFields] = useState("");
  const [uploadedDocs, setUploadedDocs] = useState([]); // [{title, pageContent}]
  const [uploading, setUploading] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [classificationsByHash, setClassificationsByHash] = useState({});
  const [selectedWorkTypes, setSelectedWorkTypes] = useState([]);
  // 폴더를 한 단계 더 열어 파일을 개별로 고를 수 있게 — 폴더 전체 선택과
  // 개별 파일 선택은 섞어 쓸 수 있다.
  const [expandedWorkTypes, setExpandedWorkTypes] = useState([]);
  const [selectedDocIds, setSelectedDocIds] = useState([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null); // { fields, documents: [{title, values}] }
  const [exportingXlsx, setExportingXlsx] = useState(false);

  useEffect(() => {
    if (scope !== "archive" && scope !== "both") return;
    Workspace.bySlug(workspace.slug).then((ws) => {
      setDocuments(Array.isArray(ws?.documents) ? ws.documents : []);
    });
    Classification.documents(workspace.slug).then((rows) => {
      const byHash = {};
      for (const row of rows || []) {
        if (row.contentHash && row.classification)
          byHash[row.contentHash] = row.classification;
      }
      setClassificationsByHash(byHash);
    });
  }, [scope, workspace.slug]);

  const docsByWorkType = useMemo(() => {
    const groups = new Map();
    for (const doc of documents) {
      const hash = docContentHashOf(doc);
      const cls = hash && classificationsByHash[hash];
      const workType = cls?.workType?.trim() || "미분류";
      if (!groups.has(workType)) groups.set(workType, []);
      groups.get(workType).push(doc);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, "ko"));
  }, [documents, classificationsByHash]);

  function docTitleOf(doc) {
    try {
      return JSON.parse(doc?.metadata || "{}").title || doc?.filename || "문서";
    } catch {
      return doc?.filename || "문서";
    }
  }

  function toggleExpanded(workType) {
    setExpandedWorkTypes((prev) =>
      prev.includes(workType)
        ? prev.filter((w) => w !== workType)
        : [...prev, workType]
    );
  }

  function toggleDoc(id) {
    setSelectedDocIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  function toggleWorkType(workType) {
    setSelectedWorkTypes((prev) =>
      prev.includes(workType)
        ? prev.filter((w) => w !== workType)
        : [...prev, workType]
    );
  }

  async function handleFilePicked(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploading(true);
    for (const file of files) {
      const res = await Workspace.uploadExtractFile(workspace.slug, file);
      if (res?.error) {
        showToast(`${file.name}: ${res.error}`, "error");
        continue;
      }
      setUploadedDocs((prev) => [...prev, res]);
    }
    setUploading(false);
    e.target.value = "";
  }

  const needsUpload = scope === "upload" || scope === "both";
  const needsArchive = scope === "archive" || scope === "both";
  const folderKeys = selectedWorkTypes.map((w) => `work:${w}`);
  // 폴더 전체로 이미 고른 문서는 개별 선택에서 뺀다(중복 방지).
  const docIdsInSelectedFolders = new Set(
    docsByWorkType
      .filter(([w]) => selectedWorkTypes.includes(w))
      .flatMap(([, docs]) => docs.map((d) => d.id))
  );
  const individualDocIds = selectedDocIds.filter(
    (id) => !docIdsInSelectedFolders.has(id)
  );
  const canRun =
    fields.trim() &&
    (uploadedDocs.length > 0 ||
      folderKeys.length > 0 ||
      individualDocIds.length > 0) &&
    !running;

  async function runExtraction() {
    if (!canRun) return;
    setRunning(true);
    setResult(null);
    const res = await Workspace.runExtractData(workspace.slug, {
      fields: fields.trim(),
      uploadedDocs,
      folderKeys,
      archiveDocIds: individualDocIds,
    });
    setRunning(false);
    if (res?.error || !res?.documents)
      return showToast(res?.error || "자료 추출에 실패했습니다.", "error");
    setResult(res);
  }

  function resultFieldNames() {
    if (!result) return [];
    const names = new Set();
    result.documents.forEach((d) =>
      Object.keys(d.values || {}).forEach((k) => names.add(k))
    );
    return [...names];
  }

  function resultMarkdown() {
    const names = resultFieldNames();
    const header = `| 문서 | ${names.join(" | ")} |`;
    const sep = `| --- | ${names.map(() => "---").join(" | ")} |`;
    const rows = result.documents.map((d) => {
      const cells = names.map((n) => {
        const v = d.values?.[n];
        return v?.value ? String(v.value).replace(/\|/g, "\\|") : "(없음)";
      });
      return `| ${d.title} | ${cells.join(" | ")} |`;
    });
    return [
      `# 자료 추출 결과`,
      ``,
      `요청 항목: ${result.fields}`,
      ``,
      header,
      sep,
      ...rows,
    ].join("\n");
  }

  function downloadHtml() {
    downloadDraftHtml({ markdown: resultMarkdown(), title: "자료 추출 결과" });
  }

  async function downloadDocx() {
    const res = await Workspace.downloadAsDocx({
      title: "자료 추출 결과",
      markdown: resultMarkdown(),
    });
    if (!res?.success)
      showToast(res?.error || "DOCX 다운로드에 실패했습니다.", "error");
  }

  async function downloadXlsx() {
    if (exportingXlsx) return;
    setExportingXlsx(true);
    const res = await Workspace.downloadAsXlsx({
      title: "자료 추출 결과",
      markdown: resultMarkdown(),
    });
    setExportingXlsx(false);
    if (!res?.success)
      showToast(res?.error || "XLSX 다운로드에 실패했습니다.", "error");
  }

  function reset() {
    setScope(null);
    setFields("");
    setUploadedDocs([]);
    setSelectedWorkTypes([]);
    setSelectedDocIds([]);
    setExpandedWorkTypes([]);
    setResult(null);
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="lg">
      <ModalHeader
        title="자료 추출하기"
        subtitle="원하는 자료에서 필요한 수치 등을 추출합니다 — 검색(RAG)이 아니라 고른 문서 전체를 그대로 훑습니다."
        onClose={onClose}
      />
      <ModalBody>
        {!scope && (
          <div className="flex flex-col gap-2">
            {[
              {
                key: "upload",
                label: "신규 자료 업로드",
                desc: "새로 올린 파일에서만 추출합니다.",
              },
              {
                key: "archive",
                label: "기존 아카이브에서 자료 선택",
                desc: "이미 아카이브에 있는 문서함 폴더를 골라 추출합니다.",
              },
              {
                key: "both",
                label: "신규 자료 + 아카이브 선택",
                desc: "둘 다 근거로 씁니다.",
              },
            ].map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setScope(opt.key)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-left transition hover:border-blue-400 light:border-slate-300 light:bg-white light:hover:bg-blue-50"
              >
                <span className="block text-sm font-semibold text-zinc-100 light:text-slate-900">
                  {opt.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-zinc-400 light:text-slate-600">
                  {opt.desc}
                </span>
              </button>
            ))}
          </div>
        )}

        {scope && !running && !result && (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={reset}
              className="flex w-fit items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-100 light:text-slate-600 light:hover:text-slate-900"
            >
              범위 다시 선택
            </button>

            {needsUpload && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-zinc-200 light:text-slate-700">
                  파일 업로드
                </span>
                <input
                  type="file"
                  multiple
                  onChange={handleFilePicked}
                  disabled={uploading}
                  className="text-[11px] text-zinc-400 light:text-slate-600"
                />
                {uploading && (
                  <span className="flex items-center gap-1 text-[11px] text-slate-500">
                    <CircleNotch size={12} className="animate-spin" /> 처리
                    중...
                  </span>
                )}
                {uploadedDocs.map((d, i) => (
                  <span
                    key={i}
                    className="flex items-center gap-1.5 text-[11px] text-blue-600 dark:text-blue-400"
                  >
                    {d.title}
                    <button
                      type="button"
                      onClick={() =>
                        setUploadedDocs((prev) =>
                          prev.filter((_, idx) => idx !== i)
                        )
                      }
                      className="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </label>
            )}

            {needsArchive && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-zinc-200 light:text-slate-700">
                  문서함 폴더 선택
                </span>
                <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-zinc-700 p-2 light:border-slate-300">
                  {docsByWorkType.map(([workType, docs]) => {
                    const folderChecked = selectedWorkTypes.includes(workType);
                    const open = expandedWorkTypes.includes(workType);
                    const pickedInside = docs.filter((d) =>
                      selectedDocIds.includes(d.id)
                    ).length;
                    return (
                      <div key={workType} className="flex flex-col">
                        <div className="flex items-center gap-1.5 text-xs text-zinc-200 light:text-slate-800">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(workType)}
                            aria-label={`${workType} 파일 목록 ${open ? "접기" : "펼치기"}`}
                            className="text-zinc-400 hover:text-zinc-100 light:text-slate-500 light:hover:text-slate-900"
                          >
                            {open ? (
                              <CaretDown size={12} />
                            ) : (
                              <CaretRight size={12} />
                            )}
                          </button>
                          <label className="flex flex-1 cursor-pointer items-center gap-2">
                            <input
                              type="checkbox"
                              checked={folderChecked}
                              onChange={() => toggleWorkType(workType)}
                            />
                            {workType}
                            <span className="text-zinc-400 light:text-slate-500">
                              {docs.length}건
                              {pickedInside > 0 && !folderChecked
                                ? ` · ${pickedInside}건 선택`
                                : ""}
                            </span>
                          </label>
                        </div>
                        {open && (
                          <div className="ml-6 mt-1 flex flex-col gap-1 border-l border-zinc-700 pl-3 light:border-slate-300">
                            {docs.map((doc) => (
                              <label
                                key={doc.id}
                                className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-300 light:text-slate-700"
                              >
                                <input
                                  type="checkbox"
                                  checked={
                                    folderChecked ||
                                    selectedDocIds.includes(doc.id)
                                  }
                                  disabled={folderChecked}
                                  onChange={() => toggleDoc(doc.id)}
                                />
                                <span className="truncate">
                                  {docTitleOf(doc)}
                                </span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!docsByWorkType.length && (
                    <span className="text-[11px] text-zinc-400 light:text-slate-500">
                      불러오는 중...
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-zinc-400 light:text-slate-500">
                  폴더 전체를 고르거나, 화살표로 폴더를 열어 파일을 하나씩
                  골라도 됩니다(최대 15건까지 추출).
                </span>
              </div>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-zinc-200 light:text-slate-700">
                추출하고 싶은 항목을 알려주세요
              </span>
              <textarea
                value={fields}
                onChange={(e) => setFields(e.target.value)}
                rows={2}
                placeholder="예: 매출액, 영업이익, 점포수"
                className="resize-none rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs leading-5 text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-blue-400 light:border-slate-300 light:bg-white light:text-slate-900"
              />
            </label>
          </div>
        )}

        {running && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-zinc-400 light:text-slate-600">
            <CircleNotch size={22} className="animate-spin" />
            <p className="text-xs">문서를 전부 훑어 추출하는 중입니다...</p>
          </div>
        )}

        {result && (
          <div className="flex flex-col gap-2">
            <div className="overflow-x-auto rounded-md border border-zinc-700 light:border-slate-300">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    <th className="border border-zinc-700 bg-zinc-800 px-2 py-1 text-left font-semibold text-zinc-100 light:border-slate-300 light:bg-slate-100 light:text-slate-800">
                      문서
                    </th>
                    {resultFieldNames().map((n) => (
                      <th
                        key={n}
                        className="border border-zinc-700 bg-zinc-800 px-2 py-1 text-left font-semibold text-zinc-100 light:border-slate-300 light:bg-slate-100 light:text-slate-800"
                      >
                        {n}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.documents.map((d, i) => (
                    <tr key={i}>
                      <td className="border border-zinc-700 px-2 py-1 font-medium text-zinc-200 light:border-slate-300 light:text-slate-800">
                        {d.title}
                      </td>
                      {resultFieldNames().map((n) => (
                        <td
                          key={n}
                          title={d.values?.[n]?.evidence || ""}
                          className="border border-zinc-700 px-2 py-1 text-zinc-300 light:border-slate-300 light:text-slate-700"
                        >
                          {d.values?.[n]?.value || "(없음)"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-zinc-400 light:text-slate-600">
              값 위에 마우스를 올리면 근거 문장이 보입니다.
            </p>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        {result ? (
          <>
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:border-blue-400 hover:text-blue-400 light:border-slate-300 light:text-slate-700"
            >
              새 추출
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={downloadHtml}
                className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
              >
                <FileHtml size={14} weight="fill" /> HTML
              </button>
              <button
                type="button"
                onClick={downloadDocx}
                className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:border-blue-400 hover:text-blue-400 light:border-slate-300 light:text-slate-700"
              >
                <FileDoc size={14} weight="fill" /> DOCX
              </button>
              <button
                type="button"
                onClick={downloadXlsx}
                disabled={exportingXlsx}
                className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:border-blue-400 hover:text-blue-400 disabled:cursor-not-allowed disabled:opacity-50 light:border-slate-300 light:text-slate-700"
              >
                {exportingXlsx ? (
                  <CircleNotch size={14} className="animate-spin" />
                ) : (
                  <FileXls size={14} weight="fill" />
                )}
                XLSX
              </button>
            </div>
          </>
        ) : (
          scope &&
          !running && (
            <button
              type="button"
              onClick={runExtraction}
              disabled={!canRun}
              className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <UploadSimple size={14} weight="fill" /> 추출 시작
            </button>
          )
        )}
      </ModalFooter>
    </Modal>
  );
}
