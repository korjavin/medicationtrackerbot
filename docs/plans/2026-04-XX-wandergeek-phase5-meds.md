# Wandergeek Phase 5 — Meds Screen Rewrite

## Overview

Reskin the Meds screen to match the Wandergeek deep-teal / glossy / JetBrains-Mono aesthetic established in Phase 1+2 (`docs/plans/completed/2026-04-20-wandergeek-design-rewrite.md`) and extended by Phase 3 BP (`docs/plans/completed/2026-04-20-wandergeek-phase3-bp.md`) + Phase 4 Food (`docs/plans/completed/2026-04-XX-wandergeek-phase4-food.md`). The Meds view becomes a full first-class destination driven by the bottom nav from `WGBottomNav.DEFAULT_ITEMS`. Phase 5 keeps the same runtime model Phases 3+4 settled on: every screen renders directly into `#app` under the fixed `.wg-bottom-nav`; `<wg-phone-chrome>` remains an available primitive but is not mounted here.

Phase 5 is different from Phases 3 and 4 in one respect: the handoff prototype (`project/screens.jsx`) does NOT include a dedicated Meds screen — only Today, BP, and Food/Edit. The Meds layout must therefore be composed from Wandergeek primitives already available (gloss / gloss-sun / gloss-inset / card / card-inset / mono-display / section-label / tag / icon-btn), informed by the "Next · 08:20 · Take" sun next-action card on Today (`project/screens.jsx:TodayScreen` lines 15-26) and the sub-tab strip + meal-group patterns shipped in Phase 4.

The target layout:

- **Sub-tab strip** at the top (Schedule / History / Inventory) rendered as a `.wg-gloss--inset` container with a `.wg-gloss--sun` active pill — same primitive Phases 3 & 4 use. State persists via a new `mt-meds-subtab` localStorage key matching the `mt-bp-range` / `mt-food-subtab` pattern.
- **Next-action card** (Schedule sub-tab, top) — a `.wg-gloss--sun` card mirroring the Today "Next · HH:MM · in Xh Ym" next-action pattern, listing the upcoming med cluster by name with a sun Take button that drives `showMedicationConfirmModal([ids], [names], now, 'take')`.
- **Schedule grouped by hour** — `.wg-section-label` hour headers (e.g. "08:00 · in 1h 21m"), then a `.wg-card` row per medication carrying name, dosage, schedule summary, inventory tag (if tracked), and a trailing `.wg-icon-btn` cluster (Log / Edit / Delete). As-needed and archived meds collapse into separate `.wg-section-label` groups below the scheduled ones.
- **History sub-tab** — existing filter controls (medication + days) reskinned as `.wg-gloss--inset` select wraps; day-grouped log list with `.wg-section-label` headers, each entry a `.wg-card` row with med name (mono), dosage, ISO-local time, and an edit/delete icon cluster. Offline-pending + rejected badges become `.wg-tag--mono` variants.
- **Inventory sub-tab** — a `.wg-card` per medication that tracks inventory, showing count (mono-display), low-stock warning as `.wg-tag--alert`, last-refilled date, and a Refill `.wg-gloss--sun` button. Non-tracked meds excluded from this sub-tab.
- **Add medication FAB** — full-width `.wg-gloss--sun` button at the bottom of the Schedule sub-tab (replaces the current `#add-btn` FAB).
- **Edit medication modal** — mono header ("New medication" / "Edit medication"), name + dosage `.wg-gloss--inset` wraps, schedule-type selector (`.wg-gloss--inset` container with sun-capable pills for Daily / Interval / Weekly / As-needed), times-of-day editor, start/end dates, inventory toggle + count, supplement toggle, archived toggle, Cancel + Save buttons (`.wg-gloss` + `.wg-gloss--sun`, 2× flex on Save per modal-button-order convention). Uses existing `modal-controller.js` history plumbing.

No backend changes. The existing `/api/medications`, `/api/intakes`, `/api/medications/{id}/confirm`, `/api/medications/{id}/skip`, and `/api/medications/{id}/log` endpoints, the Dexie offline queue (`MedicationStore`, `IntakeHistoryStore`), and the `DataStore.loadSWR` flow stay intact — we rewrite only the render layer and the CSS.

## Context (from discovery)

**Existing meds code (target):**

