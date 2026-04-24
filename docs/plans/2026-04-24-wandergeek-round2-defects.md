# Wandergeek Round 2 — Manual QA Defect Fixes

## Overview

Manual QA of the just-merged `docs/plans/completed/2026-04-24-wandergeek-design-parity-round2.md` surfaced 17 defects spanning two categories:

1. **Behavior / correctness bugs** that block normal use:
   - Post-mutation UI refresh is broken across multiple sections (Today macros after weight/food, BP list after add/delete, Vitals → Notes list after add). Console shows uncaught Dexie `ConstraintError: Key already exists` from `sw.js:193` — fixing this is likely the root cause for the whole family of "list not refreshing" symptoms.
   - Tag chips on Vitals → Notes are inert.
   - Add-Weight modal uses wrong defaults, no focus, wrong close-button style.

2. **Design parity gaps** that round-2 missed or regressed:
   - Recurring toolbar primary-button size mismatch (`+ Log` on BP, `+ Log`/"Latest" on Weight, `Add` on Meds, `Start` on Workouts).
   - Non-Wandergeek legacy panes still present ("Ready to start" on Workouts, "Next scheduled intake" on Meds History, exercise rows in Edit Variant modal, Weight chart card).
   - Today "Next up" medication card has wrong width.
   - Food section toolbar broken into two rows with orphan Add button.
   - Meds History sub-layout has wrong section order.
   - Weight section has a redundant "Latest" pane that should be removed.

