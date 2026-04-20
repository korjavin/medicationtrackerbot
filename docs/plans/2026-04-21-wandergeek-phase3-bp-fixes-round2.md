# Wandergeek Phase 3 BP — round 2 fixes

## Overview

Second round of BP-screen fixes after PR #215 (`2bbf3dd`) landed. Some bugs from round 1 were only partially fixed, and a few new issues surfaced once the user actually used the screen:

1. **Add AND delete still don't refresh the history list.** Round 1 added `await loadBPReadings()` to `handleBPSubmit` (line 99) — that part works. But `_deleteBPApi` calls `loadBPReadings()` **without** `await` on both its local-only delete branch (bp.js:624) and its server-delete branch (bp.js:645). Delete leaves the stale row onscreen until a tab switch re-mounts BP.
2. **"+ Record BP" button is docked at the top of the BP view instead of floating bottom-right above the nav.** Round 1 swapped `btn btn-primary btn-pill btn-fab btn-lg` → `wg-gloss wg-gloss--sun wg-gloss--lg` but dropped `btn-fab`, which was the class carrying `position: fixed; bottom: var(--space-xl); right: var(--space-xl)` (styles.css:643-648). Result: sun-gloss pill sits inline at the top.
3. **Dates in the history list are unreadable.** Round 1 added the deep-teal stage so the day-group `.wg-section-label` headers resolve on dark — that worked, but per-reading timestamps (`.wg-bp-reading-row__time`, styles.css:4850-4854) use `color: var(--wg-fg-4)` (42% white). Combined with the small (10-11px Space Grotesk) size, these read illegibly even on the teal stage. And the history block may not even be visible in the user's current viewport — worth auditing the vertical rhythm.
4. **BP chart is terribly scaled — sys and dia lines sit in a thin band in the middle of the plot.** In `components/wg-bp-chart.js:34-37`, `Y_DEFAULT_MIN = 50; Y_DEFAULT_MAX = 160`. The computation loop at lines 154-165 initializes `dataMin = Y_DEFAULT_MIN; dataMax = Y_DEFAULT_MAX`, so for healthy data (sys 118-121, dia 71-72) the loop's `if (d.sys < dataMin)` never fires and the y-axis stays 50-160 — a 110-unit span for ~3 units of real variance. The plot area renders as a thin horizontal band. Also: the sys-line right-end sun marker is missing while the dia marker shows, because both circles use `--wg-teal-sage` stroke (styles.css:4630-4634) and the sys circle lands in a stroke-neighbourhood that washes it out.
5. **"Record Blood Pressure" modal is still paper-era.** `<mt-modal id="bp-modal">` at `index.html:883-901` carries legacy `.btn btn-secondary` cancel + `.btn btn-primary` Save. The title `<h3 id="bp-modal-title">` has no Wandergeek type class. Form fields (label / input / select) have no Wandergeek styling and render on the paper surface inside an otherwise teal-stage app.

All five are frontend-only. No backend changes, no API shape changes. All within existing Wandergeek token vocabulary — only place a new `.wg-fab` utility needs to be added.

## Context (from discovery)

**Bug 1 — delete doesn't await:**
- `web/static/js/features/bp.js:624` (local-only delete branch) — `loadBPReadings();` not awaited
- `web/static/js/features/bp.js:645` (server-delete branch) — same
- `invalidateTags(['bp'])` at line 630 happens but the subsequent reload races the render
- Reference pattern: submit at line 99 already `await`s correctly after PR #215

**Bug 2 — FAB positioning lost:**
- `web/static/index.html:78` — `<button id="add-bp-btn" class="wg-gloss wg-gloss--sun wg-gloss--lg">+ Record BP</button>`
- Paper-era `.btn-fab` at `styles.css:643-648` used `position: fixed; bottom: var(--space-xl); right: var(--space-xl)`
- No Wandergeek equivalent exists yet. A single new class `.wg-fab` would unblock this and any future section FABs (Food, Meds, Weight, Workouts will need the same)
- Must sit above the bottom nav — use `--wg-bottom-nav-reserved` (160px for two-row nav, already defined) plus an extra offset

