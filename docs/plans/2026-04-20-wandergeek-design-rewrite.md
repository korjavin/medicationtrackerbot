# Wandergeek Design Rewrite

## Overview

Adopt the "Wandergeek" deep-teal / glossy / JetBrains-Mono aesthetic from the Claude Design handoff bundle (`medtrackerbot-handoff.zip`, see `Medtracker.html` + `screens.jsx`) as the canonical design language and navigation pattern for the entire MedTracker web app.

The handoff prototype establishes:

- A **deep-teal stage** (`#0f2522` / `#2D544F`) with glossy convex tiles (gloss material w/ inner-shadow + highlight gradient) replacing the current paper/ink minimal design.
- **JetBrains Mono** for headlines and numeric displays; Space Grotesk for UI text.
- A **sun-yellow accent** (`#FBBD0D`) as the primary action color, mint (`#9CE4CC`) as the success/secondary, clay (`#C6553A`) as alert.
- A **multi-row bottom tab nav** with one slot per real section (Today, BP, Food, Meds, Weight, Workouts, Health, Settings) — the persistent navigation surface, replacing the current "Today is the only landing" rule. The handoff prototype shows a single 5-slot row with a "More" aggregator; we **deviate** from the prototype here: no aggregator, every section gets its own icon, and slots wrap to a second row when the count exceeds what fits comfortably (≈5 per row at 390px width).
- An **iPhone-style chrome** (status bar, dynamic island, home indicator) framing the content stage.

The rewrite is in-place on the existing vanilla-JS app under `web/static/`. We extend `tokens.css` and `styles.css` with all new gloss/teal/sun tokens and CSS classes; **no inline styles, no hardcoded hex in JS**, so the existing architecture tests still pass after we update their token allowlist.

This plan covers **Phase 1** (design system + chrome + bottom nav) and **Phase 2** (Today screen) in full task detail. **Phases 3–7** (BP, Food + edit modal, Meds, Weight, Workouts, Health, Settings) are stubbed at the bottom of the file as named follow-up sections to keep scope reviewable; they will be expanded into their own task lists when Phase 2 lands. There is no "More" aggregator screen — every section is a first-class destination in the bottom nav.

## Context (from discovery)

**Handoff prototype (read-only reference, do not deploy):**

- `/tmp/medtracker-handoff/medtrackerbot/project/Medtracker.html` — root React+Babel mock
- `project/styles.css` (392 lines) — gloss material, cards, tags, bottom nav, modal, tweaks panel
- `project/tokens.css` — Wandergeek palette + type tokens (`--paper`, `--ink`, `--teal`, `--mint`, `--sun`, `--clay`, `--font-display: JetBrains Mono`, etc.)
- `project/components.jsx` — `Icon` (24 stroke icons), `StatusBar`, `AppHeader`, `BPChart` (200×358 SVG, sys/dia paths + band fill + dotted normal-band), `Sparkline`, `BottomNav`
- `project/screens.jsx` — `TodayScreen`, `BPScreen` (range selector, averages, history list), `FoodScreen` (tabs, day nav, macros card, item list), `EditFoodModal`, `PlaceholderScreen`
- `project/data.js` — synthetic fixtures: `BP_READINGS` (60d×2/day), `FOOD_TARGETS`, `FOOD_LOG`, `TODAY_SUMMARY`

**Existing app structure (target):**

- `web/static/index.html` (1037 lines) — single SPA shell, all views in one document
- `web/static/css/styles.css` (3745 lines) — current paper/ink token system + per-feature class blocks
- `web/static/js/core/` — `app-kernel.js`, `chart-utils.js`, `modal-controller.js`, `store.js`, `utils.js`, `api.js`
- `web/static/js/components/` — `section-header.js` (the "← Today" back pill, mounted by every non-Today view), `stat-card.js`, `action-row.js`, `empty-state.js`, `mt-elements.js`
- `web/static/js/features/` — `today.js`, `bp.js`, `food.js`, `weight.js`, `health.js`, `settings.js`, `bootstrap.js`, `back-button.js`, `deeplink-router.js`
- `web/static/js/tests/architecture.design-tokens.test.js` (965 lines) — enforces required `--*` tokens in `:root` of `styles.css`
- `web/static/js/tests/architecture.globals.test.js` (139 lines) — allowlist for `window.*` globals
- `vitest.config.mjs` — `pnpm test` runs all `web/static/js/tests/**/*.test.js` in jsdom

