# Wandergeek Phase 4 — Food Screen + EditFoodModal Rewrite

## Overview

Reskin the Food screen and its editor modal to match the Wandergeek deep-teal / glossy / JetBrains-Mono aesthetic established in Phase 1+2 (`docs/plans/completed/2026-04-20-wandergeek-design-rewrite.md`) and extended by Phase 3 BP (`docs/plans/completed/2026-04-20-wandergeek-phase3-bp.md`). The Food view becomes a full first-class destination driven by the bottom nav from `WGBottomNav.DEFAULT_ITEMS`. Phase 4 keeps the same runtime model Phase 3 settled on: every screen renders directly into `#app` under the fixed `.wg-bottom-nav`; `<wg-phone-chrome>` remains an available primitive but is not mounted here — mounting chrome is a cross-screen shell decision for a dedicated later phase.

The handoff prototype gives us the target layout (see `project/screens.jsx:FoodScreen` (lines 271-366) and `project/screens.jsx:EditFoodModal` (lines 386-470) and the `MacroRow` helper (lines 368-381)):

- **Sub-tab strip** at the top (Daily log / My meals / Food DB) rendered as a `.wg-gloss--inset` container with a `.wg-gloss--sun` active pill — the same primitive Phase 3 used for the BP range selector. State persists via the existing Food sub-tab `localStorage` key pattern.
- **Day navigator** (left/right chevron buttons wrapping a centered date) above the macros card — mono title + small uppercase "20.04.2026" subtitle.
- **Daily macros card** — a `.wg-card` with the big JetBrains-Mono kcal total, `of target` percentage, and four `MacroRow`s (Energy / Protein / Carbs / Fat). Each row is a `56px / 1fr / auto` grid: label, inset progress bar, mono value `/ target unit`.
- **Meal-grouped item list** — `.wg-section-label` meal headers (e.g. "Snack · 00:46") with totals, then `.wg-card` rows for each item carrying name, grams, kcal (sun), `P/F` mono, and a trailing `.wg-icon-btn` cluster (edit + delete).
- **Add food CTA** — full-width `.wg-gloss--sun` button at the bottom of the list.
- **EditFoodModal** — mono header ("New entry" / "Edit entry"), Weight + Barcode row (with a `Scan` gloss button), name input, `Macros · per 100g` section (Carbs / Protein / Fat), Total calories input (larger mono), Date & time input, Cancel + Save entry buttons. Uses existing `modal-controller.js` history plumbing.

No backend changes. The existing `/api/food*` endpoints, Dexie offline queue, barcode-scanner plumbing, AI composer, and `DataStore.loadSWR` flow stay intact — we rewrite only the render layer and the CSS.

## Context (from discovery)

**Existing food code (target):**

- `web/static/js/features/food.js` (2070 lines) — biggest feature file; the rewrite touches layout-only helpers, not data flow.
  - `bindFoodControls` — existing event wiring, reused as-is
  - Day navigator: `formatFoodDateLabel`, `updateFoodDateNav`, `goFoodToday`, `shiftFoodDate`
  - Add/edit modal entry: `showAddFoodModal`, `editFoodLog`, `showEditFoodProductModal`
  - Autocomplete + barcode: `renderFoodAutocomplete`, `onFoodBarcodeChange`, `createFoodBarcodeDetector`, `startFoodScanner`, `openFoodScannerModal`
  - Render orchestration: `computeFoodTotals`, the daily-log render path invoked by `DataStore.loadSWR`
- `web/static/index.html` — `#food-view` section (sub-tab strip + day nav + daily log) and the edit modal template
- `web/static/css/styles.css` — existing `.food-*` paper-era classes get replaced with `.wg-food-*`

**Handoff prototype (read-only reference):**

- `/tmp/medtracker-handoff/medtrackerbot/project/screens.jsx:FoodScreen` — layout scaffold (lines 271-366)
- `/tmp/medtracker-handoff/medtrackerbot/project/screens.jsx:MacroRow` — progress-bar macro row (lines 368-381)
- `/tmp/medtracker-handoff/medtrackerbot/project/screens.jsx:EditFoodModal` — modal scaffold (lines 386-470)
- `/tmp/medtracker-handoff/medtrackerbot/project/data.js:FOOD_TARGETS` / `FOOD_LOG` — shape reference for test fixtures

