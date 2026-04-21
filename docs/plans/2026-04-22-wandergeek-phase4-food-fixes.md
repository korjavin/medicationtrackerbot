# Wandergeek Phase 4 — Food Follow-Up Fixes

## Overview

Eight visual/UX regressions were reported on the Food screen immediately after PR #217 (`feat(food): Wandergeek Phase 4 — rewrite Food screen on the design system`, merged as `3cd10e6`) landed on master. This plan closes all of them while keeping the restyle consistent with the BP and Today screens.

Issues to resolve:

1. **Meal DB** and **Food DB** sub-tab content panels were never ported to the Wandergeek token/primitive system — they still render legacy markup with paper-era visuals.
2. The food-name autocomplete dropdown renders **white text on white background** (no `color` / `background-color` tokens applied to `.autocomplete-items` / `.autocomplete-item-name`).
3. The day navigator (`.food-date-nav`) is nested inside `#food-log-tab` but nonetheless appears to render on every sub-tab in practice — needs a belt-and-suspenders visibility rule tied to the active sub-tab.
4. The Food section header carries a `data-badge="experimental"` attribute — the **"Experimental" label must be removed**.
5. The **"Today" jump-to-today button** in the day navigator is misplaced and should be **removed entirely** (not restyled).
6. The **Add Food CTA** lives inside the scrolling `#food-list` container and scrolls out of view — it must be **sticky / always visible** at the bottom of the Food daily-log viewport.
7. The `<` / `>` day-nav **chevron buttons** are white-on-white because `.wg-food-day-nav__icon-btn` lacks explicit foreground/background tokens — they must have proper contrast on both current (white) and post-fix (stage-dark) backgrounds.
8. The Food screen's root (`#food-view`) has **no screen-level backdrop** — it falls back to body white, inconsistent with BP (`#bp-view.view.wg-screen-stage`) and Today. It needs `.wg-screen-stage` to inherit the teal gradient.

## Context (from discovery)

**Files involved:**

- `web/static/index.html`
  - `:76` — BP screen (`#bp-view.view.wg-screen-stage`) — reference backdrop pattern
  - `:140` — Food section header (`<div class="section-header-mount" data-title="Food Intake" data-badge="experimental">`)
  - `:141` — Food view root (`#food-view.view`) — **missing `.wg-screen-stage`**
  - `:149–152` — Sub-tab strip (`#food-subtabs`) — already Wandergeek-styled
  - `:156–167` — `.food-date-nav` block including `#food-today-btn` at `:166`
  - `:188–189` — `#food-log-tab` and `#food-list` scroll container
  - `:192–216` — `#food-meals-tab`, `#food-fooddb-tab` — **legacy unstyled panels**
  - `:689–691` — Add Food modal: `#food-name` input + `#food-autocomplete-list` dropdown
- `web/static/js/features/food.js`
  - `:40–50` — `renderFoodDayNavIcons()` (chevron SVG injection via `WGIcons`)
  - `:825–926` — `renderFoodAutocomplete()` (creates `.autocomplete-item` rows, sets `.autocomplete-item-name`)
  - `:1215–1221` — `goFoodToday()` handler (to be deleted along with the button)
  - `:1660–1707` — `renderFoodAddCta()` (appends CTA to `#food-list`)
  - `:2154–2168` — `switchFoodTab()` (needs to toggle `.food-date-nav` visibility)
- `web/static/css/styles.css`
  - `:1977–2052` — `.autocomplete-items` / `.autocomplete-item` / `.autocomplete-item-name` — missing color tokens
  - `:3839–3857` — `.wg-icon-btn` base
  - `:4259–4316` — `.wg-screen-stage` (reference backdrop)
  - `:5100–5114` — `.wg-food-subtabs` (sub-tab strip — already styled)
  - `:5130–5134` — `.wg-food-day-nav__icon-btn` — lacks fg/bg tokens
  - `:5188–5195` — `.wg-food-day-nav__today-btn` (to be deleted)
  - `:5311–5323` — `.wg-food-add-cta` — currently flow-positioned, needs sticky
- `web/static/js/components/section-header.js` — consumes `data-badge` (no change needed; just remove the attribute)
- `web/static/js/components/wg-icons.js` — `WGIcons.iconSvg()` (verify stroke/fill uses `currentColor`)

**Tests likely touched:**

- `web/static/js/tests/food.subtabs.test.js` — sub-tab switching + day-nav visibility
- `web/static/js/tests/food.daynav.test.js` — day-nav chevrons + removal of Today button
- `web/static/js/tests/food.modal.test.js` — autocomplete dropdown styling classes
- `web/static/js/tests/food.meallist.test.js` — Add Food CTA position
- `web/static/js/tests/architecture.inline-styles.test.js` — may need line-number refresh
- `web/static/js/tests/app.ui-characterization.test.js` — snapshot of Food view shell
- New: `web/static/js/tests/food.mealdb.test.js` and `food.fooddb.test.js` (or extend existing) — Meal DB / Food DB tab rendering

