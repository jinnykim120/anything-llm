// [auto-docu 호출량 로그 admin] claude -p 호출을 기능별/일별로 요약해서 보여주는
// 관리자 화면. 글자 수 기준(토큰 아님, 대략 1글자≈1~2토큰). admin/manager 전용
// (ManagerRoute + 서버 측 flexUserRoleValid 이중 검증).
import { useEffect, useState } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { Link, useParams } from "react-router-dom";
import ArchiveSidebar from "@/components/ArchiveSidebar";
import Workspace from "@/models/workspace";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";

const RANGES = [1, 7, 30];

const nf = new Intl.NumberFormat("ko-KR");

export default function UsageLog() {
  const { slug = "archive-full" } = useParams();
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Workspace.usageSummary(days).then((res) => {
      if (cancelled) return;
      if (res.error) showToast(res.error, "error", { clear: true });
      setData(res.error ? null : res);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const features = Object.entries(data?.byFeature || {}).sort(
    (a, b) => b[1].inChars + b[1].outChars - (a[1].inChars + a[1].outChars)
  );
  const dayRows = Object.entries(data?.byDay || {}).sort((a, b) =>
    b[0].localeCompare(a[0])
  );
  const total = data?.total;
  const grandChars = total ? total.inChars + total.outChars : 0;
  const maxDayChars = Math.max(
    1,
    ...dayRows.map(([, d]) => d.inChars + d.outChars)
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
      <ArchiveSidebar slug={slug} view="management" activeManagement="usage" />
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
                Usage log
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
                호출량
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-slate-500 dark:text-zinc-400">
                Claude 호출을 기능별로 집계합니다. 글자 수 기준이며(대략 1글자
                ≈ 1~2토큰) 내용은 저장하지 않고 횟수·길이·소요시간만 기록합니다.
              </p>
            </div>
            <div className="flex shrink-0 overflow-hidden rounded-md border border-slate-200 text-xs font-semibold dark:border-zinc-800">
              {RANGES.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDays(d)}
                  className={`px-3 py-2 transition ${
                    days === d
                      ? "bg-blue-600 text-white"
                      : "bg-white text-slate-500 hover:bg-slate-100 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  }`}
                >
                  {d === 1 ? "24시간" : `${d}일`}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <p className="p-8 text-center text-sm text-slate-400 dark:text-zinc-500">
              불러오는 중...
            </p>
          ) : !total || total.calls === 0 ? (
            <p className="p-8 text-center text-sm text-slate-400 dark:text-zinc-500">
              이 기간에 기록된 호출이 없습니다.
            </p>
          ) : (
            <>
              <div className="mt-6 grid grid-cols-3 gap-3">
                {[
                  ["총 호출", `${nf.format(total.calls)}회`],
                  ["입력", `${nf.format(total.inChars)}자`],
                  ["출력", `${nf.format(total.outChars)}자`],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-lg border border-slate-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
                  >
                    <p className="text-xs text-slate-500 dark:text-zinc-500">
                      {label}
                    </p>
                    <p className="mt-1 text-xl font-semibold">{value}</p>
                  </div>
                ))}
              </div>

              <h2 className="mt-8 text-sm font-semibold">기능별</h2>
              <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 dark:border-zinc-800 dark:text-zinc-500">
                      <th className="px-4 py-3 font-semibold">기능</th>
                      <th className="px-4 py-3 text-right font-semibold">호출</th>
                      <th className="px-4 py-3 text-right font-semibold">입력(자)</th>
                      <th className="px-4 py-3 text-right font-semibold">출력(자)</th>
                      <th className="px-4 py-3 text-right font-semibold">비중</th>
                      <th className="px-4 py-3 text-right font-semibold">실패</th>
                    </tr>
                  </thead>
                  <tbody>
                    {features.map(([name, f]) => (
                      <tr
                        key={name}
                        className="border-b border-slate-100 last:border-0 dark:border-zinc-800/60"
                      >
                        <td className="px-4 py-3 font-medium">{name}</td>
                        <td className="px-4 py-3 text-right">{nf.format(f.calls)}</td>
                        <td className="px-4 py-3 text-right">{nf.format(f.inChars)}</td>
                        <td className="px-4 py-3 text-right">{nf.format(f.outChars)}</td>
                        <td className="px-4 py-3 text-right text-slate-500 dark:text-zinc-400">
                          {grandChars
                            ? Math.round(
                                ((f.inChars + f.outChars) / grandChars) * 100
                              )
                            : 0}
                          %
                        </td>
                        <td
                          className={`px-4 py-3 text-right ${
                            f.failed
                              ? "text-red-600 dark:text-red-400"
                              : "text-slate-400 dark:text-zinc-600"
                          }`}
                        >
                          {f.failed}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h2 className="mt-8 text-sm font-semibold">일별</h2>
              <div className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-zinc-800/60 dark:border-zinc-800 dark:bg-zinc-900">
                {dayRows.map(([day, d]) => {
                  const chars = d.inChars + d.outChars;
                  return (
                    <div
                      key={day}
                      className="flex items-center gap-4 px-4 py-2.5 text-xs"
                    >
                      <span className="w-24 shrink-0 font-mono text-slate-500 dark:text-zinc-400">
                        {day}
                      </span>
                      <div className="h-2 min-w-0 flex-1 rounded-full bg-slate-100 dark:bg-zinc-800">
                        <div
                          className="h-2 rounded-full bg-blue-600"
                          style={{ width: `${(chars / maxDayChars) * 100}%` }}
                        />
                      </div>
                      <span className="w-16 shrink-0 text-right">
                        {nf.format(d.calls)}회
                      </span>
                      <span className="w-28 shrink-0 text-right text-slate-500 dark:text-zinc-400">
                        {nf.format(chars)}자
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