**Wandergeek primitives available (from Phase 1+2+3):**

- `.wg-card` / `.wg-card--inset` / `.wg-gloss` / `.wg-gloss--sun` / `.wg-gloss--inset` / `.wg-tag` + variants / `.wg-mono-display` / `.wg-section-label` / `.wg-icon-btn`
- `WGSparkline.render(…)` — available if a trend line is desired on the macros card; optional for Phase 4
- `WGIcons.iconSvg('apple' | 'chevronLeft' | 'chevronRight' | 'pencil' | 'trash' | 'barcode' | 'close' | 'plus', …)`
- `WGBpChart` pattern from Phase 3 — reference for Phase 4's `WGMacroRow` / `WGMacroBar` component structure
- `<wg-phone-chrome>` wrapper still available as a primitive; not mounted in Phase 4

**Tests touching Food (will need updates):**

- `food.render.test.js` / `food.daily.test.js` / `food.barcode.test.js` (if present; otherwise created in this phase) — macros card, meal list, sub-tab strip, day-navigator snapshots
- `food.modal.test.js` — EditFoodModal open/save/cancel behavior, per-100g recompute, barcode scan handoff
- Architecture tests — `architecture.design-tokens.test.js` gets new `--wg-food-*` dimensional tokens in `WANDERGEEK_TOKENS`; `architecture.globals.test.js` gets `WGMacroBar` / `WGFood*` entries if introduced

## Development Approach

- **Testing approach**: Regular (code first, then tests). UI-heavy; visual checking per task.
- Each task includes new/updated Vitest coverage in the same commit.
- **CRITICAL**: `pnpm test` and (when backend-adjacent) `go test ./...` must pass before the next task.
- Keep the SPA single-document model — all new markup lives in `index.html`'s existing `#food-view` section and the edit-modal template.
- No inline styles, no hardcoded hex — every visual value comes from a `--wg-*` token, every dimensional value goes into `WANDERGEEK_TOKENS` in the architecture test.
- Follow Phase 3's migration pattern (clean migrate to `.wg-food-*` classes; dual-class only where DOM-query tests require).

## Testing Strategy

- **Unit tests** (Vitest, jsdom): each render helper (`renderFoodSubTabs`, `renderFoodDayNav`, `renderFoodMacrosCard`, `renderMacroBar`, `renderFoodMealGroup`, `renderFoodItemRow`, `renderEditFoodModal`) gets coverage for primary + empty + offline-stale states.
- **Architecture tests**: every new `--wg-*` token appended to `WANDERGEEK_TOKENS`; every new `window.WGFood*` / `WGMacroBar` global registered in `architecture.globals.test.js` with a one-line justification.
- **Macro bar test**: assert the bar container is `.wg-gloss--inset`, the fill width matches `min(value / target * 100, 100)`, and the mono value suffix matches the `value / target unit` format.
- **Snapshot test**: FoodScreen renders against a fixed fixture and matches a stable DOM structure across the three sub-tabs.

## Progress Tracking

- Mark `[x]` immediately when each item completes (do not batch).
- ➕ prefix for newly discovered tasks.
- ⚠️ prefix for blockers.
- Update plan if scope deviates significantly.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): tokens, sub-tab strip, day navigator, macros card + MacroBar component, meal list, edit modal, test updates, grep-cleanup of paper-era classes.
- **Post-Completion** (no checkboxes): real-device side-by-side with prototype, Lighthouse / contrast audit, reduced-motion audit on gloss `:active` transforms and macro-bar width animation.

## Implementation Steps

### Task 1: Extend tokens + primitives for Food-specific visual values

- [x] add `--wg-food-*` dimensional tokens to `:root` in `styles.css` (kcal-display size 30px, macro-bar height 8px, macro-row grid-template-columns, sub-tab padding, day-nav icon-button size) — everything the Food view needs that isn't already covered by the shared `--wg-*` set
- [x] add `--wg-food-macro-*` semantic aliases for Energy / Protein / Carbs / Fat bar colors mapping to the existing sun / mint / teal / amber tokens so `renderMacroBar` picks up the right class without duplicating styles
- [x] extend `WANDERGEEK_TOKENS` in `web/static/js/tests/architecture.design-tokens.test.js` with every new token
- [x] run `pnpm test` — design-tokens test must be green before next task

### Task 2: Build the `WGMacroBar` component

