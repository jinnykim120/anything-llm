import { useEffect, useRef, useState } from "react";
import { isMobile } from "react-device-detect";
import { useTranslation } from "react-i18next";
import { X } from "@phosphor-icons/react";
import {
  combineLikeSources,
  findCombinedSourceByFocus,
} from "../ChatHistory/Citation";
import MobileCitationModal from "./MobileCitationModal";
import SourceItem from "./SourceItem";
import SourceViewer from "./SourceViewer";
import ChatSidebar, { useSourcesSidebar } from "../ChatSidebar";

// Re-export for backward compat with existing imports
export { useSourcesSidebar } from "../ChatSidebar";

export default function SourcesSidebar() {
  const { sources, sidebarOpen, focus, closeSidebar } = useSourcesSidebar();
  const { t } = useTranslation();
  const [selectedSource, setSelectedSource] = useState(null);
  const [flashTitle, setFlashTitle] = useState(null);
  const listRef = useRef(null);

  const combined = combineLikeSources(sources);

  // A click on an inline "[n]"/"[브라우징n]" marker opens the sidebar
  // pointed at the matching source — select it, scroll it into view, and
  // flash it so it's obvious which of the (possibly many) sources answered
  // that marker.
  useEffect(() => {
    if (!sidebarOpen || !focus) return;
    const match = findCombinedSourceByFocus(combined, focus);
    if (!match) return;
    setSelectedSource(match);
    setFlashTitle(match.title);
    const el = listRef.current?.querySelector(
      `[data-source-title="${CSS.escape(match.title)}"]`
    );
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const timer = setTimeout(() => setFlashTitle(null), 1600);
    return () => clearTimeout(timer);
  }, [sidebarOpen, focus, sources]);

  if (isMobile) {
    return (
      <MobileCitationModal
        sources={sources}
        isOpen={sidebarOpen}
        selectedSource={selectedSource}
        setSelectedSource={setSelectedSource}
        onClose={() => {
          setSelectedSource(null);
          closeSidebar();
        }}
      />
    );
  }

  return (
    <>
      <ChatSidebar isOpen={sidebarOpen} width={selectedSource ? 916 : 366}>
        <div className="flex items-start h-full">
          <div
            className="ml-4 w-[350px] flex-shrink-0 bg-zinc-900 light:bg-white light:border-2 light:border-slate-300 md:rounded-[16px] p-4 flex flex-col gap-4 overflow-hidden mt-[72px]"
            style={{ maxHeight: "calc(100% - 88px)" }}
          >
            <div className="flex items-start justify-between">
              <p className="font-medium text-base leading-6 text-white light:text-slate-900">
                {t("chat_window.sources")}
              </p>
              <button
                onClick={closeSidebar}
                type="button"
                className="text-white/60 light:text-slate-400 hover:text-white light:hover:text-slate-900 transition-colors border-none bg-transparent cursor-pointer"
              >
                <X size={16} weight="bold" />
              </button>
            </div>
            <div
              ref={listRef}
              className="flex flex-col gap-3 overflow-y-auto no-scroll"
            >
              {combined.map((source, idx) => (
                <div
                  key={source.title || idx}
                  data-source-title={source.title}
                  className={
                    flashTitle === source.title
                      ? "rounded-[8px] ring-2 ring-blue-500 transition-shadow"
                      : ""
                  }
                >
                  <SourceItem
                    source={source}
                    active={selectedSource?.title === source.title}
                    onClick={() =>
                      setSelectedSource(
                        selectedSource?.title === source.title ? null : source
                      )
                    }
                  />
                </div>
              ))}
            </div>
          </div>
          {selectedSource && (
            <SourceViewer
              key={selectedSource.title}
              source={selectedSource}
              onClose={() => setSelectedSource(null)}
            />
          )}
        </div>
      </ChatSidebar>
    </>
  );
}
