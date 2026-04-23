# Wandergeek Phase 8 — Health Screen Rewrite

## Overview

Reskin the Health screen to match the Wandergeek deep-teal / glossy / JetBrains-Mono aesthetic established in Phase 1+2 (`docs/plans/completed/2026-04-20-wandergeek-design-rewrite.md`) and extended by Phase 3 BP (`docs/plans/completed/2026-04-20-wandergeek-phase3-bp.md`), Phase 4 Food (`docs/plans/completed/2026-04-XX-wandergeek-phase4-food.md`), Phase 5 Meds (`docs/plans/completed/2026-04-XX-wandergeek-phase5-meds.md`), Phase 6 Weight (`docs/plans/completed/2026-04-XX-wandergeek-phase6-weight.md`), and Phase 7 Workouts (`docs/plans/completed/2026-04-XX-wandergeek-phase7-workouts.md`). Phase 8 keeps the same runtime model the earlier phases settled on: every screen renders directly into `#app` under the fixed `.wg-bottom-nav`; `<wg-phone-chrome>` remains an available primitive but is not mounted here.

Phase 8 covers a lot of surface for modest logic: the Health screen today carries two sub-tabs (Overview + Notes), and the Overview sub-tab alone renders five vitals sub-charts (Sleep, Steps, Heart Rate, SpO2, Stress) plus a 7d/30d summary line per chart. The handoff prototype does not include a dedicated Health screen, so the layout composes Wandergeek primitives (`card`, `gloss`, `gloss-sun`, `gloss-inset`, `mono-display`, `section-label`, `tag`, `icon-btn`) with the sub-tab strip from Phases 4/5/7 and the range-selector + chart pattern from Phases 3/6.

The target layout:

- **Sub-tab strip** at the top (Overview / Notes) rendered as a `.wg-gloss--inset` container with a `.wg-gloss--sun` active pill — same primitive the earlier phases use. State persists via a new `mt-health-subtab` localStorage key matching `mt-bp-range` / `mt-food-subtab` / `mt-meds-subtab` / `mt-weight-range` / `mt-workouts-subtab` naming.
- **Overview summary tile-row** (Overview sub-tab, top) — a `.wg-card` grid of mono stat tiles carrying the key 7d averages (sleep hours, steps, HR avg, SpO2 avg, stress avg) — one tile per vital. Each tile shows the mono value, `.wg-section-label` subtitle with the vital name + unit, and a small trend arrow against the 30d average (sun = better, alert = worse per vital-specific direction).
- **Range selector** — Phase 3-style `.wg-gloss--inset` container carrying three `.wg-gloss--sun`-capable pills (7d / 30d / All). Backend currently only exposes 7d / 30d; Phase 8 keeps the same data scope but presents it through the canonical range-selector shell. Persists via a new `mt-health-range` localStorage key.
- **Sleep card** — `.wg-card` with mono header + 7d stacked-bar chart reskinned as a `WGSleepChart` component (follows the `WGBpChart` / `WGWeightChart` / `WGWorkoutChart` pattern; multi-series — deep / light / REM / awake — with an HR line overlay). Colors come from `--wg-health-sleep-*` tokens, not hardcoded hex. Empty state: muted "No sleep data yet" card.
- **Steps card** — `.wg-card` with mono header + 7d bar chart reskinned as `WGStepsChart`. Single-series bars keyed to `--wg-health-steps-*` tokens. Empty state: muted "No step data yet" card.
- **Vital-line cards** (Heart Rate, SpO2, Stress) — one `.wg-card` per vital with mono header, range value (e.g. "72 bpm (7d avg)"), and a line chart reskinned as `WGVitalsChart` (single-series area + line, configurable color token per vital). Colors come from `--wg-health-vitals-{hr|spo2|stress}-*` tokens. Empty state per vital: muted "No {vital} data yet" tile.
- **Data-source disclaimer** — `.wg-section-label` muted footer: "DATA SOURCE · .nxk backups".
- **Notes sub-tab** — mono `.wg-gloss--inset` textarea wrap at the top, full-width `.wg-gloss--sun` "Save note" CTA. Below, day-grouped `.wg-card` note list with mono timestamp eyebrow, note body, trailing `.wg-icon-btn` cluster (edit / delete). Pagination preserved via "Load more" CTA as `.wg-gloss` footer button. Offline-pending + rejected badges become `.wg-tag--mono` variants.
- **Edit-note modal** — mono header, `.wg-gloss--inset` textarea wrap, Cancel + Save buttons (`.wg-gloss` + `.wg-gloss--sun`, 2× flex on Save per modal-button-order convention). Uses existing `modal-controller.js` history plumbing.