- `web/static/js/app.js` — currently houses the Meds render + modal flow inline (not yet extracted like bp.js / food.js / today.js). Phase 5 should extract these into a feature module.
  - `renderMeds()` (lines 2131-2263) — schedule tab bucketed render: scheduledSoon, recentTaken, asNeeded, archived; each renders a `.med-item`
  - `loadMeds()` (lines 2398-2457) — SWR load orchestration
  - `renderHistory(logs)` (lines 2270+) — history tab list
  - `populateMedFilter()` (lines 2459-2495) — history filter dropdown
  - `saveMedication()` (lines 2497+) — modal submit
  - `deleteMed(id)` (lines 2588+) — delete action
  - `showEditModal(id)` / `showMedicationConfirmModal(ids, names, date, mode)` — modal entry points
  - `logMedicationPast(id, name)` — "Log" row button
  - `parseMedicationSchedule` / `getNextScheduledDate` / `getMedicationScheduleText` / `getLastTakenTimeMs` / `isLowOnStock` — helpers reused as-is
- `web/static/index.html` — `#meds-view` section (line 44) — two current sub-tabs (`History` / `Schedule`); filters + next-intake-trigger + history-list + med-list + add-btn
- `web/static/css/styles.css` — existing `.med-item` / `.med-info` / `.med-actions` / `.med-action-icons` / `.inventory-badge` / `.med-supplement-badge` / `.med-normalized-name` / `.med-tabs` / `.med-tab` / `.med-tab-content` / `.filters` paper-era classes get replaced with `.wg-meds-*`

**Handoff prototype (read-only reference):**

- `/tmp/medtracker-handoff/medtrackerbot/project/screens.jsx:TodayScreen` (lines 14-26) — the next-action card pattern (sun gradient card, "Next · HH:MM · in Xh Ym", mono names list, sun Take button) — the template for the Meds next-action card.
- No dedicated Meds screen in the prototype; Phase 5 composes the layout from existing primitives.

**Wandergeek primitives available (from Phase 1+2+3+4):**

- `.wg-card` / `.wg-card--inset` / `.wg-gloss` / `.wg-gloss--sun` / `.wg-gloss--inset` / `.wg-tag` + variants / `.wg-mono-display` / `.wg-section-label` / `.wg-icon-btn` / `.wg-fab`
- `WGSparkline.render(…)` — available if an adherence trend mini-chart is desired; optional for Phase 5
- `WGMacroBar` (Phase 4) — pattern reference for progress-indicator components; not reused directly
- `WGIcons.iconSvg('pill' | 'pencil' | 'trash' | 'plus' | 'clock' | 'archive' | 'package' | 'check', …)`
- `WGBottomNav.DEFAULT_ITEMS` already carries the `meds` slot with the `pill` icon (verified in Phase 4 Task 7)
- `<wg-phone-chrome>` wrapper still available as a primitive; not mounted in Phase 5

**Tests touching Meds (will need updates):**

- `app.loadmeds-bp-swipe-edges.test.js` — existing; verify no regression after render helper extraction
- `app.forms-and-push.test.js` — existing; verify medication-form save/delete still passes
- `meds.render.test.js` / `meds.schedule.test.js` / `meds.history.test.js` / `meds.inventory.test.js` — new, created in this phase
- `meds.modal.test.js` — new, covering edit/add modal open/save/cancel
- Architecture tests — `architecture.design-tokens.test.js` gets new `--wg-meds-*` dimensional tokens; `architecture.globals.test.js` gets `WGMeds*` globals if introduced

## Development Approach

- **Testing approach**: Regular (code first, then tests). UI-heavy; visual checking per task.
- Each task includes new/updated Vitest coverage in the same commit.
- **CRITICAL**: `pnpm test` and (when backend-adjacent) `go test ./...` must pass before the next task.
- Keep the SPA single-document model — all new markup lives in `index.html`'s existing `#meds-view` section and the edit-medication modal template.
- No inline styles, no hardcoded hex — every visual value comes from a `--wg-*` token, every dimensional value goes into `WANDERGEEK_TOKENS` in the architecture test.
- Follow Phase 3+4's migration pattern (clean migrate to `.wg-meds-*` classes; dual-class only where DOM-query tests require).
- **Scope note**: extract the meds render + modal flow out of `app.js` into a new `web/static/js/features/meds.js` during this phase to match the bp.js / food.js / today.js / health.js / weight.js pattern. This is a structural cleanup that's been pending since before Phase 3; Phase 5 is the right time because the full render layer is being rewritten anyway.

