# Wandergeek Phase 3 — BP Screen Rewrite

## Overview

Reskin the BP screen to match the Wandergeek deep-teal / glossy / JetBrains-Mono aesthetic established in Phase 1+2 (`docs/plans/completed/2026-04-20-wandergeek-design-rewrite.md`). The BP view becomes a full first-class destination driven by the bottom nav from `WGBottomNav.DEFAULT_ITEMS`. Phase 1 built `<wg-phone-chrome>` as a design-system primitive but did NOT mount it at runtime — screens render directly into `#app` under the fixed bottom nav. This phase decides whether to wrap the BP view in `wg-phone-chrome` or defer that to a later phase (see Task 6).

The handoff prototype gives us the target layout (see `project/screens.jsx:BPScreen` and `project/components.jsx:BPChart`):

- Big **current-reading card** with a 44px JetBrains Mono numeric (sys `/` dia), a small pulse line underneath, and a status tag (Normal / High-normal / Stage 1 / High) pulling from the existing `getBPCategory()` classifier in `web/static/js/features/bp.js`.
- **Range selector** (14d / 30d / 60d) rendered as a `.wg-gloss--inset` container with a `.wg-gloss--sun` active pill — the same primitive Phase 4 will reuse for the Food sub-tab strip.
- **BPChart SVG** — a 200×358 sys/dia chart with a band fill between the two lines, dotted normal-band markers at 80 and 120, and last-point sun markers. Ported from `project/components.jsx:84-148` but adapted to the existing `window.ChartUtils` helpers (aggregation, LTTB downsample, Catmull-Rom spline) already used by `renderBPChart` in `features/bp.js:169-413`.
- **3-up averages cards** — sys / dia / pulse means in gloss-card style with mono-display values.
- **Day-grouped history list** with a status tag per reading, an edit/delete action row on each item, and offline/rejected badges preserved from the existing renderer (`features/bp.js:483`).

No backend changes. The existing `/api/bp` endpoints, Dexie offline queue, and `DataStore.loadSWR` flow stay intact — we rewrite only the render layer and the CSS.

## Context (from discovery)

**Existing BP code (target):**

- `web/static/js/features/bp.js` (681 lines)
  - `getBPCategory(sys, dia)` — classifier, reused as-is
  - `showBPRecordModal` / `handleBPSubmit` — existing modal-controller wiring, reused as-is
  - `loadBPReadings` / `_renderBPData` — SWR load + render orchestration
  - `renderBPChart` (lines 169-454) — current chart renderer; biggest refactor target
  - `renderBPAverages` (455-482) — 3 stat tiles
  - `renderBPReadings` (483-618) — day-grouped history list
  - `deleteBPReading` / `_deleteBPApi` — action handlers
- `web/static/index.html` — `#bp-view` section (around line 83) — receives the new markup
- `web/static/css/styles.css` — existing `.bp-*` class block (paper-era) gets replaced with `.wg-bp-*` classes

**Handoff prototype (read-only reference):**

- `/tmp/medtracker-handoff/medtrackerbot/project/screens.jsx:BPScreen` — layout scaffold
- `/tmp/medtracker-handoff/medtrackerbot/project/components.jsx:BPChart` (lines 84-148) — 200×358 chart structure
- `/tmp/medtracker-handoff/medtrackerbot/project/data.js:BP_READINGS` — 60-day synthetic fixture, shape reference for test fixtures

**Wandergeek primitives available (from Phase 1+2):**

- `.wg-card` / `.wg-card--inset` / `.wg-gloss` / `.wg-gloss--sun` / `.wg-gloss--inset` / `.wg-tag` + variants / `.wg-mono-display` / `.wg-section-label` — all in `web/static/css/styles.css`
- `WGSparkline.render({ points, variant, width, height })` — already ported from `project/components.jsx:Sparkline`; reuse for the pulse line under the current-reading card
- `WGIcons.iconSvg('activity', …)` — BP's bottom-nav icon; also usable for the averages card header
- `<wg-phone-chrome>` wrapper (primitive available but not yet mounted at runtime in Phase 1+2) + the `section-header` / `.wg-app-header` back-pill combo — Phase 3 decides whether to wrap BP in the chrome or defer

