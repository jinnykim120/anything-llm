// [NEXUS 폴더 잠금] 문서함에서 잠금 폴더를 보여 주고, 비밀번호로 열어야 안의 파일을 본다.
import { useCallback, useEffect, useState } from "react";
import { Folder, Lock, LockOpen } from "@phosphor-icons/react";
import NexusAccess from "@/models/nexusAccess";
import System from "@/models/system";
import UnlockFolderModal from "@/components/NexusAccess/UnlockFolderModal";
import {
  NEXUS_ACCESS_CHANGED_EVENT,
  notifyNexusAccessChanged,
} from "@/components/NexusAccess/events";

export const LOCK_PREFIX = "lock:";

/** 잠금 폴더 목록(이름·열림 여부). 열림 상태가 바뀌면 다시 읽는다. */
export function useLockedFolders() {
  const [folders, setFolders] = useState([]);
  const load = useCallback(async () => {
    const r = await NexusAccess.folders();
    if (r.ok) setFolders((r.data.folders || []).filter((f) => f.locked));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(NEXUS_ACCESS_CHANGED_EVENT, load);
    return () => window.removeEventListener(NEXUS_ACCESS_CHANGED_EVENT, load);
  }, [load]);
  return folders;
}

/** 왼쪽 목록의 "잠금 폴더" 구역. 잠겨 있으면 비밀번호 창을 띄우고, 열리면 폴더를 고른다. */
export function LockedFolderList({ folders, selectedFolder, onSelect }) {
  const [unlockTarget, setUnlockTarget] = useState(null);
  if (!folders.length) return null;
  return (
    <div className="mt-3 border-t border-slate-200 pt-2 dark:border-zinc-800">
      <p className="px-2 pb-1 text-[11px] font-semibold text-slate-400 dark:text-zinc-600">
        잠금 폴더
      </p>
      {folders.map((f) => {
        const key = `${LOCK_PREFIX}${f.name}`;
        return (
          <button
            key={f.name}
            type="button"
            onClick={() => (f.open ? onSelect(key) : setUnlockTarget(f.name))}
            title={
              f.open
                ? "열려 있는 잠금 폴더"
                : "비밀번호를 입력하면 안의 파일을 볼 수 있습니다"
            }
            className={`mb-1 flex w-full items-center gap-1.5 rounded px-2 py-2 text-left text-xs font-medium hover:bg-slate-50 dark:hover:bg-zinc-800 ${selectedFolder === key ? "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300" : "text-slate-700 dark:text-zinc-300"}`}
          >
            {f.open ? (
              <LockOpen size={15} className="text-emerald-600" />
            ) : (
              <Lock size={15} className="text-amber-600" />
            )}
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            {!f.open && (
              <span className="text-[10px] text-slate-400 dark:text-zinc-600">
                잠김
              </span>
            )}
          </button>
        );
      })}
      {unlockTarget && (
        <UnlockFolderModal
          folder={unlockTarget}
          onClose={() => setUnlockTarget(null)}
          onUnlocked={(name) => {
            setUnlockTarget(null);
            notifyNexusAccessChanged();
            onSelect(`${LOCK_PREFIX}${name}`, { reload: true });
          }}
        />
      )}
    </div>
  );
}

function titleOf(item) {
  return item?.title || item?.name?.replace(/\.json$/, "") || "이름 없는 문서";
}

/**
 * 한 폴더 단계의 내용(하위 폴더 행 + 파일 행). 하위 폴더는 ▸ 를 눌러 펼치면
 * 그 안의 하위 폴더·파일을 같은 방식으로 보여 준다.
 */
