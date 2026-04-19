# Today as Primary Navigation

## Overview

Replace the bottom `<nav id="tabs">` icon strip with the Today view as the app's home. Today's data cards become the entry points to each section. Section views are pushed destinations with a sticky header containing a back-to-Today button. Settings is reachable via a small gear icon in the top-right of Today's own header.

Problem: the tab strip is duplicate navigation — every Today card is already a tappable entry point to the same destination. The strip costs ~56px of vertical space on every screen and reads as a row of generic icons that can't show data context. Native iOS Health and Fitness use this exact pattern (rich home + push-navigation, no persistent tab bar) because data-rich cards are better entry points than abstract icons.

Benefit: more vertical screen real-estate, cards preview their own data ("BP 118/76 ↓" beats a heart icon), and a clearer mental model — "Today is home, sections are destinations." The cost is one extra tap to switch sections cross-laterally (BP → Today → Weight); for a daily-companion app where most opens are "what's next?" queries this is the right tradeoff.

## Context (from discovery)

- Bottom tab nav: `web/static/index.html:33-44` (`<nav id="tabs">`)
- 7 section views in HTML: `today-view`, `meds-view`, `bp-view` (h3 line 83), `weight-view` (h3 line 91), `workouts-view` (h3 line 99), `food-view` (h3 line 146), `health-view`, `settings-view` (h3 line 245)
- Sub-tab groups inside views: `.med-tabs`, `.workout-tabs`, `.food-tabs`, `.health-tabs` — these stay
- `switchTab(tab)` in `app.js:866` — toggles `.view.active`, calls `activateTabGroup`, fires per-section loaders. Used by the deep-link router and the now-removed tab buttons.
- `activateTabGroup` toggles `.tab` `.active` + `aria-current="page"` on the matching button. With no tabs to toggle, this becomes a no-op for the button side; the view-side toggle remains the load-bearing part.
- Telegram WebApp `BackButton` API already wired in `features/modal-history.js:19-76` (proven integration pattern: `.show()` / `.hide()` / `.onClick()`, gated on Telegram WebApp version ≥ 6.1)
- Tab DnD: `web/static/js/features/tabs-dnd.js` (full file) — operates on flex-row `.tab` buttons
- `tab_order` schema persisted in `settings_bundle` — used today to order tab buttons; will be repurposed to order Today cards (no schema change, just semantic shift)
- Tests touching the tab strip (will need updates):
  - `app.tab-order.test.js`, `app.tab-active-state.test.js`, `app.tab-icons.test.js`, `app.tab-single-source.test.js`
  - `bootstrap.today-default.test.js`, `bootstrap.dynamic-tab.test.js`
  - `app.auth-check.test.js`, `app.checkauth-nonblocking.test.js`
  - `app.ui-characterization.test.js`, `app.visual-and-scanner.test.js`
- Architecture tests: `architecture.design-tokens.test.js` has the `tabButtons` regex check (currently expects 8 tabs)

## Design Decisions (baked in — correct in conversation if any are wrong)