**Tests touching BP (will need updates):**

- `bp.render.test.js` (if it exists; otherwise created in this phase) — current-reading card + averages + history list snapshots
- `bp.chart.test.js` — chart renderer SVG structure
- Architecture tests — `architecture.design-tokens.test.js` gets new `--wg-bp-*` dimensional tokens in `WANDERGEEK_TOKENS`

## Development Approach

- **Testing approach**: Regular (code first, then tests). UI-heavy; visual checking per task.
- Each task includes new/updated Vitest coverage in the same commit.
- **CRITICAL**: `pnpm test` and (when backend-adjacent) `go test ./...` must pass before the next task.
- Keep the SPA single-document model — all new markup lives in `index.html`'s existing `#bp-view` section.
- No inline styles, no hardcoded hex — every visual value comes from a `--wg-*` token, every dimensional value goes into `WANDERGEEK_TOKENS` in the architecture test.
- Follow the Phase 1+2 pattern of dual-classing during the transition (e.g. `bp-current-card wg-bp-current-card`) only if needed to preserve existing DOM-query tests; otherwise migrate cleanly to `.wg-bp-*` and update tests.

## Testing Strategy

- **Unit tests** (Vitest, jsdom): each render helper (`renderCurrentReading`, `renderRangeSelector`, `renderBPChart`, `renderBPAverages`, `renderBPReadings`) gets coverage for primary + empty + offline-stale states.
- **Architecture tests**: every new `--wg-*` token appended to `WANDERGEEK_TOKENS`; every new `window.WGBp*` global (if introduced) registered in `architecture.globals.test.js` with a one-line justification.
- **Chart test**: assert SVG has exactly two line paths (sys + dia), a band fill between them, two dotted guide-lines at y-positions mapped from 80 / 120, and one sun-colored circle per series at the last data point.
- **Snapshot test**: BPScreen renders against a fixed 14-day fixture and matches a stable DOM structure.

## Progress Tracking

- Mark `[x]` immediately when each item completes (do not batch).
- ➕ prefix for newly discovered tasks.
- ⚠️ prefix for blockers.
- Update plan if scope deviates significantly.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): tokens, markup/CSS rewrite, chart port, averages + history reskin, test updates, phone-chrome mount verification.
- **Post-Completion** (no checkboxes): real-device side-by-side with prototype, Lighthouse / contrast audit, reduced-motion audit on gloss `:active` transforms.

## Implementation Steps

### Task 1: Extend tokens + primitives for BP-specific visual values

- [x] add `--wg-bp-*` dimensional tokens to `:root` in `styles.css` (reading-value size 44px, range-selector height, chart width 200 / height 358, band-fill alpha, dotted-guide stroke dasharray) — everything the BP view needs that isn't already covered by the shared `--wg-*` set
- [x] add `--wg-bp-status-*` semantic aliases that wrap the existing `--wg-tag-normal-*` / `-high-*` / `-alert-*` triplets so the BP classifier can return a token-group name and the renderer picks up the right class without duplicating tag styles
- [x] extend `WANDERGEEK_TOKENS` in `web/static/js/tests/architecture.design-tokens.test.js` with every new token
- [x] run `pnpm test` — design-tokens test must be green before next task

### Task 2: Port the BPChart SVG component

