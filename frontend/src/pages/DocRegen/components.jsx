// [auto-docu 전사문서작성tool] 단계 카드·다음 버튼·폴더 행·필요 자료 상세 패널.
// index.jsx 에서 분리한 표시용 컴포넌트(상태 없음).
import {
  ArrowLeft,
  CaretDown,
  CaretRight,
  Folder,
  X,
  ArrowRight,
  CheckSquare,
  Square,
} from "@phosphor-icons/react";
import showToast from "@/utils/toast";

export function StepCard({ heading, description, onBack, children }) {
  return (
    <div className="flex flex-col gap-4">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="flex w-fit items-center gap-1 text-xs text-slate-500 hover:text-slate-800 dark:text-zinc-500 dark:hover:text-zinc-200"
        >
          <ArrowLeft size={12} /> 이전
        </button>
      )}
      <div>
        <h1 className="text-xl font-semibold">{heading}</h1>
        {description && (
          <p className="mt-1.5 text-sm text-slate-500 dark:text-zinc-400">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

export function NextButton({ onClick, disabled, label = "다음" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mt-4 flex w-fit items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label} <ArrowRight size={15} weight="bold" />
    </button>
  );
}

/** 문서함 폴더 선택 행 — 체크(선택, 중복 가능)와 펼치기(하위 폴더 보기)가
 * 분리된 별도 클릭 영역이다. "전체 문서"처럼 하위가 없으면 펼치기 버튼이 없다. */
export function FolderRow({
  label,
  count,
  indent = false,
  checked,
  onToggle,
  expandable = false,
  expanded = false,
  onExpand,
}) {
  return (
    <div
      className={`flex w-full items-center gap-2 border-b border-slate-100 py-2.5 text-left text-sm last:border-b-0 dark:border-zinc-800 ${
        indent ? "pl-9 pr-3" : "pl-3 pr-3"
      } ${checked ? "bg-violet-50 dark:bg-violet-950/20" : ""}`}
    >
      {expandable ? (
        <button
          type="button"
          onClick={onExpand}
          className="shrink-0 text-slate-400 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-200"
        >
          {expanded ? <CaretDown size={13} /> : <CaretRight size={13} />}
        </button>
      ) : (
        <span className="inline-block w-[13px] shrink-0" />
      )}
      <button
        type="button"
        onClick={onToggle}
        className="flex flex-1 items-center gap-2 hover:text-violet-700"
      >
        {checked ? (
          <CheckSquare
            size={16}
            weight="fill"
            className="shrink-0 text-violet-600"
          />
        ) : (
          <Square
            size={16}
            className="shrink-0 text-slate-300 dark:text-zinc-700"
          />
        )}
        <Folder
          size={15}
          className="shrink-0 text-slate-400 dark:text-zinc-500"
        />
        <span className="truncate">{label}</span>
      </button>
      {typeof count === "number" && (
        <span className="shrink-0 text-[11px] text-slate-400 dark:text-zinc-600">
          {count}건
        </span>
      )}
    </div>
  );
}

/** [자료 필요] 클릭 시 — 근거(신규 기준)와 과거 참고자료를 보여주는 패널. */
export function NeedDetailPanel({ need, onClose }) {
  const { description, section } = need;

  function copyForRequest() {
    const lines = [
      `[${section?.title || "절"}] ${description}`,
      section?.guidanceExcerpt
        ? `근거(신규 기준): ${section.guidanceExcerpt}`
        : "",
      section?.priorContent
        ? `과거(작년) 참고자료: ${section.priorContent.slice(0, 500)}`
        : "과거 참고자료: 없음(완전 신규 항목)",
    ].filter(Boolean);
    navigator.clipboard?.writeText(lines.join("\n\n"));
    showToast("요청 문구를 복사했습니다.", "success");
  }

  return (
    <div className="fixed inset-y-0 right-0 z-30 flex w-[380px] flex-col border-l border-slate-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-zinc-800">
        <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
          자료 필요
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <p className="text-xs text-slate-400 dark:text-zinc-600">
          {section?.title}
        </p>
        <p className="mt-1 text-sm font-medium">{description}</p>

        <div className="mt-5">
          <p className="text-xs font-semibold text-slate-500 dark:text-zinc-400">
            근거 (신규 기준/가이던스)
          </p>
          <p className="mt-1.5 whitespace-pre-line rounded-md bg-slate-50 p-3 text-xs leading-5 text-slate-700 dark:bg-zinc-900 dark:text-zinc-300">
            {section?.guidanceExcerpt ||
              "이 절과 직접 연결된 신규 기준 발췌가 없습니다."}
          </p>
        </div>

        <div className="mt-4">
          <p className="text-xs font-semibold text-slate-500 dark:text-zinc-400">
            과거(작년) 참고자료
          </p>
          {section?.priorContent ? (
            <p className="mt-1.5 whitespace-pre-line rounded-md bg-slate-50 p-3 text-xs leading-5 text-slate-700 dark:bg-zinc-900 dark:text-zinc-300">
              {section.priorContent.slice(0, 1500)}
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-slate-400 dark:text-zinc-600">
              작년 문서에는 없던 완전 신규 항목입니다.
            </p>
          )}
        </div>
      </div>
      <div className="border-t border-slate-200 p-3 dark:border-zinc-800">
        <button
          type="button"
          onClick={copyForRequest}
          className="w-full rounded-md bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-700"
        >
          이 항목 요청 문구 복사
        </button>
      </div>
    </div>
  );
}
