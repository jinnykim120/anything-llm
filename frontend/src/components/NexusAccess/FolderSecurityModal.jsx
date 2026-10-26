import { useState } from "react";
import Modal, {
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalInput,
  ModalHint,
  ModalPrimaryButton,
  ModalSecondaryButton,
  ModalDangerButton,
} from "@/components/lib/Modal";
import NexusAccess from "@/models/nexusAccess";
import showToast from "@/utils/toast";
import { notifyNexusAccessChanged } from "./events";

/**
 * 연 잠금 폴더의 보안 설정 — 이 브라우저에서 다시 잠그기, 비밀번호 변경,
 * 잠금 해제(공개로 전환). 관리자는 현재 비밀번호 없이 초기화할 수 있다.
 */
export default function FolderSecurityModal({
  folder,
  isAdmin = false,
  onClose,
  onChanged,
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run(fn, doneMessage) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return setError(r.message || "처리하지 못했습니다.");
    showToast(doneMessage, "success", { clear: true });
    notifyNexusAccessChanged();
    onChanged?.();
    onClose();
  }

  return (
    <Modal isOpen={!!folder} onClose={onClose} size="md">
      <div className="flex flex-col gap-y-5">
        <ModalHeader title={`폴더 보안: ${folder}`} onClose={onClose} />
        <ModalBody>
          <ModalHint>
            이 폴더는 비밀번호로 잠겨 있습니다. 비밀번호를 아는 사람은 누구나
            자료를 올리고 지울 수 있습니다.
          </ModalHint>

          {!isAdmin && (
            <ModalInput
              label="현재 비밀번호"
              name="currentPassword"
              type="password"
              autoComplete="off"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          )}
          <ModalInput
            label="새 비밀번호"
            name="newPassword"
            type="password"
            autoComplete="off"
            hint="4자 이상. 바꾸면 다른 사람이 열어 둔 상태도 모두 다시 잠깁니다."
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
        </ModalBody>
        <ModalFooter className="flex-wrap">
          <ModalSecondaryButton
            type="button"
            disabled={busy}
            onClick={() =>
              run(() => NexusAccess.relock(folder), "다시 잠갔습니다.")
            }
          >
            이 브라우저에서 다시 잠그기
          </ModalSecondaryButton>
          <ModalDangerButton
            type="button"
            disabled={busy || (!isAdmin && !currentPassword)}
            onClick={() => {
              if (
                !window.confirm(
                  "잠금을 풀면 누구나 이 폴더를 볼 수 있습니다. 계속할까요?"
                )
              )
                return;
              run(
                () =>
                  isAdmin
                    ? NexusAccess.adminReset(folder, null)
                    : NexusAccess.removeLock(folder, currentPassword),
                "잠금을 해제했습니다. 이제 공개 폴더입니다."
              );
            }}
          >
            잠금 해제(공개)
          </ModalDangerButton>
          <ModalPrimaryButton
            type="button"
            disabled={
              busy || newPassword.length < 4 || (!isAdmin && !currentPassword)
            }
            onClick={() =>
              run(
                () =>
                  isAdmin
                    ? NexusAccess.adminReset(folder, newPassword)
                    : NexusAccess.changePassword(
                        folder,
                        currentPassword,
                        newPassword
                      ),
                "비밀번호를 바꿨습니다."
              )
            }
          >
            비밀번호 변경
          </ModalPrimaryButton>
        </ModalFooter>
      </div>
    </Modal>
  );
}