No backend changes. The existing `/api/health/overview` and `/api/notes*` endpoints, the `DataStore.loadSWR` flow, and the existing offline queue stay intact — we rewrite only the render layer and the CSS.

## Context (from discovery)

**Existing health code (target):**

- `web/static/js/features/health.js` (~366 lines) — already extracted as a feature module (matches bp.js / food.js / meds.js / today.js / weight.js / workout.js pattern).
  - `renderHealthOverviewContent(content, data)` — top-level Overview render orchestrator; dispatches into the five chart renderers
  - `renderVitalsLineChart(containerId, data, color, yMin, yMax)` — shared vitals-line renderer (HR, SpO2, Stress)
  - `renderSleepChart(stats)` — bespoke sleep stacked-bar + HR-line chart
  - `renderStepsChart(stats)` — bespoke step bar chart
  - `loadHealthOverview()` — SWR-backed loader using `DataStore.loadSWR` (unchanged)
- `web/static/js/app.js` (notes section, around lines 2624-2850) — NOT yet extracted into `features/health-notes.js` or folded into `features/health.js`. Phase 8 should fold the notes render + pagination + edit-modal flow into `features/health.js` (or a sibling `features/health-notes.js`) during Task 1 to match the feature-module pattern.
  - `loadNotes()` / `loadMoreNotes()` / `renderNotes(list, notes)` / `appendNotes(list, notes)` — list render + pagination
  - Save + edit + delete flow (scoped around `notes-save-btn`, `notes-textarea`)
- `web/static/index.html` — `#health-view` section (lines ~266-291): `.health-tabs` sub-tab strip, two `.health-tab-content` panels, `#health-overview-loading` + `#health-overview-content` mounts, `#notes-textarea` + `#notes-save-btn` + `#notes-list` notes panel
- `web/static/css/styles.css` — existing `.health-*` / `.notes-*` paper-era classes get replaced with `.wg-health-*` / `.wg-health-notes-*`

**Handoff prototype:** no dedicated Health screen; Phase 8 composes from existing primitives plus the Phase 3/6/7 range-selector + chart pattern.

**Wandergeek primitives available (from Phase 1+2+3+4+5+6+7):**

- `.wg-card` / `.wg-card--inset` / `.wg-gloss` / `.wg-gloss--sun` / `.wg-gloss--inset` / `.wg-tag` + variants / `.wg-mono-display` / `.wg-section-label` / `.wg-icon-btn`
- `WGBpChart` / `WGWeightChart` / `WGWorkoutChart` — reference patterns for `WGVitalsChart`, `WGSleepChart`, `WGStepsChart`
- `WGSparkline.render(…)` — available for per-tile mini trend lines on the summary row
- `WGMacroBar` — pattern reference if Phase 8 ever adds a sleep-stage distribution bar under the sleep card (stretch goal, not required)
- `WGIcons.iconSvg('heart' | 'moon' | 'footprints' | 'activity' | 'pencil' | 'trash' | 'plus' | 'chevronLeft' | 'chevronRight', …)` — confirm icon names exist or add the missing ones
- `WGBottomNav.DEFAULT_ITEMS` already carries the `health` slot (confirm icon + contract test in the final task)

**Tests touching Health (will need updates):**

- `app.health-*.test.js` — existing (if any); verify no regression after render-layer rewrite
- `health.render.test.js` / `health.summary.test.js` / `health.sleep.test.js` / `health.steps.test.js` / `health.vitals.test.js` / `health.notes.test.js` / `health.modal.test.js` — new, created in this phase
- `components.wg-vitals-chart.test.js` / `components.wg-sleep-chart.test.js` / `components.wg-steps-chart.test.js` — new, covering each chart component (range filter, empty state, axis tick sanity)
- Architecture tests — `architecture.design-tokens.test.js` gets new `--wg-health-*` dimensional tokens; `architecture.globals.test.js` gets `WGVitalsChart`, `WGSleepChart`, `WGStepsChart`, and any new `WGHealth*` globals with justification