## Testing Strategy

- **Unit tests** (Vitest, jsdom): each render helper (`renderMedsSubTabs`, `renderNextActionCard`, `renderMedScheduleGroup`, `renderMedRow`, `renderMedHistory`, `renderMedInventory`, `renderEditMedModal`) gets coverage for primary + empty + offline-stale states.
- **Architecture tests**: every new `--wg-*` token appended to `WANDERGEEK_TOKENS`; every new `window.WGMeds*` global registered in `architecture.globals.test.js` with a one-line justification.
- **Next-action card test**: assert the card container is `.wg-gloss--sun`, the Take button click calls `showMedicationConfirmModal` with the upcoming med IDs, and the "in Xh Ym" relative time formats correctly for various offsets.
- **Schedule bucket test**: assert scheduledSoon/recentTaken/asNeeded/archived groups each render under a `.wg-section-label` header, sort order preserved, archived group collapsed by default if item count > 3.
- **Snapshot test**: MedsScreen renders against a fixed fixture and matches a stable DOM structure across the three sub-tabs.

## Progress Tracking

- Mark `[x]` immediately when each item completes (do not batch).
- ➕ prefix for newly discovered tasks.
- ⚠️ prefix for blockers.
- Update plan if scope deviates significantly.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): tokens, feature-module extraction, sub-tab strip, next-action card, schedule grouped by hour, history list, inventory list, edit modal, test updates, grep-cleanup of paper-era classes.
- **Post-Completion** (no checkboxes): real-device side-by-side, Lighthouse / contrast audit, reduced-motion audit on gloss `:active` transforms.

## Implementation Steps

### Task 1: Extend tokens + extract meds into a feature module

- [x] add `--wg-meds-*` dimensional tokens to `:root` in `styles.css` (next-action card padding, schedule-hour header size, med-row grid-template-columns, inventory-count mono size, sub-tab padding) — everything the Meds view needs that isn't already covered by the shared `--wg-*` set
- [x] add `--wg-meds-status-*` semantic aliases that wrap the existing `--wg-tag-*` triplets so the inventory classifier (low / ok / out) can return a token-group name without duplicating tag styles
- [x] extend `WANDERGEEK_TOKENS` in `web/static/js/tests/architecture.design-tokens.test.js` with every new token
- [x] create `web/static/js/features/meds.js` and move `renderMeds`, `loadMeds`, `renderHistory`, `populateMedFilter`, `saveMedication`, `deleteMed`, `showEditModal`, `showMedicationConfirmModal`, `logMedicationPast` out of `app.js` into it; script-tag load order + hoisted function declarations keep them accessible as globals (no `window.MedsFeature` namespace introduced — matches the de-facto `features/bp.js` / `features/food.js` pattern where functions stay as script-scope globals). Cross-file shared state (`initialAuthLoad`, `medications`, `editingMedId`, `pendingMedConfirm*`) switched from `let` to `var` so it persists as a true global across script tags.
- [x] update `index.html` script load order to include `features/meds.js` in the same phase as the other feature modules (also added to `sw.js` precache list + `tests/helpers/frontend-harness.js`)
- [x] keep all existing helpers (`parseMedicationSchedule`, `getNextScheduledDate`, `getMedicationScheduleText`, `getLastTakenTimeMs`, `isLowOnStock`) wherever they currently live; only the render + modal flow moves
- [x] verify no behavior change — `app.loadmeds-bp-swipe-edges.test.js` and `app.forms-and-push.test.js` stay green
- [x] run `pnpm test` — design-tokens test + extraction smoke test must be green before next task

### Task 2: Build the sub-tab strip + subtab state plumbing

- [x] replace the current `.med-tabs` buttons (History / Schedule) with a `.wg-gloss--inset` container carrying three `.wg-gloss--sun`-capable pills (Schedule / History / Inventory) — active state via class, not inline style
- [x] state: which sub-tab is active persists via a new `mt-meds-subtab` localStorage key matching the `mt-bp-range` / `mt-food-subtab` naming pattern
- [x] default sub-tab: Schedule (distinct from current default of History, which was the paper-era default)
- [x] write `meds.subtabs.test.js` — active-state toggle, persistence across reload, default-tab behavior
- [x] run `pnpm test` — must pass before next task

### Task 3: Build the next-action card

