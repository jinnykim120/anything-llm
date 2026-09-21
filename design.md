# Design — NEXUS

A locked design system for the NEXUS archive/RAG tool (AnythingLLM fork).
Every redesign of a NEXUS-branded page reads this file first. This is a
production React + Tailwind app with existing routes and working
functionality — the system below is expressed as Tailwind utility
conventions, not raw CSS tokens, and is scoped to the **custom NEXUS UI**
only (`frontend/src/pages/Main/LandingPage.jsx`,
`frontend/src/components/ArchiveSidebar/`,
`frontend/src/components/WorkspaceChat/ChatContainer/DraftPanel/`,
`frontend/src/pages/DocRegen/`). It does not apply to the stock AnythingLLM
admin/settings screens outside the archive UI.

## Genre
modern-minimal — internal B2B enterprise tool, Stripe/Linear/dev-tool register.

## Tone
Technical. Precise, calm-confident, instrument-panel — not playful, not warm,
not editorial. (User-selected over utilitarian/austere.)

## Theme — Cobalt, adapted
Catalog pick: **Cobalt** (cool cobalt-on-light, dev-tool register). Chosen
because its single "electric cobalt blue" signal accent is the same blue
NEXUS's brand already anchors on (established this session) — the rotation
doesn't fight prior work, it formalizes it.

**Three deliberate deviations from the canonical Cobalt spec**, driven by
this being a live internal tool (not a marketing site) with Korean as a
primary UI language:
1. **No JetBrains Mono / Space Grotesk webfonts.** No external font CDN
   (corp-proxy constraints). Mono texture, where still used, comes from
   Tailwind's default `font-mono` system stack (ui-monospace/SFMono/Menlo/
   Consolas) — zero network dependency.
2. **Display font is Pretendard Variable, not Plus Jakarta Sans alone.**
   Self-hosted (`frontend/public/fonts/PretendardVariable.woff2`, one
   variable-weight file). Added 2026-09-17 (`21d094d1`) because Plus Jakarta
   Sans is Latin-only and has no Hangul glyphs — most of this UI's real text
   is Korean, and it was silently falling back to the OS default font.
   `tailwind.config.js` → `fontFamily.sans` and both hardcoded
   `frontend/src/index.css` font-family rules (html/body, and the
   `!important` form-control fallback that was overriding it) list
   `"Pretendard Variable", "plus-jakarta-sans", ...` in that order — Jakarta
   Sans stays as the Latin fallback, not the primary.
3. **No literal "code is the hero" artifact.** NEXUS has no code/API to
   demo. The equivalent focal-artifact move is the existing **citation /
   source card** (bordered snippet + page/bbox metadata + score) already
   surfaced in chat answers — that IS NEXUS's "structured data" hero, and
   should read with the same instrument-panel precision Cobalt gives a code
   card (hairline border, mono metadata line, no drop shadow).

### Palette (Tailwind classes, light mode / dark mode)
| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-paper` | `bg-slate-50` / `bg-white` | `bg-zinc-950` | page/app background |
| `--color-paper-2` | `bg-white` | `bg-zinc-900` | raised surface (inputs, cards) |
| `--color-ink` | `text-slate-900` | `text-zinc-100` | primary text |
| `--color-ink-2` | `text-slate-600` | `text-zinc-400` | body/secondary text |
| `--color-muted` | `text-slate-500` | `text-zinc-500` | tertiary/meta text — **floor**, never `slate-400`/`zinc-600` for real reading text (AA contrast) |
| `--color-rule` | `border-slate-200` | `border-zinc-800` | hairline borders — does the structural work; no filled/shaded boxes |
| `--color-accent` | `blue-600` (`#2563EB`) | `blue-400`/`blue-300` per surface | the one signal — CTAs, active states, eyebrow labels, focus rings |
| `--color-accent-soft` | `blue-50` / `blue-950/40` | | accent-tinted surfaces (active nav item, primary button ghost state) |
| `--color-focus` | `ring-blue-500/30` | | focus rings, ≥3:1 contrast, never animated in |

Violet (`violet-600`) stays reserved for the 전사문서작성tool (DocRegen)
feature as an intentional secondary accent — a different *tool*, not a
competing brand color. Amber stays reserved for "필요 자료"/status warnings.

## Typography
- Display + body: **Pretendard Variable**, Latin fallback **Plus Jakarta
  Sans** (`tailwind.config.js` → `theme.extend.fontFamily.sans`; see the
  Theme deviation above for why). Single-family discipline per
  modern-minimal — no second display face.
- Mono: Tailwind's default `font-mono` stack, reserved for genuinely
  tabular/numeric or code-like content only — citation-index brackets
  (`SourceItem`), token/sec metrics (`RenderMetrics`), tool-call JSON
  (`ToolApprovalRequest`), the DraftPanel raw-markdown edit textarea. Not
  used for section/eyebrow labels (see next point).