## Development Approach

- **Testing approach**: Regular (code first, then tests). UI-heavy; visual checking per task.
- Each task includes new/updated Vitest coverage in the same commit.
- **CRITICAL**: `pnpm test` and (when backend-adjacent) `go test ./...` must pass before the next task.
- Keep the SPA single-document model — all new markup lives in `index.html`'s existing `#health-view` section and the related modal templates.
- No inline styles, no hardcoded hex — every visual value comes from a `--wg-*` token, every dimensional value goes into `WANDERGEEK_TOKENS` in the architecture test. The existing `features/health.js` hardcodes hex for every chart stroke + sleep-stage fill (`#5a2d9c` / `#2481cc` / `#c161d9` / `#e5b220` / `#ff3b30` / `#32ade6` / `#ff9500` / `#34c759`) — every one of these moves to a `--wg-health-*` token in Task 1.
- Follow Phase 3+4+5+6+7's migration pattern (clean migrate to `.wg-health-*` classes; dual-class only where DOM-query tests require).
- **Scope note**: fold the notes render + pagination + edit-modal flow out of `web/static/js/app.js` into `features/health.js` (or a sibling `features/health-notes.js`) during Task 1 to match the feature-module pattern. Notes is the last remaining top-level JS chunk that isn't under `features/`; Phase 8 is the right time because the full render layer is being rewritten anyway.

## Testing Strategy

- **Unit tests** (Vitest, jsdom): each render helper (`renderHealthSubTabs`, `renderHealthSummaryTiles`, `renderHealthRangeSelector`, `renderSleepCard`, `renderStepsCard`, `renderVitalCard`, `renderNotesList`, `renderEditNoteModal`) gets coverage for primary + empty + offline-stale states.
- **Architecture tests**: every new `--wg-*` token appended to `WANDERGEEK_TOKENS`; every new `window.WGHealth*` / `WGVitalsChart` / `WGSleepChart` / `WGStepsChart` global registered in `architecture.globals.test.js` with a one-line justification.
- **Summary-tile test**: assert trend arrow direction + color variant flip correctly for each vital relative to its "good direction" (steps: up=sun, stress: down=sun, sleep: toward 8h=sun, HR: within healthy range=sun, SpO2: up=sun).
- **Chart tests**: assert each chart component honors the active range, degrades to an empty-state card when no data exists in the range, and axis tick count is sane for short + long ranges.
- **Notes test**: assert day grouping, Save button dispatch, pagination ("Load more"), edit-modal open/save/cancel flow, offline-pending + rejected badge states.
- **Snapshot test**: HealthScreen renders against a fixed fixture and matches a stable DOM structure across Overview + Notes sub-tabs.

## Progress Tracking

- Mark `[x]` immediately when each item completes (do not batch).
- `+` prefix for newly discovered tasks.
- `!` prefix for blockers.
- Update plan if scope deviates significantly.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): tokens, sub-tab strip, summary tile row, range selector, sleep + steps + vitals chart components, notes fold-in + list + edit modal, test updates, grep-cleanup of paper-era classes.
- **Post-Completion** (no checkboxes): real-device side-by-side, Lighthouse / contrast audit, reduced-motion audit on gloss `:active` transforms and chart animation.

## Implementation Steps

### Task 1: Extend tokens + fold notes into the health feature module