- [x] create `web/static/js/components/wg-bp-chart.js` exposing `WGBpChart.render({ readings, goal, width, height, range })` returning an `<svg>` SVGElement
- [x] port the band fill + sys/dia paths + dotted normal-band (80 and 120) + last-point markers from `project/components.jsx:84-148`
- [x] reuse existing `window.ChartUtils.aggregateToDaily`, `lttbDownsample`, `catmullRomSpline`, `animateLine` helpers — `createLastValueDot` intentionally not reused because its inline `fill=` conflicts with the no-inline-colour rule; instead the renderer emits plain `<circle>` elements with `.wg-bp-chart__last` and lets CSS drive the sun fill
- [x] colors come from `--wg-*` tokens via CSS classes on the SVG children (`.wg-bp-chart__sys`, `__dia`, `__band`, `__guide`, `__last`) — no inline `stroke=` / `fill=`
- [x] register `window.WGBpChart` in `architecture.globals.test.js` with a one-line justification
- [x] write `components.wg-bp-chart.test.js` — SVG namespace, path count (sys + dia), band `<path>` exists between them, two dotted guide lines, sun-colored last-point circles per series, empty-input returns null
- [x] run `pnpm test` — must pass before next task

### Task 3: Rewrite renderBPChart + current-reading card in features/bp.js

- [ ] replace `renderBPChart(readings, goalData)` body with a call to `WGBpChart.render(…)`, inserting the returned SVG into the new `.wg-bp-current-card` container
- [ ] add a new `renderCurrentReading(reading)` helper above the chart: renders a `.wg-bp-current-card` with the 44px mono sys/dia display, the pulse sparkline via `WGSparkline.render({ variant: 'sun', … })`, and a `.wg-tag` classed by the `getBPCategory` result
- [ ] add a new `renderRangeSelector({ active, onChange })` helper — `.wg-gloss--inset` container with three `.wg-gloss--sun` buttons (14d / 30d / 60d); active state via class, not inline style
- [ ] state: which range is active is persisted via the existing `localStorage` key pattern used by Today (`mt-bp-range` or similar — confirm the pattern during implementation)
- [ ] write/update `bp.render.test.js` — current-reading card shape, range-selector active-state toggle, chart is wired
- [ ] run `pnpm test` — must pass before next task

### Task 4: Rewrite renderBPAverages as 3-up gloss cards

- [ ] replace the current averages DOM with a 3-column grid of `.wg-bp-average-card` tiles; each shows a `.wg-section-label`, a `.wg-mono-display` value, and a unit suffix
- [ ] values come from the existing `statsRes` payload unchanged — no backend changes
- [ ] write/update `bp.averages.test.js` — three cards render, values formatted to 0 decimals, missing stats fall back to "—"
- [ ] run `pnpm test` — must pass before next task

### Task 5: Rewrite renderBPReadings as day-grouped history list

- [ ] replace the existing `.bp-history` markup with a `.wg-bp-history` container — day groups use `.wg-section-label` headers, each reading is a `.wg-card` row with sys/dia mono values, a status tag, time, and an edit/delete `.wg-icon-btn` trailing cluster
- [ ] preserve the existing offline and rejected badge logic — they become `.wg-tag--mono` variants
- [ ] delete + edit callbacks unchanged (reuse `deleteBPReading`, `_deleteBPApi`)
- [ ] write/update `bp.history.test.js` — day grouping, status-tag class per reading, offline-pending + rejected badge states, delete flow invokes existing handler
- [ ] run `pnpm test` — must pass before next task

### Task 6: Wire BP into the canonical bottom nav + phone chrome

- [ ] decide whether to wrap `#bp-view` in `<wg-phone-chrome>`. Phase 1 did NOT wrap any views at runtime — the chrome is a design-system primitive available in `components/wg-phone-chrome.js` but not yet mounted. If this phase wraps BP, thread the mount through `features/bootstrap.js`; otherwise document the deferral and keep the fixed bottom nav as the only persistent shell
- [ ] confirm `WGBottomNav.DEFAULT_ITEMS` still carries the `bp` slot first (post-Today) and `activity` icon; add a test case if one doesn't exist
- [ ] remove any remaining `.bp-*` paper-era classes from `styles.css` that are no longer referenced after the rewrite (grep-verify)
- [ ] run `pnpm test` — must pass before next task

