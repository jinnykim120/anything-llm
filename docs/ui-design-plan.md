# Auto Docu UI design plan

Status: design decisions captured on 2026-09-03. Implementation is intentionally deferred until the next work session.

## Product direction

The product is a document-grounded archive QA workspace. The first screen should explain that purpose before opening the work surface. The UI should feel calm and intentional rather than like a full AnythingLLM administration console.

The visual reference combines:

- IBM Carbon-inspired structure: light canvas, charcoal text, IBM Blue `#0f62fe` as the primary accent, 1px hairlines, square geometry, 4px spacing rhythm, and restrained elevation.
- Raycast-inspired first impression: one strong message, one clear primary action, and a simple abstract product visual that explains the flow without stock photography.

This is inspiration only. Do not use IBM or Raycast logos, copy, or proprietary artwork.

## First entry / landing page

The root route should be an introduction page. It must not automatically drop a first-time visitor into a chat workspace.

Recommended hero copy:

> 데이터의 흐름을 읽고, 근거를 따라 답합니다.

Supporting copy:

> PDF·HWP·PPTX 등 다양한 문서를 맥락 단위로 읽고 저장합니다. 질문에 답할 때는 원본에 근거한 결과만 보여주며, 출처와 페이지, 실제 원본 위치까지 함께 확인할 수 있습니다.

The workspace empty-state copy is:

> 아카이브에서 무엇을 확인할까요?

> 질문을 입력하면 관련 문서의 맥락을 읽고, 답변과 원본 근거를 함께 보여드립니다.

Landing actions:

- `시작하기` → `/workspace/archive-full` (or the selected workspace when workspace selection is introduced).
- `작동 방식 보기` → the workflow section on the landing page.
- A small `작업 화면 열기` link may remain available for returning users.

Landing visual:

- Original SVG/CSS artwork, not a stock image.
- Geometric document cards and a single connected data/evidence line representing `문서 → 맥락 → 근거 → 답변`.
- IBM Blue and charcoal on a light canvas; no noisy 3D scene.
- Slow, optional motion only; respect `prefers-reduced-motion`.

The footer should include a restrained credit:

> 정책지원팀이 문서 업무의 정확성과 추적 가능성을 위해 설계했습니다.

## Main workspace shell

Three columns are acceptable for archive work because chat, evidence, and the original document are used together. The layout must make the three areas feel like one evidence workbench:

```text
┌ logo · workspace name · status · 관리 ┐
├ 질의 아카이브 ┤ 질문·답변 ┤ 출처 / 원본 PDF ┤
│ history        │ main chat │ evidence panel │
│                │           │                │
│ 기록 검색      │ prompt    │ source + PDF   │
│ + 새 질의      │           │                │
└────────────────────────────────────────────┘
```

- The center chat must keep a usable minimum width.
- The left and right panels should be resizable and remember their widths.
- At narrower widths, the evidence panel becomes a drawer/overlay instead of squeezing the answer into an unreadable column.
- The right side should be one evidence inspector: source list and PDF are tabs or stacked sections inside it, not unrelated permanent windows.
- Add `채팅 집중`, `근거 집중`, and `기본 배치` layout actions.

### Left rail: 질의 아카이브

Keep this rail deliberately quiet. It is a history navigator, not an administration menu.

Visible elements only:

- workspace name (for example, `공정거래 아카이브`)
- `질의 아카이브` heading with a small `최근 질문과 답변` helper
- a short list of history items
- bottom actions: `기록 검색` and `+ 새 질의`
- one `관리` entry

Default history order is latest-first. After a new question, show `현재 질문과 관련된 기록` above `최근 질의`; provide a small `관련순 / 최신순` switch. Use concise generated titles rather than full question paragraphs.

Do not show vector counts, scores, provider names, or the inherited Agent/MCP/channel menu in this rail.

### Center chat

The empty state uses the copy above and three suggested questions, such as:

- `이 문서의 목적은 무엇인가요?`
- `관련 조항의 적용 요건은 무엇인가요?`
- `답변의 원본 페이지를 보여주세요.`

The prompt area should expose the current scope as a compact chip, for example `공정거래 아카이브 · 전체 문서 · Default 검색`. The input placeholder remains short: `문서에 대해 질문해 보세요.`

Answer actions should prioritize practical work: copy with citations, save, export, regenerate, related question, and show evidence used.

### Right evidence inspector

The inspector should connect answer → source → original location.

- source cards show document title, page, section, reference count, and `원본 보기`.
- clicking a source selects the corresponding PDF page and BBox.
- the PDF toolbar provides page navigation, zoom, fit-to-width, and a clear active-highlight state.
- retain yellow for the active BBox as a semantic highlight, with a stronger border/legend in the light theme.

## Management and document room

The wrench is renamed to `관리` and no longer opens the entire inherited AnythingLLM settings surface.

Visible management areas:

1. `문서함`
2. `질의 환경`
3. `시스템 상태`

### 문서함

The document room must make the loaded archive understandable at a glance. Use a left folder tree and a right document list/detail view:

```text
문서함
├ 전체 문서 (232)
├ 공정거래
│ ├ 기준
│ ├ 지침
│ └ 교육
├ 협력사
├ 계약
└ 미분류
```

- Folder counts are visible and folders expand/collapse.
- Selecting a folder shows document name, type, processing status, classification status, and registration date.
- Selecting a document opens raw extracted text, metadata, and classification review in the detail pane.
- Keep technical vector IDs out of the default view.

### Settings visibility

Hide inherited features that are not part of the archive QA product: Agent, MCP, channels, external search, embeds, community, model marketplace, and unrelated branding/developer/experimental screens. Keep a guarded `고급 기능` area for rollback; remove items permanently only after usage is confirmed to be zero.

## Theme and identity

- Light theme is the default.
- A bottom-right theme control switches to dark mode and persists the user's choice.
- New logo: an original geometric mark where document shapes are connected by one continuous evidence line (`데이터 → 맥락 → 근거`). It must work as a sidebar mark, favicon, and monochrome icon.

## Data scope affordance

The UI should make the logical search scope explicit: `공정거래 아카이브 · 현재 문서 232개만 검색 중`. The backend uses one shared vector table with workspace namespaces, so this label helps users understand what corpus is being searched without exposing database details.

## Suggested implementation order

1. Carbon-light tokens, new logo, and responsive three-pane shell.
2. Landing page and first-use flow.
3. Simplified 질의 아카이브 rail and empty-state copy.
4. Evidence inspector with source/PDF synchronization.
5. Document room tree and classification review surface.
6. Hide/guard inherited settings and add the light/dark toggle.
