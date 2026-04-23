# Wandergeek Phase 7 — Workouts Screen Rewrite

## Overview

Reskin the Workouts screen to match the Wandergeek deep-teal / glossy / JetBrains-Mono aesthetic established in Phase 1+2 (`docs/plans/completed/2026-04-20-wandergeek-design-rewrite.md`) and extended by Phase 3 BP (`docs/plans/completed/2026-04-20-wandergeek-phase3-bp.md`), Phase 4 Food (`docs/plans/completed/2026-04-XX-wandergeek-phase4-food.md`), Phase 5 Meds (`docs/plans/completed/2026-04-XX-wandergeek-phase5-meds.md`), and Phase 6 Weight (`docs/plans/completed/2026-04-XX-wandergeek-phase6-weight.md`). Phase 7 keeps the same runtime model the earlier phases settled on: every screen renders directly into `#app` under the fixed `.wg-bottom-nav`; `<wg-phone-chrome>` remains an available primitive but is not mounted here.

Phase 7 is the most structurally complex reskin so far: the Workouts view today has four sub-tabs (History / Groups / Exercises / Statistics), a rotation-driven "next workout" card, an ad-hoc session flow, and a log-set modal with per-exercise set/reps/weight editors. The handoff prototype does not include a dedicated Workouts screen, so the layout composes Wandergeek primitives (`card`, `gloss`, `gloss-sun`, `gloss-inset`, `mono-display`, `section-label`, `tag`, `icon-btn`) with the sub-tab strip from Phase 4/5 and the range-selector + chart pattern from Phase 3/6.

The target layout:

- **Sub-tab strip** at the top (History / Groups / Exercises / Stats) rendered as a `.wg-gloss--inset` container with a `.wg-gloss--sun` active pill — same primitive Phases 3/4/5/6 use. State persists via a new `mt-workouts-subtab` localStorage key matching `mt-bp-range` / `mt-food-subtab` / `mt-meds-subtab` / `mt-weight-range`.
- **Today's-workout card** (History sub-tab, top) — a `.wg-gloss--sun` card mirroring the Meds next-action pattern, showing the current rotation slot (PUSH / PULL / LEGS / REST), the expected exercise cluster ("Bench · Overhead · Triceps · +2"), and a sun **Start** button that drives `startRotatedWorkout()`. When the rotation says REST or the slot is already completed today, the card flips to a muted `.wg-card` with a "Rest day — start ad-hoc?" CTA.
- **Ad-hoc CTA** — full-width `.wg-gloss` (not sun) "Start ad-hoc workout" button under the today card, replaces the current `#start-adhoc-workout-btn` FAB.
- **History list** — day-grouped `.wg-card` rows with mono duration, session-type tag (PUSH/PULL/LEGS/AD-HOC as `.wg-tag--mono` variants), exercise-count eyebrow, and a trailing `.wg-icon-btn` cluster (view / edit / delete). Row click opens the session-detail view. Offline-pending + rejected badges become `.wg-tag--mono` variants.
- **Session-detail view** (full-screen overlay or expanded inline card) — mono header ("PUSH · 22.04.2026 · Tue"), duration + timestamp eyebrow, a per-exercise `.wg-card` list with set-by-set mono rows (weight × reps), and a bottom-row action cluster (Log set, Finish, Delete).
- **Groups sub-tab** — each workout group renders as a `.wg-card` with mono group name, exercise-count eyebrow, rotation slot tag, and a trailing `.wg-icon-btn` cluster (edit / delete). Full-width `.wg-gloss--sun` "Add workout group" CTA at the bottom.
- **Exercises sub-tab** — library list as `.wg-card` rows with mono exercise name, muscle-group tag, and edit/delete icon cluster. Full-width `.wg-gloss--sun` "Add exercise" CTA at the bottom.
- **Stats sub-tab** — Phase 3-style range selector (7d / 30d / 90d / All) driving a panel of mono stat tiles (total sessions, total volume, most-used exercise, longest streak) plus the existing progress charts reskinned as `WGWorkoutChart` (follows the `WGBpChart` / `WGWeightChart` pattern; single-series or dual-series depending on the chart).
- **Log-set modal / Edit-exercise modal / Edit-group modal / Edit-library-exercise modal** — mono headers, `.wg-gloss--inset` input wraps for name / reps / weight / duration, Cancel + Save buttons (`.wg-gloss` + `.wg-gloss--sun`, 2× flex on Save per modal-button-order convention). Uses existing `modal-controller.js` history plumbing.

