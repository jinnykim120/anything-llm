import { useEffect, useState } from "react";
import NexusAccess from "@/models/nexusAccess";

const ITEMS = [
  ["documents", "아카이브 문서", "건"],
  ["summarized", "요약이 있는 문서", "건"],
  ["lockedFolders", "비밀번호로 잠긴 폴더", "개"],
  ["threads", "대화 스레드", "개"],
  ["chats", "누적 질문·답변", "건"],
  ["chatsLast24h", "최근 24시간 질문", "건"],
  ["browsersWithChats", "대화를 남긴 브라우저", "개"],
];

export default function OverviewTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    NexusAccess.adminOverview().then((r) =>
      r.ok ? setData(r.data) : setError(r.message || "불러오지 못했습니다.")
    );
  }, []);

  if (error) return <p className="text-sm text-red-500">{error}</p>;
  if (!data) return <p className="text-sm text-slate-500">불러오는 중...</p>;

  const pending = Math.max(0, data.documents - data.summarized);
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {ITEMS.map(([key, label, unit]) => (
          <div
            key={key}
            className="rounded-lg border border-slate-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <p className="text-xs text-slate-500 dark:text-zinc-400">{label}</p>
            <p className="mt-1 text-2xl font-semibold">
              {Number(data[key] || 0).toLocaleString()}
              <span className="ml-1 text-xs font-normal text-slate-400">
                {unit}
              </span>
            </p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs leading-5 text-slate-500 dark:text-zinc-400">
        요약이 없는 문서 {pending}건은 15분마다 새 문서부터 자동으로
        만들어집니다. 잠긴 폴더 문서는 자동으로 요약하지 않고, 폴더를 연 사람이
        문서함에서 "요약 만들기"를 눌러 만듭니다.
      </p>
    </div>
  );
}
