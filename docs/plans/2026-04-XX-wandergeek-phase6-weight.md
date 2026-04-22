# Wandergeek Phase 6 — Weight Screen Rewrite

## Overview

Reskin the Weight screen to match the Wandergeek deep-teal / glossy / JetBrains-Mono aesthetic established in Phase 1+2 (`docs/plans/completed/2026-04-20-wandergeek-design-rewrite.md`) and extended by Phase 3 BP (`docs/plans/completed/2026-04-20-wandergeek-phase3-bp.md`), Phase 4 Food (`docs/plans/completed/2026-04-XX-wandergeek-phase4-food.md`), and Phase 5 Meds (`docs/plans/completed/2026-04-XX-wandergeek-phase5-meds.md`). Phase 6 keeps the same runtime model the earlier phases settled on: every screen renders directly into `#app` under the fixed `.wg-bottom-nav`; `<wg-phone-chrome>` remains an available primitive but is not mounted here.

Phase 6 is similar to Phase 3 (BP) in structure: a big current-metric card, a range selector driving a line chart, and a day-grouped history list. The handoff prototype does not include a dedicated Weight screen, so the layout composes Wandergeek primitives (`card`, `gloss`, `gloss-sun`, `gloss-inset`, `mono-display`, `section-label`, `tag`, `icon-btn`) with the range-selector + chart pattern validated in Phase 3.

The target layout:

- **Big current-weight card** at the top — `.wg-card` with a large `.wg-mono-display` kilo reading, a small uppercase "kg" unit suffix, and a trend arrow + delta against the previous entry (sun for decrease, alert for increase when goal is lose-weight; inverted for gain). A small section-label subtitle carries the recorded timestamp ("ISO-LOCAL · 2h ago").
- **Goal card** (optional, renders only when a goal is set) — inline `.wg-card--inset` row with "GOAL · 72.0 kg" mono, a progress bar similar to `WGMacroBar`, and a muted "−2.4 kg to goal" label. Hidden when no goal exists.
- **Range selector** — `.wg-gloss--inset` container carrying four `.wg-gloss--sun`-capable pills (7d / 30d / 90d / All), matching the `WGBpChart` range-selector pattern. Active state via class, not inline style. Persists via a new `mt-weight-range` localStorage key matching `mt-bp-range` / `mt-food-subtab` / `mt-meds-subtab`.
- **Line chart** — a single-series `WGWeightChart` component (new; follows the Phase 3 `WGBpChart` structure with one line instead of two), plotting the active range. Includes goal line overlay when a goal is set. Empty state renders a muted "No weight entries yet" card instead of an empty canvas.
- **Day-grouped history** — `.wg-section-label` day headers ("22.04.2026 · Tue"), each entry a `.wg-card` row with mono weight, ISO-local time, and a trailing `.wg-icon-btn` cluster (edit + delete). Offline-pending + rejected badges become `.wg-tag--mono` variants.
- **Add weight FAB / CTA** — full-width `.wg-gloss--sun` button at the bottom of the screen (replaces the current `#add-weight-btn` FAB).
- **EditWeightModal** — mono header ("New weight" / "Edit weight"), weight input + unit toggle (kg/lb) as `.wg-gloss--inset` wraps, date-time input, Cancel + Save buttons (`.wg-gloss` + `.wg-gloss--sun`, 2× flex on Save per modal-button-order convention). Uses existing `modal-controller.js` history plumbing.

No backend changes. The existing `/api/weight*` endpoints, Dexie offline queue (`WeightStore`), goal endpoints, and `DataStore.loadSWR` flow stay intact — we rewrite only the render layer and the CSS.

## Context (from discovery)

**Existing weight code (target):**

- `web/static/js/features/weight.js` (~788 lines) — already extracted as a feature module (matches bp.js / food.js / meds.js / today.js pattern).
  - `renderWeightChart(logs, goalData)` — current chart render; switched to `WGWeightChart.render(…)` in Phase 6
  - `renderWeightStats(stats)` — stats block (streak, average, etc.); may be folded into the top card or kept as a secondary section
  - `_renderWeightData(logsRes, goalRes)` — SWR-backed render orchestrator; unchanged
  - `renderWeightLogs(logs)` — history list render path; rewritten into day-grouped `.wg-card` rows
  - Modal entry + save flow: `showAddWeightModal`, `editWeightLog`, `saveWeight`, `deleteWeight` — restyled but behavior preserved