No backend changes. The existing `/api/workouts*`, `/api/exercises*`, `/api/workout-groups*`, `/api/exercise-library*`, and rotation endpoints, plus the Dexie offline queue (`WorkoutStore`, `ExerciseStore`), stay intact — we rewrite only the render layer and the CSS.

## Context (from discovery)

**Existing workouts code (target):**

- `web/static/js/workout.js` (~2300 lines) — NOT yet extracted into `features/workout.js` like the other feature modules. Phase 7 should extract it in Task 1 to match the bp.js / food.js / meds.js / today.js / weight.js / health.js pattern.
  - `renderWorkoutHistory(workouts)` — History sub-tab list render
  - `renderWorkoutGroups(groups)` / `renderExerciseLibrary(exercises)` — Groups + Exercises sub-tab lists
  - `renderWorkoutStats(stats)` — Stats sub-tab block (currently flat; Phase 7 rebuilds as tile grid + chart)
  - `showNextWorkoutCard()` — rotation-driven "today's workout" card
  - `startRotatedWorkout()` / `startAdhocWorkout()` / `finishWorkout()` — session lifecycle
  - `showLogSetModal(exerciseId)` / `showEditExerciseModal(exerciseId)` / `showEditWorkoutGroupModal(groupId)` / `showEditLibraryExerciseModal(libId)` — modal entry points
  - `saveWorkoutGroup()` / `saveLibraryExercise()` / `deleteWorkout(id)` — action dispatchers
  - Helpers (`getWorkoutDurationText`, `getExerciseSetSummary`, `getMuscleGroupLabel`, `getRotationSlot`) — reused as-is
- `web/static/index.html` — `#workouts-view` section (lines ~135-179): `.workout-tabs` sub-tab strip, four `.workout-tab-content` panels, `#next-workout-card` mount, `#start-adhoc-workout-btn` FAB, `#workout-history-display` / `#workout-groups-list` / `#exercise-library-list` / `#workout-stats-display` mounts
- `web/static/css/styles.css` — existing `.workout-*` / `.exercise-*` / `.set-*` paper-era classes get replaced with `.wg-workouts-*`

**Handoff prototype:** no dedicated Workouts screen; Phase 7 composes from existing primitives plus the Phase 5 next-action card pattern and the Phase 3/6 range-selector + chart pattern.

**Wandergeek primitives available (from Phase 1+2+3+4+5+6):**

- `.wg-card` / `.wg-card--inset` / `.wg-gloss` / `.wg-gloss--sun` / `.wg-gloss--inset` / `.wg-tag` + variants / `.wg-mono-display` / `.wg-section-label` / `.wg-icon-btn`
- `WGBpChart` / `WGWeightChart` — reference patterns for `WGWorkoutChart` (single-series volume trend or dual-series weight-vs-reps)
- `WGSparkline.render(…)` — available for per-exercise mini trend lines on the session-detail view
- `WGMacroBar` — pattern reference for the weekly-volume progress bar (if applicable)
- `WGIcons.iconSvg('dumbbell' | 'plus' | 'pencil' | 'trash' | 'check' | 'chevronRight' | 'clock' | 'refresh', …)`
- `WGBottomNav.DEFAULT_ITEMS` already carries the `workouts` slot (confirm icon + contract test in Task 8)

**Tests touching Workouts (will need updates):**

- `app.weight-ruler-and-workout-start.test.js` — existing; verify the ad-hoc start flow still works after the extraction + reskin
- `workout.render.test.js` / `workout.history.test.js` / `workout.groups.test.js` / `workout.exercises.test.js` / `workout.stats.test.js` — new, created in this phase
- `workout.next-action.test.js` / `workout.session-detail.test.js` / `workout.modal.test.js` — new, covering today's-workout card, session-detail view, and the log-set / edit-group / edit-exercise modals
- `components.wg-workout-chart.test.js` — new, covering the chart component (range filter, empty state, goal/target overlay if applicable)
- Architecture tests — `architecture.design-tokens.test.js` gets new `--wg-workouts-*` dimensional tokens; `architecture.globals.test.js` gets `WGWorkoutChart` and any new `WGWorkout*` globals with justification