**CLAUDE.md rules being relaxed (this plan updates them):**

1. *"Today is the only landing surface; there is no persistent tab strip."* → repealed. The bottom nav is now the canonical navigation.
2. *"Do not re-introduce `<nav id="tabs">` or any `.tab` / `.tab-icon-*` rules."* → repealed and replaced with a new `<nav class="bottom-nav">` pattern.
3. *"No hardcoded colors or inline `.style.` assignments in frontend code."* → **kept**. Every Wandergeek hex/gradient becomes a token; every dimensional style becomes a CSS class.

**Existing tests we must keep green:**

- `today.aggregate.test.js`, `today.render.test.js`, `today.subscribe.test.js` — the Today aggregation contract (`aggregateToday(bootstrap, swrCaches, now) → {greeting, nextMed, bpLatest, …}`) is reused; only the renderer changes.
- `bootstrap.today-default.test.js` — keep Today as the default landing screen; bottom nav highlights it on first paint.
- `bootstrap.dynamic-tab.test.js`, `app.tab-order.test.js`, `app.tab-single-source.test.js` — these enforce the *old* `<nav id="tabs">` model and **will need to be rewritten** for the new bottom nav (one task each).

## Development Approach

- **Testing approach**: Regular (code first, then tests). UI-heavy rewrite — visual checking is part of each task.
- Complete each task fully before moving to the next; small focused changes; tests required per task.
- **CRITICAL**: every task that adds/modifies code MUST include new/updated tests in the same task. Architecture tests (token allowlist, globals allowlist) must be updated alongside the code that adds new tokens or globals.
- **CRITICAL**: all tests must pass before starting the next task — `pnpm test` and `go test ./...` (the latter only when touching backend).
- **CRITICAL**: update this plan file when scope changes during implementation.
- Keep the SPA single-document model (everything in `index.html`); do not split into per-screen HTML files.
- The iPhone chrome (frame + dynamic island + home indicator) is decorative on desktop only — on mobile/PWA it disappears so the app fills the viewport. Use a media query, not JS.

## Testing Strategy

- **Unit tests** (Vitest, jsdom): every render function and every aggregator gets coverage for primary + empty + offline-stale states.
- **Architecture tests**:
  - extend `architecture.design-tokens.test.js` — new required tokens get added to `REQUIRED_TOKENS` arrays.
  - update `architecture.globals.test.js` — every new `window.*` global (`window.GlossButton`, `window.BottomNav`, `window.PhoneChrome`, …) needs an entry with justification.
  - add a new `architecture.no-inline-styles.test.js` if one doesn't exist — scans `web/static/js/**/*.js` for `.style.` assignments and `style=` template literals; allowlists are explicit per-file.
- **Render snapshots**: each screen gets a UI characterization test against fixture data.
- **No backend changes** in Phases 1–2; Phases 3–6 reuse existing endpoints.

## Progress Tracking

- Mark `[x]` immediately when each item completes (do not batch).
- ➕ prefix for newly discovered tasks.
- ⚠️ prefix for blockers.
- Update plan if scope deviates significantly.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): all Phase 1 + Phase 2 work — tokens, CSS classes, web components, screen reskin, tests.
- **Follow-up Phases** (no checkboxes; named-only): Phase 3 (BP), Phase 4 (Food + modal), Phase 5 (Meds), Phase 6 (More). Each gets its own plan file when Phase 2 lands.
- **Post-Completion** (no checkboxes): announcement copy, screenshots for `pitch.html`, manual mobile/PWA verification.

## Implementation Steps

### Task 1: Extend tokens.css with the Wandergeek palette + type tokens

