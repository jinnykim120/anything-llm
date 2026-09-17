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

// [auto-docu 좌우 폭 조절] 출처 목록 폭 — 페이지 목록(p.51, 52, 53...)이
// 길어지면 truncate로 잘리므로, 사용자가 드래그로 넓혀서 전체를 볼 수 있게 한다.
const LIST_WIDTH_STORAGE_KEY = "archive-sources-list-width";
const LIST_WIDTH_MIN = 260;
const LIST_WIDTH_MAX = 640;
const VIEWER_WIDTH = 520; // SourceViewer/index.jsx의 w-[520px]와 동일
function clampListWidth(width) {
  return Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, width));
}

export default function SourcesSidebar() {
  const { sources, sidebarOpen, focus, closeSidebar } = useSourcesSidebar();
  const { t } = useTranslation();
  const [selectedSource, setSelectedSource] = useState(null);
  const [flashTitle, setFlashTitle] = useState(null);
  const listRef = useRef(null);
  const [listWidth, setListWidth] = useState(() => {
    const stored = Number(localStorage.getItem(LIST_WIDTH_STORAGE_KEY));
    return clampListWidth(stored > 0 ? stored : 350);
  });

  function startListResize(event) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = listWidth;
    function onMove(moveEvent) {
      setListWidth(clampListWidth(startWidth + (moveEvent.clientX - startX)));
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setListWidth((current) => {
        localStorage.setItem(LIST_WIDTH_STORAGE_KEY, String(current));
        return current;
      });
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

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
      <ChatSidebar
        isOpen={sidebarOpen}
        width={16 + listWidth + (selectedSource ? 16 + VIEWER_WIDTH : 0)}
      >
        <div className="flex items-start h-full">
          <div
            className="ml-4 flex-shrink-0 bg-zinc-900 light:bg-white light:border-2 light:border-slate-300 md:rounded-[16px] p-4 flex flex-col gap-4 overflow-hidden mt-[72px] relative"
            style={{ maxHeight: "calc(100% - 88px)", width: listWidth }}
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
            {/* [auto-docu 좌우 폭 조절] 드래그로 목록 폭 조절 */}
            <div
              onMouseDown={startListResize}
              role="separator"
              aria-orientation="vertical"
              aria-label="출처 목록 폭 조절"
              className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-blue-500/40 active:bg-blue-500/70"
            />
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