### Task 7: Verify acceptance criteria for Phase 3

- [ ] open `index.html` in desktop 390×844 phone view, compare BP screen side-by-side with `Medtracker.html` — document pixel deviations > 2px in a comment block in this plan
- [ ] open in mobile viewport (DevTools 375×812) — confirm chart does not overflow, range selector stays tappable, history list scrolls cleanly under sticky chrome
- [ ] full `pnpm test` suite green
- [ ] `go test ./...` green (sanity check; no backend changes expected)
- [ ] grep `style="` and `\.style\.` in the new JS — document any allowlisted exceptions

### Task 8: [Final] Update plan and write Phase 4 plan stub

- [ ] mark this plan complete; ralphex moves it to `docs/plans/completed/`
- [ ] write `docs/plans/2026-04-XX-wandergeek-phase4-food.md` covering the Food screen + EditFoodModal rewrite (see Phase 4 stub in the Phase 1+2 plan)
- [ ] no code changes in this task

## Technical Details

**Chart port strategy**: the prototype's `BPChart` is a pure React component that builds paths inline. The production app's `renderBPChart` already mirrors the same math (aggregation → downsample → spline → last-point markers) via `window.ChartUtils`. The port consolidates the two: `WGBpChart.render()` owns the SVG structure, `ChartUtils` owns the numerics. No duplication.

**Status tag mapping**: `getBPCategory(sys, dia)` returns one of `'Normal' | 'High-normal' | 'Stage 1' | 'High'`. Map to `.wg-tag--normal` / `.wg-tag--high` / `.wg-tag--alert` via a small lookup in the renderer. The classifier itself stays unchanged (same thresholds, same bot parity).

**Offline-pending parity**: every render helper must surface the existing offline-pending and rejected states. Phase 1+2 did not touch `MedTrackerDB.BPStore.getPending/getRejected`; Phase 3 only changes how those badges look (`.wg-tag--mono` instead of the current paper-era pill).

**Back-button + bottom nav**: same model as every other screen after Phase 1+2 — tapping BP in the bottom nav is lateral (no back stack); tapping a history row to edit pushes a modal (back stack via `modal-history.js`). Nothing new here.

## Follow-up Phases (out of scope; named only)

### Phase 4 — Food screen + EditFoodModal rewrite
Sub-tab strip (`.wg-gloss--inset` + `.wg-gloss--sun` active), day navigator, daily macros card with `MacroRow`s, meal-grouped item list, EditFoodModal (per-100g macros, barcode scan, datetime) via existing `modal-controller.js`.

### Phase 5 — Meds screen rewrite
Replaces placeholder with real schedule UI, next-action card pattern, schedule grouped by hour, inventory + history sub-views.

### Phase 6 — Weight screen rewrite
Big current-weight card (mono + trend arrow), range selector + line chart, day-grouped history with delete actions.

### Phase 7 — Workouts screen rewrite
Today's-workout card (PUSH/PULL/LEGS), session detail + log-set flow, rotation editor + history sub-views.

### Phase 8 — Health screen rewrite
SpO2 + sleep + diary — vitals tiles, sleep history by week, notes/diary list.

### Phase 9 — Settings screen rewrite
Form-heavy — tokens for every input state, gloss-inset inputs, sectioned cards. Largest CSS surface; do last so primitives are stable.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes.*

**Manual verification:**
- Real-device side-by-side with the handoff prototype on iPhone (PWA install) and Android Chrome
- Lighthouse / a11y audit on BP screen — 44px JetBrains Mono contrast vs. deep-teal stage
- Reduced-motion preference: gloss `:active` transforms and chart animation respect `prefers-reduced-motion`
- Telegram WebApp BackButton verification inside the actual Telegram client

**External system updates:**
- Update `pitch.html` screenshots once Phase 3 lands
- Announce in whatever release-notes channel applies