- [x] create a `renderNextActionCard(meds, nextIntake)` helper that picks the upcoming med cluster (the meds scheduled within the same hour as `nextIntake.scheduled_at`)
- [x] mirror the Today next-action card pattern — `.wg-gloss--sun` container, small uppercase "Next · HH:MM · in Xh Ym" subtitle, mono names list ("Allopurinol · Bisoprolol · +4" when > 3), and a `.wg-gloss--sun` Take button
- [x] Take button click invokes `showMedicationConfirmModal([ids], [names], scheduledAt, 'confirm')` — names→ids resolved against the local `medications` list; mode is `confirm` (the actual modal mode for a scheduled intake; the plan's `'take'` was colloquial)
- [x] empty state (no upcoming dose within 24h) renders a muted card with "No upcoming doses" and hides the Take button
- [x] write `meds.nextaction.test.js` — primary state, empty state, > 3 names truncation, Take button dispatch
- [x] run `pnpm test` — must pass before next task

### Task 4: Rewrite the schedule sub-tab (grouped by hour)

- [x] replace `renderMeds()` body to group scheduled meds by next-dose hour rather than flat bucketed list — `.wg-section-label` header per hour ("08:00 · in 1h 21m"), items within the hour rendered as `.wg-card` rows
- [x] preserve the existing bucket fallbacks — as-needed and archived meds collapse into separate `.wg-section-label` groups below the scheduled ones
- [x] each `.wg-card` row: med name (mono-display, 16px), dosage (section-label style), schedule summary (small muted), inventory tag if tracked (`.wg-tag--mono` or `.wg-tag--alert` for low), trailing `.wg-icon-btn` cluster (Log / Edit / Delete)
- [x] full-width `.wg-gloss--sun` "Add medication" CTA appended at the bottom of the sub-tab (replaces `#add-btn` FAB)
- [x] preserve the existing `med.archived` → archived-bucket collapse behavior
- [x] write `meds.schedule.test.js` — hour grouping, inventory tag rendering, low-stock alert state, archived collapse, Log/Edit/Delete callback dispatch
- [x] run `pnpm test` — must pass before next task

### Task 5: Rewrite the history sub-tab

- [x] replace the existing `#history-list` markup with a `.wg-meds-history` container — day groups use `.wg-section-label` headers, each minute-cluster log row is a `.wg-card` row with med names (mono), ISO-local time, and a trailing `.wg-tag--mono` status tag. (The plan also mentioned an edit/delete `.wg-icon-btn` trailing cluster, but there is no `/api/intakes` DELETE endpoint and the existing edit handler is the whole-row click — adding separate icons would duplicate the row-click behavior, so the row remains fully clickable and the trailing cluster carries only the status tag.)
- [x] restyle the filter controls (`#history-filter-med` + `#history-filter-days`) as `.wg-gloss--inset` select wraps inside a `.wg-meds-filters` strip with monospace eyebrow labels; preserve existing `id`s + change-handler wiring
- [x] preserve offline-pending + rejected badge logic — status pills render as `.wg-tag--mono` + `.wg-tag--normal` (TAKEN), `.wg-tag--mono` + `.wg-tag--high` (PENDING), `.wg-tag--mono` + `.wg-tag--alert` (MISSED/other). Emojis retained inside the pill text so existing tests grepping for `✅` still pass.
- [x] delete + edit callbacks unchanged (reuse existing `showMedicationConfirmModal` handler — row click dispatches `'edit'` for TAKEN and `'confirm'` for PENDING clusters, identical to the paper-era behavior)
- [x] `#next-intake-trigger` becomes a link-style muted row under the filters, unchanged behavior (inline `style="margin-bottom:15px"` swept out; geometry now comes from `.wg-meds-next-intake-trigger`)
- [x] write `meds.history.test.js` — day grouping, filter-change refetch, pending + missed badge states, row click dispatches existing handler, empty state, filter-strip structure, `next-intake-trigger` class
- [x] run `pnpm test` — all 844 tests green (new suite: 9 tests under `features/meds.js renderHistory (Phase 5, Task 5)`)

### Task 6: Build the inventory sub-tab (new)

- [x] create an `Inventory` sub-tab rendering one `.wg-card` per medication with `inventory_count !== null`
- [x] each card: med name (mono-display), current count (large mono-display), low-stock warning as `.wg-tag--alert` when `isLowOnStock(med)`, last-refilled date from the most recent inventory adjustment (if tracked) — resolved async via the existing `/api/medications/{id}/restocks` endpoint; row paints "—" until the fetch settles
- [x] Refill button (`.wg-gloss--sun`, trailing) opens an inline `.wg-gloss--inset` quantity input + Confirm/Cancel row that POSTs to the existing `/api/medications/{id}/restock` endpoint and re-renders with the updated count
- [x] empty state (no meds track inventory) renders a muted placeholder: "No medications track inventory — enable tracking in the edit modal."
- [x] write `meds.inventory.test.js` — inventory-count display, low-stock tag, refill flow, empty state (8 tests under `Meds inventory sub-tab (Phase 5, Task 6)`)
- [x] run `pnpm test` — all 852 tests green

### Task 7: Rewrite EditMedicationModal

- [x] replace the existing edit-medication modal markup in `index.html` with the Wandergeek shell — mono header (eyebrow + mono title, "Edit medication" / medication name), `.wg-icon-btn` close trailing the header
- [x] name + dosage row — both are `.wg-gloss--inset` input wraps (`.wg-meds-modal__row--identity`)
- [x] schedule-type selector — `.wg-gloss--inset` pill strip with three `.wg-gloss--sun`-capable pills (Daily / Weekly / As-needed); clicks call `setScheduleType()` which keeps the hidden `#schedule-type` select in sync and swaps detail panels. (Plan mentioned four pills including Interval, but the backend schedule schema only supports daily/weekly/as_needed, so the strip renders the three types the app actually persists — matching the `meds.modal.test.js` assertion `expect(types).toEqual(['daily','weekly','as_needed'])`.)
- [x] detail panel per schedule-type: time-of-day list (daily + weekly), weekday spans (weekly), no panel (as-needed) — all time inputs use `.wg-gloss--inset` wraps; `addTimeInput()` emits the wrapped structure with a `.wg-icon-btn` remove affordance
- [x] start + end dates row — two `.wg-gloss--inset` date inputs side-by-side
- [x] inventory toggle + count input — `.wg-meds-modal__toggle` label, count field + restock row conditionally revealed (`inventory-fields` `hidden` class driven by `toggleInventoryFields()`)
- [x] supplement + archived toggles — `.wg-meds-modal__toggle-row` with two `.wg-meds-modal__toggle` labels
- [x] Cancel + Save buttons row at the bottom — Cancel `.wg-gloss`, Save `.wg-gloss` + `.wg-gloss--sun` with 2× flex per modal-button-order convention (Cancel left, Save right, both inside `.wg-meds-modal__actions`)
- [x] write `meds.modal.test.js` — 18 tests covering open/save/cancel, schedule-type pill swap, inventory toggle reveals count field, existing `saveMedication()` path preserved, `modal-controller.js` history integration (`ModalManager.closeTopMostVisibleModal`) preserved
- [x] run `pnpm test` — all 870 tests green, `meds.modal.test.js` (18 tests) passing under `EditMedicationModal (Phase 5, Task 7)`

### Task 8: Wire Meds into the canonical bottom nav + cleanup

- [x] confirmed `WGBottomNav.DEFAULT_ITEMS[3] = { id:'meds', label:'Meds', icon:'pill' }` and added a Phase 5 contract test (`components.wg-bottom-nav.test.js` — "Meds is the fourth slot with the 'pill' icon — Phase 5 contract") matching the BP/Food contract tests
- [x] grep-verified paper-era classes still referenced: `.med-tabs` / `.med-tab` / `.med-tab-content` (dual-classed on `#med-subtabs` in `index.html` so existing query selectors in `app.js` + 5 test files still resolve); `.med-item` / `.med-info` (reused by `workout.js` for workout-group-cards — cross-feature reuse); `.med-supplement-badge` / `.med-normalized-name` / `.med-action-icons` / `.med-empty-text` / `.inventory-badge` (dual-classed in `features/meds.js` rows for styling layering). `.filters` CSS rule was already absent (only the dual-class marker remains in `index.html` for test compat). Removed the one truly orphan rule — `.inventory-section` (no DOM references anywhere) — from `styles.css:1249-1256`
- [x] run `pnpm test` — all 871 tests green (28 tests in `components.wg-bottom-nav.test.js`, including the new Phase 5 contract test)

### Task 9: Verify acceptance criteria for Phase 5

- [x] open `index.html` in desktop 390×844 phone view, compare Meds screen side-by-side with `Medtracker.html` — manual visual check (skipped - not automatable)
- [x] open in mobile viewport (DevTools 375×812) — manual visual check (skipped - not automatable)
- [x] full `pnpm test` suite green — all 871 tests pass across 87 files
- [x] `go test ./...` green (sanity check; no backend changes expected) — all Go packages pass
- [x] grep `style="` and `\.style\.` in the new JS — 11 pre-Phase-5 show/hide toggles carried over from the Task 1 extraction allowlisted in `architecture.inline-styles.test.js` with one-line justifications (scope expanded to cover `web/static/js/features/meds.js`); no new inline styles introduced by Phase 5's render layer

### Task 10: [Final] Update plan and write Phase 6 plan stub

- [x] mark this plan complete; ralphex moves it to `docs/plans/completed/`
- [x] write `docs/plans/2026-04-XX-wandergeek-phase6-weight.md` covering the Weight screen rewrite (big current-weight card, range selector + line chart, day-grouped history with delete actions)
- [x] no code changes in this task

## Technical Details

**Feature-module extraction strategy**: the meds flow is the last paper-era feature still living in `app.js`. Phase 5 moves it out into `web/static/js/features/meds.js` to match bp.js / food.js / today.js / weight.js / health.js. The extraction happens in Task 1 before the reskin so the rewrite happens on already-modular code. Keep the helpers (`parseMedicationSchedule`, `getNextScheduledDate`, `getMedicationScheduleText`, `getLastTakenTimeMs`, `isLowOnStock`) wherever they currently sit — only the render + modal + action-dispatch flow moves.

**Next-action card vs. Today card parity**: both cards share the same visual shell (`.wg-gloss--sun` container, uppercase sun-colored subtitle, mono names list, sun Take button). Phase 5 extracts the shared markup into a `renderNextActionCard({ variant: 'meds' | 'today' })` helper only if it simplifies — if Today's card carries Today-specific logic (e.g. the "Take" → `go('meds')` transition), keep them as separate render helpers that share CSS only.

**Schedule grouping: hour buckets vs. time buckets**: the current `renderMeds()` uses time-based buckets (scheduledSoon within 14h, recentTaken > 14h, asNeeded, archived). The rewrite switches to hour-of-day grouping within the scheduledSoon bucket (so 08:00 meds group together), then falls back to the time-based buckets for the rest. This aligns with the "Schedule grouped by hour" acceptance criterion from the Phase 1+2 stub.

**Inventory sub-tab is a new surface**: the existing `#meds-view` has only History + Schedule. Phase 5 adds an Inventory sub-tab as a first-class destination because medication inventory is a distinct concern (refill workflow, low-stock alerts, consumption tracking). The backend already exposes `inventory_count` on each medication — no API changes required.

**Modal history parity**: `modal-controller.js` already drives the open/close lifecycle for the edit-medication modal via the back-button stack. Phase 5 only restyles the modal body; the controller, history entry, and Telegram WebApp BackButton wiring are unchanged.

**Offline parity**: every render helper must surface the existing offline-pending, rejected, and cached-stale states. `MedTrackerDB.MedicationStore.getPending/getRejected` and `IntakeHistoryStore.getPending/getRejected` are unchanged; Phase 5 only changes how those badges look (`.wg-tag--mono` instead of the paper-era pills).

## Follow-up Phases (out of scope; named only)

### Phase 6 — Weight screen rewrite
Big current-weight card (mono + trend arrow), range selector + line chart (reuse Phase 3's `WGBpChart` pattern with a single-series variant), day-grouped history with delete actions.

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
- Lighthouse / a11y audit on Meds screen — mono display contrast vs. deep-teal stage, minimum-touch-target check on the Log/Edit/Delete icon buttons
- Reduced-motion preference: gloss `:active` transforms and next-action card animation respect `prefers-reduced-motion`
- Telegram WebApp BackButton verification inside the actual Telegram client — confirm EditMedicationModal close path still pops history cleanly
- Take button → `showMedicationConfirmModal` flow verification across the four modes (`take`, `log_past`, `skip`, `snooze`)
- Inventory refill flow verification — manual entry, bot-parity check (ensure bot's inventory-adjustment path still works after any refactor)

**External system updates:**
- Update `pitch.html` screenshots once Phase 5 lands
- Announce in whatever release-notes channel applies
