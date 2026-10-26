import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE } from "@/utils/constants";

const GLOBAL_LINKS = [
  ["LLM 설정", "/settings/llm-preference"],
  ["임베딩 설정", "/settings/embedding-preference"],
  ["벡터 데이터베이스", "/settings/vector-database"],
  ["텍스트 분할", "/settings/text-splitter-preference"],
  ["에이전트", "/settings/agents"],
  ["API 키", "/settings/api-keys"],
  ["이벤트 로그", "/settings/event-logs"],
  ["채팅 기록(전체)", "/settings/workspace-chats"],
  ["보안", "/settings/security"],
  ["개인정보·데이터", "/settings/privacy"],
  ["화면 설정", "/settings/interface"],
  ["브랜딩", "/settings/branding"],
  ["기본 시스템 프롬프트", "/settings/default-system-prompt"],
  ["채팅 설정", "/settings/chat"],
  ["작업공간 관리", "/settings/workspaces"],
  ["임베드 위젯", "/settings/embed-chat-widgets"],
  ["예약 작업", "/settings/scheduled-jobs"],
  ["베타 기능", "/settings/beta-features"],
];

const WORKSPACE_LINKS = [
  ["작업공간 설정(질의 환경)", (s) => `/workspace/${s}/settings/chat-settings`],
  ["문서 연계성", (s) => `/workspace/${s}/affinity`],
  ["호출량", (s) => `/workspace/${s}/usage`],
];

export default function SystemTab() {
  const [slug, setSlug] = useState(null);
  const [server, setServer] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/workspaces`)
      .then((r) => r.json())
      .then((d) => setSlug(d.workspaces?.[0]?.slug || null))
      .catch(() => {});
    fetch(`${API_BASE}/ping`)
      .then((r) => r.json())
      .then((d) => setServer(!!d.online))
      .catch(() => setServer(false));
  }, []);

  const card =
    "rounded-md border border-slate-200 bg-white px-3 py-2 text-sm hover:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900";
  return (
    <div>
      <p className="text-xs text-slate-500 dark:text-zinc-400">
        서버 상태: {server === null ? "확인 중" : server ? "정상" : "응답 없음"}
        . 아래 설정 화면은 관리자 로그인 상태에서만 열립니다.
      </p>
      <h2 className="mt-5 text-sm font-semibold">시스템 설정</h2>
      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3">
        {GLOBAL_LINKS.map(([label, to]) => (
          <Link key={to} to={to} className={card}>
            {label}
          </Link>
        ))}
      </div>
      {slug && (
        <>
          <h2 className="mt-6 text-sm font-semibold">작업공간별</h2>
          <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3">
            {WORKSPACE_LINKS.map(([label, build]) => (
              <Link key={label} to={build(slug)} className={card}>
                {label}
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