- [x] add `--wg-health-*` dimensional tokens to `:root` in `styles.css` (summary-tile grid, chart heights, sub-tab padding, notes-row grid-template-columns)
- [x] add `--wg-health-sleep-{deep,light,rem,awake,hr}`, `--wg-health-steps-*`, `--wg-health-vitals-{hr,spo2,stress}-*` semantic tokens replacing every hardcoded hex currently in `features/health.js`
- [x] extend `WANDERGEEK_TOKENS` in `web/static/js/tests/architecture.design-tokens.test.js` with every new token
- [x] fold the notes render + pagination + edit-modal flow out of `app.js` into `features/health.js` (or a sibling `features/health-notes.js`); script-tag load order + hoisted function declarations keep them accessible as globals (matches bp.js / food.js / meds.js / today.js / weight.js / workout.js / health.js)
- [x] update `index.html` script load order if a new feature file is added; update `sw.js` precache list + `tests/helpers/frontend-harness.js` (not applicable — notes folded into existing `features/health.js`, no new script)
- [x] verify no behavior change — existing health + notes tests stay green
- [x] run `pnpm test` — design-tokens test + extraction smoke test must be green before next task

### Task 2: Build the sub-tab strip + subtab state plumbing

- [x] replace the current `.health-tabs` buttons with a `.wg-gloss--inset` container carrying two `.wg-gloss--sun`-capable pills (Overview / Notes) — active state via class, not inline style
- [x] state: which sub-tab is active persists via a new `mt-health-subtab` localStorage key matching the naming pattern
- [x] default sub-tab: Overview
- [x] write `health.subtabs.test.js` — active-state toggle, persistence across reload, default-tab behavior
- [x] run `pnpm test` — must pass before next task

### Task 3: Build the summary tile row + range selector

- [x] create `renderHealthSummaryTiles(data, range)` helper that renders a grid of mono stat tiles (one per vital: sleep hours, steps, HR avg, SpO2 avg, stress avg)
- [x] trend arrow classifier: compare active-range average vs. the opposite-range average (7d vs. 30d); variant flips per vital direction (sleep/steps/SpO2 up=sun, stress down=sun, HR in-range=sun)
- [x] empty tile state when a vital has no data: muted mono dash + "—" placeholder (no trend arrow)
- [x] range selector: `.wg-gloss--inset` container with 7d / 30d pills; persists via `mt-health-range` localStorage key; default 7d
- [x] write `health.summary.test.js` — tile render for each vital, trend arrow direction for each direction, empty-tile fallback, range-selector persistence
- [x] run `pnpm test` — must pass before next task

### Task 4: Build the `WGSleepChart` component + rewrite sleep card

- [x] create `web/static/js/components/wg-sleep-chart.js` exposing `WGSleepChart.render({ stats, range })` returning a DOM element
- [x] mirror the existing `renderSleepChart` structure — stacked bars (deep/light/REM/awake) + HR line overlay — but replace every hardcoded hex with `--wg-health-sleep-*` CSS custom properties via CSS classes
- [x] register `window.WGSleepChart` in `architecture.globals.test.js` with a one-line justification
- [x] replace the sleep block in `renderHealthOverviewContent` with a `.wg-card` shell rendering `WGSleepChart` + mono 7d / 30d average subtitle + legend
- [x] empty state: muted "No sleep data yet" card
- [x] write `components.wg-sleep-chart.test.js` — stacked bars render, HR overlay renders when HR data present, empty-state card when no data, axis tick count sane
- [x] write `health.sleep.test.js` — sleep card render, legend render, empty state
- [x] run `pnpm test` — must pass before next task

### Task 5: Build the `WGStepsChart` component + rewrite steps card

- [x] create `web/static/js/components/wg-steps-chart.js` exposing `WGStepsChart.render({ stats, range })` returning a DOM element
- [x] mirror the existing `renderStepsChart` structure — vertical bars with rotated step-count labels — but replace hardcoded fill + text colors with `--wg-health-steps-*` tokens
- [x] register `window.WGStepsChart` in `architecture.globals.test.js` with a one-line justification
- [x] replace the steps block in `renderHealthOverviewContent` with a `.wg-card` shell rendering `WGStepsChart` + mono 7d / 30d average subtitle
- [x] empty state: muted "No step data yet" card
- [x] write `components.wg-steps-chart.test.js` — bars render, axis tick count sane, empty-state card
- [x] write `health.steps.test.js` — steps card render, empty state
- [x] run `pnpm test` — must pass before next task

### Task 6: Build the `WGVitalsChart` component + rewrite HR / SpO2 / Stress cards

