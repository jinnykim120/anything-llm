// [auto-docu PPT 미리보기] 슬라이드 한 장을 구조화된 카드로 보여준다(불릿·표·차트
// 자리표시자·핵심 수치·비교·타임라인·인용). index.jsx 에서 분리 — 상태 없음,
// data-block-* 속성은 ScopedEditOverlay 의 부분 수정이 그대로 읽는다.
import { CHART_TYPE_LABEL, SLIDE_LAYOUT_LABEL } from "./panelConstants";
import { blockTextFor } from "./pptSlideSpecPatch";

export default function PptSlideCard({ slide, index: i }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <span className="rounded-md border border-blue-200 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-blue-600 dark:border-blue-900 dark:text-blue-400">
          {i + 1} / {SLIDE_LAYOUT_LABEL[slide.layout] || "내용"}
        </span>
        <span
          data-block-id={`${i}.title`}
          data-block-text={slide.title || ""}
          className="text-sm font-semibold text-slate-800 dark:text-zinc-100"
        >
          {slide.title}
        </span>
      </div>
      {slide.subtitle && (
        <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
          {slide.subtitle}
        </p>
      )}
      {Array.isArray(slide.content) && slide.content.length > 0 && (
        <ul
          data-block-id={`${i}.content`}
          data-block-text={blockTextFor(slide, "content")}
          className="mt-2 list-disc space-y-1 rounded px-5 py-1 text-xs leading-5 text-slate-700 dark:text-zinc-300"
        >
          {slide.content.map((c, ci) => (
            <li
              key={ci}
              data-block-id={`${i}.bullet.${ci}`}
              data-block-text={c}
            >
              {c}
            </li>
          ))}
        </ul>
      )}
      {Array.isArray(slide.stats) && slide.stats.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {slide.stats.map((st, si) => (
            <div
              key={si}
              className="min-w-[110px] rounded border border-slate-200 px-3 py-2 text-center dark:border-zinc-700"
            >
              <div className="text-base font-bold text-blue-600 dark:text-blue-400">
                {st.value}
              </div>
              <div className="text-[11px] font-medium text-slate-700 dark:text-zinc-200">
                {st.label}
              </div>
              {st.note && (
                <div className="text-[10px] text-slate-500 dark:text-zinc-500">
                  {st.note}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {Array.isArray(slide.columns) && slide.columns.length > 0 && (
        <div className="mt-2 flex gap-2">
          {slide.columns.map((col, ci) => (
            <div
              key={ci}
              className="min-w-0 flex-1 rounded border border-slate-200 dark:border-zinc-700"
            >
              <div className="bg-slate-100 px-2 py-1 text-center text-[11px] font-semibold dark:bg-zinc-800">
                {col.heading}
              </div>
              <ul className="list-disc space-y-0.5 px-5 py-1.5 text-xs text-slate-700 dark:text-zinc-300">
                {(col.items || []).map((it, ii) => (
                  <li key={ii}>{it}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {Array.isArray(slide.steps) && slide.steps.length > 0 && (
        <ol className="mt-2 space-y-1 text-xs text-slate-700 dark:text-zinc-300">
          {slide.steps.map((st, si) => (
            <li key={si} className="flex gap-2">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white">
                {si + 1}
              </span>
              <span>
                <b>{st.label}</b>
                {st.text ? ` — ${st.text}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
      {slide.quote && (
        <blockquote className="mt-2 border-l-2 border-blue-500 pl-3 text-xs italic text-slate-700 dark:text-zinc-300">
          {slide.quote}
        </blockquote>
      )}
      {slide.table && (
        <div
          data-block-id={`${i}.table`}
          data-block-text={blockTextFor(slide, "table")}
          className="mt-2 overflow-x-auto rounded p-1"
        >
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {slide.table.headers.map((h, hi) => (
                  <th
                    key={hi}
                    data-block-id={`${i}.header.${hi}`}
                    data-block-text={h}
                    className="border border-slate-200 bg-slate-50 px-2 py-1 text-left font-semibold text-slate-700 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slide.table.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      data-block-id={`${i}.cell.${ri}.${ci}`}
                      data-block-text={cell}
                      className="border border-slate-200 px-2 py-1 text-slate-600 dark:border-zinc-800 dark:text-zinc-400"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {slide.chart && (
        <div
          data-block-id={`${i}.chart`}
          data-block-text={blockTextFor(slide, "chart")}
          className="mt-2 rounded border border-dashed border-blue-300 bg-blue-50/50 px-3 py-2 text-xs text-slate-600 dark:border-blue-900 dark:bg-blue-950/20 dark:text-zinc-300"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
            {CHART_TYPE_LABEL[slide.chart.type] || "차트"}
          </span>
          <span className="ml-1.5">
            {(slide.chart.categories || []).join(", ")}
            {slide.chart.series?.length
              ? ` · ${slide.chart.series
                  .map((s) => s.name)
                  .filter(Boolean)
                  .join(", ")}`
              : ""}
          </span>
        </div>
      )}
    </div>
  );
}
