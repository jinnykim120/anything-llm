import { useEffect, useRef, useState } from "react";
import {
  CheckCircle,
  CircleNotch,
  CloudArrowUp,
  Plus,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import Workspace from "@/models/workspace";
import showToast from "@/utils/toast";

export const OPEN_ARCHIVE_UPLOAD_EVENT = "open-archive-upload";

const ARCHIVE_CATEGORIES = ["전체", "실적", "법규", "대외"];

function getStoredCategory() {
  if (typeof window === "undefined") return "전체";
  const stored = window.localStorage.getItem("archive-scope");
  return ARCHIVE_CATEGORIES.includes(stored) ? stored : "전체";
}

function normalizeFiles(files = []) {
  return Array.from(files).filter(Boolean);
}

export default function ArchiveUploadButton({ workspaceSlug }) {
  const inputRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const [category, setCategory] = useState(getStoredCategory);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    function openFromEvent(event) {
      const files = normalizeFiles(event.detail?.files);
      setSelectedFiles(files);
      setUploads([]);
      setCategory(getStoredCategory());
      setIsOpen(true);
    }

    window.addEventListener(OPEN_ARCHIVE_UPLOAD_EVENT, openFromEvent);
    return () =>
      window.removeEventListener(OPEN_ARCHIVE_UPLOAD_EVENT, openFromEvent);
  }, []);

  function openDialog() {
    setUploads([]);
    setSelectedFiles([]);
    setCategory(getStoredCategory());
    setIsOpen(true);
  }

  function closeDialog() {
    if (isUploading) return;
    setIsOpen(false);
    setSelectedFiles([]);
    setUploads([]);
  }

  function addFiles(files) {
    const incoming = normalizeFiles(files);
    if (!incoming.length) return;
    setSelectedFiles((prev) => {
      const seen = new Set(prev.map((file) => `${file.name}-${file.size}`));
      return [
        ...prev,
        ...incoming.filter((file) => !seen.has(`${file.name}-${file.size}`)),
      ];
    });
    setUploads([]);
  }

  function updateUpload(index, update) {
    setUploads((prev) =>
      prev.map((upload, uploadIndex) =>
        uploadIndex === index ? { ...upload, ...update } : upload
      )
    );
  }

  async function uploadFiles() {
    if (!workspaceSlug || selectedFiles.length === 0 || isUploading) return;

    setIsUploading(true);
    const queue = selectedFiles.map((file) => ({
      file,
      status: "pending",
      error: null,
    }));
    setUploads(queue);

    const results = await Promise.all(
      selectedFiles.map(async (file, index) => {
        updateUpload(index, { status: "uploading" });
        const formData = new FormData();
        const metadata = {
          title: file.name,
          docSource: file.name,
          archiveScope: category,
        };

        // Multipart text fields must precede the file field for multer to
        // expose them to the upload-and-embed endpoint.
        if (category !== "전체") formData.append("folderName", category);
        formData.append("metadata", JSON.stringify(metadata));
        formData.append("file", file, file.name);

        try {
          const { response, data } = await Workspace.uploadAndEmbedFile(
            workspaceSlug,
            formData
          );
          if (!response.ok || !data?.success) {
            const error =
              data?.error || "자료를 아카이브에 저장하지 못했습니다.";
            updateUpload(index, { status: "failed", error });
            return false;
          }
          updateUpload(index, { status: "complete" });
          return true;
        } catch (error) {
          updateUpload(index, {
            status: "failed",
            error: error?.message || "업로드 중 오류가 발생했습니다.",
          });
          return false;
        }
      })
    );

    setIsUploading(false);
    if (results.every(Boolean)) {
      showToast(
        `${results.length}개 자료를 ${category === "전체" ? "전체" : category} 아카이브에 저장했습니다.`,
        "success",
        { clear: true }
      );
      window.dispatchEvent(new Event("archive-documents-uploaded"));
      setTimeout(() => closeDialog(), 600);
    } else {
      showToast(
        "일부 자료를 저장하지 못했습니다. 결과를 확인해 주세요.",
        "error",
        {
          clear: true,
        }
      );
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="group inline-flex h-7 items-center gap-1 rounded-full border border-zinc-700 px-2.5 text-[11px] font-medium text-zinc-300 transition hover:border-blue-500 hover:bg-blue-950/40 hover:text-blue-200 light:border-slate-300 light:text-slate-600 light:hover:border-blue-400 light:hover:bg-blue-50 light:hover:text-blue-700"
        aria-label="자료 업로드"
      >
        <Plus size={14} weight="bold" /> 자료 업로드
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 px-4 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDialog();
          }}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-900 p-5 text-zinc-100 shadow-2xl light:border-slate-200 light:bg-white light:text-slate-900"
            role="dialog"
            aria-modal="true"
            aria-labelledby="archive-upload-title"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-300 light:text-blue-600">
                  Archive intake
                </p>
                <h2
                  id="archive-upload-title"
                  className="mt-1 text-lg font-semibold"
                >
                  자료를 아카이브에 저장
                </h2>
                <p className="mt-1 text-xs leading-5 text-zinc-400 light:text-slate-500">
                  분류를 먼저 선택하면 해당 아카이브 폴더로 저장하고 바로 검색할
                  수 있습니다.
                </p>
              </div>
              <button
                type="button"
                onClick={closeDialog}
                disabled={isUploading}
                className="rounded-full p-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-white disabled:opacity-40 light:hover:bg-slate-100 light:hover:text-slate-800"
                aria-label="업로드 창 닫기"
              >
                <X size={18} />
              </button>
            </div>

            <label className="mt-5 block text-xs font-medium text-zinc-300 light:text-slate-700">
              자료 구분
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                disabled={isUploading}
                className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-blue-500 light:border-slate-300 light:bg-slate-50 light:text-slate-800"
              >
                {ARCHIVE_CATEGORIES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <label
              className="mt-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-zinc-600 bg-zinc-950/60 px-5 py-7 text-center transition hover:border-blue-500 hover:bg-blue-950/20 light:border-slate-300 light:bg-slate-50 light:hover:border-blue-400 light:hover:bg-blue-50"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                addFiles(event.dataTransfer.files);
              }}
            >
              <CloudArrowUp
                size={30}
                className="text-blue-300 light:text-blue-600"
              />
              <span className="mt-2 text-sm font-medium">
                파일을 선택하거나 이곳에 놓으세요
              </span>
              <span className="mt-1 text-xs text-zinc-500 light:text-slate-500">
                PDF, HWP, DOCX, PPTX, XLSX 등
              </span>
              <input
                ref={inputRef}
                type="file"
                multiple
                className="sr-only"
                onChange={(event) => addFiles(event.target.files)}
                disabled={isUploading}
              />
            </label>

            {selectedFiles.length > 0 && (
              <div className="mt-4 max-h-32 space-y-1 overflow-y-auto">
                {selectedFiles.map((file, index) => {
                  const upload = uploads[index];
                  return (
                    <div
                      key={`${file.name}-${file.size}-${index}`}
                      className="flex items-center gap-2 rounded-lg bg-zinc-800/80 px-3 py-2 text-xs light:bg-slate-100"
                    >
                      {upload?.status === "uploading" ? (
                        <CircleNotch
                          size={15}
                          className="animate-spin text-blue-300"
                        />
                      ) : upload?.status === "complete" ? (
                        <CheckCircle size={15} className="text-emerald-400" />
                      ) : upload?.status === "failed" ? (
                        <WarningCircle size={15} className="text-red-400" />
                      ) : (
                        <CloudArrowUp size={15} className="text-zinc-400" />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {file.name}
                      </span>
                      {upload?.error && (
                        <span className="max-w-[180px] truncate text-[10px] text-red-300">
                          {upload.error}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeDialog}
                disabled={isUploading}
                className="rounded-lg px-3 py-2 text-xs font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-white disabled:opacity-40 light:text-slate-500 light:hover:bg-slate-100 light:hover:text-slate-800"
              >
                취소
              </button>
              <button
                type="button"
                onClick={uploadFiles}
                disabled={isUploading || selectedFiles.length === 0}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isUploading && (
                  <CircleNotch size={14} className="animate-spin" />
                )}
                {isUploading ? "저장 중…" : "아카이브에 저장"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
