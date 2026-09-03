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
          aria-label="Archive QA 홈"
        >
          {logo ? (
            <img src={logo} alt="Archive QA" className="h-8 w-auto" />
          ) : (
            <span className="text-sm font-semibold tracking-wide">
              Archive QA
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
        <div className="max-w-2xl">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-blue-700 shadow-sm backdrop-blur light:border-blue-200 light:bg-white/70 dark:border-blue-900 dark:bg-zinc-900/70 dark:text-blue-300">
            <Sparkle size={14} weight="fill" />
            문서 근거형 질의 아카이브
          </div>
          <h1 className="text-4xl font-semibold leading-[1.12] tracking-[-0.04em] text-slate-950 sm:text-5xl lg:text-7xl light:text-slate-950 dark:text-white">
            데이터의 흐름을 읽고,
            <br />
            <span className="text-blue-600 light:text-blue-600 dark:text-blue-300">
              근거를 따라 답합니다.
            </span>
          </h1>
          <p className="mt-7 max-w-xl text-base leading-8 text-slate-600 sm:text-lg light:text-slate-600 dark:text-zinc-300">
            문서의 맥락을 읽어 저장하고, 질문에 답할 때는 원본에 근거한 결과만
            보여드립니다. 출처와 페이지, 실제 원본 위치까지 한 화면에서
            확인하세요.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={openArchive}
              className="inline-flex h-12 items-center gap-2 rounded bg-blue-600 px-5 text-sm font-semibold text-white shadow-[0_10px_30px_rgba(15,98,254,0.22)] transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 light:bg-blue-600 light:hover:bg-blue-700"
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
          <p className="mt-5 text-xs leading-6 text-slate-500 light:text-slate-500 dark:text-zinc-500">
            현재 연결된 아카이브: 공정거래 아카이브 · 문서 232개 · 원본 위치
            추적 가능
          </p>
        </div>

        <div
          className="relative mx-auto w-full max-w-[560px] lg:justify-self-end"
          aria-label="문서에서 답변으로 이어지는 흐름 그래픽"
        >
          <div className="absolute -inset-10 rounded-full bg-blue-500/10 blur-3xl" />
          <svg
            viewBox="0 0 560 460"
            className="relative h-auto w-full overflow-visible"
            role="img"
            aria-hidden="true"
          >
            <defs>
              <linearGradient
                id="archive-flow-line"
                x1="0"
                y1="0"
                x2="1"
                y2="1"
              >
                <stop offset="0" stopColor="#0f62fe" stopOpacity="0.35" />
                <stop offset="0.55" stopColor="#0f62fe" />
                <stop offset="1" stopColor="#78a9ff" stopOpacity="0.35" />
              </linearGradient>
              <filter
                id="archive-flow-shadow"
                x="-30%"
                y="-30%"
                width="160%"
                height="160%"
              >
                <feDropShadow
                  dx="0"
                  dy="12"
                  stdDeviation="16"
                  floodColor="#0f62fe"
                  floodOpacity="0.14"
                />
              </filter>
            </defs>
            <path
              d="M64 92C159 20 190 178 278 124S385 47 488 102"
              fill="none"
              stroke="url(#archive-flow-line)"
              strokeWidth="2"
              strokeDasharray="5 8"
            />
            <path
              d="M71 339C176 384 210 244 302 294S410 383 498 306"
              fill="none"
              stroke="url(#archive-flow-line)"
              strokeWidth="2"
              strokeDasharray="5 8"
            />
            <path
              d="M99 216H463"
              fill="none"
              stroke="url(#archive-flow-line)"
              strokeWidth="1.5"
              strokeDasharray="3 10"
              opacity="0.55"
            />
            <g filter="url(#archive-flow-shadow)">
              <g transform="translate(36 55) rotate(-7)">
                <rect
                  width="150"
                  height="190"
                  rx="5"
                  fill="white"
                  stroke="#c8d6e8"
                />
                <path
                  d="M22 35h92M22 52h67M22 83h106M22 100h95M22 117h78"
                  stroke="#b6c7de"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
                <rect
                  x="22"
                  y="141"
                  width="62"
                  height="9"
                  rx="4"
                  fill="#d8e6ff"
                />
                <path d="M105 0h25l20 20v25" fill="#e9f1ff" />
                <path d="M130 0v24h20" fill="none" stroke="#b9d2ff" />
              </g>
              <g transform="translate(211 139)">
                <rect width="168" height="128" rx="7" fill="#0f62fe" />
                <rect
                  x="18"
                  y="18"
                  width="45"
                  height="8"
                  rx="4"
                  fill="#a6c8ff"
                />
                <rect
                  x="18"
                  y="41"
                  width="128"
                  height="7"
                  rx="3.5"
                  fill="#d0e2ff"
                  opacity="0.9"
                />
                <rect
                  x="18"
                  y="59"
                  width="110"
                  height="7"
                  rx="3.5"
                  fill="#d0e2ff"
                  opacity="0.7"
                />
                <rect
                  x="18"
                  y="87"
                  width="74"
                  height="8"
                  rx="4"
                  fill="white"
                  opacity="0.92"
                />
                <circle cx="137" cy="91" r="13" fill="#78a9ff" />
                <path
                  d="m131 91 4 4 8-9"
                  fill="none"
                  stroke="#0f62fe"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
              <g transform="translate(358 257) rotate(7)">
                <rect
                  width="164"
                  height="140"
                  rx="7"
                  fill="white"
                  stroke="#c8d6e8"
                />
                <rect
                  x="17"
                  y="18"
                  width="74"
                  height="9"
                  rx="4"
                  fill="#0f62fe"
                  opacity="0.8"
                />
                <rect
                  x="17"
                  y="47"
                  width="130"
                  height="5"
                  rx="2.5"
                  fill="#c3d0e2"
                />
                <rect
                  x="17"
                  y="60"
                  width="114"
                  height="5"
                  rx="2.5"
                  fill="#c3d0e2"
                />
                <rect
                  x="17"
                  y="73"
                  width="123"
                  height="5"
                  rx="2.5"
                  fill="#c3d0e2"
                />
                <rect
                  x="17"
                  y="100"
                  width="84"
                  height="18"
                  rx="3"
                  fill="#fff7d6"
                  stroke="#f1c21b"
                />
                <path
                  d="M29 109h60"
                  stroke="#b28600"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </g>
            </g>
            <g fill="#0f62fe">
              <circle cx="66" cy="92" r="5" />
              <circle cx="278" cy="124" r="5" />
              <circle cx="488" cy="102" r="5" />
              <circle cx="71" cy="339" r="5" />
              <circle cx="302" cy="294" r="5" />
              <circle cx="498" cy="306" r="5" />
            </g>
          </svg>
        </div>
      </section>

      <section
        id="how-it-works"
        className="relative z-10 border-t border-slate-200/80 bg-white/55 light:border-slate-200/80 light:bg-white/55 dark:border-zinc-800 dark:bg-zinc-900/40"
      >
        <div className="mx-auto grid w-full max-w-7xl gap-8 px-6 py-14 lg:grid-cols-[0.75fr_1.25fr] lg:px-10 lg:py-20">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
              How it works
            </p>
            <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-slate-950 light:text-slate-950 dark:text-white">
              근거가 남는 문서 업무
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-7 text-slate-600 light:text-slate-600 dark:text-zinc-400">
              답변만 빠르게 만드는 것이 아니라, 나중에 다시 확인할 수 있는
              경로까지 함께 남깁니다.
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
        <span>
          정책지원팀이 문서 업무의 정확성과 추적 가능성을 위해 설계했습니다.
        </span>
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