**Bug 3 — date legibility:**
- `web/static/css/styles.css:4793-4816` — `.wg-bp-history` is correctly laid out, stage is applied via last round's fix
- `web/static/css/styles.css:4850-4854` — `.wg-bp-reading-row__time { color: var(--wg-fg-4); font-size: 11px; }` — 42%-white-on-teal is WCAG ~3:1 for small text, below AA 4.5:1
- `--wg-fg-3` (55% white, ~5.2:1) is the intended token for small readable text on stage — `.wg-bp-history__group-label` already uses it after last round's fix for consistency
- Scope: swap `--wg-fg-4` → `--wg-fg-3` on `.wg-bp-reading-row__time`. Do NOT change `--wg-fg-4` itself (used by other "quiet" elements)
- Also: the history block's `margin-top` against the averages grid — confirm it's visible in the first scroll below the averages on a typical mobile viewport. If it's buried, tighten the gap

**Bug 4 — chart y-axis and markers:**
- `web/static/js/components/wg-bp-chart.js:34-37` — `Y_FLOOR=40, Y_CEIL=260, Y_DEFAULT_MIN=50, Y_DEFAULT_MAX=160`
- `web/static/js/components/wg-bp-chart.js:154-165` — loop seeds `dataMin = Y_DEFAULT_MIN; dataMax = Y_DEFAULT_MAX;` (bug: defaults dominate)
- Fix shape: seed with `+Infinity`/`-Infinity`, compute real `dataMin`/`dataMax`, then pad (`±8`), snap to nearest 10, clamp to `[Y_FLOOR, Y_CEIL]`. Guarantee the normal-band markers (80, 120) remain drawn when they fall in range, otherwise omit them so the chart doesn't draw off-plot dotted lines
- `web/static/css/styles.css:4630-4634` — sys + dia end-of-line circles both use `stroke: var(--wg-teal-sage)` with `fill: var(--wg-sun)`. In the screenshot the sys circle is invisible. Likely because the sys path stroke (`--wg-teal-sage`) passes directly through the circle centre, and the fill area is tiny. Fix: give the circle a distinct `stroke: var(--wg-teal-stage)` (dark outline) or thicker stroke, and ensure `z-order` places circles after paths (check element order in `wg-bp-chart.js` render sequence)

**Bug 5 — modal not Wandergeek:**
- `web/static/index.html:883-901` — modal markup block
- `<h3 id="bp-modal-title">Record Blood Pressure</h3>` — no class; legacy `mt-modal` paper surface
- `<button class="btn btn-secondary">Cancel</button>` and `<button class="btn btn-primary">Save</button>` — paper-era
- `<input>`, `<select>`, `<label>` — no Wandergeek field styling
- Target: `.wg-modal` + `.wg-modal__title` + `.wg-modal__actions` shell, with buttons `.wg-gloss` (cancel) and `.wg-gloss wg-gloss--sun` (save). Form fields get `.wg-input` / `.wg-select` / `.wg-label` token-driven styling
- This is the first Wandergeek modal — the classes created here will be reused by Food edit modal (Phase 4), Medication modal (Phase 5), etc. Keep the utility classes generic (`.wg-modal`, not `.wg-bp-modal`)

**Testing in place:**
- `tests/components.wg-bp-chart.test.js` — update y-axis cases
- `tests/bp.render.test.js` — add delete-refresh assertion
- `tests/architecture.wg-primitives.test.js` — asserts every `.wg-*` class uses only tokens; extend for `.wg-fab`, `.wg-modal`, `.wg-input`
- No e2e harness in this project — manual verification in Post-Completion

## Development Approach

