import {
  ArrowLeft,
  ChartLineUp,
  FileText,
  GearSix,
  Pulse,
} from "@phosphor-icons/react";
import { Link, useParams } from "react-router-dom";
import ArchiveSidebar from "@/components/ArchiveSidebar";
import paths from "@/utils/paths";

const MANAGEMENT_ITEMS = [
  {
    title: "문서함",
    description: "폴더별 문서, 추출 텍스트, 분류 상태를 확인합니다.",
    icon: FileText,
    href: (slug) => paths.workspace.library(slug),
    action: "문서함 열기",
  },
  {
    title: "질의 환경",
    description: "검색 범위와 답변에 사용하는 작업공간 설정을 관리합니다.",
    icon: GearSix,
    href: (slug) => paths.workspace.settings.chatSettings(slug),
    action: "환경 열기",
  },
  {
    title: "시스템 상태",
    description: "서버와 수집기의 최근 동작을 확인할 수 있습니다.",
    icon: Pulse,
    href: paths.settings.logs,
    action: "상태 확인",
  },
];

export default function ArchiveManagement() {
  const { slug = "archive-full" } = useParams();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50 text-slate-900 dark:bg-zinc-950 dark:text-zinc-100">
      <ArchiveSidebar slug={slug} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-8 lg:px-12 lg:py-12">
          <Link
            to={paths.workspace.chat(slug)}
            className="inline-flex items-center gap-2 text-xs font-medium text-slate-500 transition hover:text-blue-600 dark:text-zinc-500 dark:hover:text-blue-300"
          >
            <ArrowLeft size={15} /> 작업 화면으로 돌아가기
          </Link>
          <div className="mt-8 border-b border-slate-200 pb-7 dark:border-zinc-800">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
              Archive controls
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
              관리
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-500 dark:text-zinc-400">
              아카이브 업무에 필요한 기능만 남겼습니다. 문서와 질의 환경, 시스템
              상태를 이곳에서 확인합니다.
            </p>
          </div>
          <section className="mt-8 grid gap-4 md:grid-cols-3">
            {MANAGEMENT_ITEMS.map((item) => {
              const Icon = item.icon;
              const href = item.href(slug);
              return (
                <Link
                  key={item.title}
                  to={href}
                  className="group flex min-h-[210px] flex-col border border-slate-200 bg-white p-5 transition hover:-translate-y-0.5 hover:border-blue-400 hover:shadow-[0_12px_30px_rgba(15,98,254,0.08)] dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-blue-700"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-300">
                    <Icon size={20} weight="bold" />
                  </div>
                  <h2 className="mt-7 text-lg font-semibold">{item.title}</h2>
                  <p className="mt-2 flex-1 text-sm leading-6 text-slate-500 dark:text-zinc-400">
                    {item.description}
                  </p>
                  <span className="mt-5 inline-flex items-center gap-1 text-xs font-semibold text-blue-600 transition group-hover:gap-2 dark:text-blue-300">
                    {item.action} →
                  </span>
                </Link>
              );
            })}
          </section>
          <section className="mt-10 grid gap-4 md:grid-cols-2">
            <div className="border border-slate-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <ChartLineUp size={18} className="text-blue-600" /> 검색 범위
              </div>
              <p className="mt-4 text-sm text-slate-600 dark:text-zinc-300">
                공정거래 아카이브 · 현재 문서 232개만 검색 중
              </p>
              <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-zinc-500">
                공유 벡터 저장소를 사용하지만 작업공간 namespace로 문서 범위를
                분리합니다.
              </p>
            </div>
            <div className="border border-slate-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Pulse size={18} className="text-emerald-600" /> 운영 모드
              </div>
              <p className="mt-4 text-sm text-slate-600 dark:text-zinc-300">
                ONNX 재랭커 · 기본 검색
              </p>
              <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-zinc-500">
                외부 Google/Gemini API 없이 현재 서버 설정으로 동작합니다.
              </p>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