- **Eyebrow / section-label pattern — de-monofied 2026-09-17 (`21d094d1`).**
  The original Cobatt-signature `font-mono uppercase tracking-[0.08em]`
  treatment was dropped project-wide (`ArchiveSidebar`, `LandingPage`,
  `DraftPanel`, `ScopedEditOverlay`, `StatsMethodPicker`, `DocRegen`) because
  uppercase+mono+wide-tracking Korean text is illegible — Hangul has no
  upper/lowercase and the letterforms fought the tight tracking. Current
  pattern is plain proportional text, semibold, accent-colored, no
  uppercase/tracking/mono: `text-xs font-semibold text-blue-600`
  (`text-sm` on the landing page's larger eyebrows). A few older screens
  outside the originally-scoped file list (`DocumentRoom`,
  `ArchiveManagement`, `GeneralSettings/ScheduledJobs`) still carry the old
  `uppercase tracking-[…]` pattern — harmless (mostly Latin/numeric labels
  there) but not yet reconciled; follow the new plain pattern if they're
  next touched.

## Spacing & radius
- Spacing: Tailwind's default scale as already used (no new custom scale —
  the codebase already spaces on 4px increments via standard utilities).
- Radius — **tightened, Cobalt's "drawn with a ruler," not Coral's soft
  pills**: `rounded-md` (6px) on buttons/inputs/controls, `rounded-lg` (8px)
  on cards/panels. No `rounded-full` pills on primary CTAs (the internal
  search-mode toggle chips are an existing exception — they're a segmented
  switch, not a CTA, and keep their capsule shape).

## Component voice
- **Hairlines over boxes.** Structural grouping (sidebar sections, card
  boundaries) comes from a 1px `border-slate-200`/`border-zinc-800` divider,
  not a filled `bg-slate-50` rounded box. Reserve filled surfaces for genuine
  raised controls (inputs, dropdowns, the code/citation card).
- **No drop shadows** beyond a barely-there lift on the one genuinely
  elevated surface (citation card, modal). Depth comes from borders.
- **One accent, used sparingly** (<5% of any viewport) — primary button,
  active nav/tab state, focus rings, eyebrow labels, links. Never floods.
- **Buttons** — solid `bg-blue-600 hover:bg-blue-700` primary, `rounded-md`,
  no gradient, no pill. Outlined/ghost secondary uses `border-slate-200`.

## Motion
Motion-cut project (no framer-motion/gsap in `package.json`). Keep Tailwind
`transition-colors duration-200` on hover/focus states only. No scroll
reveals, no entrance animation — the page is composed, not performed.
Respect `prefers-reduced-motion` (already inherited from Tailwind's default
behavior; no custom keyframes introduced that would need gating).

## Macrostructure families
- **Landing (`LandingPage.jsx`)** — Marquee-lite: asymmetric hero (title
  left, one focal graphic right), restrained — no pricing/testimonials/logo
  wall (there's nothing to sell, this is a gateway into the internal tool).
  MAY use the existing abstract data-flow illustration as enrichment
  (Tier-A/B, already hand-built SVG — keep it, just tighten its surrounding
  chrome to match the system below).
- **App shell (`ArchiveSidebar`, `WorkspaceChat`, `DraftPanel`, `DocRegen`)**
  — Workbench: tool-first, information-dense, hairline-divided, zero
  enrichment. Function carries every one of these screens.

## Nav & footer
- **Sidebar = N3 Side-rail** (already the shape — keep it structurally,
  restyle its surfaces per Component voice above).
- **Landing footer = Ft2 Inline single line** (already the shape — wordmark
  credit + one link, hairline rule above. Keep.)

## What pages MUST share
- The NEXUS wordmark, exactly as-is.
- The blue-600 accent and its restrained (<5%) placement.
- Plus Jakarta Sans, single-family.
- The hairline-over-boxes component voice and the 6px/8px radius scale.
- The mono-eyebrow label pattern for section headers.

## What pages MAY differ on
- Landing may carry its one hero illustration; app-shell pages carry none.
- DocRegen keeps its violet secondary accent for its own controls.

## Rollout status
- ✅ `ArchiveSidebar/index.jsx` — hairline restyle applied.
- ✅ `pages/Main/LandingPage.jsx` — eyebrow/CTA/card tightening applied
  (partially done in the earlier ui-ux-pro-max pass; this pass finishes it).
- ✅ `WorkspaceChat/ChatContainer/DraftPanel/index.jsx` — hairline + mono
  meta applied; eyebrow labels de-monofied `21d094d1`; result preview
  widened to `max-w-7xl` (`9a93bf01`).
- ✅ `21d094d1` (2026-09-17) — Pretendard Variable self-hosted + wired as
  primary font; eyebrow labels de-monofied across `ArchiveSidebar`,
  `LandingPage`, `DraftPanel`, `ScopedEditOverlay`, `StatsMethodPicker`,
  `DocRegen`.
- 🟡 `pages/DocRegen/index.jsx` — eyebrow de-monofied (`21d094d1`), but the
  full hairline/card restyle pass this file originally deferred (was 959
  lines, complex multi-step wizard) still hasn't happened; still keeps its
  violet secondary accent.
- 🟡 `WorkspaceChat/ChatContainer/SourcesSidebar/SourceItem/index.jsx` — got
  layout-only fixes in `9a93bf01` (capped citation-chip row height,
  drag-resizable panel), not the hairline-card visual restyle this system
  calls for; it's currently a plain list item (no border), with mono used
  only for the `[n]` citation-index badge. Still the next candidate for the
  full "structured data hero" treatment described above.