- [x] create `web/static/js/components/wg-vitals-chart.js` exposing `WGVitalsChart.render({ history, range, vital })` returning a DOM element, where `vital` is one of `hr` / `spo2` / `stress` and drives the color token + y-range defaults
- [x] mirror the existing `renderVitalsLineChart` structure — area gradient + line + last-value dot — but replace hardcoded color with a token per vital (`--wg-health-vitals-hr-*` / `--wg-health-vitals-spo2-*` / `--wg-health-vitals-stress-*`)
- [x] register `window.WGVitalsChart` in `architecture.globals.test.js` with a one-line justification
- [x] replace the three `renderVitalGroup` calls with a `.wg-card` shell per vital, each rendering `WGVitalsChart({ vital: 'hr' | 'spo2' | 'stress' })` + mono 7d / 30d subtitle
- [x] empty state per vital: muted "No {vital} data yet" tile
- [x] write `components.wg-vitals-chart.test.js` — line + area render, color token switches per vital, axis tick count sane, empty-state card
- [x] write `health.vitals.test.js` — vital cards render, each uses the correct token, empty state
- [x] run `pnpm test` — must pass before next task

### Task 7: Rewrite the Notes sub-tab

- [x] replace `#notes-textarea` + `#notes-save-btn` with a `.wg-health-notes-compose` container — `.wg-gloss--inset` textarea wrap + full-width `.wg-gloss--sun` "Save note" CTA
- [x] replace `#notes-list` markup with a day-grouped `.wg-card` list — `.wg-section-label` day headers ("22.04.2026 · Tue"), each entry carrying mono timestamp eyebrow, note body, and a trailing `.wg-icon-btn` cluster (edit + delete)
- [x] preserve offline-pending + rejected badge logic — status pills render as `.wg-tag--mono` variants
- [x] preserve pagination — "Load more" renders as a full-width `.wg-gloss` footer button
- [x] empty state: muted card with "No notes yet — write your first one."
- [x] write `health.notes.test.js` — day grouping, Save-button dispatch, pagination, edit + delete callbacks, offline + rejected badge states, empty state
- [x] run `pnpm test` — must pass before next task

### Task 8: Rewrite the edit-note modal

- [x] replace the existing edit-note modal markup in `index.html` with the Wandergeek shell — mono header ("Edit note"), `.wg-icon-btn` close trailing the header
- [x] note body — `.wg-gloss--inset` textarea wrap with mono labels
- [x] Cancel + Save buttons row at the bottom — Cancel `.wg-gloss` left, Save `.wg-gloss--sun` right with 2× flex per modal-button-order convention
- [x] write `health.modal.test.js` — open/save/cancel, input round-trip, `modal-controller.js` history integration preserved
- [x] run `pnpm test` — must pass before next task

### Task 9: Wire Health into the canonical bottom nav + cleanup

- [x] confirm `WGBottomNav.DEFAULT_ITEMS` still carries the `health` slot with the heart (or equivalent) icon; add a Phase 8 contract test matching the BP/Food/Meds/Weight/Workouts contract tests
- [x] grep-verify remaining paper-era health + notes classes — remove truly orphaned rules from `styles.css`, dual-class only where DOM-query tests require
- [x] run `pnpm test` — must pass before next task

### Task 10: Verify acceptance criteria for Phase 8

- [x] open `index.html` in desktop 390×844 phone view, compare Health screen side-by-side with `Medtracker.html` — manual visual check (skipped — not automatable from CI environment)
- [x] open in mobile viewport (DevTools 375×812) — manual visual check (skipped — not automatable from CI environment)
- [x] full `pnpm test` suite green (111 files / 1244 tests passed)
- [x] `go test ./...` green (sanity check; no backend changes expected)
- [x] grep `style="` and `\.style\.` in the new JS — zero `style="` matches in `features/health.js` + the three chart components; the remaining `.style.display` hits in `features/health.js` are pre-existing loading-indicator show/hide toggles folded in during Task 1 (not Phase 8 additions, not `.style.setProperty` calls, not hardcoded visual values)

### Task 11: [Final] Update plan and write Phase 9 plan stub

- [x] mark this plan complete; ralphex moves it to `docs/plans/completed/`
- [x] write `docs/plans/2026-04-XX-wandergeek-phase9-settings.md` covering the Settings screen rewrite (form-heavy — tokens for every input state, gloss-inset inputs, sectioned cards)
- [x] no code changes in this task

