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

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col gap-[2px] items-start w-full text-left rounded-md p-1 -m-1 transition-colors ${
        active
          ? "bg-amber-500/10 ring-1 ring-amber-500/40"
          : "hover:opacity-75"
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
      </div>
      <div className="flex flex-col gap-[2px] pl-[22px] text-[10px] text-zinc-400 light:text-slate-500 leading-[14px]">
        <p>{subtitle}</p>
        <p>
          {t("chat_window.source_count", { count: source.references })}
          {hasOriginal ? " · 원본 보기" : ""}
        </p>
      </div>
    </button>
  );
}
