import { useState } from "react";
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

/** 잠긴 폴더를 비밀번호로 연다. 이 브라우저에서만, 일정 시간 동안 열린다. */
export default function UnlockFolderModal({ folder, onClose, onUnlocked }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const r = await NexusAccess.unlock(folder, password);
    setBusy(false);
    if (!r.ok) return setError(r.message || "폴더를 열지 못했습니다.");
    onUnlocked?.(folder);
  }

  return (
    <Modal isOpen={!!folder} onClose={onClose} size="sm">
      <form onSubmit={submit} className="flex flex-col gap-y-5">
        <ModalHeader title={`잠긴 폴더: ${folder}`} onClose={onClose} />
        <ModalBody>
          <ModalInput
            label="폴더 비밀번호"
            name="folderPassword"
            type="password"
            autoFocus
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <ModalHint>
            비밀번호를 아는 사람만 이 폴더의 자료를 검색하고 볼 수 있습니다. 연
            상태는 이 브라우저에서만 유지됩니다.
          </ModalHint>
          {error && <p className="text-red-400 text-sm">{error}</p>}
        </ModalBody>
        <ModalFooter>
          <ModalSecondaryButton type="button" onClick={onClose}>
            취소
          </ModalSecondaryButton>
          <ModalPrimaryButton type="submit" disabled={busy || !password}>
            {busy ? "확인 중..." : "열기"}
          </ModalPrimaryButton>
        </ModalFooter>
      </form>
    </Modal>
  );
}
