# Wandergeek Phase 3 BP — post-merge fixes

## Overview

Four focused bugs found after the Phase 3 BP rewrite landed on master (merge commit `41929f3`, branch `wandergeek-phase3-bp`). All user-visible, none affect data correctness on the server side.

1. **New BP reading doesn't appear in the history list until the user switches tabs and back.** After a successful "+ Record BP" submit, the list renders the pre-submit state until the BP view is torn down and re-mounted.
2. **The BP chart renders as a tower on desktop/tablet.** On a ≈390px mobile viewport it looks correct; on wider screens the SVG stretches to the full column width with a portrait 200:358 aspect ratio, producing a chart that's taller than the whole viewport.
3. **The "+ Record BP" floating action button is still Telegram-blue.** It uses the paper-era `btn btn-primary btn-pill btn-fab btn-lg` classes and never got re-themed during Phase 3.
4. **Day-group headers ("Today", "Yesterday", etc.) in the BP history list are invisible.** Text color is `var(--wg-fg-4)` (42% white) but `#bp-view` never got the deep-teal stage background applied — same bug pattern that hit `.wg-today` in Phase 2 review pass 5 (fixed at commit `cdb12ec`). 42%-white text drowns on paper-white.

All four fixes are localised and land without backend or test-harness changes.

## Context (from discovery)

**Bug 1 — missing refresh after submit:**
- `web/static/js/features/bp.js:89-94` — `handleBPSubmit` success branch calls `loadBPReadings()` without `await`, then immediately hides the modal and returns. `loadBPReadings` is async (SWR load via `DataStore`), so the list often re-renders *after* the modal close cycle has already completed — the view shows stale data until `switchTab()` re-mounts BP and re-invokes `loadBPReadings()` at `app.js:977`.
- Comparable flow: weight submit (`features/weight.js`) awaits its reload. Use that as the canonical pattern.

**Bug 2 — chart aspect ratio swapped:**
- `web/static/js/components/wg-bp-chart.js:28-29` — constants are `DEFAULT_WIDTH = 200; DEFAULT_HEIGHT = 358;` but the doc comment at lines 19-20 says "width — coord-space width (defaults to 358); height — coord-space height (defaults to 200)". The handoff prototype chart in `project/components.jsx:BPChart` is **358×200** (landscape). The SVG is emitted with `viewBox="0 0 200 358"` and the container CSS gives it `width: 100%` → on a ~360px mobile column it reads as a ~360×644px tower, which happens to *look* OK because the viewport itself is narrow; on a 768px+ tablet/desktop it becomes ~720×1288px and dominates the screen.
- `.wg-bp-chart` / `.wg-bp-chart-card` CSS in `web/static/css/styles.css` does not pin a `max-width` or aspect-ratio, so the SVG floods the card.

