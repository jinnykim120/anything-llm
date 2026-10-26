import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ShieldCheck, SignOut } from "@phosphor-icons/react";
import NexusAccess from "@/models/nexusAccess";
import { notifyNexusAccessChanged } from "@/components/NexusAccess/events";
import OverviewTab from "./OverviewTab";
import FoldersTab from "./FoldersTab";
import ChatsTab from "./ChatsTab";
import SystemTab from "./SystemTab";

const TABS = [
  { key: "overview", label: "개요", Component: OverviewTab },
  { key: "folders", label: "폴더 관리", Component: FoldersTab },
  { key: "chats", label: "전체 대화", Component: ChatsTab },
  { key: "system", label: "시스템·설정", Component: SystemTab },
];

function minutesLeft(expiresAt) {
  if (!expiresAt) return null;
  return Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / 60000));
}

function LoginForm({ onLoggedIn, enabled }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const r = await NexusAccess.adminLogin(password);
    setBusy(false);
    if (!r.ok) return setError(r.message || "로그인하지 못했습니다.");
    setPassword("");
    onLoggedIn();
  }

  return (
    <form
      onSubmit={submit}
      className="mx-auto mt-24 w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex items-center gap-2 text-slate-800 dark:text-zinc-100">
        <ShieldCheck size={22} weight="fill" className="text-blue-600" />
        <h1 className="text-base font-semibold">관리자 콘솔</h1>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-zinc-400">
        설정과 전체 폴더·대화를 관리하는 화면입니다. 관리자 비밀번호를 입력해
        들어오세요. 평소 사용 화면은 관리자도 일반 사용자와 똑같이 동작합니다.
      </p>
      {enabled === false ? (
        <p className="mt-4 text-xs text-amber-600">
          서버에 관리자 비밀번호가 설정돼 있지 않습니다 (NEXUS_ADMIN_PASSWORD).
        </p>
      ) : (
        <>
          <input
            type="password"
            autoFocus
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="관리자 비밀번호"
            className="mt-4 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={busy || !password}
            className="mt-4 h-9 w-full rounded-md border-none bg-slate-900 text-sm font-medium text-white hover:opacity-80 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy ? "확인 중..." : "로그인"}
          </button>
        </>
      )}
      <Link
        to="/"
        className="mt-4 block text-center text-xs text-slate-500 hover:underline dark:text-zinc-400"
      >
        일반 화면으로 돌아가기
      </Link>
    </form>
  );
}

export default function NexusAdmin() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [access, setAccess] = useState(null);
  const [tab, setTab] = useState("overview");

  const load = useCallback(async () => {
    const r = await NexusAccess.access();
    setAccess(r.ok ? r.data : { adminEnabled: false, adminAuthed: false });
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60 * 1000);
    return () => clearInterval(timer);
  }, [load]);

  async function loggedIn() {
    notifyNexusAccessChanged();
    const next = params.get("next");
    if (next && next.startsWith("/") && !next.startsWith("//")) {
      navigate(next, { replace: true });
      return;
    }
    await load();
  }

  async function logout() {
    await NexusAccess.adminLogout();
    notifyNexusAccessChanged();
    await load();
  }

  if (!access)
    return <div className="p-10 text-sm text-slate-500">불러오는 중...</div>;

  const Active = TABS.find((t) => t.key === tab)?.Component || OverviewTab;
  const left = minutesLeft(access.adminExpiresAt);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 dark:bg-zinc-950 dark:text-zinc-200">
      {!access.adminAuthed ? (
        <LoginForm onLoggedIn={loggedIn} enabled={access.adminEnabled} />
      ) : (
        <div className="mx-auto max-w-5xl px-6 py-8">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ShieldCheck
                size={24}
                weight="fill"
                className="text-emerald-500"
              />
              <h1 className="text-lg font-semibold">관리자 콘솔</h1>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-zinc-400">
              {left !== null && (
                <span>로그인 유지 약 {left}분 (사용하면 연장)</span>
              )}
              <Link to="/" className="hover:underline">
                일반 화면으로
              </Link>
              <button
                type="button"
                onClick={logout}
                className="flex items-center gap-1 rounded-md border border-slate-300 bg-transparent px-2 py-1 text-xs hover:bg-slate-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <SignOut size={14} /> 로그아웃
              </button>
            </div>
          </header>

          <nav className="mt-6 flex gap-1 border-b border-slate-200 dark:border-zinc-800">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`-mb-px border-0 border-b-2 bg-transparent px-4 py-2 text-sm font-medium ${
                  tab === t.key
                    ? "border-blue-600 text-blue-700 dark:text-blue-400"
                    : "border-transparent text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <main className="mt-6">
            <Active />
          </main>
        </div>
      )}
    </div>
  );
}