1. **Settings access** = small gear icon in Today's top-right header. NOT a Today card (settings isn't "today's data"). Settings is still a normal `<div id="settings-view">` with the same back-to-Today affordance as other sections.
2. **Back-to-Today affordance** = a sticky header on every section view with a leading `[← Today]` pill on the left and the section title centered. Always visible, doesn't scroll away.
3. **Telegram WebApp BackButton** = also wired up as a parallel back affordance. Pressing the device back button (Android hardware) or the Telegram-rendered back arrow returns to Today. Mirrors the modal-history integration.
4. **Cross-section jump** = 2-tap (Today → tap card). Accepted. No fast-switcher pop-over in MVP.
5. **`tab_order` reuse** = the existing `tab_order` array now controls Today card order (instead of tab button order). Settings is excluded from `tab_order` (it's not a card). No schema migration needed; the meaning shifts naturally because there are no tabs to order anymore.
6. **Card drag-reorder** = OUT OF SCOPE for this plan. Refactoring `tabs-dnd.js` to work on a CSS grid is non-trivial; ship without it and file as a follow-up. Today card order is server-driven (default order or user's previously-saved `tab_order`).
7. **No tab strip CSS** = remove `#tabs`, `.tab`, `.tab.active`, `.tab.active::before`, `.tab-icon-*` rules entirely. They're dead after this lands.

## Development Approach

- **Testing approach**: Regular — UI-heavy
- Order tasks safety-first: ADD the new navigation (section headers + BackButton) BEFORE removing the tab strip. There must always be a way to navigate. The tab strip stays until task 5.
- Each section's existing `<h3>` is replaced by the new component, not duplicated.
- The new section-header is a single shared component (`section-header.js`) registered as a custom element OR rendered as an HTML partial — pick whichever fits the existing primitives (the codebase has both `mt-elements.js` custom elements and plain `components/*.js` factories — match the latter pattern for simplicity).
- After this lands, the rebuilt `tab_order` semantics are documented in CLAUDE.md.

## Testing Strategy

- **Unit tests** (Vitest): every changed component gets new/updated tests
- **Architecture tests**: update the design-tokens test that asserts on tab buttons (regex no longer needs to match 8 buttons since `<nav id="tabs">` is gone — replace with an assertion that `<nav id="tabs">` is ABSENT)
- **UI characterization snapshots**: update `app.ui-characterization.test.js` and `app.visual-and-scanner.test.js` to the new DOM (no tab strip; section headers present)
- **Telegram BackButton integration**: write a test that mocks `Telegram.WebApp.BackButton` (same shape as the modal-history mock) and asserts show/hide/onClick are called when navigating between Today and a section view

## Progress Tracking

- Mark `[x]` when done; ➕ for new tasks; ⚠️ for blockers; update plan if scope changes

## What Goes Where

- **Implementation Steps**: component creation, view header replacement, BackButton wiring, tab strip removal, test updates
- **Post-Completion**: device verification on iOS + Android, screenshots for review, follow-up plan for card drag-reorder

## Implementation Steps

### Task 1: Build the section-header component

- [x] create `web/static/js/components/section-header.js` exposing `createSectionHeader({ title, onBack, rightSlot? })` returning an `HTMLElement`
- [x] structure: `<header class="section-header"><button class="section-back btn btn-icon" aria-label="Back to Today"><svg…/> Today</button><h2 class="section-title">{title}</h2><div class="section-header-right">{rightSlot}</div></header>`
- [x] add CSS for `.section-header` in `web/static/css/styles.css` — sticky top, flex row (back left / title center / right slot right), uses design tokens, respects safe-area insets
- [x] no inline `style.` assignments; classes only
- [x] register `window.SectionHeader = { create: createSectionHeader }`; add to `tests/architecture.globals.test.js` allowlist with justification
- [x] write Vitest cases for `createSectionHeader`: structure, back-button click invokes `onBack`, optional `rightSlot` slots in correctly, omitted `rightSlot` produces empty container
- [x] run `pnpm test` — must pass before next task

### Task 2: Add the Today header (greeting + gear)

- [x] in `features/today.js` `renderToday(state, root, ctx)`, prepend a header element built via `window.SectionHeader.create({ title: state.greeting || 'Today', onBack: null, rightSlot: settingsButton })` — `onBack: null` hides the back button, since Today IS home
- [x] the `rightSlot` is a small gear icon button (`btn btn-icon` + inline SVG matching the existing settings tab icon's stroke variant) that calls `window.handleDeepLinks('settings')` (or the equivalent — use the existing deep-link router so URL hash and switchTab fire together)
- [x] add CSS for the no-back variant: `.section-header.no-back .section-back { display: none; }`
- [x] write Vitest case: rendering Today produces a header with the gear button, no back button; clicking the gear invokes the deep-link router with 'settings'
- [x] run `pnpm test` — must pass before next task

### Task 3: Replace section view headers (bp, weight, workouts, food, health, meds, settings)

- [x] for each of the 7 section views in `index.html`, REPLACE the existing `<h3>…</h3>` (or absent header) with a placeholder `<div class="section-header-mount" data-title="…"></div>`
- [x] in `app.js` `switchTab`, after the view becomes active, hydrate the placeholder by calling `window.SectionHeader.create({ title, onBack: () => switchTab('today') })` and inserting it once (idempotent — check if the header is already mounted)
- [x] for `meds-view`, `workouts-view`, `food-view`, `health-view`: the section header sits ABOVE the existing sub-tabs (e.g., History/Schedule for meds), not replacing them
- [x] for `workouts-view`: the existing `🏋️ Workout Planner` emoji-prefixed h3 becomes plain `Workouts` in the new header (consistent with sibling section titles)
- [x] for `food-view`: the `(experimental)` annotation moves into the rightSlot as a small `.badge.badge-experimental` element
- [x] for `settings-view`: title is `Settings`; back button returns to Today like every other section
- [x] write Vitest cases: switching to each section creates exactly one section header; switching away and back doesn't duplicate; back button invokes switchTab('today')
- [x] run `pnpm test` — must pass before next task

### Task 4: Wire Telegram WebApp BackButton

- [x] create `web/static/js/features/back-button.js` exporting `setupAppBackButton()` that:
  - on each `switchTab` (subscribe via `window.AppStore` or extend `switchTab` to fire a `tab-changed` event), shows the Telegram BackButton when current view !== `today` and hides it when current view === `today`
  - registers `Telegram.WebApp.BackButton.onClick(() => switchTab('today'))` once on init
  - gates on `Telegram.WebApp.version >= 6.1` (same gating as `modal-history.js:21`)
  - coordinates with `modal-history.js`: when a modal is open, modal-history's BackButton handler wins (close the modal); when no modal is open, our handler wins (return to Today). Reuse modal-history's open-modal detection so the two integrations don't fight.
- [x] expose `window.AppBackButton = { setup: setupAppBackButton }`; add to globals allowlist
- [x] call `setupAppBackButton()` from `features/bootstrap.js` after the initial tab is activated
- [x] write Vitest cases mocking `Telegram.WebApp.BackButton`: shows on section nav, hides on Today, click invokes switchTab('today'), respects open modals (defers to modal-history)
- [x] run `pnpm test` — must pass before next task

### Task 5: Remove the tab strip

- [x] delete the entire `<nav id="tabs">…</nav>` block from `web/static/index.html:33-44`
- [x] delete `#tabs`, `.tab`, `.tab.active`, `.tab.active::before`, `.tab-icon`, `.tab-icon-stroke`, `.tab-icon-fill` CSS rules from `web/static/css/styles.css`
- [x] in `app.js` `activateTabGroup`, the button-side toggle becomes a no-op when no buttons match the selector — verify it doesn't throw on an empty querySelectorAll (it shouldn't, but assert in a test)
- [x] in `features/bootstrap.js`, ensure the initial tab is `today` (drop the "first visible tab" fallback logic — Today is now always first)
- [x] DELETE `web/static/js/features/tabs-dnd.js` and its test `web/static/js/tests/tabs-dnd.cleanup.test.js` (drag-reorder is deferred per Design Decision 6)
- [x] DELETE the `initTabsDragAndDrop` consumer call sites in `app.js` / `features/bootstrap.js`
- [x] remove `window.initTabsDragAndDrop` from globals allowlist
- [x] write a Vitest case asserting `<nav id="tabs">` is ABSENT from `index.html` (architecture-level guard against accidental reintroduction)
- [x] run `pnpm test` — must pass before next task

### Task 6: Update tab-strip-dependent tests

- [x] DELETE `app.tab-active-state.test.js` (no tab strip, no `.tab.active` to test) — single-active invariant is now about `.view.active`, which is already covered by `app.tab-single-source.test.js`
- [x] DELETE `app.tab-icons.test.js` (no tab buttons, no stroke/fill icons to test) — section headers don't have icons in the same sense
- [x] UPDATE `app.tab-single-source.test.js`: assertions become "switching to a tab activates exactly one `.view`", not "exactly one `.tab.active`"
- [x] UPDATE `app.tab-order.test.js`: `tab_order` semantics now control Today card order. The save/load API is unchanged; assertions about the DOM should target Today's `.today-card-grid` instead of `#tabs`
- [x] UPDATE `bootstrap.today-default.test.js` and `bootstrap.dynamic-tab.test.js`: Today is unconditionally the initial view; `tab_order` is no longer about which tab to show first, it's about card order on Today
- [x] UPDATE `app.ui-characterization.test.js` and `app.visual-and-scanner.test.js`: regenerate snapshots (manually verify the new DOM matches expectations before committing)
- [x] UPDATE `architecture.design-tokens.test.js`: replace the `tabButtons` regex check with an assertion that `<nav id="tabs">` is absent
- [x] run `pnpm test` — must pass before next task

### Task 7: Verify acceptance criteria

- [ ] verify Today renders with greeting + gear; gear → Settings
- [ ] verify each section view shows the sticky section header with back-to-Today
- [ ] verify Telegram BackButton appears on section views, hides on Today, navigates back when clicked
- [ ] verify Telegram BackButton + modal-history don't conflict (open a modal in BP, press back: modal closes, then press back again: returns to Today)
- [ ] verify deep-link router still works (`#bp` lands on BP with header showing "Blood Pressure")
- [ ] verify dark mode for the section header
- [ ] verify safe-area insets on iOS (header isn't clipped by the notch)
- [ ] run full `pnpm test`, `go test ./...`, linter
- [ ] verify coverage ≥ project standard for new files

### Task 8: Documentation

- [ ] update `docs/frontend.md` "Tabs and Navigation" section: rename to "Navigation"; document the Today-as-home pattern, section headers, BackButton wiring
- [ ] update `CLAUDE.md` Critical Rules: add a rule that section views are entered via Today cards or deep links, NOT via a persistent tab strip
- [ ] note in `docs/frontend.md` that `tab_order` semantically now controls Today card order (the schema name didn't change)
- [ ] file a follow-up plan stub `docs/plans/2026-04-XX-today-card-drag-reorder.md` (skeleton only, mark "deferred from today-as-primary-nav")

## Technical Details

- Section header height target: 48-56px (matches the removed tab strip — net vertical real-estate gain comes from removing the header h3 + tab strip together)
- `--space-*` tokens for padding; `--shadow-sm` for the bottom border (instead of a hard line); `position: sticky; top: 0` so it stays visible while the section scrolls
- Telegram BackButton API (from `modal-history.js:19-76` reference):
  - `Telegram.WebApp.BackButton.show()` / `.hide()`
  - `Telegram.WebApp.BackButton.onClick(handler)` — register once; idempotent
  - `Telegram.WebApp.isVersionAtLeast('6.1')` for gating
- Coordination with modal-history: on `BackButton.onClick`, check `document.querySelector('.modal-overlay.active')` first; if present, defer (modal-history will handle); else `switchTab('today')`. The two integrations call `BackButton.show()` independently — last call wins, but both want it visible in their respective situations, so this is fine.
- `tab_order` array semantics post-change: `['bp','weight',…]` controls Today card render order. Server stays unchanged; the rendering call site changes from "order tab buttons" to "order today cards".

## Post-Completion

**Manual verification**:
- iOS Telegram: scroll up/down inside BP — section header sticks; tap back, returns to Today
- Android Telegram: hardware back from BP returns to Today; from Today, hardware back closes the WebApp
- Deep link `t.me/<bot>?startapp=bp` lands on BP with the section header visible
- Settings reachable via Today's gear; from Settings, back returns to Today
- All 7 section views verified with their sub-tab groups intact (meds, workouts, food, health)
- Side-by-side before/after screenshots: BP tab in old vs. new design

**External system updates**:
- README screenshot may need refresh (less prominent tab strip → more screen for content)
- `pitch.html` marketing page if it shows app screenshots — verify
- Follow-up: `docs/plans/2026-04-XX-today-card-drag-reorder.md` once this lands and feels right