**Related patterns found:**

- `.wg-screen-stage` is the canonical screen backdrop (BP, Today); it owns the teal gradient and bottom-nav reservation.
- `.wg-gloss--inset` + `.wg-card` + `.wg-mono-display` are the primitive trio used by the Daily log tab — Meal DB / Food DB should follow the same composition.
- Chevron icon buttons elsewhere (BP day-nav, Today card carousel) use a consistent `.wg-gloss` + explicit `color: var(--wg-fg-1)` on the dark stage — Food day-nav must align.
- Sticky footer pattern: look at whether `.wg-phone-chrome` or the bottom-nav reservation offers a sticky slot; if not, use `position: sticky; bottom: var(--wg-bottom-nav-reserved)`.

## Development Approach

- **Testing approach**: Regular (code first, then tests) per repo convention; write/update tests as the final checkbox(es) of each task.
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task** — `pnpm test` + `go test ./...` both green.
- **CRITICAL: update this plan file when scope changes during implementation.**
- No new design tokens — reuse `--wg-*` vars added in Phase 4 (`--wg-food-*`, `--wg-food-macro-*`) and the base Wandergeek palette.
- No inline styles (architecture test will fail otherwise).
- Run tests after each change; keep test counts rising, never falling.

## Testing Strategy

- **Unit tests** (Vitest + jsdom): required for every task. For CSS-driven changes, assert the presence of the right classes/data-attributes rather than computed color (jsdom doesn't resolve CSS vars).
- **Architecture tests**: re-run `architecture.inline-styles.test.js`, `architecture.design-tokens.test.js`, `architecture.globals.test.js` after every task.
- **Go backend**: no changes expected; run `go test ./...` as a sanity check after tasks that touch shared files.
- **No E2E framework** in-repo today — manual verification scenarios go to Post-Completion.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.
- Keep plan in sync with actual work done.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): everything achievable inside this repo — HTML/CSS/JS edits, test changes, architecture-test updates.
- **Post-Completion** (no checkboxes): manual browser verification on mobile + desktop viewports, visual consistency check against BP/Today, Telegram Mini App cold-start smoke.

## Implementation Steps

### Task 1: Food screen shell — backdrop, remove "Experimental" badge, remove Today button

- [x] `web/static/index.html:141` — add `wg-screen-stage` to `#food-view`'s class list: `class="view wg-screen-stage"`.
- [x] `web/static/index.html:140` — remove the `data-badge="experimental"` attribute from the Food `.section-header-mount`.
- [x] `web/static/index.html:166` — delete the `#food-today-btn` element entirely.
- [x] `web/static/js/features/food.js` — delete `goFoodToday()` (≈`:1215–1221`) and any wiring (`addEventListener` on `#food-today-btn`, `.classList.remove('hidden')` calls that referenced it, `food-today-chip` class manipulation). Grep `food-today-btn` and `goFoodToday` to ensure no dangling references.
- [x] `web/static/css/styles.css` — delete the `.wg-food-day-nav__today-btn` and `.food-today-chip` rules (≈`:5188–5195`).
- [x] Update `web/static/js/tests/food.daynav.test.js` — remove any assertion about the Today button; add assertion that `#food-today-btn` does **not** exist in the rendered markup.
- [x] Update `web/static/js/tests/app.ui-characterization.test.js` if its Food snapshot captured the old shell (badge / today btn / view class). (updated app.section-header-hydration.test.js instead — the actual location of the experimental-badge assertion)
- [x] Refresh `architecture.inline-styles.test.js` allowlist line numbers if they shifted.
- [x] Run `pnpm test` — must be green before moving on.

### Task 2: Day navigator — hide on non-log sub-tabs + fix chevron contrast

- [ ] `web/static/js/features/food.js` — in `switchFoodTab(tab)` (≈`:2154`), explicitly toggle `.food-date-nav` visibility: show only when `tab === 'log'`. Use an existing helper class (e.g. `.hidden`) rather than inline `style.display`.
- [ ] Audit the sub-tab content switching code path — confirm `#food-log-tab`, `#food-meals-tab`, `#food-fooddb-tab` are mutually exclusive via `.active` / `.hidden` (not just opacity). Fix if not.
- [ ] `web/static/css/styles.css` — extend `.wg-food-day-nav__icon-btn` with `color: var(--wg-fg-1)` (or the chevron-on-stage equivalent used by BP/Today) and a subtle `background: var(--wg-gloss-bg)` so the chevrons read on the teal stage backdrop; ensure hover/active states also resolve with tokens.
- [ ] Verify `web/static/js/components/wg-icons.js` `chevronLeft` / `chevronRight` SVGs use `stroke="currentColor"` (or `fill="currentColor"`) so they inherit the button color — if they hard-code a color, fix them.
- [ ] Update `web/static/js/tests/food.subtabs.test.js` — add cases: switching to `meals` hides `.food-date-nav`; switching to `fooddb` hides it; switching back to `log` restores it.
- [ ] Update `web/static/js/tests/food.daynav.test.js` — assert both `#food-date-prev-btn` and `#food-date-next-btn` carry the chevron SVG and the expected class list (including the new color-bearing class/token if added).
- [ ] Run `pnpm test` — must be green before moving on.

