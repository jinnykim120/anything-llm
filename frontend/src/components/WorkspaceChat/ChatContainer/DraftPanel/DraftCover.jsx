/** 다운로드되는 HTML의 표지 배너와 같은 모양을 패널 안에서 미리 보여준다. */
export default function DraftCover({ label, title, accent }) {
  return (
    <div
      className="rounded-t-lg px-5 py-4 text-white"
      style={{
        background: `linear-gradient(135deg, ${accent.accent}, ${accent.accentDark})`,
      }}
    >
      <span className="inline-flex items-center rounded-full bg-white/20 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
        {label || "문서 초안"}
      </span>
      <h3 className="mt-1.5 text-base font-extrabold leading-snug">{title}</h3>
      <p className="mt-0.5 text-[11px] text-white/80">
        {new Date().toLocaleString("ko-KR")} · NEXUS
      </p>
    </div>
  );
}