- [x] add Wandergeek raw palette tokens to `web/static/css/styles.css` `:root`: `--wg-paper` (`#F4FBF7`), `--wg-paper-deep`, `--wg-paper-soft`, `--wg-ink` (`#0F5042`) + alphas (-85/-70/-55/-35/-15/-08), `--wg-teal` (`#2D544F`), `--wg-teal-stage` (`#0f2522`), `--wg-teal-sage` (`#56AC8A`), `--wg-mint`, `--wg-mint-soft` (`#9CE4CC`), `--wg-sun` (`#FBBD0D`), `--wg-sun-deep`, `--wg-sun-soft`, `--wg-clay` (`#C6553A`), `--wg-clay-soft`
- [x] add Wandergeek semantic aliases on top of those: `--wg-bg-stage`, `--wg-bg-card`, `--wg-bg-card-inset`, `--wg-fg-1` (`#F4FBF7`), `--wg-fg-2` (rgba(244,251,247,0.72)), `--wg-fg-3` (0.55), `--wg-fg-4` (0.42), `--wg-fg-5` (0.32), `--wg-border-hairline` (rgba(255,255,255,0.06)), `--wg-border-strong` (0.12)
- [x] add status-tag tokens: `--wg-tag-normal-bg`, `--wg-tag-normal-fg`, `--wg-tag-normal-border`, plus `-high-` and `-alert-` triplets
- [x] add type tokens: `--wg-font-display: 'JetBrains Mono', ui-monospace, …`, `--wg-font-ui: 'Space Grotesk', …`, `--wg-font-mono: 'JetBrains Mono', …` (display + mono share the same family — that's intentional, headlines are mono)
- [x] import the Google Fonts URL from `tokens.css` (Instrument Serif + Source Serif 4 + Space Grotesk + JetBrains Mono) at the top of `styles.css` (or inline the equivalent `<link>` in `index.html` — pick one and document) — chose `<link>` in `index.html` with `preconnect` hints (avoids the render-blocking `@import`); documented in a comment at the top of the Wandergeek token block in `styles.css`
- [x] add gloss-material gradient tokens: `--wg-gloss-bg` (the linear-gradient stack used by `.gloss`), `--wg-gloss-bg-sun`, `--wg-gloss-bg-clay`, `--wg-gloss-bg-inset`; plus their box-shadow strings as `--wg-gloss-shadow`, `--wg-gloss-shadow-sun`, `--wg-gloss-shadow-inset`
- [x] update `web/static/js/tests/architecture.design-tokens.test.js` — add a new `WANDERGEEK_TOKENS` array with every `--wg-*` token introduced; add a `describe('Wandergeek tokens', …)` block asserting all are present. Also added a companion test asserting no `--wg-*` token is referenced from JS source files (the CSS-only rule).
- [x] run `pnpm test` — design-tokens test must be green before next task (489/489 passed)

### Task 2: Build the gloss material primitives (CSS classes, no JS yet)

- [x] add `.wg-stage` block to `styles.css` — sets the deep-teal background gradient stack (radial highlights + `--wg-bg-stage`), `color: var(--wg-fg-1)`, `font-family: var(--wg-font-ui)`
- [x] add `.wg-card` — `--wg-bg-card` background, `--wg-border-hairline` border, inner highlight + bottom shadow box-shadow stack, 14px border-radius, 14px padding
- [x] add `.wg-card--inset` modifier — uses `--wg-gloss-bg-inset` for inset-tile look (used by macro tracks, range selectors)
- [x] add `.wg-gloss` — base button material: `--wg-gloss-bg`, `--wg-gloss-shadow`, 10px border-radius, 600 weight, font-family `--wg-font-ui`, `:active` translateY(1px) + brightness, `:hover` brightness 1.07
- [x] add `.wg-gloss--sun`, `.wg-gloss--clay`, `.wg-gloss--inset` modifiers
- [x] add `.wg-icon-btn` — 44×44 wrapper used inside `AppHeader` slots and toolbar rows
- [x] add `.wg-tag`, `.wg-tag--normal`, `.wg-tag--high`, `.wg-tag--alert`, `.wg-tag--mono` — pill badges (10.5px Space Grotesk)
- [x] add `.wg-section-label` — uppercase 10.5px section header w/ accent-dot pseudo-element (`var(--wg-sun)`, glow). Implemented via `::before` pseudo-element rather than a `.accent-dot` child so the markup stays clean; test updated to assert the pseudo-element.
- [x] add `.wg-mono-display` (large numeric display: JetBrains Mono 500, -0.02em letter-spacing) and `.wg-muted` / `.wg-muted-strong` text utilities
- [x] add a Storybook-style demo route at `/wg-primitives.html` that renders one of every primitive against the stage — used as a visual checklist (not shipped in `index.html`). Uses inline styles (layout-only) since the file is a demo scaffold, not shipped app code — the inline-styles architecture test scans `web/static/js/**/*.js` only.
- [x] write `web/static/js/tests/architecture.wg-primitives.test.js` — parses `styles.css` and asserts each `.wg-*` class block exists with no hardcoded hex outside `var(--wg-*)` references. Also asserts `.wg-gloss` wires the gloss gradient/shadow tokens, that each tag modifier pulls its triplet of `--wg-tag-*` tokens, and that the section-label accent dot uses `--wg-sun`. Added 7 new `--wg-*` dimensional tokens (`--wg-radius-gloss/icon/card`, `--wg-card-pad`, `--wg-icon-btn-size`, `--wg-font-size-tag`, `--wg-section-label-pad-top`) to satisfy the existing no-hardcoded-px architecture test; these are appended to `WANDERGEEK_TOKENS` in `architecture.design-tokens.test.js`.
- [x] run `pnpm test` — must pass before next task (62 files / 527 tests passed)

### Task 3: Phone chrome web components (status bar, dynamic island, home indicator)

- [x] create `web/static/js/components/wg-phone-chrome.js` — exports a `<wg-phone-chrome>` custom element (or vanilla render fn `mountPhoneChrome(rootEl)`) that wraps `index.html`'s main view container with the `.wg-phone` shell + `.wg-phone-screen` inner + `.wg-dynamic-island` + `.wg-status-bar` + `.wg-home-indicator`. Exposed as `window.WGPhoneChrome` with `mount(rootEl)` and `create()` helpers (no custom-element registration — vanilla render path matches the rest of the `components/` folder).
- [x] add CSS for those classes — `.wg-phone` (390×844 desktop, full-viewport mobile via `@media (max-width: 480px)`), `.wg-phone-screen` (border-radius 38px, overflow hidden, deep-teal bg), `.wg-dynamic-island` (110×32 black pill, top:20px, centered, z-index above content), `.wg-status-bar` (50px height, "9:41" + signal/wifi/battery SVGs), `.wg-home-indicator` (134×5 white-45% pill at bottom). Added `--wg-phone-pad`, `--wg-phone-radius`, `--wg-phone-screen-radius`, `--wg-phone-shadow`, `--wg-dynamic-island-radius`, `--wg-status-bar-pad-bottom`, `--wg-status-bar-font-size`, `--wg-radius-pill` tokens and wired them into `WANDERGEEK_TOKENS`.
- [x] inline the three SVG icons (signal bars, wifi arc, battery) in the chrome component as constants — each `<svg>` keeps the original viewBox + paths from `components.jsx:42-58`
- [x] register `window.WGPhoneChrome` (or the custom element name) in `architecture.globals.test.js` allowlist with a one-line justification
- [x] write `components.wg-phone-chrome.test.js` — mounts the component, asserts `.wg-status-bar`, `.wg-dynamic-island`, `.wg-home-indicator` exist; asserts `@media` shrinks chrome on small viewports (use jsdom + getComputedStyle on a stub). Mount-error test uses regex message match rather than `toThrow(TypeError)` because jsdom's TypeError is a different constructor across realms.
- [x] run `pnpm test` — must pass before next task (543/543 passed)

### Task 4: AppHeader + back-button reskin

- [x] add `.wg-app-header` CSS — grid `44px 1fr 44px`, padding 2px 16px 8px, `.wg-app-header__title` centered (font `--wg-font-display`, 17px, 500), `.wg-app-header__title small` (10px, 0.18em letter-spacing, uppercase, fg-3 alpha). Added `--wg-app-header-title-size` (17px) and `--wg-app-header-subtitle-size` (10px) tokens and wired them into `WANDERGEEK_TOKENS`. The new block lives next to the legacy `.section-header` rules and intentionally zeroes `background`/`box-shadow`/`min-height` so it layers cleanly over the old paper-era sticky header.
- [x] update `web/static/js/components/section-header.js` — render the new `.wg-app-header` markup with a `.wg-icon-btn > .wg-gloss` back pill (replaces the existing "← Today" pill); keep the same exported function signature so call sites don't change. Dual-classed the output (`section-header wg-app-header`, `section-back wg-icon-btn`, `section-title wg-app-header__title`, `section-header-right wg-app-header__right`) so legacy queries (Today's renderer fallback, existing tests, hydration CSS for the experimental badge) keep working during the phased rewrite. Also threaded a new optional `subtitle` prop into the factory.
- [x] keep the Telegram BackButton wiring in `features/back-button.js` intact — only the visual chrome changes (no touches to that file)
- [x] update `app.section-header-hydration.test.js` and `components.section-header.test.js` to assert the new class names — hydration test now asserts `.wg-app-header`, `.wg-app-header__title`, and that the back pill carries `.wg-icon-btn` with a `.wg-gloss svg` and no legacy `.section-back-label` span; component test asserts dual-class on the root, `.wg-app-header__right` slot, and the new `.wg-app-header--no-back` modifier
- [x] add a new test case: header with `subtitle` prop renders the `<small>` line in mono caps (two cases actually — one for a non-empty subtitle that asserts the `<small>` is a child of `.wg-app-header__title`, one guard that an empty-string subtitle omits the `<small>`)
- [x] run `pnpm test` — must pass before next task (545/545 passed)

