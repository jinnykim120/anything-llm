import {
  parseChunkSource,
  SourceTypeCircle,
  getCustomImage,
} from "../../ChatHistory/Citation";
import { useTranslation } from "react-i18next";

export default function SourceItem({ source, onClick, active = false }) {
  const { t } = useTranslation();
  const info = parseChunkSource(source);
  const customImage = getCustomImage(info?.icon);
  const subtitle = info?.isUrl ? info?.text : t("chat_window.document");
  const hasOriginal = !!source?.has_original;
  const citedPages = [
    ...new Set(
      (source?.chunks || [])
        .map((chunk) => Number(chunk.page) || 0)
        .filter(Boolean)
    ),
  ];
  const section = (source?.chunks?.[0]?.section_path || "")
    .split(">")
    .pop()
    .trim();
  // [auto-docu] the "[n]" number(s) the answer cited this source as — lets
  // the user match an inline "[3]" in the answer to this item at a glance.
  const citationIndexes = [...new Set(source?.citationIndexes || [])].sort(
    (a, b) => a - b
  );
  // [auto-docu 외부검색] same idea for a live web-search result's "[브라우징n]".
  const browsingIndexes = [...new Set(source?.browsingIndexes || [])].sort(
    (a, b) => a - b
  );

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col gap-[2px] items-start w-full text-left rounded-md p-1 -m-1 transition-colors ${
        active ? "bg-amber-500/10 ring-1 ring-amber-500/40" : "hover:opacity-75"
      }`}
    >
      <div className="flex gap-[6px] items-start w-full">
        <SourceTypeCircle
          type={info.icon}
          size={16}
          iconSize={10}
          url={info.href}
          customImage={customImage}
        />
        <p className="flex-1 font-medium text-sm text-white light:text-slate-900 leading-[15px] truncate">
          {source.title}
        </p>
        {citationIndexes.length > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-amber-400 light:text-amber-600">
            {citationIndexes.map((n) => `[${n}]`).join("")}
          </span>
        )}
        {browsingIndexes.length > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-sky-400 light:text-sky-600">
            {browsingIndexes.map((n) => `[브라우징${n}]`).join("")}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-[2px] pl-[22px] text-[10px] text-zinc-400 light:text-slate-500 leading-[14px]">
        <p>{subtitle}</p>
        <p>
          {t("chat_window.source_count", { count: source.references })}
          {hasOriginal ? " · 원본 보기" : ""}
        </p>
        {(citedPages.length > 0 || section) && (
          <p className="truncate text-zinc-500 light:text-slate-400">
            {citedPages.length > 0 && `p.${citedPages.join(", ")}`}
            {citedPages.length > 0 && section ? " · " : ""}
            {section}
          </p>
        )}
      </div>
    </button>
  );
}