- `web/static/index.html` — `#weight-view` section (lines ~123-129): `#weightChart` canvas, `#weight-stats` block, `#weight-list` ul, `#add-weight-btn` FAB
- `web/static/css/styles.css` — existing `.weight-*` paper-era classes get replaced with `.wg-weight-*`

**Handoff prototype:** no dedicated Weight screen; Phase 6 composes from existing primitives and the Phase 3 BP pattern.

**Wandergeek primitives available (from Phase 1+2+3+4+5):**

- `.wg-card` / `.wg-card--inset` / `.wg-gloss` / `.wg-gloss--sun` / `.wg-gloss--inset` / `.wg-tag` + variants / `.wg-mono-display` / `.wg-section-label` / `.wg-icon-btn`
- `WGBpChart` — reference pattern for `WGWeightChart`; the single-series variant reuses the range-selector + axis rendering scaffolding
- `WGSparkline.render(…)` — available for the top-card mini trend line if desired
- `WGMacroBar` — reference pattern for the goal-progress bar (reuse or port depending on token overlap)
- `WGIcons.iconSvg('scale' | 'chevronLeft' | 'chevronRight' | 'pencil' | 'trash' | 'plus' | 'target', …)`
- `WGBottomNav.DEFAULT_ITEMS` already carries the `weight` slot

**Tests touching Weight (will need updates):**

- `app.bp-weight-data-and-export-branches.test.js` — existing; verify no regression after render-layer rewrite
- `app.bp-weight-global-scope.test.js` — existing; cross-scope wiring check
- `app.weight-ruler-and-workout-start.test.js` — existing; verify ruler interaction preserved
- `weight.render.test.js` / `weight.chart.test.js` / `weight.history.test.js` / `weight.modal.test.js` — new, created in this phase
- Architecture tests — `architecture.design-tokens.test.js` gets new `--wg-weight-*` dimensional tokens; `architecture.globals.test.js` gets `WGWeightChart` and any new `WGWeight*` globals with justification

## Development Approach

- **Testing approach**: Regular (code first, then tests). UI-heavy; visual checking per task.
- Each task includes new/updated Vitest coverage in the same commit.
- **CRITICAL**: `pnpm test` and (when backend-adjacent) `go test ./...` must pass before the next task.
- Keep the SPA single-document model — all new markup lives in `index.html`'s existing `#weight-view` section and the edit-weight modal template.
- No inline styles, no hardcoded hex — every visual value comes from a `--wg-*` token, every dimensional value goes into `WANDERGEEK_TOKENS` in the architecture test.
- Follow Phase 3+4+5's migration pattern (clean migrate to `.wg-weight-*` classes; dual-class only where DOM-query tests require).

## Testing Strategy

- **Unit tests** (Vitest, jsdom): each render helper (`renderWeightCurrentCard`, `renderWeightGoalCard`, `renderWeightRangeSelector`, `renderWeightHistoryGroup`, `renderEditWeightModal`) gets coverage for primary + empty + offline-stale states.
- **Architecture tests**: every new `--wg-*` token appended to `WANDERGEEK_TOKENS`; every new `window.WGWeight*` / `WGWeightChart` global registered in `architecture.globals.test.js` with a one-line justification.
- **Chart test**: assert `WGWeightChart` honors the active range, plots the goal overlay when a goal is set, and degrades to an empty-state card when no logs exist in the range.
- **Trend arrow test**: assert arrow direction and color variant flip correctly relative to `goal_direction` (lose vs. gain).
- **Snapshot test**: WeightScreen renders against a fixed fixture and matches a stable DOM structure.

## Progress Tracking

- Mark `[x]` immediately when each item completes (do not batch).
- ➕ prefix for newly discovered tasks.
- ⚠️ prefix for blockers.
- Update plan if scope deviates significantly.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): tokens, WGWeightChart component, current-weight + goal cards, range selector, history list, edit modal, test updates, grep-cleanup of paper-era classes.
- **Post-Completion** (no checkboxes): real-device side-by-side, Lighthouse / contrast audit, reduced-motion audit on gloss `:active` transforms and chart animation.

## Implementation Steps

### Task 1: Extend tokens for Weight-specific visual values