- [x] create `web/static/js/components/wg-macro-bar.js` exposing `WGMacroBar.render({ label, value, target, unit, variant })` returning a DOM element
- [x] mirror `project/screens.jsx:MacroRow` — `56px / 1fr / auto` grid, `.wg-gloss--inset` track, fill element classed by `variant` (`energy` | `protein` | `carbs` | `fat`)
- [x] colors come from `--wg-food-macro-*` tokens via CSS classes — no inline `style=` / hardcoded hex
- [x] register `window.WGMacroBar` in `architecture.globals.test.js` with a one-line justification
- [x] write `components.wg-macro-bar.test.js` — fill width clamped to 0-100%, unit suffix formatted, variant class present, reduced-motion fill transition still applies via CSS
- [x] run `pnpm test` — must pass before next task

### Task 3: Rewrite Food sub-tab strip + day navigator

- [x] replace the current sub-tab buttons with a `.wg-gloss--inset` container carrying three `.wg-gloss--sun`-capable pills (Daily log / My meals / Food DB); active state via class, not inline style
- [x] state: which sub-tab is active persists via the existing Food sub-tab `localStorage` key (confirm the exact key during implementation) — settled on `mt-food-subtab` (matches the `mt-bp-range` naming pattern)
- [x] rewrite the day navigator as a 3-cell row — left `.wg-icon-btn` (chevronLeft), center `.wg-mono-display` title + `.wg-section-label` date subtitle, right `.wg-icon-btn` (chevronRight) — wiring the existing `shiftFoodDate` / `goFoodToday` callbacks
- [x] write/update `food.subtabs.test.js` + `food.daynav.test.js` — active-state toggle, chevron click dispatches correct delta, today-tap resets date
- [x] run `pnpm test` — must pass before next task

### Task 4: Rewrite the daily macros card

- [x] replace the existing daily-total block with a `.wg-food-macros-card` — `.wg-mono-display` kcal total with a small `kcal` unit suffix, `% of target` sun value on the right
- [x] render four `WGMacroBar` instances (Energy / Protein / Carbs / Fat) using `FOOD_TARGETS` plus `computeFoodTotals()` output unchanged — no backend changes
- [x] empty state (no items logged today) renders the card with zero values and the bars collapsed to 0% (not hidden)
- [x] write/update `food.macros.test.js` — three/four bars render, totals formatted to 0 decimals, empty state handled, missing targets fall back gracefully
- [x] run `pnpm test` — must pass before next task

### Task 5: Rewrite meal-grouped item list

- [x] replace the existing `.food-items` markup with a `.wg-food-meal-group` container per meal — `.wg-section-label` headers with a trailing mono kcal total, each item a `.wg-card` row carrying name, grams, kcal (sun), `P/F` macro breakdown, and trailing `.wg-icon-btn` cluster (edit + delete)
- [x] preserve the existing offline and rejected badge logic — they become `.wg-tag--mono` variants
- [x] delete + edit callbacks unchanged (reuse `editFoodLog`, existing delete path)
- [x] full-width `.wg-gloss--sun` "Add food" CTA appended after the last meal group
- [x] write/update `food.meallist.test.js` — meal grouping, offline-pending + rejected badge states, edit-button click invokes existing handler, delete flow preserved
- [x] run `pnpm test` — must pass before next task

### Task 6: Rewrite EditFoodModal

- [x] replace the existing edit-food modal markup in `index.html` with the Wandergeek shell — mono header (dual-line: "Edit entry" / "Food"), `.wg-icon-btn` close trailing the header
- [x] Weight (g) + Barcode row — both are `.wg-gloss--inset` input wraps sharing the 10px gap; Scan button is `.wg-gloss` with the barcode icon
- [x] Food name input — full-width `.wg-gloss--inset` wrap; autocomplete dropdown from `renderFoodAutocomplete` stays functional
- [x] `Macros · per 100g` section — three-column `.wg-gloss--inset` input wraps (Carbs / Protein / Fat)
- [x] Total calories input — full-width, larger mono (18px via `--wg-food-total-kcal-input` token)
- [x] Date & time input — full-width `.wg-gloss--inset` wrap carrying the existing ISO-local formatter
- [x] Cancel + Save entry buttons row at the bottom — Cancel `.wg-gloss`, Save `.wg-gloss--sun` with 2× flex per modal-button order convention (Cancel left, Save right); top-right placement alternative only if keyboard-occlusion still happens on mobile
- [x] barcode scanner overlay (`openFoodScannerModal`) unchanged — only the trigger button is restyled
- [x] write/update `food.modal.test.js` — open/save/cancel, per-100g recompute, barcode scan handoff, `modal-controller.js` history integration preserved
- [x] run `pnpm test` — must pass before next task

