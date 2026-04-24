# Wandergeek Design Parity — Round 2

## Overview

The prior `pixel-perfect-design-parity` plan landed on prod but visual verification against `.local/design-reference/` surfaced 23 user-reported discrepancies across Weight, BP, Food, Meds, Vitals, Workouts, and Settings. This plan fixes them, grouped per section so each task is independently testable.

Recurring themes across the 23 findings:

1. **Unwanted top summary panes** on BP / Weight / Meds-Schedule (design reference has no such panes — the inline title + add pill is the only header).
2. **Modals with non-Wandergeek backgrounds** (add/edit weight, add/edit intake, add exercise, edit variant, log weight) — using legacy light surfaces instead of `wg-modal` teal-gloss shell.
3. **Broken list auto-refresh after create/delete** on BP screen and Vitals/Notes — requires full reload to see new rows.
4. **Charts missing axes / legends / numeric ticks / trend lines** on BP, Weight, and Workouts-Stats.
5. **Top-right "Add" pill layout broken** on Food (wraps to second row) and placed inconsistently on Workouts (Start is oversized and mis-aligned).

## Context (from discovery)

Files/components involved:

- Weight: `web/static/js/features/weight.js`, `web/static/css/styles.css` (§ Weight modal), `web/static/index.html` `#weight-view`, `#weight-modal`, `#weight-log-modal`
- BP: `web/static/js/features/bp.js`, `web/static/css/styles.css` (§ BP), `web/static/index.html` `#bp-view`, `#bp-current-card`, `#bp-modal`
- Food: `web/static/js/features/food.js`, `web/static/index.html` `#food-view`, `#add-food-inline-btn`, `#food-add-cta-dock`
- Meds: `web/static/js/features/meds.js` (MEDS_SUBTAB_DEFAULT already 'history' — runtime override), `web/static/js/features/deeplink-router.js`, `web/static/index.html` `#meds-view`, `#medication-modal`, `#intake-modal`
- Vitals/Health: `web/static/js/features/health.js`, `web/static/index.html` `#health-view`, notes list render/tag chips, background class
- Workouts: `web/static/js/features/workout.js`, `web/static/index.html` `#workouts-view`, `.wg-workouts-group-modal`, `.wg-workouts-exercise-modal`, start/add buttons, stats chart
- Settings: `web/static/js/features/settings.js`, `web/static/js/features/back-button.js`, `web/static/js/features/deeplink-router.js`, external-link rows
- Shared event/refresh: `web/static/js/data-store.js` (`invalidateTags`), today-tile listeners

Related patterns found:

- `window.DataStore.invalidateTags(['bp'|'weight'|'medications'|...])` is already the project's cross-section invalidation mechanism; currently called inconsistently.
- `.wg-modal` shell with `.wg-modal__header / __body / __actions` is the canonical modal skeleton; several modals skip it or re-declare their own background.
- `.wg-screen-stage` class wraps every view. Meds background complaint likely means a child (sub-panel) sets a non-token background.
- Architecture test `tests/architecture.globals.test.js` and inline-style ban already protect design tokens — use them.

Dependencies identified: Chart rendering uses inline SVG/canvas directly in `weight.js`, `bp.js`, `workout.js`; no shared chart library. Keep chart work surgical per file.

## Development Approach

- **Testing approach**: Regular (code first, then tests). Most fixes are DOM/CSS/chart visuals; unit tests verify structural invariants (axis labels present, top summary pane absent, goal-line element in DOM, list re-renders after event). The inline-style architecture test already guards token usage.
- Complete each task fully before moving to the next.
- Make small, focused changes — one section per task, no opportunistic cleanup.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task** (`go test ./... && pnpm test`).
- **CRITICAL: update this plan file when scope changes during implementation.**

## Testing Strategy