## Development Approach

- **Testing approach**: Regular (code first, then tests). UI-heavy; visual checking per task.
- Each task includes new/updated Vitest coverage in the same commit.
- **CRITICAL**: `pnpm test` and (when backend-adjacent) `go test ./...` must pass before the next task.
- Keep the SPA single-document model — all new markup lives in `index.html`'s existing `#workouts-view` section and the related modal templates.
- No inline styles, no hardcoded hex — every visual value comes from a `--wg-*` token, every dimensional value goes into `WANDERGEEK_TOKENS` in the architecture test.
- Follow Phase 3+4+5+6's migration pattern (clean migrate to `.wg-workouts-*` classes; dual-class only where DOM-query tests require).
- **Scope note**: extract the workouts render + modal flow out of `web/static/js/workout.js` into a new `web/static/js/features/workout.js` during Task 1 to match the feature-module pattern. Workouts is the last remaining top-level JS file that isn't under `features/`; Phase 7 is the right time because the full render layer is being rewritten anyway.

## Testing Strategy

- **Unit tests** (Vitest, jsdom): each render helper (`renderWorkoutSubTabs`, `renderTodaysWorkoutCard`, `renderWorkoutHistoryGroup`, `renderWorkoutGroups`, `renderExerciseLibrary`, `renderWorkoutStats`, `renderSessionDetail`, `renderLogSetModal`, `renderEditWorkoutGroupModal`, `renderEditLibraryExerciseModal`) gets coverage for primary + empty + offline-stale states.
- **Architecture tests**: every new `--wg-*` token appended to `WANDERGEEK_TOKENS`; every new `window.WGWorkout*` / `WGWorkoutChart` global registered in `architecture.globals.test.js` with a one-line justification.
- **Today's-workout card test**: assert rotation slot drives the card variant (PUSH/PULL/LEGS → sun; REST → muted), Start button dispatch, and the "already completed today" state.
- **Session-detail test**: assert per-exercise cards render the set-by-set mono rows, Log-set button opens the modal with the correct exercise context, Finish button closes the session.
- **Chart test**: assert `WGWorkoutChart` honors the active range, degrades to an empty-state card when no sessions exist in the range, and axis tick count is sane for short + long ranges.
- **Snapshot test**: WorkoutsScreen renders against a fixed fixture and matches a stable DOM structure across the four sub-tabs.

## Progress Tracking

- Mark `[x]` immediately when each item completes (do not batch).
- `+` prefix for newly discovered tasks.
- `!` prefix for blockers.
- Update plan if scope deviates significantly.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): tokens, feature-module extraction, sub-tab strip, today's-workout card, history list + session detail, groups list, exercises list, stats tiles + chart, modals, test updates, grep-cleanup of paper-era classes.
- **Post-Completion** (no checkboxes): real-device side-by-side, Lighthouse / contrast audit, reduced-motion audit on gloss `:active` transforms and chart animation.

## Implementation Steps

### Task 1: Extend tokens + extract workouts into a feature module

- [x] add `--wg-workouts-*` dimensional tokens to `:root` in `styles.css` (today-card padding, rotation-slot tag size, history-row grid-template-columns, session-detail set-row height, stats-tile grid, chart height, sub-tab padding) — everything the Workouts view needs that isn't already covered by the shared `--wg-*` set
- [x] add `--wg-workouts-slot-*` semantic aliases wrapping the existing tag-variant tokens so the rotation-slot classifier (PUSH / PULL / LEGS / REST / AD-HOC) can return a token-group name without duplicating tag styles
- [x] extend `WANDERGEEK_TOKENS` in `web/static/js/tests/architecture.design-tokens.test.js` with every new token
- [x] create `web/static/js/features/workout.js` and move render + modal + action-dispatch flow out of `web/static/js/workout.js` into it; script-tag load order + hoisted function declarations keep them accessible as globals (matches bp.js / food.js / meds.js / today.js / weight.js / health.js)
- [x] update `index.html` script load order to include `features/workout.js`; update `sw.js` precache list + `tests/helpers/frontend-harness.js`
- [x] keep all existing helpers (`getWorkoutDurationText`, `getExerciseSetSummary`, `getMuscleGroupLabel`, `getRotationSlot`) wherever they currently live; only the render + modal flow moves
- [x] verify no behavior change — `app.weight-ruler-and-workout-start.test.js` and related existing tests stay green
- [x] run `pnpm test` — design-tokens test + extraction smoke test must be green before next task

