import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, ShieldSlash } from "@phosphor-icons/react";
import Modal, {
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalInput,
  ModalHint,
  ModalPrimaryButton,
  ModalSecondaryButton,
} from "@/components/lib/Modal";
import NexusAccess from "@/models/nexusAccess";
import showToast from "@/utils/toast";

export const NEXUS_ACCESS_CHANGED_EVENT = "nexus-access-changed";

/**
 * 화면 한쪽 구석의 작은 관리자 버튼. 관리자로 로그인한 브라우저는 모든 폴더를
 * 비밀번호 없이 열 수 있다. 관리자 비밀번호가 서버에 설정돼 있지 않으면
 * 아무것도 그리지 않는다.
 */
export default function AdminBadge() {
  const [state, setState] = useState({ adminEnabled: false, isAdmin: false });
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await NexusAccess.access();
    if (r.ok)
      setState({
        adminEnabled: !!r.data.adminEnabled,
        isAdmin: !!r.data.isAdmin,
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function notifyChanged() {
    window.dispatchEvent(new Event(NEXUS_ACCESS_CHANGED_EVENT));
  }

  async function login(e) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const r = await NexusAccess.adminLogin(password);
    setBusy(false);
    if (!r.ok) return setError(r.message || "로그인하지 못했습니다.");
    setPassword("");
    setOpen(false);
    await load();
    notifyChanged();
    showToast(
      "관리자로 로그인했습니다. 모든 폴더를 볼 수 있습니다.",
      "success",
      {
        clear: true,
      }
    );
  }

  async function logout() {
    await NexusAccess.adminLogout();
    setOpen(false);
    await load();
    notifyChanged();
    showToast("관리자 로그아웃했습니다.", "info", { clear: true });
  }

  if (!state.adminEnabled) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={state.isAdmin ? "관리자 모드" : "관리자 로그인"}
        className={`fixed bottom-3 left-3 z-40 flex h-8 w-8 items-center justify-center rounded-full border text-sm shadow ${
          state.isAdmin
            ? "border-emerald-500 bg-emerald-600/20 text-emerald-400"
            : "border-zinc-700 bg-zinc-900/80 text-zinc-400 hover:text-zinc-100 light:border-slate-300 light:bg-white light:text-slate-500"
        }`}
      >
        {state.isAdmin ? <ShieldCheck size={18} /> : <ShieldSlash size={18} />}
      </button>
      <Modal isOpen={open} onClose={() => setOpen(false)} size="sm">
        {state.isAdmin ? (
          <div className="flex flex-col gap-y-5">
            <ModalHeader title="관리자 모드" onClose={() => setOpen(false)} />
            <ModalBody>
              <ModalHint>
                이 브라우저는 관리자로 로그인돼 있어 모든 폴더와 모든 대화를 볼
                수 있습니다.
              </ModalHint>
            </ModalBody>
            <ModalFooter>
              <ModalSecondaryButton
                type="button"
                onClick={() => setOpen(false)}
              >
                닫기
              </ModalSecondaryButton>
              <ModalPrimaryButton type="button" onClick={logout}>
                로그아웃
              </ModalPrimaryButton>
            </ModalFooter>
          </div>
        ) : (
          <form onSubmit={login} className="flex flex-col gap-y-5">
            <ModalHeader title="관리자 로그인" onClose={() => setOpen(false)} />
            <ModalBody>
              <ModalInput
                label="관리자 비밀번호"
                name="adminPassword"
                type="password"
                autoFocus
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {error && <p className="text-red-400 text-sm">{error}</p>}
            </ModalBody>
            <ModalFooter>
              <ModalSecondaryButton
                type="button"
                onClick={() => setOpen(false)}
              >
                취소
              </ModalSecondaryButton>
              <ModalPrimaryButton type="submit" disabled={busy || !password}>
                {busy ? "확인 중..." : "로그인"}
              </ModalPrimaryButton>
            </ModalFooter>
          </form>
        )}
      </Modal>
    </>
  );
}
