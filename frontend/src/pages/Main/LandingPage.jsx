import { ArrowRight, PlayCircle, Sparkle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import useLogo from "@/hooks/useLogo";
import paths from "@/utils/paths";

const FLOW_STEPS = [
  {
    number: "01",
    title: "문서",
    description: "PDF·HWP·PPTX 등 원본을 보존한 채 아카이브에 담습니다.",
  },
  {
    number: "02",
    title: "맥락",
    description: "문장을 잘게 나누는 대신 문서의 구조와 맥락을 함께 읽습니다.",
  },
  {
    number: "03",
    title: "근거",
    description: "답변과 함께 출처, 페이지, 원본 위치를 바로 확인합니다.",
  },
];

const DATA_NODES = [
  { id: "archive", x: 112, y: 132, radius: 45, color: "#f6c84c" },
  { id: "context", x: 104, y: 286, radius: 51, color: "#63d9ad" },
  { id: "source", x: 118, y: 438, radius: 48, color: "#f1787e" },
  { id: "evidence", x: 218, y: 535, radius: 42, color: "#4ac7c6" },
];

const STREAM_COLORS = ["#f6c84c", "#74d9b2", "#f1787e", "#4ac7c6", "#a9a7ff"];

const DATA_STREAMS = DATA_NODES.flatMap((node, nodeIndex) =>
  Array.from({ length: 5 }, (_, streamIndex) => {
    const lane = streamIndex - 2;
    const startX = node.x + node.radius * 0.72;
    const startY = node.y + lane * 6;
    const endX = 650 + (streamIndex % 2) * 18;
    const endY = 86 + ((nodeIndex * 107 + streamIndex * 63) % 440);
    const firstControlX = 230 + nodeIndex * 14;
    const secondControlX = 405 + streamIndex * 12;
    const firstControlY = startY + lane * 24 - nodeIndex * 7;
    const secondControlY = endY - lane * 28 + nodeIndex * 10;

    return {
      id: `${node.id}-${streamIndex}`,
      d: `M ${startX} ${startY} C ${firstControlX} ${firstControlY}, ${secondControlX} ${secondControlY}, ${endX} ${endY}`,
      color: STREAM_COLORS[(nodeIndex + streamIndex) % STREAM_COLORS.length],
      width: streamIndex === 2 ? 2.25 : 1.15,
      opacity: 0.42 + ((nodeIndex + streamIndex) % 3) * 0.1,
    };
  })
);

const DATA_BUBBLES = [
  { x: 522, y: 102, radius: 42, color: "#f6c84c", opacity: 0.18 },
  { x: 585, y: 130, radius: 63, color: "#74d9b2", opacity: 0.16 },
  { x: 660, y: 100, radius: 34, color: "#a9a7ff", opacity: 0.2 },
  { x: 470, y: 188, radius: 30, color: "#f1787e", opacity: 0.16 },
  { x: 545, y: 210, radius: 72, color: "#4ac7c6", opacity: 0.13 },
  { x: 646, y: 228, radius: 56, color: "#74d9b2", opacity: 0.18 },
  { x: 721, y: 194, radius: 30, color: "#f6c84c", opacity: 0.18 },
  { x: 503, y: 298, radius: 52, color: "#a9a7ff", opacity: 0.14 },
  { x: 600, y: 316, radius: 81, color: "#f1787e", opacity: 0.13 },
  { x: 695, y: 300, radius: 45, color: "#4ac7c6", opacity: 0.18 },
  { x: 454, y: 400, radius: 34, color: "#74d9b2", opacity: 0.15 },
  { x: 528, y: 415, radius: 63, color: "#f6c84c", opacity: 0.15 },
  { x: 640, y: 422, radius: 70, color: "#a9a7ff", opacity: 0.14 },
  { x: 718, y: 410, radius: 28, color: "#f1787e", opacity: 0.2 },
  { x: 502, y: 506, radius: 42, color: "#4ac7c6", opacity: 0.16 },
  { x: 584, y: 520, radius: 61, color: "#74d9b2", opacity: 0.13 },
  { x: 682, y: 510, radius: 48, color: "#f6c84c", opacity: 0.15 },
];

export default function LandingPage() {
  const navigate = useNavigate();
  const { logo } = useLogo();

  function openArchive() {
    navigate(paths.workspace.chat("archive-full"));
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-slate-50 text-slate-950 light:bg-slate-50 dark:bg-zinc-950 dark:text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_75%_14%,rgba(15,98,254,0.12),transparent_34%),linear-gradient(135deg,rgba(15,98,254,0.04),transparent_45%)]" />
      <header className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-6 lg:px-10">
        <button
          type="button"
          onClick={() => navigate(paths.home())}
          className="rounded border-0 bg-transparent p-0"
          aria-label="Document Expansion LLM 홈"
        >
          {logo ? (
            <img
              src={logo}
              alt="Document Expansion LLM"
              className="h-8 w-auto"
            />
          ) : (
            <span className="text-sm font-semibold tracking-wide">
              Document Expansion LLM
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={openArchive}
          className="hidden items-center gap-2 border-0 bg-transparent text-sm font-medium text-slate-600 transition hover:text-blue-700 light:text-slate-600 light:hover:text-blue-700 md:flex dark:text-zinc-300 dark:hover:text-blue-300"
        >
          작업 화면 열기 <ArrowRight size={16} />
        </button>
      </header>

      <section className="relative z-10 mx-auto grid w-full max-w-7xl gap-14 px-6 pb-20 pt-12 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:px-10 lg:pb-28 lg:pt-20">
        <div className="relative z-10 max-w-2xl">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-blue-700 shadow-sm backdrop-blur light:border-blue-200 light:bg-white/70 dark:border-blue-900 dark:bg-zinc-900/70 dark:text-blue-300">
            <Sparkle size={14} weight="fill" />
            문서 근거형 질의 아카이브
          </div>
          <h1 className="text-5xl font-semibold leading-[0.98] tracking-[-0.06em] text-slate-950 sm:text-6xl lg:text-8xl light:text-slate-950 dark:text-white">
            Document
            <br />
            Expansion
            <br />
            <span className="text-blue-600 light:text-blue-600 dark:text-blue-300">
              LLM
            </span>
          </h1>
          <div className="mt-10 max-w-xl lg:ml-auto lg:text-right">
            <h2 className="text-2xl font-medium leading-[1.25] tracking-[-0.03em] text-slate-900 sm:text-3xl light:text-slate-900 dark:text-white">
              데이터의 흐름을 읽고,
              <br />
              <span className="text-blue-600 light:text-blue-600 dark:text-blue-300">
                근거를 따라 답합니다.
              </span>
            </h2>
            <p className="mt-5 text-sm leading-8 text-slate-600 light:text-slate-600 dark:text-zinc-300 xl:whitespace-nowrap">
              문서의 맥락을 읽어 저장하고, 질문에 답할 때는 원본에 근거한 결과만
              보여드립니다.
            </p>
            <p className="mt-1 text-sm leading-8 text-slate-600 light:text-slate-600 dark:text-zinc-300 xl:whitespace-nowrap">
              출처와 페이지, 실제 원본 위치까지 한 화면에서 확인하세요.
            </p>
          </div>
          <div className="mt-9 flex flex-wrap items-end gap-5 lg:justify-end">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={openArchive}
                className="inline-flex h-12 items-center gap-2 rounded bg-violet-600 px-5 text-sm font-semibold text-white shadow-[0_10px_30px_rgba(124,58,237,0.24)] transition hover:bg-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-2 light:bg-violet-600 light:hover:bg-violet-700"
              >
                시작하기 <ArrowRight size={18} weight="bold" />
              </button>
              <a
                href="#how-it-works"
                className="inline-flex h-12 items-center gap-2 rounded border border-slate-300 bg-white/60 px-5 text-sm font-medium text-slate-700 transition hover:border-blue-400 hover:text-blue-700 light:border-slate-300 light:bg-white/60 light:text-slate-700 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-200 dark:hover:border-blue-500"
              >
                <PlayCircle size={18} /> 작동 방식 보기
              </a>
            </div>
          </div>
          <p className="mt-5 text-xs leading-6 text-slate-500 light:text-slate-500 dark:text-zinc-500">
            현재 연결된 아카이브 · 문서 232개 · 원본 위치 추적 가능
          </p>
        </div>

        <div
          className="relative mx-auto h-[470px] w-full max-w-[540px] overflow-hidden lg:h-[600px] lg:justify-self-end"
          role="img"
          aria-label="왼쪽의 컬러 데이터 노드에서 곡선이 흐르고 오른쪽의 근거 버블로 모이는 지식 그래픽"
        >
          <div className="pointer-events-none absolute inset-0 z-0 opacity-95">
            <svg
              viewBox="0 0 760 600"
              preserveAspectRatio="xMidYMid meet"
              className="h-full w-full"
              aria-hidden="true"
            >
              <defs>
                <radialGradient id="data-halo" cx="62%" cy="50%" r="72%">
                  <stop offset="0" stopColor="#3aabb0" stopOpacity="0.34" />
                  <stop offset="0.28" stopColor="#1d7781" stopOpacity="0.24" />
                  <stop offset="0.62" stopColor="#12485b" stopOpacity="0.12" />
                  <stop offset="0.86" stopColor="#0b2335" stopOpacity="0.05" />
                  <stop offset="1" stopColor="#061321" stopOpacity="0" />
                </radialGradient>
                <radialGradient id="bubble-glass" cx="32%" cy="26%" r="74%">
                  <stop offset="0" stopColor="#ffffff" stopOpacity="0.3" />
                  <stop offset="0.48" stopColor="#ffffff" stopOpacity="0.04" />
                  <stop offset="1" stopColor="#061b2b" stopOpacity="0.08" />
                </radialGradient>
                <filter
                  id="node-glow"
                  x="-60%"
                  y="-60%"
                  width="220%"
                  height="220%"
                >
                  <feGaussianBlur stdDeviation="8" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
                <filter
                  id="stream-glow"
                  x="-10%"
                  y="-20%"
                  width="120%"
                  height="140%"
                >
                  <feGaussianBlur stdDeviation="1.4" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              <ellipse
                cx="488"
                cy="300"
                rx="340"
                ry="330"
                fill="url(#data-halo)"
              />

              <g fill="none" stroke="#8de8e4" strokeOpacity="0.14">
                <ellipse cx="557" cy="300" rx="188" ry="244" strokeWidth="1" />
                <ellipse
                  cx="557"
                  cy="300"
                  rx="134"
                  ry="185"
                  strokeWidth="0.8"
                  strokeDasharray="2 13"
                />
                <path
                  d="M 268 66 C 412 112 554 76 724 132"
                  strokeWidth="0.7"
                  strokeDasharray="1 10"
                />
                <path
                  d="M 290 550 C 432 478 568 536 736 470"
                  strokeWidth="0.7"
                  strokeDasharray="1 11"
                />
              </g>

              <g>
                {DATA_BUBBLES.map(({ x, y, radius, color, opacity }, index) => (
                  <g key={`data-bubble-${index}`}>
                    <circle
                      cx={x}
                      cy={y}
                      r={radius}
                      fill={color}
                      fillOpacity={opacity}
                      stroke={color}
                      strokeOpacity={opacity + 0.1}
                      strokeWidth="1"
                    />
                    <circle
                      cx={x - radius * 0.2}
                      cy={y - radius * 0.2}
                      r={radius * 0.82}
                      fill="url(#bubble-glass)"
                      opacity="0.42"
                    />
                  </g>
                ))}
              </g>

              <g fill="none" strokeLinecap="round" filter="url(#stream-glow)">
                {DATA_STREAMS.map(({ id, d, color, width, opacity }) => (
                  <path
                    key={`data-stream-${id}`}
                    d={d}
                    stroke={color}
                    strokeWidth={width}
                    strokeOpacity={opacity}
                  />
                ))}
              </g>

              <g fill="none" strokeLinecap="round" opacity="0.34">
                <path
                  d="M 147 112 C 282 75 401 126 684 74"
                  stroke="#d8ffff"
                  strokeWidth="0.9"
                  strokeDasharray="1 10"
                />
                <path
                  d="M 143 305 C 316 266 434 348 704 262"
                  stroke="#d8ffff"
                  strokeWidth="0.9"
                  strokeDasharray="1 12"
                />
                <path
                  d="M 154 462 C 320 448 458 528 716 438"
                  stroke="#d8ffff"
                  strokeWidth="0.9"
                  strokeDasharray="1 11"
                />
              </g>

              <g filter="url(#node-glow)">
                {DATA_NODES.map(({ id, x, y, radius, color }) => (
                  <g key={`data-node-${id}`}>
                    <circle
                      cx={x}
                      cy={y}
                      r={radius + 10}
                      fill={color}
                      fillOpacity="0.1"
                    />
                    <circle
                      cx={x}
                      cy={y}
                      r={radius}
                      fill={color}
                      fillOpacity="0.8"
                    />
                    <circle
                      cx={x - radius * 0.2}
                      cy={y - radius * 0.24}
                      r={radius * 0.67}
                      fill="#ffffff"
                      fillOpacity="0.08"
                    />
                    <circle
                      cx={x}
                      cy={y}
                      r={radius * 0.24}
                      fill="#071a29"
                      fillOpacity="0.56"
                    />
                    <circle
                      cx={x}
                      cy={y}
                      r={radius * 0.1}
                      fill="#ffffff"
                      fillOpacity="0.72"
                    />
                    <circle
                      cx={x}
                      cy={y}
                      r={radius + 4}
                      fill="none"
                      stroke={color}
                      strokeOpacity="0.55"
                      strokeWidth="1"
                    />
                  </g>
                ))}
              </g>

              <g fill="#c8ffff" opacity="0.64">
                <circle cx="416" cy="112" r="2" />
                <circle cx="462" cy="192" r="1.6" />
                <circle cx="548" cy="270" r="2.2" />
                <circle cx="626" cy="360" r="1.8" />
                <circle cx="694" cy="482" r="2.1" />
              </g>
            </svg>
          </div>
        </div>
      </section>

      <section
        id="how-it-works"
        className="relative z-10 border-t border-slate-200/80 bg-white/55 light:border-slate-200/80 light:bg-white/55 dark:border-zinc-800 dark:bg-zinc-900/40"
      >
        <div className="mx-auto grid w-full max-w-7xl gap-8 px-6 py-14 lg:grid-cols-[0.95fr_1.05fr] lg:px-10 lg:py-20">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
              How it works
            </p>
            <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-slate-950 light:text-slate-950 dark:text-white">
              근거에 기반한 답변과 문서 업무
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-7 text-slate-600 light:text-slate-600 dark:text-zinc-400">
              <span className="block">
                우리가 쌓아온 내부 데이터를 안전하게 아카이빙하고,
              </span>
              <span className="block">
                이 데이터를 바탕으로 빠른 답변을 만들고, 근거자료를 눈으로
                재검토합니다.
              </span>
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {FLOW_STEPS.map((step) => (
              <article
                key={step.number}
                className="border border-slate-200 bg-white p-5 light:border-slate-200 light:bg-white dark:border-zinc-800 dark:bg-zinc-900"
              >
                <span className="text-xs font-semibold text-blue-600">
                  {step.number}
                </span>
                <h3 className="mt-8 text-lg font-semibold text-slate-900 light:text-slate-900 dark:text-white">
                  {step.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-600 light:text-slate-600 dark:text-zinc-400">
                  {step.description}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <footer className="relative z-10 mx-auto flex w-full max-w-7xl flex-col gap-2 px-6 py-7 text-xs text-slate-500 light:text-slate-500 sm:flex-row sm:items-center sm:justify-between lg:px-10 dark:text-zinc-500">
        <span>정책지원팀이 자료 기반 업무의 효율화를 위해 설계했습니다.</span>
        <button
          type="button"
          onClick={openArchive}
          className="w-fit border-0 bg-transparent p-0 font-medium text-blue-600 hover:text-blue-700"
        >
          아카이브 열기 →
        </button>
      </footer>
    </main>
  );
}