- [x] add `--wg-weight-*` dimensional tokens to `:root` in `styles.css` (current-weight mono display size, trend-arrow size, chart height, range-selector padding, goal-bar height, history-row grid-template-columns) — everything the Weight view needs that isn't already covered by the shared `--wg-*` set
- [x] add `--wg-weight-trend-*` semantic aliases wrapping the existing sun / alert / mint tokens so the trend-direction classifier (decrease / increase / flat, relative to goal direction) returns a token-group name without duplicating styles
- [x] extend `WANDERGEEK_TOKENS` in `web/static/js/tests/architecture.design-tokens.test.js` with every new token
- [x] run `pnpm test` — design-tokens test must be green before next task

### Task 2: Build the `WGWeightChart` component

- [x] create `web/static/js/components/wg-weight-chart.js` exposing `WGWeightChart.render({ logs, range, goal })` returning a DOM element
- [x] mirror `WGBpChart` structure — SVG canvas, axis + grid rendering, line plot (single-series, not two), goal-line overlay when a goal is set
- [x] colors + stroke widths come from `--wg-weight-*` tokens via CSS classes — no inline `style=` / hardcoded hex (canvas/SVG attribute values count as styling here; prefer CSS custom properties piped into `stroke`/`fill` attributes)
- [x] register `window.WGWeightChart` in `architecture.globals.test.js` with a one-line justification
- [x] write `components.wg-weight-chart.test.js` — range filter applied, goal line rendered when goal present / hidden when absent, empty-state card when no logs, axis tick count sane for short + long ranges
- [x] run `pnpm test` — must pass before next task

### Task 3: Rewrite the current-weight + goal cards

- [ ] replace the current stats block with a `.wg-weight-current-card` — `.wg-mono-display` kilo value, small uppercase "kg" suffix, trend arrow (↓/↑/→) + delta mono, small section-label timestamp subtitle
- [ ] trend classifier: compare latest entry vs. previous entry; variant flips based on goal direction (`lose` → down-is-sun, `gain` → up-is-sun)
- [ ] goal card renders only when a goal exists — `.wg-card--inset` row with goal mono, progress bar (reuse `WGMacroBar` if token overlap permits; otherwise a simple `.wg-gloss--inset` track), and a muted "Δ kg to goal" label
- [ ] empty state (no weight entries yet) renders a single muted card: "No weight logged yet — add your first entry."
- [ ] write `weight.current-card.test.js` — trend direction + color variant for lose/gain goals, goal card visibility, empty state
- [ ] run `pnpm test` — must pass before next task

### Task 4: Rewrite the range selector + chart panel

- [ ] replace the existing chart container with a `.wg-weight-chart-panel` — a `.wg-gloss--inset` range selector (7d / 30d / 90d / All) above the `WGWeightChart` canvas
- [ ] range state persists via `mt-weight-range` localStorage key (new; matches `mt-bp-range` / `mt-food-subtab` / `mt-meds-subtab` naming)
- [ ] default range: 30d
- [ ] write `weight.range.test.js` — active-state toggle, persistence across reload, default-range behavior, chart re-renders on range change
- [ ] run `pnpm test` — must pass before next task

### Task 5: Rewrite the day-grouped history list

- [ ] replace the existing `#weight-list` markup with a `.wg-weight-history` container — day groups use `.wg-section-label` headers ("22.04.2026 · Tue"), each entry a `.wg-card` row carrying mono weight, ISO-local time, and a trailing `.wg-icon-btn` cluster (edit + delete)
- [ ] preserve offline-pending + rejected badge logic — status pills render as `.wg-tag--mono` variants (normal = TAKEN/SYNCED, high = PENDING, alert = REJECTED)
- [ ] delete + edit callbacks unchanged (reuse `editWeightLog`, existing delete path)
- [ ] full-width `.wg-gloss--sun` "Add weight" CTA appended at the bottom (replaces `#add-weight-btn` FAB)
- [ ] write `weight.history.test.js` — day grouping, edit-button click invokes existing handler, delete flow preserved, offline + rejected badge states, empty state
- [ ] run `pnpm test` — must pass before next task

### Task 6: Rewrite EditWeightModal

- [ ] replace the existing edit-weight modal markup in `index.html` with the Wandergeek shell — mono header ("New weight" / "Edit weight"), `.wg-icon-btn` close trailing the header
- [ ] weight input + unit toggle — `.wg-gloss--inset` input wrap + small unit-toggle strip (kg/lb) as a `.wg-gloss--inset` pill pair
- [ ] date-time input — `.wg-gloss--inset` wrap carrying the existing ISO-local formatter
- [ ] Cancel + Save buttons row at the bottom — Cancel `.wg-gloss` left, Save `.wg-gloss--sun` right with 2× flex per modal-button-order convention
- [ ] write `weight.modal.test.js` — open/save/cancel, unit-toggle round-trip, existing `saveWeight()` path preserved, `modal-controller.js` history integration preserved
- [ ] run `pnpm test` — must pass before next task

