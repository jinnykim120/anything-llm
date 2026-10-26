import { useCallback, useEffect, useState } from "react";
import { Lock, LockOpen, ShieldCheck } from "@phosphor-icons/react";
import Modal, {
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalHint,
  ModalSecondaryButton,
} from "@/components/lib/Modal";
import NexusAccess from "@/models/nexusAccess";
import UnlockFolderModal from "./UnlockFolderModal";
import { NEXUS_ACCESS_CHANGED_EVENT, notifyNexusAccessChanged } from "./events";

const REFRESH_MS = 60 * 1000;

const EXPLAIN =
  "잠긴 폴더의 문서는 비밀번호로 열기 전에는 검색·답변에 쓰이지 않습니다. " +
  "'자료에 없다'는 답이 나오면 잠긴 폴더 때문일 수 있습니다.";

/**
 * 지금 검색에 어떤 폴더가 포함되는지 보여 주는 작은 표시.
 * 잠긴 폴더가 하나도 없으면 아무것도 그리지 않는다.
 * @param {{variant?: "pill"|"line"}} props
 */
export default function SearchScopeBadge({ variant = "line" }) {
  const [folders, setFolders] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [unlockTarget, setUnlockTarget] = useState(null);

  const load = useCallback(async () => {
    const r = await NexusAccess.folders();
    if (!r.ok) return;
    setFolders(r.data.folders || []);
    setIsAdmin(!!r.data.isAdmin);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    window.addEventListener(NEXUS_ACCESS_CHANGED_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener(NEXUS_ACCESS_CHANGED_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  const locked = folders.filter((f) => f.locked);
  if (locked.length === 0) return null;

  const closed = locked.filter((f) => !f.open);
  const opened = locked.filter((f) => f.open);

  let tone = "text-amber-600 dark:text-amber-400";
  let icon = <Lock size={12} weight="fill" className="shrink-0" />;
  let text = `잠긴 폴더 ${closed.length}개는 검색에서 제외됨`;
  if (isAdmin) {
    tone = "text-emerald-600 dark:text-emerald-400";
    icon = <ShieldCheck size={12} weight="fill" className="shrink-0" />;
    text = `관리자 모드 · 잠긴 폴더 ${locked.length}개 포함`;
  } else if (closed.length === 0) {
    tone = "text-emerald-600 dark:text-emerald-400";
    icon = <LockOpen size={12} weight="fill" className="shrink-0" />;
    text = `열어 둔 잠긴 폴더 ${opened.length}개 포함하여 검색`;
  }

  const base =
    variant === "pill"
      ? "inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/80 px-3 py-1.5 text-[11px] font-medium shadow-sm backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-900/80"
      : "mt-1 inline-flex items-center gap-1 text-[11px] font-medium";

  return (
    <>
      <button
        type="button"
        title={EXPLAIN}
        onClick={() => setListOpen(true)}
        className={`${base} ${tone} cursor-pointer border-solid bg-transparent hover:underline`}
      >
        {icon}
        <span>{text}</span>
        {!isAdmin && closed.length > 0 && <span>· 열기</span>}
      </button>

      <Modal isOpen={listOpen} onClose={() => setListOpen(false)} size="md">
        <div className="flex flex-col gap-y-5">
          <ModalHeader
            title="검색에 포함되는 폴더"
            onClose={() => setListOpen(false)}
          />
          <ModalBody>
            <ModalHint>{EXPLAIN}</ModalHint>
            <ul className="flex flex-col gap-y-1.5">
              {locked.map((f) => (
                <li
                  key={f.name}
                  className="flex items-center gap-x-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-100 light:border-slate-300 light:text-slate-800"
                >
                  {f.open ? (
                    <LockOpen
                      size={14}
                      weight="fill"
                      className="text-emerald-400"
                    />
                  ) : (
                    <Lock size={14} weight="fill" className="text-amber-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="text-xs text-zinc-400">
                    {isAdmin ? "관리자" : f.open ? "열림" : "잠김"}
                  </span>
                  {!isAdmin && !f.open && (
                    <button
                      type="button"
                      onClick={() => {
                        setListOpen(false);
                        setUnlockTarget(f.name);
                      }}
                      className="shrink-0 rounded-md border-none bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-950 hover:opacity-80 light:bg-slate-900 light:text-white"
                    >
                      열기
                    </button>
                  )}
                  {!isAdmin && f.open && (
                    <button
                      type="button"
                      onClick={async () => {
                        await NexusAccess.relock(f.name);
                        notifyNexusAccessChanged();
                      }}
                      className="shrink-0 rounded-md border border-zinc-600 bg-transparent px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 light:text-slate-700 light:hover:bg-slate-100"
                    >
                      다시 잠그기
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </ModalBody>
          <ModalFooter>
            <ModalSecondaryButton
              type="button"
              onClick={() => setListOpen(false)}
            >
              닫기
            </ModalSecondaryButton>
          </ModalFooter>
        </div>
      </Modal>

      <UnlockFolderModal
        folder={unlockTarget}
        onClose={() => setUnlockTarget(null)}
        onUnlocked={() => setUnlockTarget(null)}
      />
    </>
  );
}
