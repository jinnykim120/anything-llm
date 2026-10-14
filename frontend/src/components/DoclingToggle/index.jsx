import { useCallback, useEffect, useRef, useState } from "react";
import Workspace from "@/models/workspace";

// [auto-docu] Docling(고급 문서 파서) 켜기/끄기 버튼. 문서함·자료 적재·관리
// 화면에서 같이 쓴다. 상태는 서버 /docling/status 를 폴링해서 보여주므로
// 한 화면에서 켜면 다른 화면도 곧 같은 상태가 된다.
export default function DoclingToggle({
  compact = false,
  variant = "page", // "page" | "modal"(자료 업로드 창: 어두운 기본 + light: 변형)
  className = "",
}) {
  const modal = variant === "modal";
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const s = await Workspace.doclingStatus();
    if (alive.current && s && !s.error) setSt(s);
    return s;
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  // 켜는 중이면 자주, 아니면 가끔 (유휴 자동 종료 반영용)
  useEffect(() => {
    const ms = st?.starting || busy ? 2500 : 20000;
    const t = setInterval(refresh, ms);
    return () => clearInterval(t);
  }, [st?.starting, busy, refresh]);

  async function turnOn(force = false) {
    setBusy(true);
    setErr(null);
    const r = await Workspace.doclingStart(force);
    if (r?.needsConfirm) {
      setBusy(false);
      if (window.confirm(`${r.message}\n\n그래도 켤까요?`)) return turnOn(true);
      return;
    }
    if (r?.error || r?.ok === false) setErr(r.message || r.error);
    await refresh();
    setBusy(false);
  }

  async function turnOff() {
    if (
      !window.confirm(
        "Docling을 끌까요? 진행 중인 파싱이 있으면 중단될 수 있습니다."
      )
    )
      return;
    setBusy(true);
    setErr(null);
    const r = await Workspace.doclingStop();
    if (r?.ok === false) setErr(r.message);
    await refresh();
    setBusy(false);
  }

  if (!st) return null;
  const on = st.running;
  const starting = st.starting || (busy && !on);
  const label = starting
    ? "Docling 켜는 중…"
    : on
      ? "Docling 켜짐"
      : "Docling 꺼짐";
  const dot = starting
    ? "bg-amber-400 animate-pulse"
    : on
      ? "bg-emerald-500"
      : "bg-slate-300 dark:bg-zinc-600";

  return (
    <div className={className}>
      <div
        className={`flex items-center gap-2 rounded border px-3 py-2 ${
          modal
            ? "border-zinc-700 bg-zinc-950 light:border-slate-300 light:bg-slate-50"
            : "border-slate-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
        }`}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span
          className={`text-xs font-semibold ${
            modal
              ? "text-zinc-200 light:text-slate-700"
              : "text-slate-700 dark:text-zinc-200"
          }`}
        >
          {label}
        </span>
        <button
          type="button"
          onClick={on ? turnOff : () => turnOn(false)}
          disabled={starting || busy}
          className={`ml-auto rounded px-2 py-1 text-[11px] font-semibold transition disabled:opacity-50 ${
            on
              ? "border border-slate-300 text-slate-600 hover:border-red-400 hover:text-red-600 dark:border-zinc-700 dark:text-zinc-300"
              : "bg-blue-600 text-white hover:bg-blue-700"
          }`}
        >
          {on ? "끄기" : "켜기"}
        </button>
      </div>
      {!compact && (
        <p
          className={`mt-1.5 text-[10px] leading-4 ${
            modal
              ? "text-zinc-500 light:text-slate-500"
              : "text-slate-400 dark:text-zinc-600"
          }`}
        >
          표·구조가 있는 PDF/PPTX를 더 정확히 읽습니다. 메모리를 많이 쓰므로
          자료 적재할 때만 켜고, 끝나면 꺼 주세요.
          {on && st.autoStopMinutes > 0
            ? ` ${st.autoStopMinutes}분간 사용하지 않으면 자동으로 꺼집니다${
                st.idleMinutes != null ? ` (유휴 ${st.idleMinutes}분)` : ""
              }.`
            : ""}
          {!on && ` 현재 여유 메모리 ${st.freeGb}GB.`}
        </p>
      )}
      {err && (
        <p className="mt-1 text-[10px] text-red-600 dark:text-red-400">{err}</p>
      )}
    </div>
  );
}