### Task 3: Add Food CTA — always visible (sticky)

- [ ] Decide placement: (a) hoist `#add-food-btn` out of `#food-list` into a sibling sticky footer inside `#food-log-tab`, or (b) keep it inside `#food-list` but apply `position: sticky; bottom: 0`. Prefer (a) because `#food-list` is the scroll container and sticky inside it anchors to that container, not the viewport.
- [ ] `web/static/js/features/food.js` — update `renderFoodAddCta()` (≈`:1660`) and its caller to mount the button into a dedicated `#food-add-cta-dock` (sibling of `#food-list` inside `#food-log-tab`) instead of `#food-list.appendChild`.
- [ ] `web/static/index.html` — add `<div id="food-add-cta-dock" class="wg-food-cta-dock"></div>` after `#food-list` inside `#food-log-tab`.
- [ ] `web/static/css/styles.css` — add `.wg-food-cta-dock { position: sticky; bottom: var(--wg-bottom-nav-reserved, 0); background: linear-gradient(...transparent→stage-bg...); padding: var(--space-sm) 0; z-index: 2; }` so the CTA floats above scrolling content and sits above the bottom nav.
- [ ] Verify the CTA is only visible on the Daily log sub-tab (hide the dock on `meals` / `fooddb` — extend Task 2's `switchFoodTab` toggles to cover `#food-add-cta-dock`).
- [ ] Update `web/static/js/tests/food.meallist.test.js` — adjust expectations for the CTA's parent element; add a test that the dock exists inside `#food-log-tab` and not inside the scrolling `#food-list`.
- [ ] Refresh `architecture.inline-styles.test.js` allowlist line numbers if shifted.
- [ ] Run `pnpm test` — must be green before moving on.

### Task 4: Food-name autocomplete dropdown — readable on the Wandergeek shell

- [ ] `web/static/css/styles.css` — rewrite `.autocomplete-items`, `.autocomplete-item`, `.autocomplete-item-name`, `.autocomplete-item-meta` (≈`:1977–2052`) to use Wandergeek tokens:
  - container: `background: var(--wg-card-bg)` or a modal-surface token, `border: 1px solid var(--wg-border-1)`, `box-shadow: var(--wg-shadow-pop)`, rounded via `--wg-radius-card`.
  - item: `color: var(--wg-fg-1)`; hover/active with `background: var(--wg-gloss-hover-bg)`.
  - name: explicit `color: var(--wg-fg-1)`; meta: `color: var(--wg-fg-2)` (or muted token).
- [ ] Keep the legacy `.autocomplete-*` class names (the JS render code uses them) but re-alias internal style to WG tokens. No new class names needed unless semantically helpful.
- [ ] `web/static/js/features/food.js:825–926` — ensure `renderFoodAutocomplete` does not set inline `style.*` on the items; lift any inline sizing into CSS (check for `architecture.inline-styles.test.js` violations).
- [ ] Update `web/static/js/tests/food.modal.test.js` — add assertions: dropdown element exists + has expected class list; items render name+meta spans; no inline style assignments on items.
- [ ] Run `pnpm test` — must be green before moving on.

### Task 5: Wandergeek-style the "Meal DB" and "Food DB" sub-tab panels

- [ ] `web/static/index.html:192–216` — wrap `#food-meals-tab` and `#food-fooddb-tab` content in the standard WG card composition (`.wg-gloss--inset` outer + `.wg-card` content), match the Daily log's visual rhythm (section label, content padding, divider strokes).
- [ ] Replace any legacy `.btn` / `.btn-*` usages inside these panels with `.wg-gloss` / `.wg-gloss--sun` primary CTAs as appropriate.
- [ ] `web/static/js/features/food.js` — audit the render functions for Meal DB (`renderMealList`, `renderMealDb`, or similar) and Food DB (`renderFoodDb`, `renderProductList`, etc.) and port any remaining paper-era classes to Wandergeek equivalents. Grep `food-tab-content`, `food-meals-`, `food-fooddb-` to find all touch points.
- [ ] `web/static/css/styles.css` — add `.wg-food-db-*` or reuse existing `.wg-food-*` classes for the two panels; do **not** add new color values — tokens only. Match card/label/divider rhythm used in `#food-log-tab`.
- [ ] Verify empty states + error states for both panels render with WG typography/colors.
- [ ] Add `web/static/js/tests/food.mealdb.test.js` and `web/static/js/tests/food.fooddb.test.js` (or extend `food.subtabs.test.js`) — assert: correct class list on panel roots, list rows carry `.wg-card` or its dedicated variant, primary action buttons use `.wg-gloss`, empty-state copy renders.
- [ ] Refresh `architecture.inline-styles.test.js` / `architecture.design-tokens.test.js` allowlists if new `--wg-food-*` tokens are introduced (they shouldn't need to be).
- [ ] Run `pnpm test` — must be green before moving on.

### Task 6: Verify acceptance criteria

- [ ] Walk all 8 issues in the Overview and confirm each one is closed with a one-line pointer to the fix commit.
- [ ] Run full unit test suite: `pnpm test` — expect strictly more passing tests than before this plan (baseline 782 from PR #217).
- [ ] Run `go test ./...` — must stay green (no backend changes expected).
- [ ] Run linter/arch tests: `architecture.inline-styles.test.js`, `architecture.design-tokens.test.js`, `architecture.globals.test.js` — zero violations.
- [ ] Visually diff `#food-view`, `#bp-view`, `#today-view` root class lists — all three must carry `.wg-screen-stage` and share the same bottom-nav reservation.
- [ ] Verify the Food screen renders no `data-badge` attribute.
- [ ] Grep for stale references: `food-today-btn`, `goFoodToday`, `.food-today-chip`, `data-badge="experimental"` — must return zero matches.

### Task 7: [Final] Update documentation

- [ ] `docs/frontend.md` — if the Food section entry documents the day-nav Today button or the Experimental badge, remove those references; add a one-line note that `#food-view` inherits `.wg-screen-stage` and that the Add Food CTA is docked (sticky) in `#food-log-tab`.
- [ ] `CLAUDE.md` — only touch if the Navigation Critical Rule section mentions Food specifics that are now stale (unlikely).
- [ ] No new public docs needed.

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`*

## Technical Details

- **Token reuse only.** No new `--wg-*` vars beyond Phase 4's additions. If a needed token genuinely doesn't exist, prefer extending the existing `--wg-food-*` family rather than inventing a new prefix.
- **Sticky CTA dock** must sit above `<wg-bottom-nav>` — use `--wg-bottom-nav-reserved` (or equivalent) as the bottom offset. Ensure the dock has a non-transparent background (solid stage color or a vertical gradient from transparent to stage) so scrolled content doesn't bleed through.
- **Chevron contrast**: the root cause of the white-on-white is that the Food screen was on a white body; once Task 1 ships `.wg-screen-stage`, the chevrons with `.wg-gloss` will probably look right. Still add explicit `color: var(--wg-fg-1)` so the fix doesn't regress if backdrops are theme-swapped.
- **Autocomplete surface**: the dropdown mounts inside the Add Food modal (`<wg-food-modal>` or the modal's inner card); verify its z-index is above the modal's scrim and that it doesn't clip when the viewport is short — use `max-height + overflow-y: auto`.
- **Visibility toggles**: prefer class-based `.hidden` over `element.style.display` (inline-styles architecture test will fail otherwise).
- **Sub-tab panels**: when porting Meal DB / Food DB to WG, avoid duplicating structure — factor shared row markup into a small render helper if the two panels repeat the same card+row composition (e.g. `renderFoodDbRow(item)`). Keep test files mirror-structured (`food.mealdb.test.js`, `food.fooddb.test.js`).

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification** (run in Telegram Mini App cold-start + browser dev tools, narrow + wide viewports):

- Food screen backdrop matches BP and Today — same teal gradient, same bottom-nav reservation.
- Sub-tab strip active-pill still transitions smoothly; active pill persists across reloads via `mt-food-subtab`.
- Meal DB and Food DB tabs render with WG cards, no legacy paper-era buttons, empty states legible.
- Autocomplete dropdown items are readable (dark text on light card surface, or light text on dark — whichever matches the modal theme) and the hover state is visible.
- Day navigator only shows on Daily log; switching to Meal DB or Food DB hides it completely (no flash).
- Chevrons on day-nav are tappable (44×44 minimum), visible, and respect disabled state when at the date bounds.
- Add Food CTA stays pinned at bottom during scroll, disappears on Meal DB / Food DB sub-tabs.
- No "Today" button anywhere in the Food screen.
- No "Experimental" badge in the section header.

**External system updates**:

- None — pure frontend + test work. No migrations, no env vars, no deployment pipeline changes.