- **Testing approach**: Regular. Write the fix, update tests, run `pnpm test` before the next task.
- One bug per task; each task ends with a green `pnpm test` before the next starts.
- Keep `.wg-fab` and `.wg-modal` utilities generic — Phase 4+ will consume them. Resist the temptation to scope them to BP.
- Do NOT alter the `--wg-fg-4` token definition — only change the site that misuses it (`.wg-bp-reading-row__time`).
- For the chart fix, DO NOT rip out the fixed-axis safety (floor/ceiling stay) — just fix the seed so real data drives the range. This keeps pathological inputs (e.g. a single reading of 5/3 from a device error) from breaking the chart.

## Testing Strategy

- **Unit tests** (per task):
  - Task 1: extend `bp.render.test.js` or add `bp.delete-refresh.test.js` — mock `apiCall` + Dexie, call `_deleteBPApi`, assert the rendered list no longer contains the deleted row by the time the awaited promise resolves.
  - Task 2: add `architecture.wg-primitives.test.js` case asserting `.wg-fab` exists with `position: fixed` + bottom offset pulling `--wg-bottom-nav-reserved` (plus padding); DOM test asserts `#add-bp-btn` carries `wg-fab wg-gloss wg-gloss--sun`.
  - Task 3: extend `bp.render.test.js` to render the history and assert `.wg-bp-reading-row__time` CSS resolves to `--wg-fg-3` via the cssText lookup trick.
  - Task 4: `components.wg-bp-chart.test.js` — add cases: (a) data with tight range (sys 118-121, dia 71-72) yields y-axis spanning ≤40 units, not 110; (b) data with extreme range (sys 30, dia 220) clamps to floor/ceiling; (c) both sys and dia end-circles are present in the output SVG and have distinct stroke vs the path.
  - Task 5: add `tests/components.wg-modal.test.js` (or extend existing modal-controller test) — mount a `.wg-modal`, assert title uses `.wg-modal__title`, actions row has cancel `.wg-gloss` + save `.wg-gloss--sun`, inputs carry `.wg-input`. Also architecture test asserts `.wg-modal` / `.wg-input` / `.wg-select` use only `--wg-*` tokens.
- **E2E**: none in project.

## Progress Tracking

- Mark `[x]` immediately on task completion.
- ➕ for newly discovered tasks.
- ⚠️ for blockers.

## Implementation Steps

### Task 1: Fix BP delete not refreshing the list
- [x] in `web/static/js/features/bp.js:624`, add `await` to `loadBPReadings();` (local-only delete branch)
- [x] in `web/static/js/features/bp.js:645`, add `await` to `loadBPReadings();` (server-delete branch)
- [x] confirm `invalidateTags` at line 630 is awaited (per codex-round fix) — if not, wrap in `await` too
- [x] write a delete-refresh test: seed a 3-row fixture, trigger `_deleteBPApi` on row 2, assert rendered `#bp-readings-list` contains only 2 rows after the awaited promise settles
- [x] write an error-path test: rejected delete leaves the row in place and surfaces the error to the user (existing behaviour preserved)
- [x] run `pnpm test` — must pass before Task 2

### Task 2: Add `.wg-fab` utility and place "+ Record BP" bottom-right
- [x] add `.wg-fab` CSS block in `web/static/css/styles.css` next to the `.wg-gloss` block — `position: fixed; right: var(--wg-space-lg); bottom: calc(var(--wg-bottom-nav-reserved) + var(--wg-space-md)); z-index: var(--wg-z-fab, 30);` — pick tokens that already exist, add a `--wg-z-fab` token if missing
- [x] in `web/static/index.html:78`, change the button class to `wg-fab wg-gloss wg-gloss--sun wg-gloss--lg` (preserve `id="add-bp-btn"` and `+ Record BP` text); remove the now-redundant `.wg-gloss--lg` if the `.wg-fab` size override conflicts
- [x] manual viewport check (skipped - not automatable)
- [x] extend `architecture.wg-primitives.test.js` to assert `.wg-fab` exists and references `--wg-bottom-nav-reserved`
- [x] extend `bp.render.test.js` to assert `#add-bp-btn` carries `wg-fab wg-gloss wg-gloss--sun`
- [x] run `pnpm test` — must pass before Task 3

