// [auto-docu 문서 연계성 학습 admin] documentAffinity 테이블에 쌓인 "이 두
// 문서는 실제로 같이 쓰인다" 학습 이력을 확인하고, 잘못 학습된 쌍을 지우거나
// 워크스페이스 전체를 초기화할 수 있는 관리자 화면. admin/manager 권한만
// 접근 가능(ManagerRoute + 서버 측 flexUserRoleValid 이중 검증).
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Trash } from "@phosphor-icons/react";
import { Link, useParams } from "react-router-dom";
import ArchiveSidebar from "@/components/ArchiveSidebar";
import Workspace from "@/models/workspace";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("ko-KR", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "-";
  }
}

export default function DocumentAffinity() {
  const { slug = "archive-full" } = useParams();
  const [pairs, setPairs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { pairs: rows, error } = await Workspace.listAffinity(slug);
    if (error) showToast(error, "error", { clear: true });
    setPairs(rows);
    setLoading(false);
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDelete(id) {
    setDeletingId(id);
    const result = await Workspace.deleteAffinityPair(slug, id);
    setDeletingId(null);
    if (!result?.success) {
      showToast("삭제하지 못했습니다.", "error", { clear: true });
      return;
    }
    setPairs((prev) => prev.filter((p) => p.id !== id));
  }

  async function handleResetAll() {
    if (
      !window.confirm(
        `이 워크스페이스의 문서 연계 이력 ${pairs.length}건을 전부 지웁니다. 되돌릴 수 없습니다. 계속할까요?`
      )
    )
      return;
    setResetting(true);
    const result = await Workspace.resetAffinity(slug);
    setResetting(false);
    if (!result?.success) {
      showToast("초기화하지 못했습니다.", "error", { clear: true });
      return;
    }
    setPairs([]);
    showToast(`${result.count ?? 0}건을 초기화했습니다.`, "success", {
      clear: true,
    });
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
      <ArchiveSidebar
        slug={slug}
        view="management"
        activeManagement="affinity"
      />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-8 lg:px-12 lg:py-12">
          <Link
            to={paths.workspace.manage(slug)}
            className="inline-flex items-center gap-2 text-xs font-medium text-slate-500 transition hover:text-blue-600 dark:text-zinc-500 dark:hover:text-blue-300"
          >
            <ArrowLeft size={15} /> 관리로 돌아가기
          </Link>

          <div className="mt-8 flex items-start justify-between gap-4 border-b border-slate-200 pb-7 dark:border-zinc-800">
            <div>
              <p className="text-xs font-semibold text-blue-600 dark:text-blue-500">
                Document affinity
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
                문서 연계성 학습
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-slate-500 dark:text-zinc-400">
                함께 선택되거나(명시적) 다운로드까지 이어진 답변에서 함께
                인용된(검증됨) 문서 쌍의 학습 이력입니다. 검색 랭킹에는 발생
                횟수 2회 이상인 쌍만, 45일 반감기로 감쇠된 값으로 반영됩니다.
              </p>
              <p className="mt-2 max-w-xl text-xs leading-5 text-amber-600 dark:text-amber-400">
                현재는 <b>기록만 쌓고 검색 순위에는 반영하지 않습니다</b>(가산점
                가중치 0). 데이터가 충분히 쌓이면 서버 설정{" "}
                <code>HYBRID_AFFINITY_WEIGHT_PCT</code>로 켭니다. 아래 "반영
                중"은 켰을 때 반영될 쌍이라는 뜻입니다.
              </p>
            </div>
            {pairs.length > 0 && (
              <button
                type="button"
                onClick={handleResetAll}
                disabled={resetting}
                className="shrink-0 rounded-md border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30"
              >
                전체 초기화
              </button>
            )}
          </div>

          <div className="mt-6 overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            {loading ? (
              <p className="p-8 text-center text-sm text-slate-400 dark:text-zinc-500">
                불러오는 중...
              </p>
            ) : pairs.length === 0 ? (
              <p className="p-8 text-center text-sm text-slate-400 dark:text-zinc-500">
                아직 학습된 연계 이력이 없습니다.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 dark:border-zinc-800 dark:text-zinc-500">
                    <th className="px-4 py-3 font-semibold">문서 A</th>
                    <th className="px-4 py-3 font-semibold">문서 B</th>
                    <th className="px-4 py-3 font-semibold">신호 강도</th>
                    <th className="px-4 py-3 font-semibold">발생 횟수</th>
                    <th className="px-4 py-3 font-semibold">최근 관측</th>
                    <th className="px-4 py-3 font-semibold">랭킹 반영</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {pairs.map((pair) => (
                    <tr
                      key={pair.id}
                      className="border-b border-slate-100 last:border-0 dark:border-zinc-800/60"
                    >
                      <td className="max-w-[220px] truncate px-4 py-3">
                        {pair.filenameA}
                      </td>
                      <td className="max-w-[220px] truncate px-4 py-3">
                        {pair.filenameB}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-slate-500 dark:text-zinc-400">
                        {pair.decayedWeight.toFixed(2)}
                        <span className="ml-1 text-slate-400 dark:text-zinc-600">
                          (누적 {pair.weight.toFixed(1)})
                        </span>
                      </td>
                      <td className="px-4 py-3">{pair.occurrences}</td>
                      <td className="px-4 py-3 text-slate-500 dark:text-zinc-400">
                        {formatDate(pair.lastSeenAt)}
                      </td>
                      <td className="px-4 py-3">
                        {pair.belowRankThreshold ? (
                          <span className="text-slate-400 dark:text-zinc-600">
                            미반영
                          </span>
                        ) : (
                          <span className="text-blue-600 dark:text-blue-400">
                            반영 중
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleDelete(pair.id)}
                          disabled={deletingId === pair.id}
                          aria-label="이 연계 이력 삭제"
                          className="rounded-md p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:text-zinc-500 dark:hover:bg-red-950/30 dark:hover:text-red-400"
                        >
                          <Trash size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
