import { useCallback, useEffect, useState } from "react";
import { Lock, LockOpen, FolderNotch } from "@phosphor-icons/react";
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
import System from "@/models/system";
import { notifyNexusAccessChanged } from "@/components/NexusAccess/events";

function PasswordModal({ title, hint, confirmLabel, onClose, onSubmit }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (password.length < 4 || busy) return;
    setBusy(true);
    const r = await onSubmit(password);
    setBusy(false);
    if (!r.ok) return setError(r.message || "처리하지 못했습니다.");
    onClose(true);
  }
  return (
    <Modal isOpen onClose={() => onClose(false)} size="sm">
      <form onSubmit={submit} className="flex flex-col gap-y-5">
        <ModalHeader title={title} onClose={() => onClose(false)} />
        <ModalBody>
          <ModalInput
            label="새 비밀번호"
            name="pw"
            type="password"
            autoFocus
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <ModalHint>{hint}</ModalHint>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </ModalBody>
        <ModalFooter>
          <ModalSecondaryButton type="button" onClick={() => onClose(false)}>
            취소
          </ModalSecondaryButton>
          <ModalPrimaryButton
            type="submit"
            disabled={busy || password.length < 4}
          >
            {confirmLabel}
          </ModalPrimaryButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}

export default function FoldersTab() {
  const [folders, setFolders] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null); // { kind: "lock" | "reset", name }

  const load = useCallback(async () => {
    const r = await NexusAccess.adminFolders();
    if (r.ok) setFolders(r.data.folders);
    else setError(r.message || "불러오지 못했습니다.");
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function release(name) {
    if (
      !window.confirm(
        `“${name}” 폴더의 잠금을 풀면 누구나 볼 수 있습니다. 계속할까요?`
      )
    )
      return;
    const r = await NexusAccess.adminReset(name, null);
    if (!r.ok) return window.alert(r.message || "처리하지 못했습니다.");
    notifyNexusAccessChanged();
    load();
  }

  async function remove(folder) {
    const warn = folder.documents
      ? `\n안의 문서 ${folder.documents}건과 검색 데이터가 모두 삭제됩니다. 되돌릴 수 없습니다.`
      : "";
    if (!window.confirm(`“${folder.name}” 폴더를 삭제할까요?${warn}`)) return;
    const ok = await System.deleteFolder(folder.name);
    if (!ok) return window.alert("삭제하지 못했습니다.");
    notifyNexusAccessChanged();
    load();
  }

  if (error) return <p className="text-sm text-red-500">{error}</p>;
  if (!folders) return <p className="text-sm text-slate-500">불러오는 중...</p>;

  const btn =
    "rounded-md border border-slate-300 bg-transparent px-2 py-1 text-xs hover:bg-slate-100 dark:border-zinc-700 dark:hover:bg-zinc-800";
  return (
    <div>
      <p className="mb-3 text-xs leading-5 text-slate-500 dark:text-zinc-400">
        전체 저장 폴더입니다. 관리자는 비밀번호 없이 모든 폴더를 관리할 수
        있습니다. 폴더 안의 문서 목록은 문서함에서 확인하세요.
      </p>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-zinc-800/50 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-2 font-medium">폴더</th>
              <th className="px-4 py-2 font-medium">문서</th>
              <th className="px-4 py-2 font-medium">상태</th>
              <th className="px-4 py-2 text-right font-medium">관리</th>
            </tr>
          </thead>
          <tbody>
            {folders.map((f) => (
              <tr
                key={f.name}
                className="border-t border-slate-100 dark:border-zinc-800"
              >
                <td className="px-4 py-2">
                  <span className="flex items-center gap-2">
                    <FolderNotch size={16} className="text-slate-400" />
                    {f.name}
                  </span>
                </td>
                <td className="px-4 py-2">{f.documents}건</td>
                <td className="px-4 py-2">
                  {f.locked ? (
                    <span className="inline-flex items-center gap-1 text-amber-600">
                      <Lock size={13} weight="fill" /> 잠김
                      {f.createdByBrowser && (
                        <span className="text-xs text-slate-400">
                          (만든 브라우저 {f.createdByBrowser})
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-slate-500">
                      <LockOpen size={13} /> 공개
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <span className="inline-flex flex-wrap justify-end gap-1.5">
                    {f.locked ? (
                      <>
                        <button
                          className={btn}
                          onClick={() =>
                            setDialog({ kind: "reset", name: f.name })
                          }
                        >
                          비밀번호 초기화
                        </button>
                        <button className={btn} onClick={() => release(f.name)}>
                          잠금 해제
                        </button>
                      </>
                    ) : (
                      f.name !== "custom-documents" && (
                        <button
                          className={btn}
                          onClick={() =>
                            setDialog({ kind: "lock", name: f.name })
                          }
                        >
                          잠그기
                        </button>
                      )
                    )}
                    {f.deletable && (
                      <button
                        className={`${btn} text-red-600 dark:text-red-400`}
                        onClick={() => remove(f)}
                      >
                        삭제
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dialog && (
        <PasswordModal
          title={
            dialog.kind === "lock"
              ? `“${dialog.name}” 폴더 잠그기`
              : `“${dialog.name}” 비밀번호 초기화`
          }
          hint={
            dialog.kind === "lock"
              ? "4자 이상. 이후 이 폴더는 비밀번호를 아는 사람만 열 수 있습니다."
              : "4자 이상. 바꾸면 이전에 연 모든 브라우저가 다시 잠깁니다."
          }
          confirmLabel={dialog.kind === "lock" ? "잠그기" : "초기화"}
          onClose={(changed) => {
            setDialog(null);
            if (changed) {
              notifyNexusAccessChanged();
              load();
            }
          }}
          onSubmit={(pw) =>
            dialog.kind === "lock"
              ? NexusAccess.adminLockFolder(dialog.name, pw)
              : NexusAccess.adminReset(dialog.name, pw)
          }
        />
      )}
    </div>
  );
}
