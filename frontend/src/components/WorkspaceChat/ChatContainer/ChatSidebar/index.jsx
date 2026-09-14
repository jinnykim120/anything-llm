import { createContext, useContext, useState } from "react";

const ChatSidebarContext = createContext();

export function ChatSidebarProvider({ children }) {
  const [activeSidebar, setActiveSidebar] = useState(null);
  const [sidebarData, setSidebarData] = useState(null);

  function openSidebar(type, data = null) {
    setActiveSidebar(type);
    setSidebarData(data);
  }

  function closeSidebar() {
    setActiveSidebar(null);
    setSidebarData(null);
  }

  function toggleSidebar(type, data = null) {
    if (activeSidebar === type) closeSidebar();
    else openSidebar(type, data);
  }

  return (
    <ChatSidebarContext.Provider
      value={{
        activeSidebar,
        sidebarData,
        openSidebar,
        closeSidebar,
        toggleSidebar,
      }}
    >
      {children}
    </ChatSidebarContext.Provider>
  );
}

export function useChatSidebar() {
  return useContext(ChatSidebarContext);
}

export function useSourcesSidebar() {
  const { activeSidebar, sidebarData, openSidebar, closeSidebar } =
    useContext(ChatSidebarContext);
  const isOpen = activeSidebar === "sources";
  const data = isOpen ? sidebarData : null;
  return {
    sidebarOpen: isOpen,
    // `sidebarData` is either a plain sources array (older callers) or
    // `{ sources, focus }` (a click on an inline "[n]"/"[브라우징n]" marker).
    // `focus` is `{ citationIndex }` for an internal source or
    // `{ browsingIndex }` for an external web-search result.
    sources: (Array.isArray(data) ? data : data?.sources) || [],
    focus: Array.isArray(data) ? null : (data?.focus ?? null),
    openSidebar: (sources, focus = null) =>
      openSidebar("sources", { sources, focus }),
    closeSidebar,
  };
}

export function useMemoriesSidebar() {
  const { activeSidebar, toggleSidebar, closeSidebar } =
    useContext(ChatSidebarContext);
  return {
    sidebarOpen: activeSidebar === "memories",
    toggleSidebar: () => toggleSidebar("memories"),
    closeSidebar,
  };
}

/**
 * Reusable animation wrapper for right-side chat panels.
 * Uses a fixed-width wrapper + GPU-composited translateX so opening/closing
 * never triggers layout recalculation on the chat history (which can have
 * 500+ message nodes).
 */
export default function ChatSidebar({ isOpen, children, width = 366 }) {
  return (
    <div
      className="h-full flex-shrink-0 overflow-hidden"
      style={{
        width: isOpen ? `${width}px` : "0px",
        transition: "width 400ms cubic-bezier(0.4,0,0.2,1)",
        willChange: isOpen ? "width" : "auto",
        contain: "size layout",
      }}
    >
      <div
        className="h-full"
        style={{
          width: `${width}px`,
          transform: isOpen ? "translateX(0)" : "translateX(100%)",
          transition: "transform 400ms cubic-bezier(0.4,0,0.2,1)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
