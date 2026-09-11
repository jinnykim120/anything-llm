import { useMemo, useState } from "react";
import {
  X,
  ArrowLeft,
  Sparkle,
  FileHtml,
  FileDoc,
  FileXls,
  CircleNotch,
} from "@phosphor-icons/react";
import Workspace from "@/models/workspace";
import showToast from "@/utils/toast";
import DOMPurify from "@/utils/chat/purify";
import { draftBodyHtml, downloadDraftHtml } from "./exporters";

// [auto-docu 목표 3] 검색 답변 아래에서 열리는 하단 분할 패널.
// 답변 액션줄의 "문서 작성" 버튼이 아래 이벤트를 쏘면 ChatContainer 가 이 패널을 띄운다.
export const ARCHIVE_DRAFT_EVENT = "archive-open-draft";

export function openDraftPanel({ message, sources = [], chatId = null }) {
  window.dispatchEvent(
    new CustomEvent(ARCHIVE_DRAFT_EVENT, {
      detail: { message, sources, chatId },
    })
  );
}

const MODES = [
  {
    key: "report",
    label: "보고용",
    desc: "사내 보고 형식 · 개조식 · 목적 / 배경 / 현황 / 시사점 / 건의",
  },
  {
    key: "external",
    label: "대외기관용",
    desc: "공문 형식 · 정중한 경어체 · 근거와 출처 명시",
  },
];

const MODE_LABEL = {
  report: "보고용 (사내 보고)",
  external: "대외기관용 (외부 발송)",
};

export default function DraftPanel({ source, workspace, onClose }) {
  const [mode, setMode] = useState(null);
  const [instructions, setInstructions] = useState("");
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState(null); // { markdown, title }

  const previewHtml = useMemo(
    () => (draft ? DOMPurify.sanitize(draftBodyHtml(draft.markdown)) : ""),
    [draft]
  );

  async function generate() {
    if (!mode) return;
    setGenerating(true);
    setDraft(null);
    const res = await Workspace.generateDraft(workspace.slug, {
      sourceText: source.message,
      citations: source.sources || [],
      mode,
      instructions: instructions.trim(),
    });
    setGenerating(false);
    if (res?.error || !res?.draft)
      return showToast(
        res?.error || "초안 생성에 실패했습니다. 다시 시도해 주세요.",
        "error"
      );
    setDraft({
      markdown: res.draft,
      title: res.title || `${MODE_LABEL[mode]} 초안`,
    });
    showToast("초안이 생성되었습니다.", "success");
  }

  function downloadHtml() {
    if (!draft) return;
    downloadDraftHtml({
      markdown: draft.markdown,
      title: draft.title,
      modeLabel: MODE_LABEL[mode],
    });
    showToast("HTML 파일을 내려받았습니다.", "success");
  }

  return (
    <div className="flex h-[50%] shrink-0 flex-col border-t-2 border-blue-500/40 bg-white light:bg-white dark:bg-zinc-950">
      {/* 헤더 */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-zinc-800">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-zinc-100">
          <Sparkle size={16} weight="fill" className="text-blue-500" />
          문서 초안 작성
          {mode && (
            <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-300">
              {MODES.find((m) => m.key === mode)?.label}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-zinc-800"
          aria-label="초안 패널 닫기"
        >
          <X size={16} />
        </button>
      </div>

      {/* 본문 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {/* 1단계: 유형 선택 */}
        {!mode && (
          <div className="mx-auto flex max-w-xl flex-col gap-3 py-2">
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              위 답변을 바탕으로 어떤 문서를 만들까요? 사실 내용은 그대로 두고
              형식과 표현만 다듬습니다.
            </p>
            {MODES.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMode(m.key)}
                className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-blue-400 hover:bg-blue-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
              >
                <span className="block text-sm font-semibold text-slate-800 dark:text-zinc-100">
                  {m.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 dark:text-zinc-400">
                  {m.desc}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* 2단계: 추가 요청 + 생성 */}
        {mode && !draft && !generating && (
          <div className="mx-auto flex max-w-xl flex-col gap-3 py-2">
            <button
              type="button"
              onClick={() => setMode(null)}
              className="flex w-fit items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200"
            >
              <ArrowLeft size={12} /> 유형 다시 선택
            </button>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-600 dark:text-zinc-300">
                추가 요청 사항 (선택)
              </span>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={4}
                placeholder="예: A4 1장 분량으로 / 핵심만 간결하게 / 수신처는 OO부 / 마지막에 건의사항 강조"
                className="resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-800 outline-none focus:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </label>
            <button
              type="button"
              onClick={generate}
              className="flex w-fit items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
            >
              <Sparkle size={14} weight="fill" /> 초안 생성
            </button>
          </div>
        )}

        {/* 생성 중 */}
        {generating && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500 dark:text-zinc-400">
            <CircleNotch size={22} className="animate-spin" />
            <p className="text-xs">
              {MODE_LABEL[mode]} 초안을 작성하고 있습니다…
            </p>
          </div>
        )}

        {/* 결과 */}
        {draft && !generating && (
          <div className="mx-auto max-w-2xl">
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="mb-2 flex w-fit items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200"
            >
              <ArrowLeft size={12} /> 요청 수정 / 다시 생성
            </button>
            <div
              className="draft-preview rounded-lg border border-slate-200 bg-white px-5 py-4 text-sm leading-7 text-slate-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </div>
        )}
      </div>

      {/* 다운로드 바 */}
      {draft && !generating && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-2.5 dark:border-zinc-800">
          <span className="text-[11px] font-medium text-slate-500 dark:text-zinc-400">
            내보내기
          </span>
          <button
            type="button"
            onClick={downloadHtml}
            className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
          >
            <FileHtml size={15} weight="fill" /> HTML 다운로드
          </button>
          <DisabledExport icon={FileDoc} label="DOCX" />
          <DisabledExport icon={FileXls} label="XLSX" />
        </div>
      )}
    </div>
  );
}

function DisabledExport({ icon: Icon, label }) {
  return (
    <button
      type="button"
      disabled
      title={`${label} 내보내기는 준비 중입니다`}
      className="flex cursor-not-allowed items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1 text-xs font-medium text-slate-400 dark:border-zinc-800 dark:text-zinc-600"
    >
      <Icon size={15} />
      <span className="flex flex-col items-start leading-none">
        {label}
        <span className="text-[9px] font-normal">준비 중</span>
      </span>
    </button>
  );
}