### Task 3: Make BP history dates legible
- [ ] in `web/static/css/styles.css:4850-4854`, change `.wg-bp-reading-row__time { color: var(--wg-fg-4); }` → `color: var(--wg-fg-3);` — leaves other `--wg-fg-4` consumers untouched
- [ ] audit `.wg-bp-reading-row__time` font-size — if still ≤10px, bump to 11-12px via an existing `--wg-font-size-*` token
- [ ] confirm `.wg-bp-history` sits directly below the 3-up averages on a typical scroll — if an extra `margin-top` is pushing it below the fold, tighten to `var(--wg-space-md)`
- [ ] extend `bp.render.test.js` — render the history with a fixture and assert the time element's computed color rule resolves to `var(--wg-fg-3)` (use the stylesheet cssText lookup pattern already in use)
- [ ] write a jsdom assertion that day-group header `.wg-bp-history__group-label` text is visible (not the same color as background) — regression guard for the round-1 stage fix
- [ ] run `pnpm test` — must pass before Task 4

### Task 4: Fix chart y-axis scale and sys-line end marker
- [ ] in `web/static/js/components/wg-bp-chart.js:154-165`, replace the seed `dataMin = Y_DEFAULT_MIN; dataMax = Y_DEFAULT_MAX;` with `dataMin = Infinity; dataMax = -Infinity;`
- [ ] after the loop, if `dataMin === Infinity` (empty data), fall back to `Y_DEFAULT_MIN`/`Y_DEFAULT_MAX` so the empty-state render still draws a chart
- [ ] pad and snap: `yMin = Math.max(Y_FLOOR, Math.floor((dataMin - 8) / 10) * 10); yMax = Math.min(Y_CEIL, Math.ceil((dataMax + 8) / 10) * 10);` — guarantees ≥16u span + decade alignment for readable grid
- [ ] conditionally draw the 80 and 120 normal-band dotted lines: only when they fall within `[yMin, yMax]`; when off-plot, omit them so the chart doesn't render dotted lines at clipped positions
- [ ] in `web/static/css/styles.css:4630-4634`, give `.wg-bp-chart__last` a distinct stroke (`stroke: var(--wg-teal-stage); stroke-width: 2;`) so the sun-fill circle reads clearly against any underlying path; verify sys and dia circles render over their respective paths (adjust SVG element order in the renderer if needed)
- [ ] update `components.wg-bp-chart.test.js` — (a) tight-range fixture → assert computed `yMin >= 60 && yMax <= 140` (span ≤80, not 110); (b) extreme-range fixture → assert `yMin === Y_FLOOR && yMax === Y_CEIL`; (c) both end-circles present in the output SVG
- [ ] visual sanity: manually verify on a seeded 60-day fixture that the chart fills vertically, not a thin middle band
- [ ] run `pnpm test` — must pass before Task 5

### Task 5: Wandergeek-style the BP record modal
- [ ] introduce `.wg-modal`, `.wg-modal__title`, `.wg-modal__body`, `.wg-modal__actions`, `.wg-input`, `.wg-select`, `.wg-label`, `.wg-field` CSS blocks in `web/static/css/styles.css` — token-driven only; no hex. Size + padding reuse existing `--wg-space-*`, colors use `--wg-bg-card`, `--wg-fg-1`, `--wg-border-hairline`
- [ ] in `web/static/index.html:883-901`, rewrite the BP modal markup — `mt-modal` shell stays (preserves open/close wiring), but inner content uses new classes: title → `.wg-modal__title`, field wrappers → `.wg-field` (label + input), cancel button → `.wg-gloss`, save button → `.wg-gloss wg-gloss--sun`
- [ ] verify `handleBPSubmit` / `showBPRecordModal` still find every `#bp-*` id — do NOT rename ids, only classes/structure
- [ ] add `components.wg-modal.test.js` — render a `.wg-modal` skeleton, assert structural classes + token-driven rules
- [ ] extend `architecture.wg-primitives.test.js` with a block that asserts every new `.wg-modal*` / `.wg-input*` / `.wg-select*` / `.wg-label*` / `.wg-field*` rule references only `--wg-*` tokens
- [ ] visual: open the modal, confirm it reads as deep-teal/gloss consistent with the rest of the screen (title is JetBrains Mono, save is sun-gloss pill)
- [ ] run `pnpm test` — must pass before Task 6