### Task 7: Wire Weight into the canonical bottom nav + cleanup

- [ ] confirm `WGBottomNav.DEFAULT_ITEMS` still carries the `weight` slot with the scale icon; add a Phase 6 contract test matching the BP/Food/Meds contract tests
- [ ] grep-verify remaining paper-era weight classes — remove truly orphaned rules from `styles.css`, dual-class only where DOM-query tests require
- [ ] run `pnpm test` — must pass before next task

### Task 8: Verify acceptance criteria for Phase 6

- [ ] open `index.html` in desktop 390×844 phone view, compare Weight screen side-by-side with `Medtracker.html` — manual visual check
- [ ] open in mobile viewport (DevTools 375×812) — manual visual check
- [ ] full `pnpm test` suite green
- [ ] `go test ./...` green (sanity check; no backend changes expected)
- [ ] grep `style="` and `\.style\.` in the new JS — zero matches in `web/static/js/features/weight.js` and `web/static/js/components/wg-weight-chart.js` (or allowlisted in `architecture.inline-styles.test.js` with a one-line justification)

### Task 9: [Final] Update plan and write Phase 7 plan stub

- [ ] mark this plan complete; ralphex moves it to `docs/plans/completed/`
- [ ] write `docs/plans/2026-04-XX-wandergeek-phase7-workouts.md` covering the Workouts screen rewrite (today's-workout card, session detail + log-set flow, rotation editor + history sub-views)
- [ ] no code changes in this task

## Technical Details

**Chart component strategy**: Phase 3's `WGBpChart` already handles axis rendering, range filtering, and tooltip behavior for a two-series chart. `WGWeightChart` is a single-series variant — the simplest port is to duplicate the structure and strip the second series (systolic/diastolic → just weight). If duplication becomes burdensome, extract a shared `WGLineChart` base in a follow-up, but Phase 6 keeps the two components independent to avoid mid-phase refactors.

**Trend arrow direction + color**: the trend classifier reads `goal_direction` from the goal endpoint. When `lose`, decreasing weight is "good" (sun); increasing is "alert". When `gain`, it flips. When no goal is set, flat styling is used regardless of direction. This mirrors the intent of the existing stats block.

**Range selector state**: Phase 3 settled on `mt-bp-range` for BP. Phase 4 used `mt-food-subtab`. Phase 5 used `mt-meds-subtab`. Phase 6 adds `mt-weight-range` — consistent with the naming pattern. The key stores the active range string ('7d' | '30d' | '90d' | 'all'), default '30d'.

**Modal history parity**: `modal-controller.js` already drives the open/close lifecycle for the edit-weight modal via the back-button stack. Phase 6 only restyles the modal body; the controller, history entry, and Telegram WebApp BackButton wiring are unchanged.

**Offline parity**: every render helper must surface the existing offline-pending, rejected, and cached-stale states. `MedTrackerDB.WeightStore.getPending/getRejected` is unchanged; Phase 6 only changes how those badges look (`.wg-tag--mono` instead of the paper-era pills).

## Follow-up Phases (out of scope; named only)

### Phase 7 — Workouts screen rewrite
Today's-workout card (PUSH/PULL/LEGS), session detail + log-set flow, rotation editor + history sub-views.

### Phase 8 — Health screen rewrite
SpO2 + sleep + diary — vitals tiles, sleep history by week, notes/diary list.

### Phase 9 — Settings screen rewrite
Form-heavy — tokens for every input state, gloss-inset inputs, sectioned cards. Largest CSS surface; do last so primitives are stable.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes.*

**Manual verification:**
- Real-device side-by-side on iPhone (PWA install) and Android Chrome
- Lighthouse / a11y audit on Weight screen — mono display contrast vs. deep-teal stage, minimum-touch-target check on the edit/delete icon buttons
- Reduced-motion preference: gloss `:active` transforms and chart animation respect `prefers-reduced-motion`
- Telegram WebApp BackButton verification inside the actual Telegram client — confirm EditWeightModal close path still pops history cleanly
- Chart rendering sanity on a high-DPR device and in a dark system theme

**External system updates:**
- Update `pitch.html` screenshots once Phase 6 lands
- Announce in whatever release-notes channel applies