### Task 7: Wire Food into the canonical bottom nav + cleanup

- [ ] confirm `WGBottomNav.DEFAULT_ITEMS` still carries the `food` slot and the `apple` icon; add a test case if one doesn't exist
- [ ] remove any remaining `.food-*` paper-era classes from `styles.css` that are no longer referenced after the rewrite (grep-verify)
- [ ] run `pnpm test` — must pass before next task

### Task 8: Verify acceptance criteria for Phase 4

- [ ] open `index.html` in desktop 390×844 phone view, compare Food screen side-by-side with `Medtracker.html` — manual visual check
- [ ] open in mobile viewport (DevTools 375×812) — manual visual check
- [ ] full `pnpm test` suite green
- [ ] `go test ./...` green (sanity check; no backend changes expected)
- [ ] grep `style="` and `\.style\.` in the new JS — zero matches in `web/static/js/features/food.js` and `web/static/js/components/wg-macro-bar.js` (or allowlisted in `architecture.inline-styles.test.js` with a one-line justification)

### Task 9: [Final] Update plan and write Phase 5 plan stub

- [ ] mark this plan complete; ralphex moves it to `docs/plans/completed/`
- [ ] write `docs/plans/2026-04-XX-wandergeek-phase5-meds.md` covering the Meds screen rewrite (see Phase 5 stub in the Phase 1+2 plan)
- [ ] no code changes in this task

## Technical Details

**MacroBar component strategy**: the prototype's `MacroRow` is a pure React JSX block with inline styles and a hardcoded `color` prop. The production port consolidates it into a reusable `WGMacroBar` component: DOM structure owned by the component, visual values owned by CSS classes + `--wg-food-macro-*` tokens. The four variants (energy / protein / carbs / fat) are class names, not props carrying hex values.

**Sub-tab state**: Food already persists the active sub-tab via `localStorage` (pattern confirmed during Phase 4 Task 3). The rewrite does not change the key or the shape — only the rendered markup. Integration with `DataStore.loadSWR` and the existing `renderFoodDailyLog` / `renderMyMeals` / `renderFoodDB` render paths stays intact.

**Modal history parity**: `modal-controller.js` already drives the open/close lifecycle for EditFoodModal via the back-button stack. Phase 4 only restyles the modal body; the controller, history entry, and Telegram WebApp BackButton wiring are unchanged.

**Offline + barcode parity**: every render helper must surface the existing offline-pending, rejected, and barcode-scanner states. `MedTrackerDB.FoodStore.getPending/getRejected` is unchanged; `createFoodBarcodeDetector`, `startFoodScanner`, and `openFoodScannerModal` are unchanged. Phase 4 only changes how those states look (`.wg-tag--mono` badges instead of paper-era pills; gloss scan button instead of a bordered secondary).

**Per-100g recompute**: `calculateFoodCalories`, `onFoodPer100gChange`, `parseOptionalNumber`, and the existing gotcha ("Edit modals must show original per-100g values, not calculated totals") are all preserved. Phase 4 changes the input styling, not the math.

## Follow-up Phases (out of scope; named only)

### Phase 5 — Meds screen rewrite
Replaces placeholder with real schedule UI, next-action card pattern from Today, schedule grouped by hour, inventory + history sub-views.

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
- Lighthouse / a11y audit on Food screen — 30px JetBrains Mono contrast vs. deep-teal stage, macro-bar minimum-touch-target check on the edit/delete icon buttons
- Reduced-motion preference: gloss `:active` transforms and macro-bar width animation respect `prefers-reduced-motion`
- Telegram WebApp BackButton verification inside the actual Telegram client — confirm EditFoodModal close path still pops history cleanly
- Barcode scanner regression sweep on a real device (camera permission prompt, decode path, photo-fallback path)

**External system updates:**
- Update `pitch.html` screenshots once Phase 4 lands
- Announce in whatever release-notes channel applies