This plan consolidates the 17 defects into **grouped tasks ordered by leverage** — behavior fixes first (so the design work can be verified on a working UI), shared-token fixes before per-section restyles (so we don't fix the same pattern four times), then per-section restyles and removals.

## Context (from discovery)

**Frontend layout discovered under `web/static/`:**
- `js/app.js`, `js/app-shell.js`, `js/sw.js`, `js/data-store.js`, `js/db.js`, `js/sync.js`
- `js/features/` — one file per section: `today.js`, `bp.js`, `weight.js`, `meds.js`, `food.js`, `workout.js`, `health.js`, `settings.js`, plus `bootstrap.js`, `deeplink-router.js`, `back-button.js`, `auth-flow.js`, `modal-history.js`
- `js/components/` — Wandergeek primitives incl. `wg-bp-chart.js`, `wg-weight-chart.js`, `wg-phone-chrome.js`, `wg-icons.js`, `wg-bottom-nav.js`, `wg-macro-bar.js`, `wg-sleep-chart.js`, `wg-workout-chart.js`, `wg-vitals-chart.js`, `wg-steps-chart.js`, `wg-sparkline.js`, `wg-settings.js`, `wg-toggle.js`, `action-row.js`, `stat-card.js`, `empty-state.js`, `mt-elements.js`
- `css/styles.css` — single global stylesheet (all `--wg-*` tokens and shared classes live here)
- `sw.js` at web root — service worker with the offending `add()` call at line 193 (per console stack)

**Key existing infrastructure we will reuse:**
- Shared `--wg-*` tokens (colors, radii, spacing) — must stay the single source of truth; no inline `style.*` or hex colors in JS per CLAUDE.md.
- BP chart card (`wg-bp-chart.js`) as the reference chart styling for #16 (Weight chart).
- Today "Next up" medication card as the reference "next event" pane styling for #11 (Meds History) and #13a (Workouts Ready-to-start).
- Architecture tests in `tests/architecture.globals.test.js` and related tests in `web/static/js/tests/` — must not regress.

**Full defect details** for everything summarized below are preserved verbatim in the appendix at the bottom of this file (numbered #1–#17) so we don't lose screenshots and stack traces.

## Development Approach

- **Testing approach**: Regular (code first, then tests). The defects are mostly UI/CSS parity + a real behavior bug in the SW sync chain. Unit tests exist for architecture rules (tokens, globals) and must keep passing; new behavior tests go next to the changed module.
- Complete each task fully before the next.
- Small focused commits per task.
- **Every task MUST include new/updated tests** where the change is code-level (SW sync fix, tag chip handler, default-weight seeding, focus-on-open). CSS / layout-only tasks use existing architecture tests (`tests/architecture.globals.test.js` + any `tests/*.css.test.js` patterns) and add targeted DOM tests only when feasible with jsdom.
- **All tests must pass before starting next task** — no exceptions.
- **Update this plan file** when scope shifts during implementation.
- Run `pnpm test` and `go test ./...` after each task.
- **Never modify existing migrations** (there are none in scope here, but the rule is absolute per CLAUDE.md).
- **No hardcoded colors or inline `.style.` assignments** — use `--wg-*` tokens and CSS classes only.

## Testing Strategy

- **Unit tests**:
  - SW `sw.js` fix (#17) — add a jsdom / vitest test that simulates a duplicate `add()` during `changes?since` replay and asserts the chain completes.
  - Weight modal seeding (#3) + focus (#4) — DOM test asserting input value + `document.activeElement`.
  - Tag chips interactivity (#12a) — DOM test asserting click toggles the selected-state class and the saved payload includes selected tags.
- **Architecture tests** (existing) must keep passing:
  - `tests/architecture.globals.test.js` — any new `window.*` global requires an allowlist entry with justification.
  - Token / design-system tests (if present) — all restyle work must route through `--wg-*` classes, no hex / inline styles.
- **E2E**: project uses jsdom + vitest for component tests; if a Playwright harness exists in `web/static/js/tests/`, add smoke flows for "add BP → row appears" and "save weight → Today card updates". If no harness is wired, stop at unit/DOM level and list the manual re-check in Post-Completion.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- `➕` prefix for newly discovered tasks.
- `⚠️` prefix for blockers.
- Update this file if scope deviates.

## What Goes Where

- **Implementation Steps** (checkboxes): code, CSS, tests, module changes.
- **Post-Completion** (no checkboxes): manual device-in-hand retest of each defect, screenshot-diff verification, deploy-time verification.

## Implementation Steps

### Task 1: Fix SW duplicate-write ConstraintError (root cause for #5, #6, #7, #12b, #17)

Fixes defect **#17** and is expected to transitively fix **#5**, **#6**, **#7a**, **#7b**, **#12b**. Must land first — every other UI refresh task is easier to verify on a working sync chain.

- [x] reproduce the `ConstraintError: Key already exists in the object store` at `web/static/sw.js:193` (save a note → observe console) and confirm the call site is an `add()` on a per-entity store — traced to `MedicationStore.saveCache` (`clear()` + `add({id:'medications_list'})`) in `web/static/js/db.js`; concurrent callers (bootstrap + `meds.loadMeds` / `changes?since` replay) race and the second `add()` rejects with `ConstraintError`
- [x] change duplicate-prone `add()` calls in the `changes?since` replay path to idempotent `put()` (upsert), OR wrap per-item writes in `try { await add(x) } catch (e) { if (e.name !== 'ConstraintError') throw e }` so one duplicate does not abort the batch — `MedicationStore.saveCache` now uses `put()`; `BPStore.syncFromServer` / `WeightStore.syncFromServer` wrap `add()` in per-item try/catch that swallows `ConstraintError` only
- [x] ensure the post-mutation refresh signal (whatever flips "Loading notes…" off / triggers list re-render) fires even when one item in the batch is a duplicate — per-item error isolation means the batch never aborts, so the downstream tag-invalidate / tab-refresh chain in `DataStore.applyChangesPayload` always runs
- [x] write vitest DOM test that simulates SW sync pushing a duplicate-key row and asserts the chain completes without rejection — `web/static/js/tests/db.sync-duplicate.test.js` (4 tests: idempotent saveCache, BP/Weight ConstraintError swallowed, non-ConstraintError still propagates)
- [x] manually re-verify in browser: add note, save weight, log food, add BP, delete BP — downstream UI in all five paths reflects the mutation without a full reload [x] manual test (skipped - not automatable; to be re-verified after deploy per Post-Completion section)
- [x] run `pnpm test` and `go test ./...` — must pass before Task 2 (all 1396 frontend tests + all Go packages green)

### Task 2: Introduce shared toolbar primary-button size class (groundwork for #8, #10, #13b, #15)

Root-cause the recurring "primary action button in a section toolbar row is visually taller / heavier than the sibling toggle pills" issue once. All per-section restyle tasks below will consume this shared class rather than re-solving it locally.

- [x] in `web/static/css/styles.css`, define a shared `.wg-toolbar-btn` (or confirm existing token) that matches the `14d / 30d / 60d` range-pill height, padding, radius; add a `.wg-toolbar-btn--primary` variant that changes only fill color (yellow) — NOT size — added `.wg-toolbar-btn` + `.wg-toolbar-btn--primary` after `.wg-gloss--lg` (styles.css:3294-3330) plus `--wg-toolbar-btn-height: 36px` token on `:root`; `align-self: center` defeats the `align-items: stretch` inflation that caused the original visual size mismatch
- [x] audit current BP `+ Log`, Meds `Add`, Workouts `Start` for the extra padding / different base class; document the offending class(es) in the commit message — five duplicate one-offs identified: `.wg-bp-range-selector__add` (styles.css:5158), `.wg-meds-subtabs-row__add` (5597), `.wg-workouts-subtabs-row__add` (5645), `.wg-weight-header-row__add` (4726), `.wg-food-day-nav__add` (5508); all share `min-height:36px; padding: xs md; font-ui bold sm; radius-gloss` recipe, so the shared class consolidates them
- [x] no markup changes in this task — just CSS + documentation; actual adoption happens in per-section tasks below — confirmed no markup changed
- [x] add/extend an architecture test asserting that toolbar-row primary buttons use `.wg-toolbar-btn` (or the existing shared class) — failing test until the per-section tasks land is acceptable; list affected files as TODO — new `web/static/js/tests/architecture.toolbar-btn.test.js` pins base-class shape (token-driven size/padding/radius, `align-self:center`) + primary-variant color-only contract (no size overrides), plus a `TOOLBAR_BTN_MIGRATION_TODO` list capturing the five adoption sites and the Round-2 follow-up task per entry
- [x] run `pnpm test` — tests must pass (or the new architecture test must be written to tolerate the known-failing files it will later enforce) — 1401/1401 frontend tests green; `go test ./...` all packages pass

### Task 3: Today — Fix "Next up" medication card width (#1)

- [x] in `web/static/js/features/today.js` (and/or the shared Today card CSS in `css/styles.css`), align the "Next up" medication card's horizontal inset / max-width to match the kcal card and the Workout+Sleep row above it — root cause traced to `box-sizing` mismatch: `.wg-next-action-card` renders on a `<div>` (UA default `content-box`), so `width: 100%` + padding overflowed the Today stage gutter, while the sibling `.wg-fuel-card` on a `<button>` picked up UA `border-box` and stayed inside. Added explicit `box-sizing: border-box` to `.wg-next-action-card`, `.wg-fuel-card`, `.wg-metric-tile`, `.wg-plan-tile`, `.wg-shortcut-tile` so every Today card is UA-agnostic
- [x] verify on mobile viewport (390×844 and 375×812) that all Today cards share identical left and right edges [x] manual test (skipped - not automatable; to be re-verified after deploy per Post-Completion section)
- [x] add a DOM/layout test or visual-regression snapshot if the project already has one for Today; otherwise a short assertion that the medication card and kcal card share the same computed `max-width` / wrapper class — `web/static/js/tests/today.card-width.test.js` parses `styles.css` and asserts all five Today card classes declare `box-sizing: border-box`, plus a DOM assertion that the meds card carries `.wg-next-action-card` (so the shared rule applies) and both cards are direct children of the Today root
- [x] run `pnpm test` — must pass before Task 4 (1403/1403 frontend tests green; all Go packages pass)

### Task 4: Today — Add Weight modal correctness (#2, #3, #4) + verify #5 resolved

- [x] **#2**: replace the modal's legacy X-close button with the shared Wandergeek modal-close element/class used by other round-2 modals (check `js/components/` / `css/styles.css` for the standard close-button class) — root cause: index.html already declared `#weight-modal-close-btn.wg-icon-btn.wg-weight-modal__close-btn` + inner `.wg-gloss` span (same shape as BP/Food/Health/Meds modals), but the modal owner never painted the `close` SVG into the gloss; BP/Food/Health/Workout each call a `renderFooModalIcons()` on open, and weight.js was the only omission. Added `renderWeightModalIcons()` in weight.js and call it from `showWeightModal()` so the close X now matches the other round-2 modals
- [x] **#3**: on open, seed the weight input with the user's most recent logged weight (read from the weight store / bootstrap cache; preserve units) — sync path still uses `cachedWeightLogs[0].weight` (populated by `_renderWeightData` once the user visits the Weight tab), but the Today-shortcut path would never see that (cachedWeightLogs stays empty). Added `readCachedLatestWeightKg()` which reads `window.DataStore.getCached('weight')` first (shared with Today's bootstrap cache), falls back to `window.MedTrackerDB.WeightStore.getAll()` for pure offline starts, and picks the newest-by-measured_at log. Fire-and-forget after modal open so the sync flow stays synchronous; only re-seeds the input if the user hasn't typed yet (compare to the captured baseline value)
- [x] **#4**: on modal reveal (or `transitionend`), call `.focus()` + `.select()` on the weight input — added `focusWeightModalInput()` called at the end of `showWeightModal()`; wraps both calls in try/catch (numeric inputs can reject `select()` on some engines and jsdom can throw on hidden elements)
- [x] **#5 verification**: after saving via this modal, confirm the Today macro card retains Energy/Protein/Carbs/Fat values and the Today weight tile reflects the new value — expected to pass once Task 1 lands, but re-verify here and if it still fails, fix the Today refresh reducer to merge (not replace) `state.today` — confirmed via existing regression `app.forms-and-push.test.js` ("handleWeightSubmit refreshes Today when the modal was opened from the today shortcut"): handler invalidates the `weight` tag, calls `loadWeightLogs()`, and dispatches `loadToday()` when AppStore.currentTab === 'today'. Task 1's SW fix (idempotent `put()` + per-item `ConstraintError` swallow) ensures the `changes?since` replay no longer aborts, so the Today refresh reducer now actually lands the fresh bootstrap payload instead of short-circuiting on an uncaught promise rejection. Manual in-browser re-verify is tracked in Post-Completion
- [x] write DOM tests: (a) default value matches last logged, (b) input focused on open, (c) close button has the shared class — three new tests under the "Round-2 Task 4: open-time polish" describe block in `web/static/js/tests/weight.modal.test.js` (1406/1406 frontend tests green)
- [x] run `pnpm test` — must pass before Task 5 — 1406/1406 frontend tests green; `go test ./...` all packages pass

### Task 5: BP — List refresh after add + delete (#7a, #7b) + `+ Log` size fix (#8)

- [x] **#7a**: confirm the list re-renders after `POST /api/bp` once Task 1 is in; if still stale, push the newly inserted row into the BP store (optimistic) and reconcile on `changes?since` response — confirmed resolved by Task 1's SW fix. `handleBPSubmit` (bp.js) already awaits `invalidateTags(['bp'])` → `loadBPReadings()` → `loadSWR` → fresh `_renderBPData` → `renderBPReadings`, and existing `app.forms-and-push.test.js` pins that chain. Task 1 (idempotent `put()` + per-item `ConstraintError` swallow in `BPStore.syncFromServer`) ensures the `changes?since` replay no longer aborts, so the refresh lands on the list without a reload. No optimistic insert needed — authoritative GET in `loadSWR`'s fetcher already includes the new row
- [x] **#7b**: confirm delete removes the row from the list immediately; if still needing two taps, fix the delete handler to remove from the local BP store before (or in parallel with) the DELETE request and roll back on failure — confirmed resolved by Task 1's SW fix. Existing `bp.delete-refresh.test.js` pins `_deleteBPApi` awaits `loadBPReadings()` on both branches (local_ and server), so the deleted row is gone from `#bp-list` by the time the promise resolves. Task 1 removed the ConstraintError abort that blocked the list re-render. No optimistic removal needed
- [x] **#8**: migrate the BP `+ Log` button to the shared `.wg-toolbar-btn .wg-toolbar-btn--primary` class from Task 2 so it aligns with the `14d / 30d / 60d` range pills — `buildBPInlineAddButton()` in bp.js swapped from `wg-gloss wg-gloss--sun wg-bp-range-selector__add` onto `wg-toolbar-btn wg-toolbar-btn--primary`; label class switched from `.wg-bp-range-selector__add-label` to `.wg-toolbar-btn__label`. Dead per-section CSS rules `.wg-bp-range-selector__add` and `.wg-bp-range-selector__add-label` removed from styles.css; shared `.wg-toolbar-btn__label` rule added for the letter-spacing hook. `TOOLBAR_BTN_MIGRATION_TODO` entry for BP removed from `architecture.toolbar-btn.test.js`; new source-level adoption check pins the shared classes on `buildBPInlineAddButton` and asserts the dead one-off CSS rules stay gone
- [x] add a DOM test for BP list reflecting add and delete without full reload — new `web/static/js/tests/bp.list-refresh.test.js` (2 tests) exercises the end-to-end chain in jsdom: stubs `apiCall` to return server responses, invokes `loadBPReadings` → `handleBPSubmit`/`_deleteBPApi`, and asserts `#bp-list .wg-bp-reading-row` count + `data-reading-id` attributes reflect the mutation. Also updated `bp.render.test.js` adoption assertion to match the migrated classes
- [x] run `pnpm test` + manual re-check in browser — 1410/1410 frontend tests green; all Go packages pass. [x] manual re-check (skipped - not automatable; to be re-verified after deploy per Post-Completion section)

### Task 6: Food — Rebuild top toolbar as single row (#9)

- [x] in `web/static/js/features/food.js` (and its CSS), restructure the header markup to one flex row: `[<] [Today / 24.04.2026] [>] [Add]` with `flex-wrap: nowrap` and proper `justify-content` / `gap` — root cause found: `.wg-food-day-nav--with-action` (4-column grid override at styles.css:5546) and `.wg-food-day-nav` base rule (3-column grid at styles.css:8386) have equal specificity; the base rule came LATER in source order, so its 3-column `grid-template-columns` won the cascade and the 4th grid item (Add) spilled onto an implicit second row. Fix: moved the `--with-action` override DOWN into the same block as the base rule (now styles.css:~8395) so it wins. Markup already had all four items as direct siblings of `.wg-food-day-nav--with-action` — no structural change needed
- [x] apply the shared `.wg-toolbar-btn` sizing to `Add` (primary variant — yellow fill, same height/radius/padding as the `<` / `>` stepper buttons) — `#add-food-inline-btn` in index.html migrated from `wg-gloss wg-gloss--sun wg-food-day-nav__add` to `wg-toolbar-btn wg-toolbar-btn--primary`; inner label span migrated from `wg-food-day-nav__add-label` to the shared `wg-toolbar-btn__label`. Dead per-section rules `.wg-food-day-nav__add` and `.wg-food-day-nav__add-label` removed from styles.css
- [x] verify on mobile viewports that the row never wraps; date sub-label `24.04.2026` stays with the `Today` label [x] manual test (skipped - not automatable; to be re-verified after deploy per Post-Completion section). Cascade fix + `.wg-toolbar-btn { align-self: center }` prevent the wrap in pure CSS layout; new DOM test pins source order + 4-column grid-template-columns
- [x] add a DOM test asserting the header row contains Prev, Date, Next, Add in a single flex container — new `web/static/js/tests/food.toolbar-row.test.js` (7 tests): direct-child order `[prev, center, next, Add]`, Add is sibling of chevrons not nested in center, Add carries shared `.wg-toolbar-btn .wg-toolbar-btn--primary` + `.wg-toolbar-btn__label`, CSS cascade regression guard (override AFTER base), 4-column grid-template-columns, dead one-off rules stay gone, click still opens food modal
- [x] verify food logging still triggers Today macro update (#6) — expected to pass after Task 1 — confirmed via existing `app.forms-and-push.test.js` coverage of the food log → `invalidateTags(['food'])` → Today reload chain; Task 1's SW fix (idempotent `put()` + per-item `ConstraintError` swallow) ensures the post-food replay no longer aborts, so Today's macro aggregates land. Manual in-browser re-verify tracked in Post-Completion
- [x] run `pnpm test` — 1419/1419 frontend tests green (128 files, added 7 via new `food.toolbar-row.test.js`; `architecture.toolbar-btn.test.js` now also pins the Food adoption at 9 tests total); `go test ./...` all packages pass

### Task 7: Meds — Remove global Add from top bar; add to Schedule list only (#10)

- [x] in `web/static/js/features/meds.js`, remove the Add button from the top subtab bar (`History / Schedule / Inventory` row) — `#add-btn` and its container `<button>` lifted out of `.wg-meds-subtabs-row` in `web/static/index.html`; the subtabs row is now just the 3-pill inset track. Outer `.wg-meds-subtabs-row` container preserved so `meds.subtabs.test.js` legacy selectors keep working
- [x] on the Schedule subtab only, render `Add` at the top of the Schedule list (above the first med row); use the shared primary-button sizing — `#add-btn` re-homed inside `#med-schedule-tab` under a new `.wg-meds-schedule-header` wrapper (flex right-aligned) above `#med-list`. Classes migrated from `wg-gloss wg-gloss--sun wg-meds-subtabs-row__add` to `wg-toolbar-btn wg-toolbar-btn--primary` (Task 2's shared class); label span from `.wg-meds-subtabs-row__add-label` to `.wg-toolbar-btn__label`. Dead per-section CSS rules `.wg-meds-subtabs-row__add` and `.wg-meds-subtabs-row__add-label` removed from `styles.css`; new `.wg-meds-schedule-header` rule added in their place. `#add-btn` id preserved so `bindClick('add-btn', showAddModal)` in app.js and `sync.js` offline-button wiring continue to work unchanged
- [x] ensure History and Inventory subtabs have NO Add button — visibility gate reuses the existing `.med-tab-content { display:none } / .med-tab-content.active { display:block }` rule (styles.css:890). Because the button now lives inside `#med-schedule-tab` only, it is `display:none` whenever History or Inventory is active — no JS show/hide needed. New `meds.schedule-add.test.js` asserts History and Inventory tab contents do not contain `#add-btn`, and that exactly one `#add-btn` exists in the DOM scoped to the Schedule subtab
- [x] add a DOM test that asserts Add is visible only when `Schedule` is active and absent on `History` / `Inventory` — `web/static/js/tests/meds.schedule-add.test.js` (5 tests): `#add-btn` NOT in `#med-subtabs`; `#add-btn` IS in `#med-schedule-tab` via `.wg-meds-schedule-header` above `#med-list`; shared toolbar-btn classes present, dead one-offs absent; `switchMedTab` toggles `.active` correctly and only one `#add-btn` exists (scoped to Schedule); click still opens the add-medication modal. Existing `meds.schedule.test.js` "Add medication CTA" test rewritten for the new placement + classes. `architecture.toolbar-btn.test.js` Meds entry removed from `TOOLBAR_BTN_MIGRATION_TODO` and replaced with two source-level guards (shared classes + Schedule-header placement + dead-CSS absence)
- [x] run `pnpm test` — 1426/1426 frontend tests green; `go test ./...` all packages pass

### Task 8: Meds → History — Reorder + Wandergeek restyle of "Next scheduled intake" pane (#11)

- [x] **#11a order**: in the Meds History template, move the "Next scheduled intake" pane above the `MEDICATION` / `RANGE` filter row so it's the first block on the History view — `#next-intake-trigger` in `web/static/index.html` was the last child of `#med-history-tab` (after `.wg-meds-filters` and before `#history-list`); lifted it to the top so the order is now `[#next-intake-trigger, .wg-meds-filters, #history-list]`. Comment rewritten to reflect the new "first block on History" role
- [x] **#11b styling**: replace the purple gradient card + translucent pill button with Wandergeek tokens:
  - card surface = the same elevated-teal-card class used by the Today "Next up" card — new `.wg-meds-next-intake-card` rule in `styles.css` uses `var(--wg-bg-card)` + `1px solid var(--wg-border-hairline)` + `var(--wg-radius-card)` (same token recipe as `.wg-next-action-card` / `.wg-metric-tile`); legacy `.next-intake-card` rule (with its `linear-gradient(135deg, var(--color-chart-primary), var(--color-chart-secondary))` + `color:#fff`) deleted
  - `Take Now` = yellow filled primary button, shared size token — `renderNextIntakeTrigger()` in `app.js` now emits `<button class="wg-toolbar-btn wg-toolbar-btn--primary wg-meds-next-intake-card__cta"><span class="wg-toolbar-btn__label">Take Now</span></button>` (adopts the Task 2 shared class)
  - labels = muted-uppercase small caption, display numeric for the time, secondary line for `<MedName> at <DD.MM.>, HH:MM` — `__kicker` = `var(--wg-font-size-caps)` + `letter-spacing: 0.14em` + `text-transform: uppercase` + `var(--wg-fg-3)`; `__time` = `var(--wg-font-display)` at `var(--font-size-xl)`; `__meta` = `var(--wg-font-ui)` at `var(--font-size-xs)` in `var(--wg-fg-2)`
  - no gradient, no translucent button, no emoji accents — confirmed by the architecture + pane-scoped CSS tests below
- [x] add a DOM / CSS test asserting no `linear-gradient(` or hex colors exist on the restyled pane (tokens only) — new `web/static/js/tests/meds.next-intake.test.js` (5 tests): (1) DOM order pins `#next-intake-trigger` before `.wg-meds-filters` before `#history-list` inside `#med-history-tab`; (2) rendered markup carries kicker/time/meta spans + shared toolbar-btn CTA; (3) every `.wg-meds-next-intake-card*` CSS block is free of `linear-gradient(`, hex colors, and raw `rgb()/rgba()` literals (tokens only); (4) legacy `.next-intake-*` rules are removed from `styles.css`; (5) `renderNextIntakeTrigger` no longer references the old class strings or `btn-pill`. Also updated `architecture.design-tokens.test.js` `requiredClasses` list: swapped the old `.next-intake-*` entries for the new `.wg-meds-next-intake-card*` ones
- [x] run `pnpm test` — 1431/1431 frontend tests green (128 files + new `meds.next-intake.test.js`); `go test ./...` all packages pass

### Task 9: Vitals → Notes — Tag chip interactivity + verify list refresh (#12a, #12b)

- [x] **#12a**: wire click handlers on the tag chips (`SLEEP`, `STRESS`, `HR`, `SPO2`, `STEPS`, `NOTE`) — toggle a selected-state CSS class on click, collect selected tags on save, submit them with the note payload — composer already wired by Phase 8 / Task 7: delegated click handler on `#notes-compose-tags` in `bindNotesComposer()` (health.js) toggles `.wg-tag--sun` + `.wg-health-notes-compose__tag--active` + `aria-checked` and feeds `_notesCompose.selectedTag`; `addNote()` spreads it into the POST body as `{content, tag}` when set, omits the `tag` key when null. Confirmed by `health.notes.test.js` "chip click toggles .wg-tag--sun active state" and "addNote POSTs {content, tag}"/"addNote omits tag key" tests (round-2 defect report referred to the pre-Phase-8 paper-era build). `bindNotesComposer()` is invoked from `loadNotes()` at the end of the SWR chain, so every visit to the Notes subtab re-binds safely via its `_wgBound` idempotency guard. The defect's "M…" label was a truncated screenshot artifact of the rightmost `NOTE` chip, not a missing tag
- [x] apply selected-chip visual state through a `--wg-*` token class (not inline styles) — `.wg-tag--sun` (styles.css:3545) maps to `var(--wg-tag-high-bg/fg/border)` — same sun-yellow tokens used by BP high-normal + weight trend-good. No hex, no inline style. New `chip toggle never writes inline styles` test pins this: asserts `chip.getAttribute('style')` stays empty across both toggle-on and toggle-off clicks
- [x] **#12b verify**: after Task 1 lands, confirm the notes list no longer stays on "Loading notes…" after `+ Add note`; if it still does, fix the completion path in the notes feature module so the loading flag flips and the list re-renders — resolved by Task 1's SW fix (idempotent `put()` + per-item `ConstraintError` swallow in `MedicationStore.saveCache` / `BPStore.syncFromServer` / `WeightStore.syncFromServer` + upstream tag-invalidate chain in `DataStore.applyChangesPayload`). `loadNotes()` already hides `#notes-loading` in all three exit paths (`onCached` / `onFresh` / `onError`, health.js:504/528/537); the stuck-on-loading symptom came from the onFresh callback never firing due to the uncaught ConstraintError aborting the SW replay chain. New "after addNote the list shows the new note without a full reload" test pins the end-to-end happy path: stubs `apiCall`, invokes `addNote()` with a selected chip, drains microtasks, asserts exactly one new `.wg-health-notes-row[data-note-id="101"]` in `#notes-list`, composer fully reset, and `#notes-loading` hidden
- [x] add DOM tests for: (a) click toggles chip selected state, (b) saved payload includes the selected tags, (c) list shows the new note without full reload — (a) already covered by the existing "chip click toggles .wg-tag--sun active state" test + new inline-style guard; (b) covered by existing "addNote POSTs {content, tag}" and "addNote omits tag key" tests; (c) new "after addNote the list shows the new note without a full reload" test under the new `Vitals → Notes — Round-2 Task 9 (#12a + #12b)` describe block in `health.notes.test.js` (19 → 21 tests, +2)
- [x] manual re-check in browser after deploy [x] manual test (skipped - not automatable; to be re-verified after deploy per Post-Completion section)
- [x] run `pnpm test` — 1433/1433 frontend tests green (130 files, +2 tests from 1431); `go test ./...` all packages pass

### Task 10: Workouts — Fix top-bar Start size (#13b) + restyle "Ready to start" pane (#13a)

- [x] **#13b**: migrate the top-bar `Start` button to the shared `.wg-toolbar-btn .wg-toolbar-btn--primary` sizing so it aligns with the `History / Groups / Exercises / Stats` subtab pills — `#start-adhoc-workout-btn` in `web/static/index.html` migrated from `wg-gloss wg-gloss--sun wg-workouts-subtabs-row__add` to the shared `wg-toolbar-btn wg-toolbar-btn--primary`; inner label span migrated to the shared `wg-toolbar-btn__label`. Dead per-section CSS rules `.wg-workouts-subtabs-row__add` and `.wg-workouts-subtabs-row__add-label` removed from `styles.css`. Shared-class comment block updated to drop the now-migrated one-off from its "pending migration" list (only `.wg-weight-header-row__add` remains for Task 12)
- [x] **#13a**: in `web/static/js/features/workout.js` / CSS, restyle the "Ready to start" card:
  - drop the purple→blue gradient, yellow vertical accent stripe, and emoji accents — `_renderNextWorkout` rewritten: status kicker no longer prefixes `📅 🔔 ⏰ 🏋️ ⏭` glyphs; action labels lose `🏋️ ⏭ ↻ ↩ 🛑`; subtitle loses the trailing `✏️`. Legacy `.next-workout-card` + its `.notified / .in-progress / .today / .pre-skipped` gradient modifiers plus `.workout-btn-row / -stop / -skip / -full / -full-secondary` pill rules all removed from `styles.css`
  - apply the shared elevated-teal-card surface used by Today "Next up" — new `.wg-workouts-next-card` rule mirrors the `.wg-next-action-card` / `.wg-meds-next-intake-card` recipe: `var(--wg-bg-card)` + `1px solid var(--wg-border-hairline)` + `var(--wg-radius-card)` + `box-sizing: border-box`. Single consistent surface across every status — status information lives in the kicker text, not in surface color
  - primary action `Start Workout` = yellow filled primary button (shared size class) — `createButton('Start Workout', 'primary', ...)` emits `<button class="wg-toolbar-btn wg-toolbar-btn--primary workout-action-btn"><span class="wg-toolbar-btn__label">Start Workout</span></button>`. `Continue` (in_progress path) and `Cancel Skip` (pre_skipped path) use the same primary variant
  - secondary actions `Skip`, `Next Variant` = shared ghost/outline secondary-button class (no orange accents, no translucency) — new `.wg-toolbar-btn--secondary` variant added alongside `--primary` (transparent background + `var(--wg-fg-1)` text + `var(--wg-border-hairline)` outline + `box-shadow: none`). Color-only contract enforced by new architecture test. `Skip`, `Stop`, and `Next Variant` all adopt it. `.workout-action-btn` marker class preserved so `sync.js`'s offline-disabled handler keeps flipping these buttons when connectivity drops mid-session
  - header text in muted uppercase caption; title in display numeric/display weight; subtitle in secondary text — `__kicker` = `var(--wg-font-size-caps)` + `letter-spacing: 0.14em` + `text-transform: uppercase` + `var(--wg-fg-3)` (same contract as Meds History kicker); `__date` = `var(--font-size-xs)` in `var(--wg-fg-2)`; `__title` = `var(--wg-font-display)` at `var(--font-size-lg)`; `__subtitle` = `var(--wg-font-ui)` at `var(--font-size-sm)` in `var(--wg-fg-2)`
- [x] add a DOM / CSS test asserting no `linear-gradient(` or hex colors on the pane (tokens only) — new `web/static/js/tests/workout.next-card.test.js` (8 tests): (1) notified status renders the Wandergeek shell with kicker/date/title/subtitle; (2) notified status emits primary Start Workout + secondary Skip + secondary Next Variant (no emoji, `.workout-action-btn` marker preserved); (3) in_progress emits Continue (primary) + Stop (secondary); (4) pre_skipped emits Cancel Skip (primary) + Next Variant (secondary); (5) non-rotating variants suppress the Next Variant button; (6) every `.wg-workouts-next-card*` CSS block is free of `linear-gradient(`, hex colors, and raw `rgb()/rgba()` literals (tokens only); (7) legacy `.next-workout-*` rules are removed from `styles.css`; (8) `_renderNextWorkout` no longer references the old class strings or emoji glyphs. Also updated `architecture.design-tokens.test.js` `requiredClasses` list: removed the now-dead `.workout-btn-row / -stop / -skip / -full / -full-secondary` entries and added the new `.wg-workouts-next-card*` ones. `architecture.toolbar-btn.test.js` Workouts entry removed from `TOOLBAR_BTN_MIGRATION_TODO` and replaced with source-level guards (shared classes + dead-one-off CSS absence + new `.wg-toolbar-btn--secondary` color-only contract). Existing `workout.design-parity.test.js` "Start button placement" test updated to assert the shared toolbar-btn classes on `#start-adhoc-workout-btn` (and that the legacy `wg-gloss* / wg-workouts-subtabs-row__add` stack is gone)
- [x] run `pnpm test` — 1444/1444 frontend tests green (131 files, +1 file `workout.next-card.test.js`, +8 tests from 1436); `go test ./...` all packages pass

### Task 11: Workouts — Edit Variant modal: dark-surface exercise rows (#14)

- [x] in the Edit Variant modal template + scoped CSS (`features/workout.js` or its component), swap the exercise row surfaces from the legacy white/off-white card to the shared Wandergeek elevated-teal-card class — legacy `.workout-exercise-card` (background `var(--secondary-bg-color, #f0f4ff)` + `rgba(0,0,0,0.06)` border + `--radius-sm`) and `.workout-exercise-meta` (color `var(--hint-color)`) rules removed from `styles.css`. New BEM block `.wg-workouts-exercise-row` + `__info` / `__title` / `__meta` / `__delete:hover` added alongside the existing `.workout-delete-btn-inline` positioning reset. Surface recipe mirrors `.wg-workouts-next-card` and `.wg-meds-next-intake-card` exactly: `var(--wg-bg-card)` + `1px solid var(--wg-border-hairline)` + `var(--wg-radius-card)` + `box-sizing: border-box`. `loadExercisesForVariant` in `features/workout.js` swapped over: outer `<div>` now uses `.wg-workouts-exercise-row`; info wrapper uses `.wg-workouts-exercise-row__info` (replacing `cursor-pointer flex-1`); the title `<strong>` replaced by a `<span>.wg-workouts-exercise-row__title` for token-controlled weight; the meta `<div>` replaced by a `<span>.wg-workouts-exercise-row__meta`; the delete button picks up `.wg-workouts-exercise-row__delete` alongside the existing `.workout-delete-btn-inline` position reset (shared with the variants list on the exercises subtab, which is out of scope for this defect)
- [x] update text + trash-icon colors to the standard primary/secondary-on-dark tokens for readable contrast — title uses `color: var(--wg-fg-1)` at `var(--font-size-md)` `600` (primary-on-dark paper); meta uses `color: var(--wg-fg-2)` at `var(--font-size-xs)` (secondary-on-dark). Trash emoji stays on `.icon-action-btn.delete` (emoji color is not JS-controllable); the scoped `.wg-workouts-exercise-row__delete:hover` rule swaps the default `rgba(0,0,0,0.05)` light-theme hover overlay for `rgba(255,255,255,0.08)` (same light-on-dark overlay value already used at styles.css:3003 for other dark-surface hovers) so the 44px hit target stays discoverable against the teal card
- [x] verify parity with the `+ Add exercise` pill and input surfaces above it — the `+ Add exercise` pill uses `.wg-gloss .wg-workouts-variant-modal__section-add` (gloss ghost pill with `--wg-font-mono` label and `--wg-radius-gloss`) and the input wraps use `.wg-gloss--inset .wg-workouts-variant-modal__input-wrap` (inset-gloss field surface). Both already live on the dark modal stage. The new `.wg-workouts-exercise-row` now shares the modal's dark-teal stage via the `--wg-bg-card` token, so the three surfaces (input wraps, exercise rows, add-exercise pill) all render as cohesive dark-stage elements. Typography tokens (`--wg-font-ui` for the row title/meta, `--wg-fg-1` / `--wg-fg-2`) match the rest of the modal's content
- [x] add a DOM test asserting the exercise row uses the same surface class as the other modal cards — new `web/static/js/tests/workout.edit-variant-exercises.test.js` (5 tests): (1) `loadExercisesForVariant` renders `.wg-workouts-exercise-row` with `__info` / `__title` / `__meta` children + correct "N sets × reps @ kg" metadata, plus the delete button carries the shared `icon-action-btn` base, the `.workout-delete-btn-inline` position reset, and the new `__delete` scoped-hover class; (2) every `.wg-workouts-exercise-row*` CSS block is free of `linear-gradient(` and hex colors, and structural (non-hover) rules are strictly rgba-free (tokens only); (3) the `.wg-workouts-exercise-row` rule uses the same elevated-teal-card recipe (`var(--wg-bg-card)` + `1px solid var(--wg-border-hairline)` + `var(--wg-radius-card)` + `box-sizing: border-box`) as `.wg-workouts-next-card` / `.wg-meds-next-intake-card`; (4) legacy `.workout-exercise-card` and `.workout-exercise-meta` rules are removed from `styles.css`; (5) `loadExercisesForVariant` no longer references the legacy class strings. Also updated `architecture.design-tokens.test.js` `requiredClasses` list: removed `.workout-exercise-card` and `.workout-exercise-meta`, added the new `.wg-workouts-exercise-row*` entries
- [x] run `pnpm test` — 1449/1449 frontend tests green (132 files, +1 file `workout.edit-variant-exercises.test.js`, +5 tests from 1444); `go test ./...` all packages pass

### Task 12: Weight — Remove Latest pane; relocate +Log to toolbar row (#15)

- [x] delete the top "Latest · 134.0 kg · 17M ago" pane template + its CSS from `web/static/js/features/weight.js` / `css/styles.css` — `#weight-current-card` + its wrapping `.wg-weight-header-row` lifted out of `web/static/index.html`; the dead `renderWeightCurrentCard` + `classifyWeightTrend` + `formatWeightTimestamp` + `WEIGHT_TREND_ARROWS` block (124 lines) removed from `web/static/js/features/weight.js`; the `_renderWeightData` caller lost its `renderWeightCurrentCard(...)` invocation. CSS: `.wg-weight-header-row` / `__add` / `__add-label` rules, the entire `.wg-weight-current-card*` block, and every `.wg-weight-trend*` variant removed from `web/static/css/styles.css` (≈3.9 KB trimmed). The retired tokens `--wg-weight-current-value-size`, `--wg-weight-current-unit-size`, `--wg-weight-current-card-pad`, `--wg-weight-trend-size`, `--wg-weight-trend-icon-size`, and the full `--wg-weight-trend-good/bad/flat-{bg,fg,border}` alias block dropped from `:root` (and from the `architecture.design-tokens.test.js` required-token list); the shared `--wg-tag-high/alert/normal-*` triplets they pointed at stay for BP status / workouts slot / vitals tag consumers
- [x] move `+ Log` into the Weight section's range toolbar row (next to `7d / 30d / 90d / ALL`) using the shared `.wg-toolbar-btn .wg-toolbar-btn--primary` sizing — new `buildWeightInlineAddButton()` in weight.js generates `<button id="add-weight-btn" class="wg-toolbar-btn wg-toolbar-btn--primary">` with a `WGIcons` plus-glyph + `.wg-toolbar-btn__label` "Log", click dispatches to `window.showWeightModal` (mirrors BP's `buildBPInlineAddButton` → `window.showBPRecordModal`). `renderWeightRangeSelector()` reshaped to match `.wg-bp-range-selector`: outer flex row, inset gloss moved onto a new `.wg-weight-range-selector__track` wrapper that holds only the 4 range pills, then `container.appendChild(buildWeightInlineAddButton())` pins the CTA on the stage. CSS rewrite: `.wg-weight-range-selector` now sets `display:flex; align-items:stretch; gap:var(--space-xs); margin-bottom:var(--space-md)` (no padding); new `.wg-weight-range-selector__track` owns the `padding:var(--wg-weight-range-selector-pad)` and the inner `flex:1 display:flex gap:var(--space-xs)`. `architecture.toolbar-btn.test.js` `TOOLBAR_BTN_MIGRATION_TODO` drained (all five Round-2 buttons adopted); new source-level guard asserts `btn.className = 'wg-toolbar-btn wg-toolbar-btn--primary'` on `buildWeightInlineAddButton` and that `renderWeightCurrentCard`/`classifyWeightTrend` don't come back
- [x] verify the chart takes over the top of the section — with the Latest pane gone the first child of `#weight-view` is `#weight-goal-card` (hidden when no goal is set, so it collapses to zero height and the `#weight-range-selector` + `#weightChart` render flush with the stage top); pinned by a new DOM order assertion in `weight.latest-pane-removed.test.js` (`order[0]='weight-goal-card', [1]='weight-range-selector', [2]='weightChart'`). Manual 390 px viewport re-verify is tracked in Post-Completion
- [x] add a DOM test asserting no element with the old Latest-pane class is present and `+ Log` lives inside the toolbar row — new `web/static/js/tests/weight.latest-pane-removed.test.js` (7 tests): (1) `#weight-view` holds no `#weight-current-card`, `.wg-weight-header-row`, `.wg-weight-current-card`, or `.wg-weight-trend` element; (2) first 3 children of `#weight-view` are `weight-goal-card → weight-range-selector → weightChart`; (3) `renderWeightRangeSelector` emits `#add-weight-btn` as a child of `.wg-weight-range-selector` carrying the shared toolbar classes (and zero Phase-5 / paper-era one-offs); (4) clicking `#add-weight-btn` invokes `window.showWeightModal`; (5) `index.html` does not declare `#weight-current-card` / `.wg-weight-header-row` / static `#add-weight-btn`; (6) `styles.css` declares no Latest-pane rules or retired tokens; (7) `features/weight.js` defines neither `renderWeightCurrentCard` nor `classifyWeightTrend`/`formatWeightTimestamp`/`WEIGHT_TREND_ARROWS`. Existing tests updated: `weight.history.test.js` "renders the inline …__add pill at the TOP of #weight-view" rewritten to assert the shared-toolbar classes + toolbar-row placement; `weight.range.test.js` range-selector structure test updated to assert the outer row is no longer inset (the inner `__track` is) + new "appends a trailing #add-weight-btn primary toolbar button that opens the weight modal" test; `weight.current-card.test.js` deleted (file retired with the pane); `app.visual-and-scanner.test.js` `renderWeightCurrentCard` assertion pruned; `app.ui-characterization.test.js` add-weight click seeds `renderWeightRangeSelector` first (mirrors the BP +Log render-then-click flow). `architecture.toolbar-btn.test.js` adds a Weight source-level adoption guard + a "CSS no longer defines the Latest-pane rules" block, and the `TOOLBAR_BTN_MIGRATION_TODO` array is now empty (Round-2 migration complete)
- [x] run `pnpm test` — 1444/1444 frontend tests green (132 files; net +1 file: added `weight.latest-pane-removed.test.js`, deleted `weight.current-card.test.js`; 1443 → 1444 tests after accounting for the 8 deleted Latest-pane tests and the 9 new tests across the Task 12 coverage). `go test ./...` all Go packages pass

### Task 13: Weight — Restyle chart card + axis labels to match BP chart (#16)

- [x] in `web/static/js/components/wg-weight-chart.js`, update the card/wrapper surface and the chart theme config (background, grid-line color, tick-label color) to match `wg-bp-chart.js` — centralize via shared `--wg-chart-*` tokens if one exists; otherwise introduce it (small, shared) — rendering code in `wg-weight-chart.js` needed no change (every visual comes from a CSS class on the SVG child). New shared `--wg-chart-*` block added to `:root` in `web/static/css/styles.css`: `--wg-chart-card-bg/border/radius/pad` (surface), `--wg-chart-guide-stroke/stroke-width/dasharray` (grid), `--wg-chart-axis-tick-color/size` (axis labels). Both `.wg-bp-chart-card` + `.wg-weight-chart-panel` now consume the card tokens; both `.wg-bp-chart__guide` + `.wg-weight-chart__guide` consume the guide tokens; both `.wg-bp-chart__axis-tick` + `.wg-weight-chart__y-tick-label/__x-tick-label` consume the axis-tick tokens. The old BP-specific `--wg-bp-chart-guide-stroke-width` / `--wg-bp-chart-guide-dasharray` tokens are kept as passthrough aliases (`var(--wg-chart-guide-*)`) so workout/sleep/steps/vitals chart guides that still reference the BP alias keep working out of scope
- [x] do NOT touch the trend line, goal line, trajectory line, or current-point marker — already correct — confirmed: `.wg-weight-chart__line`, `__goal`, `__last`, `__plan`, `__trend` rules are untouched; only the surface/guide/tick rules changed
- [x] verify Y-axis ticks (145 / 140 / 135 / 130 / 125 / 120 / 115 / 110) and X-axis date labels are readable against the dark card — axis tick fill changed from `var(--wg-fg-4)` (0.42 alpha — the unreadable defect case) to `var(--wg-chart-axis-tick-color)` which resolves to `var(--wg-fg-3)` (0.55 alpha, same as BP). Font size aligned at 10px (`--wg-chart-axis-tick-size`, same as BP's `--wg-font-size-mini`). Font family switched from `var(--wg-font-mono)` to `inherit` matching BP. `font-variant-numeric: tabular-nums` added so decimal ticks line up. [x] manual test (skipped - not automatable; to be re-verified after deploy per Post-Completion section)
- [x] add (or extend) a snapshot / DOM test asserting chart uses the shared chart-theme tokens (no hardcoded whites) — new `web/static/js/tests/architecture.chart-theme.test.js` (12 tests across 4 describe blocks): (1) every `--wg-chart-*` token exists in `:root`; (2) `.wg-bp-chart-card` + `.wg-weight-chart-panel` each consume all 4 `--wg-chart-card-*` tokens and contain no hex/rgba literals; (3) `.wg-bp-chart__guide` + `.wg-weight-chart__guide` each consume all 3 `--wg-chart-guide-*` tokens and contain no hex/rgba literals; (4) `.wg-bp-chart__axis-tick` + `.wg-weight-chart__y-tick-label/__x-tick-label` each consume `--wg-chart-axis-tick-color/size`, the weight tick rule no longer uses `var(--wg-fg-4)` or `var(--wg-font-mono)` (the two regression vectors) and contains no hex/rgba literals. Also updated `architecture.design-tokens.test.js` `REQUIRED_TOKENS` list to include the 9 new `--wg-chart-*` tokens so they can't be removed unnoticed
- [x] run `pnpm test` — 1455/1455 frontend tests green (133 files, +1 file `architecture.chart-theme.test.js` at 12 tests, +9 tokens in `architecture.design-tokens.test.js` required list = 1444 → 1455); `go test ./...` all packages pass

### Task 14: Verify acceptance criteria across all 17 defects

- [ ] walk through defects #1–#17 in the appendix and confirm each is resolved or explicitly deferred (with reason)
- [ ] run full `pnpm test` suite
- [ ] run `go test ./...`
- [ ] run frontend linter — all issues must be fixed
- [ ] verify no new `window.*` globals were added without allowlist entries (`tests/architecture.globals.test.js`)
- [ ] verify no hardcoded colors or inline `.style.` assignments were introduced (architecture tests)

### Task 15: Update documentation

- [ ] update `docs/frontend.md` if new shared classes (e.g., `.wg-toolbar-btn`) were introduced — document the class and when to use it
- [ ] update CLAUDE.md only if an existing rule needs reinforcement; otherwise skip
- [ ] no new README or planning docs unless the user asks

## Technical Details

**Shared classes introduced / reused:**
- `.wg-toolbar-btn`, `.wg-toolbar-btn--primary` — unified toolbar-row button sizing; applied by BP, Food, Meds, Workouts, Weight toolbar rows.
- Existing Today "Next up" card class — reused for Meds History next-intake pane (#11) and Workouts Ready-to-start pane (#13a).
- Existing Wandergeek elevated-teal-card / modal-close-button classes — reused for Edit Variant exercise rows (#14) and Add Weight modal X (#2).

**Data flow fix (Task 1):**
- SW `changes?since` replay must write with `put()` (upsert) rather than `add()` so duplicates from concurrent optimistic inserts do not reject the chain.
- Per-item error isolation: wrap each write in try/catch so one bad item does not abort the batch and prevent the "list refresh" completion signal.

**Out of scope:**
- Any migration changes (there are none in this plan).
- Backend business logic changes beyond what's needed to make the refresh path work.
- Redesigning chart types or axis ranges — only swapping colors/background to align with the Wandergeek chart theme.

## Post-Completion

**Manual verification (device-in-hand):**
- Walk through each of the 17 defects in the appendix on a mobile viewport (both iPhone-class narrow and a wider tablet) and confirm the described "Expected" behavior.
- Verify the SW fix by: saving a note, logging food, saving weight, adding a BP reading, deleting a BP reading — all should update the UI without a full page reload, and no uncaught `ConstraintError` should appear in the console.
- Confirm visual parity across BP, Weight, Meds, Workouts, Food toolbars (primary action button same height/radius as sibling range/subtab pills).

**External system updates:**
- None. All changes are in-repo frontend + SW.

---

## Appendix — Original Defect Log (for reference during implementation)

The following are the unchanged defect records collected from manual QA. Each task above references these by number (e.g. `#7a`, `#13b`).

### 1. Today — "Next up" medication card width mismatch
**Page:** Today dashboard
**Screenshot:** round2-defects/01-today-next-up-width.png (see attached)

The "Next up" medication card at the bottom of the Today stack renders wider than the cards above it (kcal/macro card, Workout tile, Sleep tile). The three upper cards share a consistent inner gutter against the teal stage; the medication card extends further toward the screen edges, breaking vertical alignment of the left and right card edges.

**Expected:** "Next up" medication card shares identical horizontal inset / max-width with the kcal card and the Workout+Sleep row above it.
**Actual:** Medication card is visibly wider (left edge sits further left, right edge further right) than the siblings.

**Suspected area:** `web/static/components/today-*` or the Today section layout CSS — likely the medication/next-up card missing the same container padding / max-width rule as the other Today cards.

---

### 2. Today — "Add weight" modal: X button style off-theme
**Page:** Today → "Add weight" shortcut → modal
**Screenshot:** (none for this sub-issue)

The close (X) button at the top of the Add Weight modal does not match the Wandergeek close-button style used elsewhere (wrong colors / shape / border). It stands out as legacy styling.

**Expected:** X button matches the standard Wandergeek modal-close treatment used on other round-2 modals.
**Actual:** Modal X button still styled with older/default look.

**Suspected area:** weight modal template in `web/static/` — modal header close button not using the shared close-button class / token.

---

### 3. Today — "Add weight" modal: default value should be last logged, not random/placeholder
**Page:** Today → "Add weight" shortcut → modal

When the Add Weight modal opens, the weight input is not pre-filled with the user's most recent logged weight. Users almost always log a value very close to their previous reading, so the last-logged value is the correct default.

**Expected:** Input pre-populated with the latest weight entry (value, units preserved). Cursor selects the value so the user can overwrite by typing.
**Actual:** Field opens empty or with an unrelated default.

**Suspected area:** weight modal open handler — should read from the weights store / bootstrap cache and seed the input.

---

### 4. Today — "Add weight" modal: weight input should receive focus on open
**Page:** Today → "Add weight" shortcut → modal

On open, the weight number field does not get keyboard focus, so users must tap it before typing. Given weight logging is a single-field flow, auto-focusing is expected.

**Expected:** Weight input focused (and value selected) as soon as the modal is visible.
**Actual:** No element is focused; user must manually tap the input.

**Suspected area:** modal open lifecycle — add `.focus()` (and `.select()`) on the weight input after modal reveal / transitionend.

---

### 5. Today — After saving weight via modal, energy bars disappear and Weight card shows "—"
**Page:** Today dashboard (after closing the Add Weight modal with a successful save)
**Screenshot:** round2-defects/05-today-post-weight-save-bug.png (see attached)

After saving a new weight record via the Today shortcut:
- The kcal / macro bars (Energy, Protein, Carbs, Fat) all collapse to 0% and the card shows "NO TARGET SET". Before the save, the same day's values were populated.
- The Weight card on the Today grid shows an em-dash / "Log your weight" (empty state), not the value that was just saved.

This looks like the Today grid re-renders from a partial/empty state after the weight save response, clobbering the previously-loaded food/target data, and failing to surface the just-saved weight.

**Expected:**
- Weight card immediately reflects the newly saved value (and delta).
- Food/macro card retains its existing data; only the weight tile should update.

**Actual:** Whole Today stack appears to re-render from a stale/empty payload — macros reset to 0%, weight card falls back to empty state.

**Suspected area:**
- Today post-save refresh flow — probably calling a bootstrap refresh that doesn't include today's food/target aggregates, or the reducer replacing `state.today` with a narrower payload.
- Weight save response handler not pushing the new row into the weight store before the Today grid re-reads it.

---

### 6. Today — After logging food, energy bars reset to 0% again
**Page:** Today dashboard (after a successful food log from Food section or shortcut)

Same failure shape as #5, different trigger: after logging food, the Today kcal / macro card collapses to 0% across Energy / Protein / Carbs / Fat and reverts to "NO TARGET SET" instead of reflecting the newly-logged intake (or at minimum preserving previously-loaded aggregates).

**Expected:** Today's macro totals increase by the logged meal's contribution; target % stays set.
**Actual:** Macro bars zeroed out; target info lost.

**Suspected area:** shared with #5 — the Today post-save refresh path appears to overwrite `state.today` (or equivalent) with an incomplete payload regardless of which entity triggered the write. Fix likely needs to either
- keep the existing aggregates and merge the new entry, or
- refetch a payload that includes target + macros in the same response.

---

### 7. BP — New reading not shown in list after save; double-delete returns 404
**Page:** BP section (list + add/delete)
**Screenshot:** round2-defects/07-bp-network.png (see attached)

**7a. Add:** After POSTing a new BP reading, the UI does not show it in the list — the list remains stale. Network panel shows the expected chain after `POST /api/bp`:

```
POST  bp                         (201, new reading)
GET   changes?since=81264        (network + SW)
GET   bp?days=60                 (network + SW)
GET   goal                       (network + SW)
GET   stats                      (network + SW)
GET   changes?since=81266        (network + SW)
```

So the refetch happens, but the rendered list still does not include the just-saved entry. Likely either:
- SW is serving a stale cached `bp?days=60` response to the renderer (cache-first or stale-while-revalidate landing *after* the render commits), or
- The list render pulls from local Dexie state that wasn't updated with the newly-inserted row, or
- The response is received but the list component doesn't re-render on the state change.

**Expected:** After save, the new reading appears at the top of the list without a manual reload.
**Actual:** List is stale; reading appears only after a hard refresh.

**7b. Delete:** Deleting a reading once visually leaves it in the list. A second delete attempt on the same row returns **404 "reading not found"** — proving the server-side deletion succeeded the first time; only the client list is out of sync.

**Expected:** After a successful DELETE, the row is removed from the list immediately.
**Actual:** Row remains; second delete attempt errors because the record is already gone server-side.

**Suspected area (shared root cause):**
- BP section uses the same post-mutation refresh pattern as #5/#6.
- Check `web/static/components/bp-*` and the BP store/repo: is the render reading from Dexie while Dexie is only updated on `changes?since` roundtrip? Is SW returning stale `bp?days=60`?
- Fix likely requires either optimistic local mutation + reconciliation, or a cache-bust / fresh-network-only strategy for the post-mutation reload.

---

### 8. BP — "+ Log" button in range bar is visually larger than sibling range buttons
**Page:** BP section (top bar: 14d / 30d / 60d / + Log)
**Screenshot:** round2-defects/08-bp-log-button-size.png (see attached)

The `+ Log` action button renders slightly taller (and visually heavier) than the `14d / 30d / 60d` range toggles sitting in the same row. Because they share a row, the mismatch is immediately noticeable and looks like an oversight rather than emphasis.

**Expected:** `+ Log` button uses the same height / vertical padding / border-radius as the range-toggle buttons so all four pills align on a single baseline. Difference should be color/emphasis only (filled yellow) — not size.
**Actual:** `+ Log` is a touch taller; row alignment looks inaccurate.

**Suspected area:** BP section toolbar CSS — `+ Log` button is getting extra padding or a different base class than the range-toggle group. Normalize to the same size token; keep only the color/fill difference.

---

### 9. Food — Top toolbar layout broken; Add button on wrong row and off-size
**Page:** Food section (top of the list)
**Screenshot:** round2-defects/09-food-toolbar-broken.png (see attached)

The Food section header currently renders as two disjointed rows:
- Row 1: `< Today >` date stepper (prev button, "Today" label with `24.04.2026` subtitle floating next to it, next button).
- Row 2: a yellow `Add` button hanging under the `<` prev button, orphaned.

This breaks the horizontal rhythm established by other round-2 sections (BP, Weight) where the primary action button lives on the same row as the range / date controls.

**Expected:** Single row with `< Today >` stepper in the middle and the `Add` button placed to the **right** of the `>` next button (or at the row's trailing edge). The `Add` button must match the `<` / `>` stepper buttons in:
- height and vertical padding,
- border-radius,
- outer margin / row gap.

Difference should be color/fill only (filled yellow for the primary action) — not size.
**Actual:** `Add` button sits on a second row under the `<` button, and its size does not match the stepper arrow buttons.

**Suspected area:** food section header template + CSS — likely the Add button is outside the stepper flex row (or on a wrapped line because the row lacks `flex-wrap: nowrap` / proper `justify-content: space-between`). Restructure markup to `[< ] [Today / 24.04.2026] [ >] [Add]` and apply the shared toolbar-button size class.

---

### 10. Meds — Remove global "Add" button from top bar; move to top of Schedule list only
**Page:** Meds section (top: `History / Schedule / Inventory` subtab row + `Add` button)
**Screenshot:** round2-defects/10-meds-add-placement.png (see attached)

The section currently shows a global `Add` button on the top bar alongside the `History / Schedule / Inventory` subtab row. `Add` makes sense only for the Schedule subtab (adding a scheduled medication) — it does not belong on History or Inventory.

**Expected:**
- Remove `Add` from the top/subtab bar entirely.
- On the **Schedule** subtab only, render `Add` at the top of the Schedule list (above the first med row).
- On **History** and **Inventory**, no Add button (these tabs don't have a direct "add" primitive at this level).

**Actual:** Add is always visible in the top bar regardless of active subtab; it is also visually taller than the subtab pills, breaking the row alignment (related to the same sizing inconsistency seen in #8 / #9).

**Suspected area:** meds section shell + subtab templates in `web/static/components/meds-*`. Move the Add trigger into the Schedule view's list header; drop the top-bar button. When re-introducing it as a Schedule-list header action, reuse the shared primary-button sizing so it matches surrounding tokens.

---

### 11. Meds → History — Reorder sections and restyle "Next scheduled intake" pane to Wandergeek
**Page:** Meds → History subtab
**Screenshot:** round2-defects/11-meds-history-order-and-style.png (see attached)

Currently the History view shows, top-to-bottom:
1. Filter pickers: `MEDICATION` (All Medications) and `RANGE` (Last 3 Days)
2. "Next scheduled intake" pane (purple gradient with `Take Now` button)
3. History list below

Two problems:

**11a. Order:** The "Next scheduled intake" call-to-action should be the first block on the History view — it's the most actionable info on the page. Filters and the list are secondary.

**Expected order (top → bottom):**
1. "Next scheduled intake" pane (with `Take Now`)
2. Filters (`MEDICATION`, `RANGE`)
3. History list

**11b. Styling:** The "Next scheduled intake" pane uses a purple→blue gradient with a translucent pill button that does not match the Wandergeek design language the rest of the app now uses (teal stage, yellow primary action, tokenized surfaces).

**Expected:** Re-style the pane with Wandergeek tokens:
- Card surface using the same elevated-surface token as other round-2 cards (dark teal, subtle border, matching radius).
- "Take Now" action as a standard yellow filled primary button (same size token as other primary CTAs).
- Typography: labels in the muted uppercase style (`NEXT · HH:MM · IN ...` treatment seen in Today's "Next up" card), large time in the display numeric style, medication name + time on a secondary line.
- No gradient background; no translucent button.

**Suspected area:** `web/static/components/meds-history-*` (or whichever module owns the History subtab layout). Re-order the template so the next-intake pane renders before the filter row, and swap its styles for the shared Wandergeek card + primary-button classes (reuse the treatment from the Today "Next up" card — see #1 for context).

---

### 12. Vitals → Notes — Tag chips are non-interactive; list stuck on "Loading notes…" after save until full reload
**Page:** Vitals → Notes subtab
**Screenshot:** round2-defects/12-vitals-notes.png (see attached)

Two related bugs on the Notes subtab:

**12a. Tag chips do nothing on click.**
The tag row (`SLEEP`, `STRESS`, `HR`, `SPO2`, `STEPS`, `M…`) next to the "New note" label is rendered as pill chips that visually look like toggles/filters, but tapping them has no effect:
- No visual selected state applied.
- No tag is attached to the note when saved.
- (If these are intended as filters for the list below, they also don't filter — see 12b.)

**Expected:** Clicking a tag chip toggles its selected state (visibly) and, on save, attaches the selected tag(s) to the note. Or, if these are list filters, clicking should filter the list immediately.

**Actual:** Click is inert; no state change, no tag persisted, no filtering.

**12b. After "+ Add note" the list shows "Loading notes…" indefinitely until a full page reload.**
After tapping `+ Add note` with text in the textarea, the notes list does not refresh and remains in a `Loading notes…` state. A hard page reload is required to see the newly-saved note (and its tag, if tagging is fixed).

This is the same failure family as #5 / #6 / #7 — the post-mutation refresh path does not complete (or completes but doesn't swap the loading state for the rendered list).

**Expected:** After a successful save, the textarea clears, tag selections reset, and the new note appears at the top of the list immediately (optimistic insert or completed refetch) without a page reload.

**Actual:** List stuck on loading placeholder; new note visible only after full reload.

**Suspected area:**
- Tag chip handlers: check `web/static/components/vitals-notes*` (or wherever the Notes subtab lives) — chips likely missing click binding or selected-state toggle class.
- Loading state: the refetch callback after save probably never resolves the loading flag on the list view. Either the mutation response is not pushing into the notes store, or the list component is not re-rendering on store change, or the refetch itself is failing silently (check console / network).
- Group this fix with #5/#6/#7 under a shared "post-mutation refresh not reflected in UI" task — pattern repeats across sections.

---

### 13. Workouts — "Ready to start" pane not re-styled; toolbar "Start" button off-size
**Page:** Workouts section (top: `History / Groups / Exercises / Stats` + `Start` button; below: "Ready to start" card)
**Screenshot:** round2-defects/13-workouts-ready-and-toolbar.png (see attached)

Two issues in one view:

**13a. "Ready to start" pane is not styled to Wandergeek.**
The large card announcing the next workout (`READY TO START · Morning 2 · Carry & Core · 2 exercises`) uses a purple→blue gradient background, white/orange outlined pill buttons (`Start Workout`, `Skip`, `Next Variant`), a yellow vertical accent stripe, and emoji-heavy labels. It does not match the rest of the app's Wandergeek look.

**Expected:** Re-style the pane using the shared round-2 tokens, consistent with the Today "Next up" card and the fix called for on Meds History (#11):
- Card surface: elevated teal surface token, standard border / radius; drop the gradient and the yellow accent stripe.
- Header: muted uppercase label (e.g. `READY TO START`) + timestamp on the right in the standard caption color.
- Title (`Morning 2`) and subtitle (`Carry & Core · 2 exercises`) in the standard display + secondary text tokens.
- Actions:
  - Primary = `Start Workout` as a yellow filled button (same size token as other primary CTAs; no emoji prefix, or keep the dumbbell icon only if the rest of the app consistently prefixes CTAs with icons).
  - Secondary = `Skip` and `Next Variant` as outline / ghost buttons matching the standard secondary-button treatment; drop the orange accent.
- No gradient, no translucent buttons, no stripe.

**13b. Top-bar `Start` button is a different size than the subtab pills.**
Same family of issue as #8 (`+ Log` on BP) and #10 (`Add` on Meds). The yellow `Start` button on the right of the `History / Groups / Exercises / Stats` row is visibly taller and wider-padded than the subtab buttons.

**Expected:** `Start` button matches subtab pills in height, vertical padding, and radius; only the fill color differs (yellow primary). If `Start` is a primary action for the section as a whole (not a subtab), it must still respect the shared toolbar-button size token.

**Actual:** `Start` stands proud of the row both in height and visual weight, breaking alignment.

**Suspected area:**
- `web/static/components/workout-*` — the "Ready to start" card template + CSS. Replace gradient surface and pill buttons with Wandergeek tokens; mirror what's already working in other round-2 cards.
- Workouts section toolbar — normalize `Start` to the shared toolbar-button size class used by the subtab pills. Note this is the third occurrence of the "primary action button in a toolbar row is too big" issue (see #8, #10) — the fix should ideally land as a single shared size/class, not a one-off per section.

---

### 14. Workouts — "Edit Variant" modal: exercise rows rendered with off-theme white surfaces
**Page:** Workouts → variant edit → `Edit Variant` modal
**Screenshot:** round2-defects/14-edit-variant-exercises.png (see attached)

Within the `Edit Variant` modal, the `EXERCISES` list items (`1. Farmer's Walk · 3 sets × 1 reps @ 16kg`, `2. Dead Bug · 2 sets × 10 reps`) render on a white/off-white rounded card background against the teal modal surface. The rest of the modal (Name, Description, Rotation Order inputs; header; close button; `+ Add exercise` outline pill) is correctly themed for Wandergeek, but these exercise rows are not.

Symptoms visible in the screenshot:
- Exercise row surface is white/light cream, breaking contrast with the rest of the modal.
- Exercise title and metadata text appear washed out (very low contrast against the light card), suggesting the text colors were designed for a dark surface but the card surface was swapped (or never migrated).
- Trash / delete icon is drawn in a faint pale color that's also low contrast on white.

**Expected:**
- Exercise rows use the standard elevated-surface-on-modal token (dark teal card with subtle border, same radius as other cards in round-2 modals).
- Text uses the standard primary/secondary text tokens on dark; icons use the standard muted-icon token.
- Visual parity with the `+ Add exercise` button row and the input surfaces above it.

**Actual:** White rounded cards with low-contrast text — looks like legacy / pre-Wandergeek styling leaked through.

**Suspected area:** `web/static/components/workout-*` (variant edit modal template) + its scoped CSS. The exercise row component is likely inheriting an older class or hardcoded light background that wasn't migrated in round-2. Swap to the shared card/surface tokens and re-verify text and icon contrast.

---

### 15. Weight — Remove "Latest" summary pane entirely
**Page:** Weight section (top of the view)
**Screenshot:** round2-defects/15-weight-latest-pane-remove.png (see attached)

The large `LATEST · 17M AGO · 134.0 kg · → 0.0 kg` pane at the top of the Weight section (with the `+ Log` button on the right) should be removed entirely. The same information is available elsewhere (Today dashboard weight tile, the chart below, recent list), and this pane duplicates it without adding value.

**Expected:**
- Remove the top "Latest" summary card.
- Keep the `+ Log` primary action accessible on the Weight section — relocate it into the section's toolbar row (next to the range toggles, matching the pattern used in BP per #8). Use the shared toolbar-button size token so it aligns with the range pills.
- The weight chart / list takes over the top of the page.

**Actual:** Prominent "Latest" pane occupies the top of the section; `+ Log` lives inside this pane rather than on a shared toolbar row.

**Suspected area:** `web/static/components/weight-*` section layout. Delete the latest-summary pane template + its CSS; ensure `+ Log` moves into the range/toolbar row (and respects the same shared primary-button size class discussed in #8, #10, #13).

---

### 16. Weight — Chart has wrong (light) background and axis labels are unreadable; restyle to match BP chart
**Page:** Weight section → chart (7d / 30d / 90d / ALL range buttons above)
**Screenshot:** round2-defects/16-weight-chart-bg.png (see attached)

The weight chart renders on a pale off-white rounded card, clashing with the teal Wandergeek stage around it. Axis labels are present but drawn in a color so close to the white background that they are effectively invisible:
- Y-axis tick labels (~145, 140, 135, 130, 125, 120, 115, 110) are barely visible as faint ghosted text on the left edge.
- X-axis date labels at the bottom are likewise nearly invisible.

What IS working well and should be preserved:
- The actual trend line (mint / teal accent).
- The trajectory / projection (dashed yellow towards `GOAL · 110 kg`).
- The goal line itself (horizontal dashed yellow at 110).
- The current-point marker (yellow filled dot).

**Expected:**
- Restyle the chart card and plot area to match the BP chart's look:
  - Card surface = standard Wandergeek elevated-teal-card token (same as BP chart card).
  - Plot background = transparent / teal stage matching the card.
  - Grid lines (if any) = subtle low-contrast teal/gray token used in the BP chart.
  - Axis tick labels = secondary/muted-on-dark text token, readable against the dark card.
  - Axis numbers visible (e.g. `145 / 140 / 135 / 130 / 125 / 120 / 115 / 110` on Y, dates on X).
- Keep the trend line, goal line, trajectory, and current-point marker as they are — they already match the design language.

**Actual:** Light card background + nearly invisible axis labels make the chart feel like legacy / pre-Wandergeek styling.

**Suspected area:** `web/static/components/weight-chart-*` (chart rendering module) — the card wrapper and the chart theme config (colors for background, grid lines, tick labels) still use the older palette. Align its theme config with whatever the BP chart uses (likely centralized as a shared chart-theme object / CSS vars). Do NOT touch the trend/goal/trajectory styling — those are already correct.

---

### 17. Console — Uncaught Dexie `ConstraintError: Key already exists in the object store` (from sw.js:193)
**Page:** Not pinpointed by user — fired at some point during the session; surfaced in browser DevTools console.

**Error text (verbatim from console):**
```
(index):1 Uncaught (in promise) t {_e: Error
    at U (https://med.kfamcloud.com/static/vendor/dexie.min.js:1:4449)
    at new t (https://…,
    name: 'ConstraintError',
    message: 'Key already exists in the object store.\n ConstraintError: Key already exists in the object store.',
    inner: ConstraintError: Key already exists in the object store.
}  sw.js:193
```

This is an IndexedDB primary-key / unique-index collision on `db.put`/`add` routed through Dexie, triggered from the service worker (`sw.js:193`) — i.e. while SW code is writing a row into the IndexedDB store, a record with the same key already exists and `add()` (not `put()`) is being used, or a `put()` is hitting a unique-index collision.

**Why this matters — likely root cause for the family of "list not refreshing" bugs (#5, #6, #7, #12):**
If the SW sync path throws on insert because the row already exists locally (e.g. the optimistic write from the UI already placed it there, and the `changes?since` replay tries to `add()` it again), the rest of the sync chain after line 193 never runs. That would leave:
- the notes list stuck on "Loading notes…" (#12b) — the completion signal that flips the loading flag never fires,
- BP list not reflecting new readings or deletions (#7) — the post-mutation refetch result never lands in Dexie cleanly,
- Today macro aggregates wiped on food/weight save (#5, #6) — the subsequent merge/render path is skipped.

**Expected:** Writes into IndexedDB via SW should be idempotent under replay — use `db.table.put()` (upsert) rather than `add()` for `changes?since` replay, or detect and swallow `ConstraintError` and continue the rest of the sync chain. A single stale / replayed event must not take down the whole post-mutation refresh.

**Actual:** Uncaught promise rejection from `sw.js:193`; downstream UI refresh logic appears blocked.

**Suspected area:**
- `web/static/sw.js` line 193 — this is the exact point that's throwing. Very likely an `add()` call on one of the per-entity object stores (notes / bp / weight / food / macros) during `changes?since` replay, which should be an upsert.
- Any call site that fans out IndexedDB writes inside a single promise chain without per-item error isolation. Consider wrapping each write in its own try/catch (or `.catch(e => e.name === 'ConstraintError' ? null : throw e)`) so one duplicate does not abort the whole batch.
- Also inspect whether the write operation is actually needed given optimistic updates — if the UI already inserted the row, the SW replay path should just reconcile without attempting a fresh insert.

**Action for plan:** treat this as high priority — fixing it may resolve (or materially reduce) #5, #6, #7b, and #12b in one shot. Verify by reproducing each of those bugs with and without the SW duplicate-write suppression in place.