### Task 2: Build the sub-tab strip + subtab state plumbing

- [x] replace the current `.workout-tabs` buttons with a `.wg-gloss--inset` container carrying four `.wg-gloss--sun`-capable pills (History / Groups / Exercises / Stats) — active state via class, not inline style
- [x] state: which sub-tab is active persists via a new `mt-workouts-subtab` localStorage key matching the `mt-bp-range` / `mt-food-subtab` / `mt-meds-subtab` / `mt-weight-range` naming pattern
- [x] default sub-tab: History
- [x] write `workout.subtabs.test.js` — active-state toggle, persistence across reload, default-tab behavior
- [x] run `pnpm test` — must pass before next task

### Task 3: Build today's-workout card

- [x] create a `renderTodaysWorkoutCard(rotation, todaySessions)` helper that picks the current rotation slot (PUSH / PULL / LEGS / REST)
- [x] non-rest state: `.wg-gloss--sun` container, small uppercase "Today · SLOT" subtitle, mono exercise-cluster list ("Bench · Overhead · Triceps · +2" when > 3), and a `.wg-gloss--sun` Start button
- [x] rest state: muted `.wg-card` with "Rest day" mono header + "Start ad-hoc?" CTA
- [x] already-completed state: `.wg-card` with "Completed · 45m" eyebrow + Finish-indicator tag
- [x] Start button click invokes `startRotatedWorkout()`; ad-hoc CTA invokes `startAdhocWorkout()`
- [x] write `workout.today.test.js` — rotation-slot variant, rest state, completed state, Start button dispatch, ad-hoc fallback
- [x] run `pnpm test` — must pass before next task

### Task 4: Rewrite the history sub-tab + session detail view

- [x] replace `renderWorkoutHistory()` body to render day-grouped `.wg-card` rows — `.wg-section-label` day headers ("22.04.2026 · Tue"), each entry carrying mono duration, session-type tag (PUSH/PULL/LEGS/AD-HOC as `.wg-tag--mono` variants), exercise-count eyebrow, and a trailing `.wg-icon-btn` cluster (view / edit / delete)
- [x] row click opens the session-detail view (expanded inline card or full-screen overlay — pick whichever preserves modal-history semantics cleanest)
- [x] session-detail: mono header ("PUSH · 22.04.2026 · Tue"), duration + timestamp eyebrow, per-exercise `.wg-card` list with set-by-set mono rows (weight × reps), Log-set / Finish / Delete actions at the bottom
- [x] preserve offline-pending + rejected badge logic — status pills render as `.wg-tag--mono` variants
- [x] write `workout.history.test.js` — day grouping, row click opens detail, edit/delete callbacks, offline + rejected states, empty state
- [x] write `workout.session-detail.test.js` — exercise list render, set-by-set rows, Log-set / Finish / Delete dispatch
- [x] run `pnpm test` — must pass before next task

### Task 5: Rewrite the groups sub-tab

- [x] replace `#workout-groups-list` markup with a `.wg-workouts-groups` container — each group a `.wg-card` row carrying mono group name, exercise-count eyebrow, rotation-slot tag, and a trailing `.wg-icon-btn` cluster (edit / delete)
- [x] full-width `.wg-gloss--sun` "Add workout group" CTA appended at the bottom (replaces `#add-workout-group-btn` FAB)
- [x] edit modal (`showEditWorkoutGroupModal`) restyled with Wandergeek shell — mono header, `.wg-gloss--inset` input wraps for name + rotation slot + exercise list, Cancel + Save buttons (`.wg-gloss` + `.wg-gloss--sun`, 2× flex on Save)
- [x] empty state: muted card with "No workout groups yet — tap Add to create one."
- [x] write `workout.groups.test.js` — group row render, edit/delete callbacks, add-group flow, empty state, modal open/save/cancel
- [x] run `pnpm test` — must pass before next task