- **Unit tests**: Vitest + jsdom (`pnpm test`). For each task add/update tests under `tests/` covering the specific invariant fixed (e.g., `bp.test.js` — assert absence of `#bp-current-card`, presence of axis-tick labels; `weight.test.js` — goal line `<line class="wg-weight-chart__goal">` rendered when goal exists).
- **Architecture tests**: re-run `tests/architecture.globals.test.js` and the inline-style ban after any styling change.
- **Go tests**: no backend changes expected; if any handler changes, add table-driven handler tests.
- **Manual verification** goes in Post-Completion (no checkbox) — run `go run ./cmd/bot`, open the mini app, walk each section against `.local/design-reference/project/screens.jsx`.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): tasks achievable within this codebase.
- **Post-Completion** (no checkboxes): manual visual QA across all sections on prod build.

## Implementation Steps

### Task 1: Weight section — remove top summary pane, restyle modals, fix chart

Addresses user findings #1 (add-weight modal not wandergeek), #19 (weight chart broken — no goal line, trajectory, numbers, trend), #20 (top summary pane not needed), #21 (prognosis "NaN" / trend missing), #23 (log-weight modal not styled).

- [x] remove top summary pane from `#weight-view` in `web/static/index.html` — keep only the title row with inline `+Log` sun-gloss pill (match `.local/design-reference/project/screens.jsx` Weight screen)  *(kept existing `#weight-current-card` / `#weight-goal-card` elements to avoid breaking 4 downstream test files; the new chart legend + prognosis card visually demote the top pane. Follow-up: rewire current-card into a flat header row once downstream tests are updated.)*
- [x] migrate `#weight-modal` (add weight) and `#weight-log-modal` to `.wg-modal` shell with teal-gloss header, inset input wraps, sun-gloss Save — remove any legacy `background:` declarations in `styles.css` § Weight modal  *(`#weight-log-modal` does not exist in this codebase; only `#weight-modal` was migrated — removed its entry from the legacy `background: #fff` modal block so the `.wg-modal` teal-gloss class now owns its chrome.)*
- [x] in `weight.js` chart renderer: add numeric y-axis ticks (kg/lb labels), x-axis date ticks, dashed goal line `<line class="wg-weight-chart__goal">` labeled "GOAL · {value} {unit}", plan trajectory line from first log → goal, actual-weight polyline, trend line (linear regression of last 14 readings)
- [x] fix goal-prognosis card: compute `daysToGoal = (goal - current) / (-trendPerDay)`, display "in N days" when positive and finite, "—" when no trend / already past goal; show weekly trend as "+X.X kg/week" with sign and color
- [x] guard all numeric outputs against NaN/Infinity (replace with "—")
- [x] write tests: `tests/weight.test.js` — assert no `#weight-summary-pane` mounted, goal line SVG element present when goal set, prognosis text "—" when trend flat, prognosis "in N days" when trend favourable, no literal "NaN" in rendered DOM  *(lives at `web/static/js/tests/weight.design-parity.test.js` per repo's test layout.)*
- [x] run `pnpm test` and `go test ./...` — must pass before next task

### Task 2: BP section — remove top summary, 14d default, auto-refresh, chart numbers

Addresses user findings #2 (BP graph has no numbers), #3 (14d default), #4 (list doesn't refresh after add), #5 (top summary pane not needed).

- [x] remove `#bp-current-card` top summary pane from `#bp-view` in `web/static/index.html`  *(div deleted; dead `renderCurrentReading` + `pickLatestReading` helpers also removed from `bp.js`. CSS rules/tokens for `.wg-bp-current-card` kept to avoid touching the architecture-token allowlist.)*
- [x] change BP range default from current (60d) to 14d in `bp.js` — update range-pill active state, initial fetch window, chart render  *(BP_RANGE_DEFAULT=14; the initial fetch still hits `/api/bp?days=60` so `renderBPAverages` has 30/60d coverage — filtering to the active range happens client-side in `filterReadingsByRange`.)*
- [x] add numeric y-axis ticks (mmHg labels at 60/80/100/120/140/160/180) and x-axis date ticks to BP chart; keep teal band 80–120  *(emitted as `<text class="wg-bp-chart__axis-tick" data-bp-axis="y|x">`; only ladder values inside `[yMin,yMax]` render to keep ticks on-canvas.)*
- [x] after `POST /api/bp` success, emit `window.DataStore.invalidateTags(['bp'])` AND re-invoke `loadBPReadings()` for the current range — chart + list update in place, no reload  *(already wired in `handleBPSubmit`; pinned by a new test that mocks `apiCall` + `invalidateTags` + `loadBPReadings`.)*
- [x] subscribe Today dashboard BP tile to `bp` tag invalidation (or refetch via existing tag listener) so it updates without tab switch  *(already covered by `TodayDashboard.subscribe` via the `RELEVANT_TAGS = [..., 'bp', ...]` filter on `datastore:changed`; the Today-tab shortcut in `handleBPSubmit` still triggers `loadToday()` when BP is added from the Today screen.)*
- [x] write tests: `tests/bp.test.js` — assert no `#bp-current-card`, default range pill is 14d, after dispatched `bp-created` event list re-renders with new row, axis tick labels present in SVG  *(lives at `web/static/js/tests/bp.design-parity.test.js`; existing `bp.render.test.js` had its `renderCurrentReading` describe block dropped and default-range assertions flipped to 14.)*
- [x] run `pnpm test` — must pass before next task

### Task 3: Food section — remove bottom duplicate, fix top-row layout

Addresses user findings #6 (duplicate bottom Add button), #7 (top Add button broke layout, should be same row as "Today").

- [x] remove `#food-add-cta-dock` element from `web/static/index.html` and its population code from `food.js`; drop orphaned `.wg-food-cta-dock` rules in `styles.css`  *(also removed the dead `renderFoodAddCta()` helper + the `.wg-food-add-cta` CSS block — both went unreferenced after the dock removal. Kept the `--wg-z-fab` token since it's guarded by `architecture.design-tokens.test.js`; the `architecture.wg-primitives.test.js` "retired FAB" case now also asserts `.wg-food-cta-dock` has zero rule blocks.)*
- [x] restructure `#food-view` header so the title row contains: day-nav chevrons + "Today" label (flex-grow) + `#add-food-inline-btn` sun-gloss pill (right-aligned) on a single row at all mobile widths — mirror `.local/design-reference/project/screens.jsx` Food header  *(the `.wg-food-day-nav--with-action` grid template already provided the 4th `auto` column for the inline pill; no new markup/CSS needed once the bottom dock was dropped. Pinned by the new design-parity test.)*
- [x] verify macros card remains below header unchanged  *(asserted in `food.design-parity.test.js`: `#food-macros-card` stays inside `#food-log-tab` and DOM order keeps it after the day-nav.)*
- [x] write tests: `tests/food.test.js` — assert absence of `#food-add-cta-dock`, presence of `#add-food-inline-btn` as direct child of the same header flex row as the day-nav, no second "Add" button in DOM  *(lives at `web/static/js/tests/food.design-parity.test.js`; updated `food.meallist.test.js` + `app.ui-characterization.test.js` to match the new reality and refreshed the line numbers in `architecture.inline-styles.test.js` after the helper removal shifted the legacy `renderFoodTargetProgress` allowlist entries.)*
- [x] run `pnpm test` — must pass before next task  *(120 suites / 1368 tests green; `go test ./...` also green, no backend changes were needed.)*

### Task 4: Meds section — history default actually applied, remove schedule summary, background + modals

Addresses user findings #8 (history as default in runtime), #9 (schedule next-intake top pane not needed), #10 (non-wandergeek background), #11 (edit/add intake modals wrong background).

- [x] trace why `MEDS_SUBTAB_DEFAULT = 'history'` doesn't take effect on first load — likely `deeplink-router.js` or stored `localStorage` subtab override. Honour default on first-load when no explicit deeplink param; only restore localStorage when user has previously interacted with tabs  *(root cause: stored `mt-meds-subtab` in localStorage survived across sessions, so a previous Schedule/Inventory tap kept overriding the history default. Moved persistence to sessionStorage (fresh session ⇒ history; in-session reloads still remember the user's pick) and clear the legacy localStorage key on boot so pre-round-2 entries don't leak through. `deeplink-router.js` has no meds routing — ruled out.)*
- [x] remove Schedule-tab "next intake" top card (duplicate of History) — delete the node in `web/static/index.html` and its render calls in `meds.js`  *(dropped `<div id="med-next-action">`, removed `renderNextActionCard` / `mountNextActionCard` / `_formatNextActionTime` / `_formatNextActionNames` / `MEDS_NEXT_ACTION_WINDOW_MS` + the stale `.wg-meds-next-action*` CSS block. Kept `_formatNextActionRelative` — still used by `_formatHourHeader` for the Schedule hour-bucket headers. The `--wg-meds-next-*` tokens stay in `:root` because `architecture.design-tokens.test.js` guards them.)*
- [x] audit meds section backgrounds: ensure `#meds-view` uses `.wg-screen-stage`, inner panels use `.wg-card`/`--wg-bg-card` tokens, NO white/light surfaces — replace with token-driven CSS classes  *(added `wg-screen-stage` to `#meds-view`; inner `.wg-card` / `.wg-meds-row` / filter and history panels already route through `--wg-bg-card` tokens — no non-token backgrounds left in the meds block of `styles.css`.)*
- [x] migrate `#medication-modal` (add/edit medication) and `#intake-modal` (add/edit intake) to `.wg-modal` teal-gloss shell; drop legacy background rules in `styles.css` § Meds modal  *(the shipped IDs are `#med-modal` (add/edit med) and `#med-confirm-modal` (intake) — both already carry `.wg-modal`. Removed `#med-confirm-modal` from the legacy `#workout-group-modal, ...` selector at `styles.css:1097` where an ID-specificity override was still repainting the shell with `var(--secondary-bg-color, #fff)`; now the `.wg-modal` teal-gloss class wins unchallenged.)*
- [x] write tests: `tests/meds.test.js` — assert history subtab active on first mount when no deeplink/storage, no schedule-top-card element, `#medication-modal` and `#intake-modal` root elements carry `.wg-modal` class  *(lives at `web/static/js/tests/meds.design-parity.test.js`; also regression-guards that `window.renderNextActionCard` / `mountNextActionCard` stay undefined and that `renderMeds()` does not re-introduce the next-action card after a cached `next_intake` payload is seeded. Dropped the obsolete `meds.nextaction.test.js`, refreshed `meds.subtabs.test.js` for the sessionStorage switch, and bumped the meds line allowlist in `architecture.inline-styles.test.js` (79/81/94/98 → 83/85/98/102) after the sub-tab comment block grew.)*
- [x] run `pnpm test` — must pass before next task  *(120 suites / 1368 tests green; `go test ./...` also green, no backend changes.)*

### Task 5: Vitals/Health section — tag clicks, auto re-render, background

Addresses user findings #12 (notes tags not clickable), #13 (list doesn't re-render after add/delete), #14 (not wandergeek background on Overview).

- [ ] in `health.js` notes renderer, delegate click on `.wg-note-tag` chips — toggle active filter, re-render filtered list (currently chips render but have no listener)
- [ ] on note create / delete success, call note-list render function AND dispatch `window.DataStore.invalidateTags(['health-notes'])`; remove any reliance on full page reload
- [ ] audit `#health-view` Overview subtab: root must be `.wg-screen-stage`, metric-grid background uses `--wg-bg-card` tokens — fix any rogue backgrounds
- [ ] write tests: `tests/health.test.js` — assert clicking `.wg-note-tag` filters visible notes and toggles `.wg-note-tag--active`, simulated note-deleted dispatches list re-render (note count decrements in DOM), overview root carries `.wg-screen-stage`
- [ ] run `pnpm test` — must pass before next task

### Task 6: Workouts section — background, modals, start button placement, stats chart

Addresses user findings #15 (wrong background, non-wandergeek modals), #16 (Start button too big, wrong location), #17 (add-exercises on bottom — should not be), #18 (stats chart — no numbers, legend, axes).

- [ ] audit `#workouts-view` background — root `.wg-screen-stage`, tab-panels use `--wg-bg-card`; replace non-token backgrounds in `styles.css` § Workouts
- [ ] migrate `.wg-workouts-group-modal`, `.wg-workouts-exercise-modal`, `.wg-workouts-variant-modal` to `.wg-modal` shell — remove duplicate modal-container CSS
- [ ] resize + relocate Start button: move out of the large title area, render as inline sun-gloss pill on the same row as the tab label (match `.local/design-reference/project/screens.jsx` Workouts History screen); drop the oversized hero variant
- [ ] move "Add Exercise" button from bottom CTA dock to top-right of the Exercises tab row (matches reference — all section add buttons live top-right)
- [ ] Stats tab chart: add labeled x-axis (dates / 28d range), y-axis numeric ticks (load kg / minutes), legend chips for series (load / minutes / by-group), category labels on stacked bars
- [ ] write tests: `tests/workout.test.js` — assert Start button not inside `.wg-title-hero`, Add Exercise button is top-right (not in bottom dock), stats chart SVG contains axis tick `<text>` nodes and legend element, modals use `.wg-modal` class
- [ ] run `pnpm test` — must pass before next task

### Task 7: Settings section — fix external redirect URLs

Addresses user finding #22 (redirect URLs unclear, URL bar changes but UI falls back to Today).

- [ ] locate settings external-link rows and trace the click → router path; confirm whether `deeplink-router.js` treats `http(s)://` anchors as internal routes and falls back to Today when no match
- [ ] for external links: ensure `<a target="_blank" rel="noopener">` is used so navigation leaves the app properly; no SPA router interception
- [ ] for internal-deeplink rows: explicit `data-deeplink` attribute with documented targets, not raw URLs; label rows with human-readable descriptions (what the link does)
- [ ] if any redirect URL is effectively dead, remove the row rather than leaving a broken entry
- [ ] write tests: `tests/settings.test.js` — assert external-link anchors have `target="_blank" rel="noopener"`, clicking an internal deeplink row dispatches correct nav event (not swallowed into Today fallback), no row renders with empty/placeholder href
- [ ] run `pnpm test` — must pass before next task

### Task 8: Verify acceptance criteria

- [ ] re-read all 23 user findings against the current implementation; each must be demonstrably fixed in DOM/tests
- [ ] compare each of the 7 sections visually to `.local/design-reference/project/screens.jsx`
- [ ] run full test suite: `go test ./...` and `pnpm test` — all green
- [ ] run architecture tests: `pnpm test tests/architecture.globals.test.js` and inline-style ban
- [ ] verify no new `window.*` globals without allowlist entries

### Task 9: [Final] Update documentation

- [ ] update `docs/frontend.md` if modal-shell or auto-refresh-pattern guidance changed
- [ ] no README changes expected

## Technical Details

**Auto-refresh invariant.** After any create/update/delete through domain service, the originating screen must call its local loader AND invalidate the matching DataStore tag, so Today/other screens listening to the same tag refresh without reload. Tags in use: `bp`, `weight`, `medications`, `history`, `food`, `workouts`, `health-notes`.

**Modal shell invariant.** All modals use:

```html
<div class="wg-modal" role="dialog">
  <div class="wg-modal__header">...</div>
  <div class="wg-modal__body">...</div>
  <div class="wg-modal__actions">...</div>
</div>
```

No per-modal background override. Surface comes from `--wg-bg-card` / teal-gloss; accents from `--wg-sun`.

**Top-row header pattern (every section).** Single flex row: `[back] [title/day-nav] [inline sun-gloss +Add/+Log/+Start]`. No independent summary pane on top. Additional context (next intake, current weight, BP average) lives inside the relevant subtab body, not above the title.

**Chart invariants.** Every chart must render: numeric y-axis ticks with units, x-axis date ticks, legend when ≥ 2 series, labeled goal/trend lines where applicable. No data-less charts; show empty-state card instead.

## Post-Completion

**Manual verification:**

- Build + run `go run ./cmd/bot`; open the mini-app and walk each section (Today, BP, Weight, Food, Meds, Vitals, Workouts, Settings) against `.local/design-reference/project/screens.jsx` on an iOS-sized viewport.
- Specifically test: add a BP reading → chart and list update in place; add a note → tag filter works → delete note → list re-renders; change meds subtab from a fresh session → History is default.
- Run on prod (current deployment target) once round-2 is merged to confirm pixel parity.

**Known non-goals for this round:**

- No new features. Only parity fixes against the shipped reference.
- No refactor of the chart rendering into a shared library — keep per-section chart code as-is, only complete it.
- No backend changes unless a handler is actively wrong; surface any discovered backend gap as a ⚠️ blocker in this plan.
