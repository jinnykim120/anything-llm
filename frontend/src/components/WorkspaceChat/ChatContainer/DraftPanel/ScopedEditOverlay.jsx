// [auto-docu 화면 편집] 클릭 가능한 블록들을 감싸는 공용 래퍼 — 세 가지를
// 함께 처리한다:
//   1. 호버 — 점선 박스 + "클릭해서 수정" 라벨. 호버한 요소에 상위
//      data-block-id 요소가 있으면("이 부분(항목) 안에 더 큰 블록이 있다")
//      라벨이 "이 부분만 / 전체 블록" 두 선택지로 바뀐다 — 항목 단위로
//      먼저 만들어둔 뒤(예: 불릿 하나, 표 칸 하나) 필요하면 그걸 감싸는
//      블록 전체(불릿 목록 전체, 표 전체)로 한 단계 올려서 선택할 수 있다.
//   2. 선택 — 실선 박스로 "지금 이게 선택돼 있다"를 계속 보여준다.
//   3. 수정 패널 — 더 이상 클릭한 요소 옆에 떠서 본문을 가리지 않는다.
//      래퍼 오른쪽에 항상 비어있는 거터(padding-right)를 예약해두고,
//      선택된 블록의 y좌표에 맞춰 그 거터 안에만 그린다 — 절대 텍스트를
//      덮지 않는다("마진 노트"/구글독스 댓글 사이드바와 같은 모양).
// 마크다운 블록(3a)과 PPT 슬라이드 요소(3b) 양쪽에서 그대로 재사용한다 —
// 실제 콘텐츠는 children으로 받고, 클릭·호버 가능한 요소는 data-block-id
// 속성만 있으면 된다(중첩 가능 — 항목 요소가 블록 요소 안에 들어있으면
// 자동으로 2단계 선택이 된다).
import { useState } from "react";
import { CircleNotch, X } from "@phosphor-icons/react";

export const GUTTER_WIDTH = 240;
const GUTTER_GAP = 24;
export const GUTTER_RESERVE = GUTTER_WIDTH + GUTTER_GAP;

/** 클릭/호버된 요소의 위치를 이 래퍼(= containerRef) 기준 좌표로 바꾼다 —
 * getBoundingClientRect 차이로 계산하므로 스크롤 위치와 무관하게 정확하다. */
export function computeRelativeRect(el, containerEl) {
  const elRect = el.getBoundingClientRect();
  const containerRect = containerEl.getBoundingClientRect();
  return {
    top: elRect.top - containerRect.top,
    left: elRect.left - containerRect.left,
    width: elRect.width,
    height: elRect.height,
  };
}

function findBlockEl(target) {
  return target?.closest?.("[data-block-id]") || null;
}

/** el 자신은 제외하고, 그 바깥쪽에 data-block-id를 가진 조상이 있으면
 * 반환한다 — 있으면 "el은 더 큰 블록 안의 한 항목"이라는 뜻. */
function findParentBlockEl(el) {
  if (!el?.parentElement) return null;
  return el.parentElement.closest("[data-block-id]");
}

/**
 * @param {{
 *   containerRef: import("react").RefObject<HTMLElement>,
 *   children: import("react").ReactNode,
 *   className?: string,
 *   onSelect: (id:string, el:HTMLElement)=>void,
 *   activeId: string|null,
 *   activeRect: {top:number,left:number,width:number,height:number}|null,
 *   previewText: string,
 *   value: string,
 *   onChange: (v:string)=>void,
 *   onSubmit: ()=>void,
 *   submitting: boolean,
 *   onClose: ()=>void,
 *   extraButton?: {label:string, onClick:()=>void, active?:boolean},
 *   extraContent?: import("react").ReactNode,
 *   submitLabel?: string,
 * }} props
 */