### Task 6: Rewrite the exercises sub-tab

- [x] replace `#exercise-library-list` markup with a `.wg-workouts-exercises` container — each exercise a `.wg-card` row carrying mono name, muscle-group tag (`.wg-tag--mono`), and edit/delete icon cluster
- [x] full-width `.wg-gloss--sun` "Add exercise" CTA appended at the bottom (replaces `#add-exercise-library-btn` FAB)
- [x] edit modal (`showEditLibraryExerciseModal`) restyled with Wandergeek shell — mono header, `.wg-gloss--inset` input wraps for name + muscle group, Cancel + Save buttons
- [x] empty state: muted card with "No exercises in library yet — tap Add to create one."
- [x] write `workout.exercises.test.js` — exercise row render, edit/delete callbacks, add-exercise flow, empty state, modal open/save/cancel
- [x] run `pnpm test` — must pass before next task

### Task 7: Rewrite the stats sub-tab + build `WGWorkoutChart`

- [x] create `web/static/js/components/wg-workout-chart.js` exposing `WGWorkoutChart.render({ sessions, range, metric })` returning a DOM element
- [x] mirror `WGBpChart` / `WGWeightChart` structure — SVG canvas, axis + grid rendering, line plot (single-series for volume or duration trend)
- [x] colors + stroke widths come from `--wg-workouts-*` tokens via CSS classes — no inline `style=` / hardcoded hex
- [x] register `window.WGWorkoutChart` in `architecture.globals.test.js` with a one-line justification
- [x] replace `#workout-stats-display` markup with a `.wg-workouts-stats` container — `.wg-gloss--inset` range selector (7d / 30d / 90d / All) above the chart; range persists via `mt-workouts-stats-range` localStorage key; stat tiles below (total sessions / total volume / most-used exercise / longest streak) as `.wg-card` grid
- [x] write `components.wg-workout-chart.test.js` — range filter applied, empty-state card when no sessions, axis tick count sane
- [x] write `workout.stats.test.js` — stat-tile render, range-selector persistence, chart re-renders on range change
- [x] run `pnpm test` — must pass before next task

### Task 8: Rewrite the log-set modal + edit-exercise modal

- [x] replace the log-set modal markup in `index.html` with the Wandergeek shell — mono header ("Log set · Bench"), `.wg-icon-btn` close trailing the header
- [x] weight + reps inputs — `.wg-gloss--inset` wraps with mono labels
- [x] Cancel + Save buttons row at the bottom — Cancel `.wg-gloss` left, Save `.wg-gloss--sun` right with 2× flex per modal-button-order convention
- [x] edit-exercise modal (per-session exercise edit) restyled with the same shell
- [x] write `workout.modal.test.js` — open/save/cancel, input round-trip, `modal-controller.js` history integration preserved
- [x] run `pnpm test` — must pass before next task

### Task 9: Wire Workouts into the canonical bottom nav + cleanup

- [x] confirm `WGBottomNav.DEFAULT_ITEMS` still carries the `workouts` slot with the `dumbbell` (or equivalent) icon; add a Phase 7 contract test matching the BP/Food/Meds/Weight contract tests
- [x] grep-verify remaining paper-era workout classes — remove truly orphaned rules from `styles.css`, dual-class only where DOM-query tests require
- [x] run `pnpm test` — must pass before next task

### Task 10: Verify acceptance criteria for Phase 7

- [ ] open `index.html` in desktop 390×844 phone view, compare Workouts screen side-by-side with `Medtracker.html` — manual visual check
- [ ] open in mobile viewport (DevTools 375×812) — manual visual check
- [ ] full `pnpm test` suite green
- [ ] `go test ./...` green (sanity check; no backend changes expected)
- [ ] grep `style="` and `\.style\.` in the new JS — zero `style="` matches; any `.style.setProperty('--wg-*', …)` additions allowlisted in `architecture.inline-styles.test.js` (CSS custom property, not a hardcoded visual value)

### Task 11: [Final] Update plan and write Phase 8 plan stub