## Technical Details

**Chart component strategy**: Phases 3/6/7 already validated one chart component per screen (`WGBpChart`, `WGWeightChart`, `WGWorkoutChart`). Phase 8 ships three because the Health screen carries three distinct visual modes (stacked bars for sleep, plain bars for steps, area+line for vitals) — the structures are different enough that a shared `WGLineChart` base would be a premature abstraction. If duplication becomes burdensome after Phase 8, extract a shared base in a follow-up. `WGVitalsChart` is parameterized by `vital` to avoid three near-identical components, since the only difference between HR / SpO2 / Stress is the color token + y-range defaults.

**Token-naming note**: Phase 8 is the first screen that needs per-metric color tokens (sleep stages, vitals). The token namespace stays flat — `--wg-health-sleep-deep-bg` / `--wg-health-vitals-hr-line` — rather than nesting into separate sections. Keeps the architecture test's token registration simpler.

**Summary-tile direction classifier**: each vital has its own "good direction" and the tile trend arrow reflects that. Sleep: toward 8h is good (not simply up or down). Steps: up is good. HR: staying within a healthy range (e.g. 50-90 bpm) is good; going out is alert. SpO2: up is good. Stress: down is good. Task 3 encodes this as a small per-vital classifier function rather than a single shared rule.

**Range selector state**: Phase 3 settled on `mt-bp-range` for BP. Phase 4 used `mt-food-subtab`. Phase 5 used `mt-meds-subtab`. Phase 6 used `mt-weight-range`. Phase 7 added `mt-workouts-subtab` + `mt-workouts-stats-range`. Phase 8 adds `mt-health-subtab` (for the top sub-tab strip) and `mt-health-range` (for the Overview range selector) — consistent with the naming pattern.

**Notes fold-in strategy**: notes code lives in `app.js` today (lines ~2624-2850). Phase 8 folds it into `features/health.js` as a sibling `renderNotesList` / `loadNotes` / `loadMoreNotes` / `saveNote` / `editNote` / `deleteNote` set, OR breaks it out into `features/health-notes.js` if the combined file gets too large. The choice happens in Task 1 after seeing the line-count impact.

**Backend data scope**: the current `/api/health/overview` endpoint returns fixed 7d + 30d aggregates. Phase 8 adds no new endpoints; the range selector is presentation-only and currently only distinguishes which average pair (7d/30d) drives the summary tiles. An "All" option is not wired because the backend doesn't return a full history — if that lands, it's a later phase.

**Modal history parity**: `modal-controller.js` already drives the open/close lifecycle for the edit-note modal via the back-button stack. Phase 8 only restyles the modal body; the controller, history entry, and Telegram WebApp BackButton wiring are unchanged.

**Offline parity**: every render helper must surface the existing offline-pending, rejected, and cached-stale states. The notes store's pending/rejected logic is unchanged; Phase 8 only changes how those badges look (`.wg-tag--mono` instead of the paper-era pills). The health-overview endpoint is already wrapped in `DataStore.loadSWR` with a cached-fallback path — no change there.

## Follow-up Phases (out of scope; named only)

### Phase 9 — Settings screen rewrite
Form-heavy — tokens for every input state, gloss-inset inputs, sectioned cards. Largest CSS surface; do last so primitives are stable.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes.*

**Manual verification:**
- Real-device side-by-side on iPhone (PWA install) and Android Chrome
- Lighthouse / a11y audit on Health screen — mono display contrast vs. deep-teal stage, minimum-touch-target check on the edit/delete icon buttons in the Notes list, chart contrast for colorblind users
- Reduced-motion preference: gloss `:active` transforms and chart animation respect `prefers-reduced-motion`
- Telegram WebApp BackButton verification inside the actual Telegram client — confirm edit-note modal close path pops history cleanly
- Chart rendering sanity on a high-DPR device and in a dark system theme
- Sleep stage color contrast audit — four overlapping stacked-bar fills must remain distinguishable on both light and dark system themes

**External system updates:**
- Update `pitch.html` screenshots once Phase 8 lands
- Announce in whatever release-notes channel applies
