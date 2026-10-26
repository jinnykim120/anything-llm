import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { FullScreenLoader } from "@/components/Preloader";
import NexusAccess from "@/models/nexusAccess";
import { ADMIN_LOGIN_PATH } from "@/utils/nexusClient";

/**
 * 설정·관리 화면을 관리자 로그인 뒤에만 보여 준다. 관리자 비밀번호가 서버에 설정돼 있지
 * 않으면 기존처럼 그냥 연다. 서버 응답을 못 받으면 화면은 열되 서버가 요청을 막는다.
 */
export default function AdminGate({ children }) {
  const location = useLocation();
  const [state, setState] = useState("loading"); // loading | ok | login

  useEffect(() => {
    let cancelled = false;
    NexusAccess.access().then((r) => {
      if (cancelled) return;
      if (!r.ok || !r.data.adminEnabled || r.data.adminAuthed) setState("ok");
      else setState("login");
    });
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  if (state === "loading") return <FullScreenLoader />;
  if (state === "login")
    return (
      <Navigate
        to={`${ADMIN_LOGIN_PATH}?next=${encodeURIComponent(location.pathname)}`}
        replace
      />
    );
  return children;
}