**Bug 3 — unstyled action button:**
- `web/static/index.html:78` — `<button id="add-bp-btn" class="btn btn-primary btn-pill btn-fab btn-lg">+ Record BP</button>`.
- `.btn-primary` at `styles.css:596-599` sets `background-color: var(--button-color)` = Telegram `#2481cc`. No Wandergeek override exists for this button.
- Target: `.wg-gloss wg-gloss--sun` (the sun-yellow gloss pill already used for primary CTAs in Today's next-action card). The button text stays `+ Record BP` and the `id="add-bp-btn"` JS hook stays intact.

**Bug 4 — invisible day-group headers in BP history:**
- Day-header markup emitted by `buildBPHistoryGroup` in `web/static/js/features/bp.js:494-499` — `<div class="wg-section-label wg-bp-history__group-label">Today</div>` (and "Yesterday", "Mon, Apr 18", etc.).
- `.wg-section-label` CSS at `styles.css:3916-3947` uses `color: var(--wg-fg-4)` = `rgba(244, 251, 247, 0.42)` (42% white). Designed for the teal stage.
- `#bp-view` has only the generic `.view` class (display toggle only) — no background is applied. Body remains paper-white → 42%-white text on white is invisible.
- Compare to `.wg-today` at `styles.css:4149-4166`: applies the radial-highlight stack + `var(--wg-bg-stage)` (deep-teal `#0f2522`) with the same negative-margin bleed pattern so the stage fills viewport edges past `#app`'s padding. Phase 2's review pass 5 added this exact rule — Phase 3 needs the equivalent for `#bp-view` (or a shared `.wg-screen-stage` utility to avoid per-view duplication in later phases).

**Testing patterns in place:**
- BP submit has coverage via existing feature tests loaded through `helpers/frontend-harness.js`.
- `components.wg-bp-chart.test.js` asserts default SVG dims — the swap fix must update that assertion too.
- Styling is enforced by `tests/architecture.wg-primitives.test.js` (no hex in JS, tokens only) and `tests/architecture.no-inline-styles.test.js`.

## Development Approach

- **Testing approach**: Regular — matches existing BP/chart test patterns. Write the fix, update the assertion, run `pnpm test`.
- One bug per task; each task ends with `pnpm test` green before the next starts.
- No new tokens or components. Reuse `.wg-gloss--sun`, existing chart component, existing data-reload path.
- Do NOT introduce optimistic DOM insert for bug 1 — just `await` the existing reload. Dexie already carries the new row; the SWR path will render it.

## Testing Strategy

- **Unit tests**:
  - Bug 1: extend an existing `features/bp.js` test (or add one) that mocks `fetch` + `DataStore.loadSWR` and asserts `handleBPSubmit` awaits the reload before resolving.
  - Bug 2: update `components.wg-bp-chart.test.js` default-dims assertion; add a case that asserts the emitted `viewBox` reads `0 0 358 200`.
  - Bug 3: add a tiny DOM test (or extend an existing one) that reads `#add-bp-btn` after initial render and asserts it carries `wg-gloss` + `wg-gloss--sun` and no `btn-primary`.
  - Bug 4: add/extend `architecture.wg-primitives.test.js` to assert `#bp-view` (or the shared stage class if introduced) has a background rule pulling `--wg-bg-stage`. Mirrors the equivalent check for `.wg-today`.
- **E2E tests**: none in this project (manual verification in Post-Completion).

## Progress Tracking

- Mark items `[x]` when done.
- ➕ for newly discovered tasks.
- ⚠️ for blockers.

## Implementation Steps

### Task 1: Fix BP submit not refreshing the list
- [x] in `web/static/js/features/bp.js` `handleBPSubmit` success branch (around line 89-94), `await loadBPReadings()` before hiding the modal / resolving
- [x] verify no other call site relies on the non-awaited behaviour (grep `handleBPSubmit`, `loadBPReadings`)
- [x] write/extend a test that asserts: after `handleBPSubmit` resolves, the rendered `#bp-readings-list` contains the newly submitted row
- [x] write an error-path test: if the POST rejects, modal stays open, list is not re-loaded, user sees the error (existing behaviour preserved)
- [x] run `pnpm test` — must pass before Task 2

### Task 2: Fix BP chart tower on desktop/tablet
- [ ] in `web/static/js/components/wg-bp-chart.js:28-29`, swap constants to `DEFAULT_WIDTH = 358; DEFAULT_HEIGHT = 200;` so the viewBox matches the handoff prototype's landscape aspect ratio
- [ ] verify the doc comment at lines 19-20 matches the code (update comment if it drifted)
- [ ] in `web/static/css/styles.css`, add a `max-width: 358px` (or `max-width: 100%` with `aspect-ratio: 358 / 200`) on `.wg-bp-chart` so wider containers don't upscale the SVG past its design size; centre it in the card with `margin-inline: auto`. Pick whichever approach matches the chosen guard on the three averages cards — keep the file stylistically consistent.
- [ ] update `components.wg-bp-chart.test.js` default-dims assertion to the new 358×200; add a case asserting `viewBox === "0 0 358 200"`
- [ ] write a test that mounts the chart inside a 900px-wide container and asserts its rendered width is capped (jsdom getBoundingClientRect may be 0, so assert the CSS rule exists in the computed stylesheet instead)
- [ ] run `pnpm test` — must pass before Task 3

### Task 3: Restyle "+ Record BP" button to Wandergeek
- [ ] in `web/static/index.html:78`, change the button class from `btn btn-primary btn-pill btn-fab btn-lg` to `wg-gloss wg-gloss--sun` (preserve `id="add-bp-btn"` and the `+ Record BP` text)
- [ ] confirm the sizing/padding of `.wg-gloss--sun` is acceptable at the bottom of the BP view; if it reads too small compared to the previous FAB, add a task-scoped size modifier (e.g. reuse an existing `.wg-gloss--lg` if present, else add one new token-driven rule in `styles.css` — do not introduce hex, use `--wg-*` tokens)
- [ ] if a new rule was added, extend `tests/architecture.wg-primitives.test.js` to assert it references only `--wg-*` tokens (mirrors existing block patterns)
- [ ] write/extend a DOM test that asserts `#add-bp-btn` has classes `wg-gloss` + `wg-gloss--sun` and no `btn-primary`
- [ ] grep for any other orphan `btn-primary` or `btn-fab` instances inside `#bp-view` in `index.html` — if any exist, restyle them in the same task so the screen is visually consistent
- [ ] run `pnpm test` — must pass before Task 4

### Task 4: Apply deep-teal stage to BP view so section labels are visible
- [ ] in `web/static/css/styles.css`, add a background rule for `#bp-view` (or introduce a shared `.wg-screen-stage` utility that `#bp-view` — and future BP/Food/Meds/Weight/Workouts/Health/Settings views — can opt into). Mirror the `.wg-today` pattern at styles.css:4149-4166: radial-gradient highlight stack + `var(--wg-bg-stage)`, with negative horizontal margins so the stage bleeds past `#app`'s padding to fill the viewport edge-to-edge. Use `--wg-*` tokens only, no hex
- [ ] decide: per-view rule (YAGNI, matches current state) vs shared utility class (reused by later phases). Default to **shared `.wg-screen-stage`** since Phase 4+ will need it — less thrash across future PRs. Document the decision in a one-line comment in styles.css
- [ ] if the shared utility route is chosen, apply the class to `#bp-view` in `web/static/index.html`
- [ ] verify the Today view still renders correctly (`.wg-today` keeps its own rule — do not delete it; just add the BP coverage). If `.wg-today` now duplicates the shared utility, fold it in as a follow-up — do not fold in this task
- [ ] also verify that any scoped title-color override from the `.wg-today` fix applies to BP too — the day-grouped `.wg-section-label` reads correctly, but the header title color should also resolve against the dark stage (check `.wg-app-header__title` on BP)
- [ ] write an architecture test asserting `#bp-view` (or the shared utility) pulls `--wg-bg-stage`; assert no hex was introduced
- [ ] write a jsdom test: mount `renderBPReadings` with a 2-day fixture, assert the day-header `<div>` exists with `.wg-section-label wg-bp-history__group-label` AND that the computed background of its containing view is not paper-white (assert via cssText lookup of the `#bp-view` rule since jsdom getComputedStyle won't resolve the gradient)
- [ ] run `pnpm test` — must pass before Task 5

### Task 5: Verify acceptance criteria
- [ ] all four bugs from Overview are addressed with code + tests
- [ ] `pnpm test` — full suite green
- [ ] `go test ./...` — sanity check (no Go code touched, but run anyway)
- [ ] `grep -n "btn-primary\|btn-fab" web/static/index.html | grep -A0 "bp\|BP"` — empty
- [ ] architecture tests still green (no hex in JS, no inline styles, token allowlist up to date)

### Task 6: [Final] Update plan + docs
- [ ] mark all checkboxes complete in this plan file
- [ ] no changes needed in CLAUDE.md or docs/frontend.md — these are bug fixes within the existing Wandergeek rules

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`*

## Technical Details

- **Bug 1 data-flow**: `handleBPSubmit` → `fetch('/api/bp', POST)` → on success, Dexie already has the row via the existing offline queue → `loadBPReadings()` triggers `DataStore.loadSWR('bp')` which emits a fresh `{ readings }` payload → `_renderBPData` re-renders `#bp-view`. The race is purely in the modal close path: we just need to await before handing control back.
- **Bug 2 geometry**: `viewBox="0 0 W H"` with `width="100%"` means the rendered height is `containerWidth * (H / W)`. With W=200, H=358: ratio 1.79 → 900px container renders 1611px tall. Swap to W=358, H=200: ratio 0.56 → 900px container renders 503px tall. Add `max-width: 358px` so even on a 1200px column the chart never upscales past its designed fidelity.
- **Bug 3 class map**: `.btn-primary` (paper-era) → `.wg-gloss wg-gloss--sun` (Wandergeek). The existing `.wg-gloss` base already carries the gloss shadow + hover + active translate; `--sun` swaps the gradient stack to the sun-yellow variant defined in `--wg-gloss-bg-sun`.
- **Bug 4 contrast math**: `--wg-fg-4` is `rgba(244, 251, 247, 0.42)` = roughly ~#6F7272 perceived on white (contrast ratio ~3.1:1, below WCAG AA 4.5:1 for small text) — on the intended deep-teal `#0f2522` stage it reads as warm ~#8DAAA4 with ~6.8:1 contrast. The fix restores the designed substrate; do not raise the alpha of `--wg-fg-4` itself since that token is reused across every Wandergeek screen.

## Post-Completion

**Manual verification** (authors should do after deploy):
- Record a BP reading on Today → BP view shows it immediately without tab switch.
- Open BP view on a desktop browser at 1280px — chart renders around 358px wide, centred, not a tower.
- "+ Record BP" button reads as a sun-gloss pill, not Telegram blue.
- BP history shows readable "Today" / "Yesterday" / "Mon, Apr 18" day group headers against the deep-teal stage.
- Offline/rejected badges and the edit/delete row on each history item still work (regression check).

**External**: none. No API, deploy config, or consuming projects affected.