### Task 6: Verify acceptance criteria
- [ ] all five bugs from Overview are addressed with code + tests
- [ ] `pnpm test` — full suite green
- [ ] `go test ./...` — sanity check
- [ ] `grep -n "btn-primary\|btn-secondary\|btn-fab" web/static/index.html | grep -v "<!--"` — reduced scope (the remaining hits must be outside `#bp-view` + `#bp-modal`)
- [ ] architecture tests green — no hex in JS, no inline styles, token allowlist up to date
- [ ] manual: open the BP screen, record a reading, delete a reading — list updates without tab switch on both paths
- [ ] manual: "+ Record BP" sits bottom-right above the nav on both mobile and desktop
- [ ] manual: history list dates are readable
- [ ] manual: chart fills vertically with auto-scaled y-axis; sys and dia end-markers both visible
- [ ] manual: record-BP modal reads as Wandergeek, not paper-era

### Task 7: [Final] Update plan + notes
- [ ] mark all checkboxes complete in this plan file
- [ ] add a one-paragraph note in `docs/frontend.md` under the Design tokens section about `.wg-fab` and `.wg-modal` being the canonical FAB/modal utilities going forward — future section plans should reuse them
- [ ] no CLAUDE.md changes needed — all fixes operate within existing rules

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`.*

## Technical Details

- **Bug 1 flow**: `_deleteBPApi` → (optimistic local Dexie remove) → `await apiCall('/api/bp/:id', 'DELETE')` → `invalidateTags(['bp'])` → `loadBPReadings()`. The last call is async and not awaited, so the function returns before the SWR refresh renders. Adding `await` on line 624 and 645 closes the race.
- **Bug 2 geometry**: `.wg-fab { bottom: calc(var(--wg-bottom-nav-reserved) + 12px) }` leaves a 12px breathing gap above the nav. At 390px viewport with a two-row nav (160px reserved), the FAB sits at `y ≈ viewportH - 172px`. Desktop: same — nav is fixed-bottom in both modes.
- **Bug 3 contrast math**: `--wg-fg-4` = 42% white on `--wg-bg-stage` (`#0f2522`) = ~3.0:1 (fails AA small). `--wg-fg-3` = 55% white = ~5.2:1 (passes AA small). Token preserves semantic "quiet" vs "very quiet" — just corrects the site's choice.
- **Bug 4 geometry**: for sys [118,121] and dia [71,72], combined min=71, max=121. With ±8 pad + snap-to-10: yMin = 60, yMax = 130. Span = 70 units. Compared to current 110. Plotted band occupies ~70% of chart height vs current ~2%. Normal-band markers 80 and 120 both remain in range (good).
- **Bug 5 DOM contract**: `showBPRecordModal`/`handleBPSubmit` reach fields via `document.getElementById('bp-systolic')` etc. — the rewrite must keep every id. Only classes and the inner-element tree change.

## Post-Completion

**Manual verification** (after deploy):
- Record a BP reading, immediately delete it — both operations reflect in the list without a tab switch.
- "+ Record BP" sits bottom-right above the bottom nav on iPhone SE (375×667), iPhone 14 Pro (393×852), iPad (768×1024), and desktop (1280×800). Does not overlap the nav or scroll off-screen.
- History list day groups and per-reading times are legible on the teal stage.
- 60-day chart fills the card height — sys line oscillates visibly, dia line is distinct, both end-of-line sun markers are visible.
- Record-BP modal title is JetBrains Mono, inputs are teal/gloss, save is sun-gloss pill, cancel is plain gloss.

**External**: none. No API, deploy config, or consuming projects affected.