- [ ] mark this plan complete; ralphex moves it to `docs/plans/completed/`
- [ ] write `docs/plans/2026-04-XX-wandergeek-phase8-health.md` covering the Health screen rewrite (SpO2 + sleep + diary — vitals tiles, sleep history by week, notes/diary list)
- [ ] no code changes in this task

## Technical Details

**Feature-module extraction strategy**: `web/static/js/workout.js` is the last top-level JS file that isn't under `features/`. Phase 7 moves it to `web/static/js/features/workout.js` to match the bp.js / food.js / meds.js / today.js / weight.js / health.js pattern. The extraction happens in Task 1 before the reskin so the rewrite happens on already-modular code. Keep the helpers (`getWorkoutDurationText`, `getExerciseSetSummary`, `getMuscleGroupLabel`, `getRotationSlot`) wherever they currently sit — only the render + modal + action-dispatch flow moves.

**Today's-workout card vs. Meds next-action card parity**: both cards share the same visual shell (`.wg-gloss--sun` container, uppercase sun-colored subtitle, mono names list, sun action button). Phase 7 keeps them as separate render helpers that share CSS only — the today's-workout card has rotation-slot-specific variants (PUSH/PULL/LEGS/REST) and a completed-today state that don't apply to the meds card.

**Session-detail view: overlay vs. inline expand**: two reasonable shapes — (a) tap a history row to open a full-screen overlay via `modal-controller.js` (matches the Meds edit-modal pattern, preserves back-button history), or (b) expand the row inline with a chevron-toggle. Phase 7 defaults to (a) because the session-detail view carries its own action buttons (Log set / Finish / Delete) and the log-set modal needs to stack on top of the session-detail — nesting modals is cleaner than an inline expand + modal overlay combo. Reconsider in Task 4 if the history row count is low enough that inline expand is simpler.

**Range selector state**: Phase 3 settled on `mt-bp-range` for BP. Phase 4 used `mt-food-subtab`. Phase 5 used `mt-meds-subtab`. Phase 6 used `mt-weight-range`. Phase 7 adds `mt-workouts-subtab` (for the top sub-tab strip) and `mt-workouts-stats-range` (for the Stats-tab range selector) — consistent with the naming pattern.

**Modal history parity**: `modal-controller.js` already drives the open/close lifecycle for the log-set modal, edit-exercise modal, edit-workout-group modal, and edit-library-exercise modal via the back-button stack. Phase 7 only restyles the modal bodies; the controller, history entries, and Telegram WebApp BackButton wiring are unchanged.

**Offline parity**: every render helper must surface the existing offline-pending, rejected, and cached-stale states. `MedTrackerDB.WorkoutStore.getPending/getRejected` is unchanged; Phase 7 only changes how those badges look (`.wg-tag--mono` instead of the paper-era pills).

**Stats chart scope**: Phase 7 ships one `WGWorkoutChart` component covering the session-volume-over-time trend. Per-exercise progress charts (bench 1RM trend, etc.) are out of scope — if they land in the rewrite, add them as small `WGSparkline` renders inside the session-detail exercise cards rather than as full `WGWorkoutChart` instances.

## Follow-up Phases (out of scope; named only)

### Phase 8 — Health screen rewrite
SpO2 + sleep + diary — vitals tiles, sleep history by week, notes/diary list.

### Phase 9 — Settings screen rewrite
Form-heavy — tokens for every input state, gloss-inset inputs, sectioned cards. Largest CSS surface; do last so primitives are stable.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes.*

**Manual verification:**
- Real-device side-by-side on iPhone (PWA install) and Android Chrome
- Lighthouse / a11y audit on Workouts screen — mono display contrast vs. deep-teal stage, minimum-touch-target check on the view/edit/delete icon buttons, session-detail scroll behavior
- Reduced-motion preference: gloss `:active` transforms and chart animation respect `prefers-reduced-motion`
- Telegram WebApp BackButton verification inside the actual Telegram client — confirm session-detail + log-set + edit-group modal close paths all pop history cleanly in the correct order
- Rotation rollover verification — confirm "Today's workout" card updates correctly after midnight when the rotation advances
- Ad-hoc + rotated workout flows end-to-end on a real device (start → log sets → finish → appears in history)

**External system updates:**
- Update `pitch.html` screenshots once Phase 7 lands
- Announce in whatever release-notes channel applies
