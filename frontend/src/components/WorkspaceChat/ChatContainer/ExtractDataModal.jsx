import { useEffect, useMemo, useState } from "react";
import {
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

  const workTypeCounts = useMemo(() => {
    const counts = new Map();
    for (const doc of documents) {
      const hash = docContentHashOf(doc);
      const cls = hash && classificationsByHash[hash];
      const workType = cls?.workType?.trim() || "미분류";
      counts.set(workType, (counts.get(workType) || 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, "ko"));
  }, [documents, classificationsByHash]);

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
  const canRun =
    fields.trim() &&
    (uploadedDocs.length > 0 || folderKeys.length > 0) &&
    !running;

  async function runExtraction() {
    if (!canRun) return;
    setRunning(true);
    setResult(null);
    const res = await Workspace.runExtractData(workspace.slug, {
      fields: fields.trim(),
      uploadedDocs,
      folderKeys,
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
                className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-blue-400 hover:bg-blue-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
              >
                <span className="block text-sm font-semibold text-slate-800 dark:text-zinc-100">
                  {opt.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 dark:text-zinc-400">
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
              className="flex w-fit items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200"
            >
              범위 다시 선택
            </button>

            {needsUpload && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                  파일 업로드
                </span>
                <input
                  type="file"
                  multiple
                  onChange={handleFilePicked}
                  disabled={uploading}
                  className="text-[11px] text-slate-500 dark:text-zinc-400"
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
                <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                  문서함 폴더 선택
                </span>
                <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-zinc-800">
                  {workTypeCounts.map(([workType, count]) => (
                    <label
                      key={workType}
                      className="flex items-center gap-2 text-xs text-slate-600 dark:text-zinc-300"
                    >
                      <input
                        type="checkbox"
                        checked={selectedWorkTypes.includes(workType)}
                        onChange={() => toggleWorkType(workType)}
                      />
                      {workType}{" "}
                      <span className="text-slate-400">{count}건</span>
                    </label>
                  ))}
                  {!workTypeCounts.length && (
                    <span className="text-[11px] text-slate-400">
                      불러오는 중...
                    </span>
                  )}
                </div>
              </div>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                추출하고 싶은 항목을 알려주세요
              </span>
              <textarea
                value={fields}
                onChange={(e) => setFields(e.target.value)}
                rows={2}
                placeholder="예: 매출액, 영업이익, 점포수"
                className="resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-800 outline-none focus:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
          </div>
        )}

        {running && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-slate-500 dark:text-zinc-400">
            <CircleNotch size={22} className="animate-spin" />
            <p className="text-xs">문서를 전부 훑어 추출하는 중입니다...</p>
          </div>
        )}

        {result && (
          <div className="flex flex-col gap-2">
            <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-zinc-800">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    <th className="border border-slate-200 bg-slate-50 px-2 py-1 text-left font-semibold text-slate-700 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
                      문서
                    </th>
                    {resultFieldNames().map((n) => (
                      <th
                        key={n}
                        className="border border-slate-200 bg-slate-50 px-2 py-1 text-left font-semibold text-slate-700 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
                      >
                        {n}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.documents.map((d, i) => (
                    <tr key={i}>
                      <td className="border border-slate-200 px-2 py-1 font-medium text-slate-700 dark:border-zinc-800 dark:text-zinc-300">
                        {d.title}
                      </td>
                      {resultFieldNames().map((n) => (
                        <td
                          key={n}
                          title={d.values?.[n]?.evidence || ""}
                          className="border border-slate-200 px-2 py-1 text-slate-600 dark:border-zinc-800 dark:text-zinc-400"
                        >
                          {d.values?.[n]?.value || "(없음)"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-zinc-500">
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
              className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-blue-400 hover:text-blue-600 dark:border-zinc-700 dark:text-zinc-300"
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
                className="flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-blue-400 hover:text-blue-600 dark:border-zinc-700 dark:text-zinc-300"
              >
                <FileDoc size={14} weight="fill" /> DOCX
              </button>
              <button
                type="button"
                onClick={downloadXlsx}
                disabled={exportingXlsx}
                className="flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-blue-400 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
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
