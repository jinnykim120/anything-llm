import { ArrowUpRight, Lightbulb } from "@phosphor-icons/react";

// [NEXUS] 질문 전 대기 화면 하단 중앙의 "새로운 인사이트 보기" 버튼.
// 주소는 소스에 쓰지 않고 frontend/.env 의 VITE_NEXUS_INSIGHT_URL 에서 읽는다
// (공개 저장소에 사내 주소가 올라가지 않도록). 값이 없으면 아무것도 그리지 않는다.
// 새 창(탭)으로 열기 때문에 이 작업 화면은 그대로 남는다.
const INSIGHT_URL = (import.meta.env.VITE_NEXUS_INSIGHT_URL || "").trim();

export default function InsightButton() {
  if (!INSIGHT_URL) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center">
      <a
        href={INSIGHT_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold !text-white no-underline hover:!text-white shadow-lg transition hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <Lightbulb size={16} weight="fill" />
        새로운 인사이트 보기
        <ArrowUpRight size={14} weight="bold" />
      </a>
    </div>
  );
}
