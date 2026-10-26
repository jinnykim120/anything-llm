import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ShieldCheck, ShieldSlash } from "@phosphor-icons/react";
import NexusAccess from "@/models/nexusAccess";
import { NEXUS_ACCESS_CHANGED_EVENT, notifyNexusAccessChanged } from "./events";
import { ADMIN_LOGIN_PATH } from "@/utils/nexusClient";

export { NEXUS_ACCESS_CHANGED_EVENT, notifyNexusAccessChanged };

/**
 * 화면 한쪽 구석의 작은 관리자 콘솔 바로가기. 눌러서 관리자 콘솔로 들어간다 — 로그인과
 * 관리 작업은 모두 콘솔에서 한다. 관리자 비밀번호가 서버에 없으면 아무것도 그리지 않는다.
 */
export default function AdminBadge() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [state, setState] = useState({
    adminEnabled: false,
    adminAuthed: false,
  });

  const load = useCallback(async () => {
    const r = await NexusAccess.access();
    if (r.ok)
      setState({
        adminEnabled: !!r.data.adminEnabled,
        adminAuthed: !!r.data.adminAuthed,
      });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(NEXUS_ACCESS_CHANGED_EVENT, load);
    return () => window.removeEventListener(NEXUS_ACCESS_CHANGED_EVENT, load);
  }, [load, pathname]);

  if (!state.adminEnabled || pathname.startsWith(ADMIN_LOGIN_PATH)) return null;

  return (
    <button
      type="button"
      onClick={() => navigate(ADMIN_LOGIN_PATH)}
      title={state.adminAuthed ? "관리자 콘솔 (로그인됨)" : "관리자 콘솔"}
      className={`fixed bottom-3 left-3 z-40 flex h-8 w-8 items-center justify-center rounded-full border text-sm shadow ${
        state.adminAuthed
          ? "border-emerald-500 bg-emerald-600/20 text-emerald-400"
          : "border-zinc-700 bg-zinc-900/80 text-zinc-400 hover:text-zinc-100 light:border-slate-300 light:bg-white light:text-slate-500"
      }`}
    >
      {state.adminAuthed ? (
        <ShieldCheck size={18} />
      ) : (
        <ShieldSlash size={18} />
      )}
    </button>
  );
}