### Task 5: Bottom nav web component (multi-row, one slot per section)

- [x] create `web/static/js/components/wg-bottom-nav.js` — exports `mountBottomNav(rootEl, { active, onChange, items })` and a `setActive(id)` helper; renders the nav with stroke icons from a shared icon registry. The `items` array drives the grid; default order: `[today, bp, food, meds, weight, workouts, health, settings]` (8 slots). No "More" aggregator. Also exposes `WGBottomNav.DEFAULT_ITEMS` as a `Object.freeze`d const for consumers to filter by feature flags.
- [x] create `web/static/js/components/wg-icons.js` — port the 24 stroke icons from `components.jsx:5-34` as a `PATHS = { home, activity, apple, pill, scale, dumbbell, heart, settings, … }` map of inner-SVG markup strings; export `iconSvg(name, { size, stroke })` returning an `<svg>` SVGElement. Parses inner children via `DOMParser` with an `image/svg+xml` wrapper so jsdom + browsers both get SVG-namespaced nodes (the SVGElement.innerHTML setter in jsdom otherwise emits HTMLUnknownElement children). Each section gets its own distinct icon: Today=home, BP=activity, Food=apple, Meds=pill, Weight=scale, Workouts=dumbbell, Health=heart, Settings=settings (gear). Added a new `settings` (gear) icon beyond the prototype's set; `more` stays in the registry for any later non-nav use but is not used by the bottom nav.
- [x] add CSS: `.wg-bottom-nav` (absolute bottom, gradient backdrop, blur), `.wg-bottom-nav__inner` (CSS grid, `grid-template-columns: repeat(var(--wg-nav-cols, 5), 1fr)`, `auto-flow: row`, gloss tile container — wraps to a second row when `items.length > 5`), `.wg-nav-item` (column flex, 9.5px Space Grotesk caps, fg-4), `.wg-nav-item--active` (sun color + sun-tint background + sun-22% inset border). Added 13 new `--wg-*` tokens (`--wg-bottom-nav-pad-top/-pad-x/-pad-bottom/-inner-radius/-inner-pad/-gap/-z`, `--wg-nav-item-radius/-pad-y/-pad-x/-gap/-font-size`, `--wg-nav-icon-size`) to the `:root` block and wired them into `WANDERGEEK_TOKENS` in `architecture.design-tokens.test.js`.
- [x] decide column count from `items.length` in `mountBottomNav` (≤5 items → 1 row; 6–8 items → 2 rows of `Math.ceil(n/2)` cols; >8 → throws `RangeError` so misuse surfaces immediately in tests, documented as the plan's constraint). Set `--wg-nav-cols` inline on the `__inner` element via `setProperty()` — structural variable, not a visual value. Documented the exception in the new `ALLOWED_JS_TOKEN_REFS` map inside `architecture.design-tokens.test.js` (the Wandergeek-tokens-in-JS guard); `wg-bottom-nav.js` is allowlisted for `--wg-nav-cols` only.
- [x] hook `mountBottomNav` into `app-kernel.js` boot sequence — `features/bootstrap.js` now calls a new `mountCanonicalBottomNav()` helper before `switchTab('today')`; the helper mounts `window.WGBottomNav` into `#app` and registers a tiny module on `AppKernel` whose `onTabSwitch(tab)` calls `ctrl.setActive(tab)`. `switchTab()` in `app.js` now fires `window.AppKernel.onTabSwitch(tab)` after activating a view, so the bottom nav auto-syncs. Slot clicks route back through `switchTab(id)`; the setActive call on the already-active button is a no-op (no loop).
- [x] **delete** `<nav id="tabs">` and all `.tab` / `.tab-icon-*` CSS from `index.html` and `styles.css` — verified via `Grep`; no `<nav id="tabs">`, `.tab` rules, or `.tab-icon-*` rules remain. That cleanup already landed in the Today-as-primary-nav rework that preceded this plan, so this checkbox is a verification pass.
- [x] update `bootstrap.dynamic-tab.test.js`, `app.tab-order.test.js`, `app.tab-single-source.test.js` — header comments rewritten to name the Wandergeek bottom nav as the canonical nav. `app.tab-single-source.test.js` gets two new tests: (a) `switchTab` notifies registered `AppKernel` modules (so the bottom nav can update), (b) with the nav mounted, switchTab leaves exactly one `.wg-nav-item--active` — and a third that mounts the default 8 items and asserts the inner grid resolves to `--wg-nav-cols: 4`. Old drag-to-reorder assertions did not exist in the current test files (those were dropped in the preceding Today-primary rework); the top-comment note documents that intent.
- [x] register `window.WGBottomNav` in `architecture.globals.test.js` — added `window.WGBottomNav` and `window.WGIcons` with justifications; also threaded both component files into `tests/helpers/frontend-harness.js` so all existing frontend tests can invoke the new APIs and so `switchTab`'s new `AppKernel.onTabSwitch` call still fires when the harness runs.
- [x] write `components.wg-bottom-nav.test.js` — 25 tests covering: DEFAULT_ITEMS shape + canonical ordering + no-'more' rule, single-row layout at 5 items, two-row layout at 6 and 8 items, RangeError at 9+ items, TypeError on bad rootEl, click → onChange + active class, click on inner SVG still bubbles, `setActive()` updates class + aria-current, `destroy()` removes the nav, icon registry integrity (every default slot renders an SVG with `data-wg-icon` matching its key), missing-WGIcons guard, the inline-style audit (no inline styles except `--wg-nav-cols` on `.wg-bottom-nav__inner`), CSS contract (every `.wg-bottom-nav*` and `.wg-nav-item*` selector exists in `styles.css` and `.wg-nav-item--active` pulls `var(--wg-sun)`), and WGIcons API coverage (`iconSvg(name)` attributes, `iconSvg(unknown)` throws, custom `size` option).
- [x] also wired `/static/js/components/wg-icons.js` and `/static/js/components/wg-bottom-nav.js` into `sw.js` STATIC_ASSETS so the new modules precache alongside the rest of the app shell (picked up by `architecture.sw-precache.test.js`).
- [x] run `pnpm test` — all 573 tests pass (64 files). `go test ./...` also green.

### Task 6: Update CLAUDE.md and architecture docs

- [ ] in `CLAUDE.md` Critical Rules section: replace rule 6 ("Today is the only landing surface; there is no persistent tab strip.") with the new rule: *"The bottom nav is the canonical navigation — one slot per real section (Today, BP, Food, Meds, Weight, Workouts, Health, Settings), wrapping to two rows when needed. No 'More' aggregator: every section is a first-class destination with its own icon. Every screen must mount inside `<wg-phone-chrome>` and render under the active nav item. See `docs/frontend.md#navigation`."*
- [ ] update rule 3 to keep its ban on inline styles + hardcoded hex but add: *"All visual values come from `--wg-*` tokens (Wandergeek system). See `docs/frontend.md#design-tokens`."*
- [ ] update `docs/frontend.md` Navigation section — document the new bottom nav, its 5 fixed slots, the back-pill in `AppHeader`, and how `wg-phone-chrome` wraps every view
- [ ] update `docs/frontend.md` Design tokens section — add the Wandergeek subsection cataloguing `--wg-*` tokens by group (palette, semantic, gloss, type, status-tag) and the rule that **no `--wg-*` token may be referenced from JS** (only CSS)
- [ ] no test changes in this task — pure docs

### Task 7: Today screen reskin (Phase 2 starts)

- [ ] keep the existing `aggregateToday()` in `web/static/js/features/today.js` unchanged — its contract is reused
- [ ] rewrite `renderToday(state)` in `today.js` to produce the new markup: sun-accent next-action card → 2×2 vitals tile grid (`MetricTile`) → fuel-today card with mini-bars (`MiniBar`) → workout+sleep two-up → consistency streak card. Match `screens.jsx:6-124` structure 1:1 but use `.wg-*` classes only
- [ ] extract `renderMetricTile({ label, value, unit, statusTag, sparkPoints, color })` and `renderMiniBar({ label, pct, color })` as private helpers in `today.js` — color values come from `--wg-*` tokens via class names (`.wg-spark--sun`, `.wg-spark--mint`, `.wg-spark--coral`), NOT inline `stroke=`
- [ ] add CSS: `.wg-next-action-card`, `.wg-vitals-grid` (2-col grid, 8px gap), `.wg-metric-tile`, `.wg-fuel-card`, `.wg-mini-bar` + `.wg-mini-bar__track` + `.wg-mini-bar__fill`, `.wg-plan-grid`, `.wg-plan-tile`, `.wg-streak-card`, `.wg-streak-bars`
- [ ] port the `Sparkline` component to `web/static/js/components/wg-sparkline.js` — `renderSparkline({ points, variant, width, height })` where `variant` is `sun|mint|coral|mint-soft` and maps to a CSS class on the `<path>`; the path's `stroke` comes from CSS, not a JS color string
- [ ] register `window.WGSparkline` in `architecture.globals.test.js`
- [ ] update existing `today.render.test.js` snapshot — re-record against the new markup (delete old snapshot file; first run regenerates; review carefully before committing)
- [ ] write `today.render.wg.test.js` — asserts each new section block renders, asserts taps on each metric tile call the right `handleDeepLinks` target ('bp' / 'bp' / 'more' / 'more' per the prototype), asserts the fuel-card click routes to 'food'
- [ ] write `components.wg-sparkline.test.js` — given fixture points, asserts the `<path>` `d` attribute and the variant class are correct
- [ ] run `pnpm test` — must pass before next task

### Task 8: Verify acceptance criteria for Phase 1+2

- [ ] open `index.html` in a desktop browser (390×844 phone view) — visually compare Today screen side-by-side with `Medtracker.html` rendered separately; document any pixel deviation > 2px in a comment block in this plan
- [ ] open `index.html` in mobile viewport (DevTools 375×812 iPhone preset) — confirm phone chrome disappears, content fills viewport, bottom nav stays anchored, status bar from chrome is hidden behind device chrome
- [ ] verify Telegram BackButton still works on non-Today screens (via Telegram WebApp test harness if available; otherwise document as Post-Completion manual check)
- [ ] run full `pnpm test` suite — all green
- [ ] run `go test ./...` — all green (no Go changes expected, sanity check)
- [ ] confirm no `style=` attributes in the new markup and no `.style.` assignments in new JS — grep with `Grep` tool, document any allowlisted exceptions in this plan

### Task 9: [Final] Update plan and write Phase 3 plan stub

- [ ] mark this plan complete; ralphex moves it to `docs/plans/completed/`
- [ ] write `docs/plans/2026-04-XX-wandergeek-phase3-bp.md` with the BP screen task breakdown (see Phase 3 stub below). Phases 4–9 follow the same template — write each one when its predecessor lands, not preemptively.
- [ ] no code changes in this task

## Technical Details

**Token namespace**: every new token uses the `--wg-*` prefix to avoid colliding with the existing paper/ink palette. The old `--paper` / `--ink` / `--teal-sage` tokens stay in place for now — Phase 6 (or a later cleanup plan) decides whether to remove them after every screen migrates.

**Class namespace**: every new class uses the `wg-` prefix (`.wg-card`, `.wg-gloss`, `.wg-bottom-nav`). Old classes (`.card`, `.tab`, etc.) are removed only when the screen using them is rewritten — this lets phases ship independently without big-bang regressions.

**Color → class mapping for charts/sparklines**: instead of `<path stroke="#9CE4CC">`, the renderer outputs `<path class="wg-spark wg-spark--mint">` and CSS rules `.wg-spark--mint { stroke: var(--wg-mint-soft); }` set the color. This satisfies the no-hex-in-JS rule.

**Inline-styles audit**: `Grep` for `style="` and `\.style\.` in `web/static/js/**/*.js` after each phase; the existing architecture test that catches these stays the gate.

**Bottom nav state persistence**: the active screen is already persisted via the existing `localStorage` mechanism in `app-kernel.js` ("mt-screen" or equivalent — confirm in Task 5); no new persistence needed.

**Back-button + bottom nav interaction**: Today is the root. Tapping a nav item is a forward navigation (no back stack). Tapping into a deep view from a card creates a back stack. Telegram BackButton + the header back pill both pop the back stack; if back stack is empty, they no-op (Today is the root). Same model as today's app, just with the bottom nav as the lateral switcher.

## Follow-up Phases (out of scope; named only)

Each becomes its own plan file when the previous phase lands. Listed here for context, not as commitments. Every section is a first-class bottom-nav destination — there is no aggregator screen.

### Phase 3 — BP screen rewrite
- Big current-reading card (44px JetBrains Mono numeric)
- Range selector (14d/30d/60d) using `.wg-gloss` + `.wg-gloss--inset` for active state
- BPChart SVG component (port from `components.jsx:84-148`) — band fill, sys/dia paths, dotted normal-band 80–120, last-point markers in sun
- 3-up averages cards
- Day-grouped history list with status tags (Normal / High-normal / Stage 1 / High)
- Reuses existing `/api/bp` endpoints

### Phase 4 — Food screen + EditFoodModal rewrite
- Sub-tab strip (Daily log / My meals / Food DB) using `.wg-gloss--inset` container + `.wg-gloss--sun` active pill
- Day navigator (chevron buttons + center date)
- Daily total macros card with `MacroRow`s
- Meal-grouped item list with edit/delete buttons
- EditFoodModal (per-100g macros, barcode scan, datetime) using existing `modal-controller.js` infrastructure
- Reuses existing `/api/food` endpoints

### Phase 5 — Meds screen rewrite
- Replaces the placeholder with the real medication schedule UI
- Next-action card pattern from Today, expanded into a full take-now flow
- Schedule list grouped by hour
- Inventory + history sub-views

### Phase 6 — Weight screen rewrite
- Big current-weight card with mono display + trend arrow
- Range selector + line chart (reuses Sparkline + chart utils, with axis labels)
- Day-grouped history list with delete actions
- Reuses existing `/api/weight` endpoints

### Phase 7 — Workouts screen rewrite
- Today's-workout card (next session, PUSH/PULL/LEGS)
- Session detail view with exercise list + log-set flow
- Rotation editor + history sub-views
- Reuses existing workout domain service

### Phase 8 — Health screen rewrite (SpO2 + sleep + diary)
- Today's vitals tiles (SpO2 spark, sleep hours)
- Sleep history grouped by week
- Notes/diary list view
- Reuses existing health endpoints

### Phase 9 — Settings screen rewrite
- Form-heavy: tokens for all input states, gloss-inset inputs from EditFoodModal pattern, sectioned cards
- Largest CSS surface; do last so primitives are stable

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes.*

**Manual verification:**
- Visual side-by-side comparison with the prototype on a real iPhone (PWA install) and Android Chrome
- Telegram WebApp BackButton verification inside the actual Telegram client (Mini App context)
- Lighthouse / a11y audit on the reskinned Today screen — JetBrains Mono numerics need a contrast check against the deep-teal stage
- Reduced-motion preference: confirm gloss `:active` transforms and modal animations respect `prefers-reduced-motion`

**External system updates:**
- Update `pitch.html` screenshots once Phase 2 lands (the marketing page currently shows the old paper aesthetic)
- If the bot sends preview links, no change needed — same routes
- Announce the redesign in whatever release-notes channel applies (CHANGELOG, Telegram channel)
