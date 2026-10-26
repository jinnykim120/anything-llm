import { useCallback, useEffect, useState } from "react";
import NexusAccess from "@/models/nexusAccess";

const PAGE = 30;

export default function ChatsTab() {
  const [q, setQ] = useState("");
  const [client, setClient] = useState("");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(() => new Set());

  const load = useCallback(
    async (offset = 0) => {
      setLoading(true);
      const r = await NexusAccess.adminChats({
        q,
        client,
        offset,
        limit: PAGE,
      });
      setLoading(false);
      if (!r.ok) return setError(r.message || "불러오지 못했습니다.");
      setError(null);
      setTotal(r.data.total);
      setRows((prev) => (offset ? [...prev, ...r.data.chats] : r.data.chats));
    },
    [q, client]
  );
  useEffect(() => {
    load(0);
    // 검색 조건은 "검색" 버튼/엔터로만 다시 불러온다
  }, []);

  const toggle = (id) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const input =
    "h-8 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950";
  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          load(0);
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          className={`${input} w-64`}
          placeholder="질문·답변 내용 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <input
          className={`${input} w-44`}
          placeholder="브라우저 ID 앞부분 / public"
          value={client}
          onChange={(e) => setClient(e.target.value)}
        />
        <button
          type="submit"
          className="h-8 rounded-md border-none bg-slate-900 px-3 text-sm text-white hover:opacity-80 dark:bg-zinc-100 dark:text-zinc-900"
        >
          검색
        </button>
        <span className="text-xs text-slate-500 dark:text-zinc-400">
          전체 {total.toLocaleString()}건 · 읽기 전용
        </span>
      </form>
      <p className="mt-2 text-xs text-slate-500 dark:text-zinc-400">
        사용자가 남긴 모든 대화입니다. 브라우저 ID는 사람이 아니라 브라우저를
        뜻합니다 (같은 사람도 기기마다 다릅니다).
      </p>

      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
      <ul className="mt-4 space-y-2">
        {rows.map((c) => (
          <li
            key={c.id}
            className="rounded-lg border border-slate-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <div className="flex flex-wrap items-center gap-x-3 text-[11px] text-slate-400">
              <span>{new Date(c.at).toLocaleString("ko-KR")}</span>
              <span>브라우저 {c.browser}</span>
              {c.thread && <span>스레드 “{c.thread}”</span>}
              <span>출처 {c.sources}건</span>
            </div>
            <p className="mt-1 text-sm font-medium">{c.question}</p>
            <p
              className={`mt-1 whitespace-pre-wrap text-xs leading-5 text-slate-600 dark:text-zinc-400 ${open.has(c.id) ? "" : "line-clamp-3"}`}
            >
              {c.answer || "(답변 없음)"}
            </p>
            {c.answer && c.answer.length > 160 && (
              <button
                type="button"
                onClick={() => toggle(c.id)}
                className="mt-1 border-none bg-transparent p-0 text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                {open.has(c.id) ? "접기" : "펼치기"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {rows.length < total && (
        <button
          type="button"
          disabled={loading}
          onClick={() => load(rows.length)}
          className="mt-4 rounded-md border border-slate-300 bg-transparent px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {loading ? "불러오는 중..." : "더 보기"}
        </button>
      )}
      {!loading && rows.length === 0 && !error && (
        <p className="mt-6 text-sm text-slate-500">
          조건에 맞는 대화가 없습니다.
        </p>
      )}
    </div>
  );
}