function FolderBody({ path, depth, ctx }) {
  const [state, setState] = useState({
    loading: true,
    items: [],
    subfolders: [],
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState((cur) => ({ ...cur, loading: true, error: null }));
    System.localFiles(path, 0, "all").then((res) => {
      if (cancelled) return;
      if (!res || res.code !== 200)
        return setState({
          loading: false,
          items: [],
          subfolders: [],
          error: res?.locked
            ? "폴더가 다시 잠겼습니다. 왼쪽에서 비밀번호로 여세요."
            : "파일 목록을 불러오지 못했습니다.",
        });
      setState({
        loading: false,
        items: res.documents || [],
        subfolders: res.subfolders || [],
        error: null,
      });
      ctx.onLoaded?.(path, res);
    });
    return () => {
      cancelled = true;
    };
  }, [path, ctx.version]);

  const indent = { paddingLeft: `${16 + depth * 16}px` };
  return (
    <>
      {state.loading && (
        <p
          className="py-2 text-xs text-slate-500 dark:text-zinc-500"
          style={indent}
        >
          불러오는 중…
        </p>
      )}
      {state.error && (
        <p className="py-2 pr-4 text-xs text-red-500" style={indent}>
          {state.error}
        </p>
      )}
      {!state.loading &&
        state.subfolders.map((sub) => (
          <FolderNode
            key={`${path}/${sub.name}`}
            path={`${path}/${sub.name}`}
            name={sub.name}
            count={sub.fileCount}
            depth={depth}
            ctx={ctx}
          />
        ))}
      {!state.loading &&
        state.items.map((item) => {
          const full = `${path}/${item.name}`;
          const searchable = ctx.searchableNames.has(full.normalize("NFC"));
          return (
            <div
              key={full}
              className="flex items-center gap-3 border-b border-slate-100 py-3 pr-4 text-xs dark:border-zinc-800"
              style={indent}
            >
              <input
                type="checkbox"
                checked={ctx.picked.has(full)}
                onChange={() => ctx.toggle(full)}
                aria-label={`${titleOf(item)} 선택`}
              />
              <span className="min-w-0 flex-1 truncate font-medium">
                {titleOf(item)}
              </span>
              <span className="shrink-0 text-[10px] text-slate-400 dark:text-zinc-600">
                {item.published || ""}
              </span>
              <span
                title={
                  searchable
                    ? "검색 대상에 올라간 문서입니다"
                    : "파일은 있지만 검색 대상에는 올라가지 않았습니다 (같은 내용의 문서가 이미 있으면 중복으로 건너뜁니다)"
                }
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${searchable ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"}`}
              >
                {searchable ? "검색 가능" : "검색 안 됨"}
              </span>
            </div>
          );
        })}
      {!state.loading &&
        !state.error &&
        state.items.length === 0 &&
        state.subfolders.length === 0 &&
        depth === 0 && (
          <p className="p-4 text-xs text-slate-500 dark:text-zinc-500">
            이 폴더에는 아직 파일이 없습니다.
          </p>
        )}
    </>
  );
}

/** 하위 폴더 한 줄. ▸ 를 누르면 펼쳐서 안을 보여 준다. */
function FolderNode({ path, name, count, depth, ctx }) {
  const [open, setOpen] = useState(false);
  const indent = { paddingLeft: `${16 + depth * 16}px` };
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 border-b border-slate-100 py-2 pr-4 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
        style={indent}
        aria-expanded={open}
      >
        <span className="w-3 text-slate-400">{open ? "▾" : "▸"}</span>
        <Folder size={14} className="text-amber-600" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="shrink-0 text-[10px] text-slate-400 dark:text-zinc-600">
          {count}
        </span>
      </button>
      {open && <FolderBody path={path} depth={depth + 1} ctx={ctx} />}
    </>
  );
}

/**
 * 열린 잠금 폴더의 내용. 하위 폴더는 ▸ 로 펼치고, 파일마다 검색 대상 여부를 표시한다.
 * 선택한 파일은 전체 경로(폴더/하위폴더/파일)로 지운다.
 */
export function LockedFolderFiles({ folder, searchableNames, onChanged }) {
  const [picked, setPicked] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [version, setVersion] = useState(0);
  const [total, setTotal] = useState(null);
  const [directFiles, setDirectFiles] = useState([]);

  // 같은 폴더를 다시 고르면 선택을 비운다.
  useEffect(() => {
    setPicked(new Set());
    setTotal(null);
  }, [folder]);

  function toggle(full) {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(full)) next.delete(full);
      else next.add(full);
      return next;
    });
  }

  const ctx = {
    searchableNames,
    picked,
    toggle,
    version,
    onLoaded: (path, res) => {
      if (path !== folder) return;
      setTotal(res.recursiveCount ?? res.totalCount ?? 0);
      setDirectFiles(res.documents || []);
    },
  };

  const allPicked =
    directFiles.length > 0 &&
    directFiles.every((f) => picked.has(`${folder}/${f.name}`));

  async function deletePicked() {
    if (!picked.size || deleting) return;
    if (
      !window.confirm(
        `선택한 ${picked.size}개 파일을 삭제할까요?\n검색 대상에서도 함께 빠지며 되돌릴 수 없습니다.`
      )
    )
      return;
    setDeleting(true);
    const ok = await System.deleteDocuments([...picked]);
    setDeleting(false);
    if (!ok)
      return window.alert(
        "삭제하지 못했습니다. 폴더가 다시 잠겼는지 확인하세요."
      );
    setPicked(new Set());
    setVersion((v) => v + 1);
    onChanged?.();
  }

  return (
    <section className="min-h-0 overflow-y-auto border border-slate-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-zinc-800">
        <input
          type="checkbox"
          checked={allPicked}
          disabled={directFiles.length === 0}
          onChange={() =>
            setPicked(
              allPicked
                ? new Set()
                : new Set(directFiles.map((f) => `${folder}/${f.name}`))
            )
          }
          aria-label="이 폴더의 파일 전체 선택"
        />
        <LockOpen size={15} className="text-emerald-600" />
        <p className="text-xs font-semibold">
          {folder}
          <span className="ml-2 font-normal text-slate-400 dark:text-zinc-600">
            {total ?? ""}
          </span>
        </p>
        {picked.size > 0 && (
          <button
            type="button"
            onClick={deletePicked}
            disabled={deleting}
            className="ml-auto rounded bg-red-600 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
          >
            {deleting ? "삭제 중…" : `${picked.size}개 삭제`}
          </button>
        )}
      </div>
      <FolderBody path={folder} depth={0} ctx={ctx} />
    </section>
  );
}