export default function ScopedEditOverlay({
  containerRef,
  children,
  className = "",
  onSelect,
  activeId,
  activeRect,
  previewText = "",
  value,
  onChange,
  onSubmit,
  submitting,
  onClose,
  extraButton,
  extraContent,
  submitLabel = "수정",
  placeholder = "예: 더 간결하게",
  submitDisabled = false,
}) {
  const [hover, setHover] = useState(null); // {id, el, rect, parentId, parentEl, labelBelow}

  function handleMouseOver(event) {
    const el = findBlockEl(event.target);
    if (!el || !containerRef.current) {
      setHover(null);
      return;
    }
    const id = el.getAttribute("data-block-id");
    if (id === activeId) {
      setHover(null);
      return;
    }
    const parentEl = findParentBlockEl(el);
    const rect = computeRelativeRect(el, containerRef.current);
    setHover({
      id,
      el,
      rect,
      parentId: parentEl?.getAttribute("data-block-id") || null,
      parentEl,
      labelBelow: rect.top < 32,
    });
  }

  function handleMouseOut(event) {
    // 컨테이너를 완전히 벗어날 때만 지운다 — 자식 요소 사이를 이동할 땐
    // relatedTarget이 여전히 컨테이너 내부라 깜빡이지 않는다.
    if (!containerRef.current?.contains(event.relatedTarget)) setHover(null);
  }

  function handleClick(event) {
    const el = findBlockEl(event.target);
    if (!el) return;
    onSelect(el.getAttribute("data-block-id"), el);
    setHover(null);
  }

  return (
    <div
      className={`relative ${className}`}
      style={{ paddingRight: GUTTER_RESERVE }}
      ref={containerRef}
      onClick={handleClick}
      onMouseOver={handleMouseOver}
      onMouseOut={handleMouseOut}
    >
      {children}

      {/* 호버 — 점선 박스 + 라벨 */}
      {hover && (
        <>
          <div
            className="pointer-events-none absolute z-10 rounded-md border-2 border-dashed border-blue-400/70"
            style={{
              top: hover.rect.top,
              left: hover.rect.left,
              width: hover.rect.width,
              height: hover.rect.height,
            }}
          />
          <div
            className="absolute z-20 flex items-center gap-1.5 whitespace-nowrap rounded-md border border-blue-200 bg-white px-2 py-1 text-[11px] font-medium text-blue-600 shadow-sm dark:border-blue-900 dark:bg-zinc-900 dark:text-blue-400"
            style={{
              top: hover.labelBelow
                ? hover.rect.top + hover.rect.height + 4
                : hover.rect.top - 26,
              left: hover.rect.left,
            }}
          >
            {hover.parentId ? (
              <>
                <button
                  type="button"
                  className="hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(hover.id, hover.el);
                    setHover(null);
                  }}
                >
                  이 부분만
                </button>
                <span className="text-blue-300">/</span>
                <button
                  type="button"
                  className="hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(hover.parentId, hover.parentEl);
                    setHover(null);
                  }}
                >
                  전체 블록
                </button>
              </>
            ) : (
              <span>클릭해서 수정</span>
            )}
          </div>
        </>
      )}

      {/* 선택됨 — 실선 박스 */}
      {activeRect && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border-2 border-blue-500/80 transition-[top,left,width,height] duration-150"
          style={{
            top: activeRect.top,
            left: activeRect.left,
            width: activeRect.width,
            height: activeRect.height,
          }}
        />
      )}

      {/* 수정 패널 — 항상 오른쪽 거터 안에, 선택된 블록 높이에 맞춰서만
          움직인다. 본문 폭은 위 paddingRight로 이미 거터만큼 줄어들어 있어
          절대 겹치지 않는다. */}
      {activeRect && (
        <div
          className="absolute z-20 flex flex-col gap-1.5 rounded-lg border border-blue-200 bg-blue-50/95 p-3 shadow-sm dark:border-blue-900 dark:bg-blue-950/90"
          style={{ top: activeRect.top, right: 0, width: GUTTER_WIDTH }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
              선택한 부분 수정
            </span>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200"
              aria-label="선택 취소"
            >
              <X size={13} />
            </button>
          </div>
          <p className="line-clamp-3 text-[11px] text-slate-500 dark:text-zinc-400">
            {previewText.slice(0, 120)}
            {previewText.length > 120 ? "…" : ""}
          </p>
          {extraContent}
          <textarea
            autoFocus
            rows={2}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && value.trim()) {
                e.preventDefault();
                onSubmit();
              }
            }}
            placeholder={placeholder}
            className="w-full resize-none rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <div className="flex items-center justify-between gap-1.5">
            {extraButton && (
              <button
                type="button"
                onClick={extraButton.onClick}
                className={`rounded-md border px-2 py-1.5 text-[11px] font-medium ${
                  extraButton.active
                    ? "border-blue-500 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                    : "border-slate-200 text-slate-500 hover:border-blue-300 hover:text-blue-600 dark:border-zinc-700 dark:text-zinc-400"
                }`}
              >
                {extraButton.label}
              </button>
            )}
            <button
              type="button"
              onClick={onSubmit}
              disabled={!value.trim() || submitting || submitDisabled}
              className="flex w-fit items-center gap-1 self-end rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <CircleNotch size={13} className="animate-spin" />
              ) : (
                submitLabel
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
