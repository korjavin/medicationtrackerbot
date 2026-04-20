# Frontend

Vanilla JavaScript (no framework), Dexie.js for IndexedDB, Telegram WebApp SDK for theme integration.

## Local-First Architecture

Four layers:

1. **Service Worker** — precaches all static assets (~25 JS files, CSS, vendor libs, icons, manifest) for a full offline app shell
2. **IndexedDB** — write-ahead queue for offline writes + generic `api_cache` for SWR. `ApiCache.get(key)` returns `data`; `ApiCache.getWithMeta(key)` returns `{ data, timestamp }` for callers that need the cache-write time (e.g. the Today dashboard's offline-stale banner)
3. **SyncManager** (`sync.js`) — `offlineAwareApiCall()` is the entry point for all API calls; handles retry with exponential backoff (5s → 300s cap, resets on success or `online` event)
4. **SWR DataStore** (`data-store.js`) — `loadSWR()` returns cached data immediately and refreshes in the background; on fetch failure with no `onError` handler, defaults to rendering cached data with a console warning

Offline writes are supported for BP readings, weight logs, and medication confirmations. Other writes require connectivity.

### Bootstrap and Auth

- `/api/bootstrap` uses stale-while-revalidate in the SW: cached response served instantly, background revalidation notifies clients via `postMessage({ type: 'BOOTSTRAP_UPDATED' })`
- `checkAuth()` is non-blocking: uses SW-cached bootstrap for instant render, validates auth in background
- Auth state cache (`features/auth-flow.js`): localStorage-based UX cache (30-day TTL). **Not** a security mechanism — real auth uses HttpOnly cookies.

### Offline UX

- Slim banner: "Offline — showing cached data"
- Disabled buttons for unsupported writes
- "(saved locally)" confirmations for offline-capable writes
- Treat HTTP 502/503/504 as "offline" — `navigator.onLine` stays `true` behind reverse proxies

### Change Detection

Polls `/api/changes?since=` every 30s (SSE disabled due to HTTP/2 proxy issues — see [technical-decisions.md](technical-decisions.md)). When the poll reports invalidated tags, `data-store.js` both calls `window.requestTabRefresh({ changedTags, source })` (debounced 500ms, reloads the active tab) **and** dispatches a `datastore:changed` CustomEvent on `window` with `detail = { changedTags, source }`. Features that need to react without owning the active tab (e.g. the Today dashboard's live-update subscriber) listen on the CustomEvent.

### SW Cache Strategy

- All static assets listed in the `STATIC_ASSETS` array, validated by `architecture.sw-precache.test.js`
- `/api/bootstrap`: stale-while-revalidate
- Other API GETs: network-first with cache fallback
- Only cache `GET` responses as fallbacks; never cache `POST`/`PATCH`/`DELETE`
- Cache busting via timestamp replacement in Dockerfile

## Script Load Order (`index.html`)

Loading order matters — there is no bundler; cross-file communication happens via `window.*` globals.

1. `core/utils.js` — `safeAlert`, format helpers
2. `components/mt-elements.js` — registers `<mt-modal>`, `<mt-setting-toggle>`
3. `components/empty-state.js`, `stat-card.js`, `action-row.js` — UI primitives
3b. `components/wg-icons.js`, `wg-bottom-nav.js`, `wg-sparkline.js`, `wg-phone-chrome.js` — Wandergeek design-system primitives (icon registry, bottom nav, sparkline, phone-chrome). Must load before `features/bootstrap.js` mounts the bottom nav and before `today.js` renders sparklines.
4. `core/modal-manager.js` — `window.ModalManager`
5. `core/api.js` — `apiCallDirect`, `apiCall` (reads `window.userInitData` lazily)
6. `core/app-kernel.js` — `window.AppKernel` module registry
7. `core/store.js` — `window.AppStore` pub/sub state
8. `core/modal-controller.js` — `withSubmit` double-submit guard
9. `core/chart-utils.js` — `window.ChartUtils` (splines, gradients, `aggregateToDaily`, `lttbDownsample`)
10. `db.js` — sets up Dexie/IndexedDB stores (`window.MedTrackerDB`)
11. `sync.js` — `offlineAwareApiCall`, `SyncManager`
12. `data-store.js` — uses `window.MedTrackerDB` for cache, `window.apiCallDirect` for change polling
13. `app.js` — domain UI and `checkAuth`
14. `features/food.js`, `features/bp.js`, `features/weight.js` — extracted feature modules
15. `features/auth-flow.js` — auth-cache helpers used by `checkAuth()`
16. `features/modal-history.js` — MutationObserver setup
17. `features/deeplink-router.js` — `window.handleDeepLinks`
18. `workout.js`, `push.js`, `app-shell.js` — feature extensions
19. `features/bootstrap.js` — **must be last**. Runs `checkAuth()`, then `maybeUpdateTimezone()` (detects browser timezone via `Intl.DateTimeFormat`, compares against `settings_bundle` cache, prompts on change; errors are swallowed), then `mountCanonicalBottomNav()` (filters `WGBottomNav.DEFAULT_ITEMS` by `window.featureSettings`, mounts the nav into `#app`, and registers an AppKernel module so `switchTab()` mirrors into `ctrl.setActive()`), then the initial `switchTab('today')`, then `AppBackButton.setup()`, then `handleDeepLinks()`.

## Global Namespace Policy

All explicit `window.*` assignments are tracked in `tests/architecture.globals.test.js`. Adding a new global requires updating the allowlist with a justification.

| Global | Source | Consumed by |
|--------|--------|-------------|
| `window.AppKernel` | `core/app-kernel.js` | module registry |
| `window.AppStore` | `core/store.js` | app.js, feature modules |
| `window.ChartUtils` | `core/chart-utils.js` | bp.js, weight.js, health.js |
| `window.ModalManager` | `core/modal-manager.js` | app.js |
| `window.apiCallDirect` | `core/api.js` | data-store.js (change polling) |
| `window.userInitData` | `app.js` | feature files (bp.js, weight.js) |
| `window.onDataStoreUnauthorized` | `app.js` | data-store.js callback |
| `window.requestTabRefresh` | `app.js` | data-store.js change detection |
| `window.reloadCurrentTab` | `app.js` | data-store.js + sync.js |
| `window.handleDeepLinks` | `features/deeplink-router.js` | features/bootstrap.js |
| `window.DataStore` | `data-store.js` | app.js, feature files |
| `window.MedTrackerDB` | `db.js` | sync.js, data-store.js |
| `window.SyncManager` | `sync.js` | features/bootstrap.js |
| `window.offlineAwareApiCall` | `sync.js` | core/api.js |
| `window.SyncDebug` | `sync.js` | dev diagnostics |
| `window.MedTrackerPush` | `push.js` | app.js |
| `window.initServiceWorker` | `app-shell.js` | index.html inline |
| `window.showUpdateToast` | `app-shell.js` | service worker message |
| `window.TodayDashboard` | `features/today.js` | app.js `loadToday()` |
| `window.SectionHeader` | `components/section-header.js` | app.js, features/today.js |
| `window.AppBackButton` | `features/back-button.js` | features/bootstrap.js |
| `window.WGIcons` | `components/wg-icons.js` | `wg-bottom-nav.js`, `features/today.js` (tile icons) |
| `window.WGBottomNav` | `components/wg-bottom-nav.js` | `features/bootstrap.js` (`mountCanonicalBottomNav`) |
| `window.WGSparkline` | `components/wg-sparkline.js` | `features/today.js` (metric tile sparklines) |
| `window.WGPhoneChrome` | `components/wg-phone-chrome.js` | design-system primitive (no runtime consumer yet) |

## Design Tokens

CSS custom properties defined in `:root` of `web/static/css/styles.css`. See the comment block at the top of that file for the full reference.

Key rules (enforced by architecture tests in `web/static/js/tests/architecture.design-tokens.test.js`):

- **No hardcoded colors in CSS** — use `--wg-*` or `--color-*` tokens
- **No inline styles in JS** — use CSS classes (tests scan for `.style.` assignments)
- **No `--wg-*` token may be referenced from JS** — Wandergeek tokens are CSS-only. JS sets *class names*, CSS resolves values. Narrow exceptions (e.g. structural variables like `--wg-nav-cols` on the bottom nav's grid) are allowlisted in `ALLOWED_JS_TOKEN_REFS` inside the architecture test, one file at a time with a justification.
- **Button system (legacy)**: `.btn` base + `.btn-primary` / `.btn-secondary` / `.btn-danger` variants + `.btn-sm` / `.btn-lg` sizes + `.btn-pill` / `.btn-icon` shapes. Being phased out in favor of `.wg-gloss` variants.
- **Spacing / radius / shadow / typography / z-index** all use tokens (`--space-*`, `--radius-*`, `--shadow-*`, `--font-size-*`, `--z-*`, and the Wandergeek `--wg-*` counterparts)
- **Utility classes**: `.flex-row`, `.flex-between`, `.flex-center`, `.text-hint`, `.text-center`, `.hidden`, `.empty-state`, spacing helpers (`.mt-sm`, `.mb-md`, …)

### Wandergeek tokens (`--wg-*`)

The canonical visual system. Every new screen and component uses these. Organized by group (see `WANDERGEEK_TOKENS` in the design-tokens architecture test for the authoritative list):

- **Palette** — raw color primitives: `--wg-paper`, `--wg-paper-deep`, `--wg-paper-soft`; `--wg-ink` + alpha variants (`--wg-ink-85/-70/-55/-35/-15/-08`); `--wg-teal`, `--wg-teal-stage` (deep-teal page background `#0f2522`), `--wg-teal-sage`; `--wg-mint`, `--wg-mint-soft`; `--wg-sun` (`#FBBD0D`, primary accent), `--wg-sun-deep`, `--wg-sun-soft`; `--wg-clay` (`#C6553A`, alert), `--wg-clay-soft`.
- **Semantic** — role-based aliases on top of the palette: `--wg-bg-stage`, `--wg-bg-card`, `--wg-bg-card-inset`; foreground alphas `--wg-fg-1` through `--wg-fg-5`; `--wg-border-hairline`, `--wg-border-strong`.
- **Gloss material** — gradient + shadow strings for the convex tile look: `--wg-gloss-bg`, `--wg-gloss-bg-sun`, `--wg-gloss-bg-clay`, `--wg-gloss-bg-inset`; matching `--wg-gloss-shadow`, `--wg-gloss-shadow-sun`, `--wg-gloss-shadow-inset`.
- **Status tags** — triplets per severity: `--wg-tag-normal-bg/-fg/-border`, `--wg-tag-high-*`, `--wg-tag-alert-*`.
- **Typography** — `--wg-font-display` (JetBrains Mono for headlines and numerics), `--wg-font-ui` (Space Grotesk for body text), `--wg-font-mono` (JetBrains Mono, shared family as display — headlines are intentionally mono).
- **Dimensional** — radii (`--wg-radius-gloss/-icon/-card/-pill`), padding (`--wg-card-pad`, `--wg-phone-pad`, etc.), component sizing (`--wg-icon-btn-size`, `--wg-nav-icon-size`), font sizes (`--wg-font-size-tag`, `--wg-app-header-title-size`, …). Phone chrome, bottom nav, and app header all expose their fixed dimensions as tokens so `no-hardcoded-px` stays green.

Every new `.wg-*` CSS class block must source its colors/gradients/shadows from `var(--wg-*)` — hex literals inside `.wg-*` blocks are caught by `architecture.wg-primitives.test.js`. Every new token must be added to `WANDERGEEK_TOKENS` in the architecture test in the same commit that introduces it.

**Canonical FAB and modal utilities**: `.wg-fab` (in `styles.css`) is the shared floating-action-button positioner — `position: fixed` at bottom-right, offset above the bottom nav via `--wg-bottom-nav-reserved`. Compose it with `.wg-gloss wg-gloss--sun wg-gloss--lg` for the primary section action (see `#add-bp-btn`). `.wg-modal` + `.wg-modal__header` / `.wg-modal__title` / `.wg-modal__body` / `.wg-modal__actions` + the field utilities `.wg-field` / `.wg-field--row` / `.wg-label` / `.wg-input` / `.wg-select` are the shared modal shell — token-driven, teal-stage-aware, with `.wg-gloss` buttons in the actions row. Future section plans (Food edit, Medication record, Weight, Workouts) must reuse these utilities rather than introduce scoped `.wg-bp-*` / `.wg-food-*` variants; the BP screen is the reference consumer.

## Navigation

The app uses the Wandergeek **bottom nav** as the canonical navigation surface, with **Today** as the root of the back stack. Every real section has its own first-class slot — there is no "More" aggregator.

- **Bottom nav** (`components/wg-bottom-nav.js`, exposes `window.WGBottomNav`): `WGBottomNav.mount(rootEl, { items, active, onChange })` renders an absolute-positioned nav with one gloss tile per section. Canonical order via `WGBottomNav.DEFAULT_ITEMS` (frozen): `today, bp, food, meds, weight, workouts, health, settings` (8 slots). Layout is driven by `items.length`: ≤5 → one row, 6–8 → two rows of `Math.ceil(n/2)` columns, >8 throws `RangeError`. Column count is set via the `--wg-nav-cols` CSS variable on the inner grid (the only inline style allowed in the component, allowlisted in `architecture.design-tokens.test.js`). Mounted from `features/bootstrap.js` via `mountCanonicalBottomNav()` before the initial `switchTab('today')`; `DEFAULT_ITEMS` is filtered against `window.featureSettings` so disabled sections are hidden from the nav. Slot clicks route through `switchTab(id)`.
- **Nav ↔ active-tab sync** (`core/app-kernel.js`): `switchTab(tab)` in `app.js` fires `window.AppKernel.onTabSwitch(tab)` after activating the view. `mountCanonicalBottomNav` registers a module whose `onTabSwitch` calls `ctrl.setActive(tab)`, so the nav mirrors whichever tab is active (including deep-link entry points and Telegram BackButton pops). Calling `setActive()` on the already-active button is a no-op.
- **Icon registry** (`components/wg-icons.js`, exposes `window.WGIcons`): `iconSvg(name, { size, stroke })` returns a fresh `<svg>` element for a stroke-icon by name (`home, activity, apple, pill, scale, dumbbell, heart, settings`, plus a few extras). Unknown names throw. Used by the bottom nav and any future toolbar/tile icons — **do not hardcode inline SVG markup in feature code**.
- **Phone chrome** (`components/wg-phone-chrome.js`, exposes `window.WGPhoneChrome`): `WGPhoneChrome.mount(rootEl)` / `WGPhoneChrome.create()` wrap an element in the `.wg-phone` shell (status bar + dynamic island + home indicator). Built and tested as a primitive but **not yet mounted in the runtime** — `index.html` does not load it and `bootstrap.js` does not call `mount()`. It ships for the Phase 3+ screen reskins that will wrap individual views; until then the component is a primitive available to the design system only.
- **AppHeader / back pill** (`components/section-header.js`, exposes `window.SectionHeader`): each non-Today view still mounts a sticky header via the `<div class="section-header-mount" data-title="…">` placeholder. The header now uses the `.wg-app-header` layout (grid `44px 1fr 44px`, JetBrains Mono title with optional mono-caps `<small>` subtitle) and the back pill is a `.wg-icon-btn > .wg-gloss` button. Today passes `onBack: null` to suppress the back pill and uses `rightSlot` for the settings gear. Legacy classes (`section-header`, `section-back`, `section-title`, `section-header-right`) are retained alongside the new `.wg-app-header*` classes for a phased rewrite.
- **Telegram WebApp BackButton** (`features/back-button.js`, exposes `window.AppBackButton`): `setupAppBackButton()` is called from `features/bootstrap.js` after the initial tab activates. It owns the single Telegram `BackButton.onClick` handler: if a modal is open it calls `ModalManager.closeTopMostVisibleModal()`; otherwise it returns to Today via `switchTab('today')`. Visibility tracks `currentTab` via `AppStore.subscribe('currentTab')` — shown on any non-Today view, hidden on Today. Tapping a nav slot is a lateral jump (no back stack); tapping into a deep view from a card creates a back stack.
- **`tab_order` persistence**: the `tab_order` array in `settings_bundle` and the `POST /api/settings/tab-order` endpoint are still read/written, but the Wandergeek Today layout is fixed (next-action → vitals → fuel → plan → streak) and `renderToday()` does not consume `opts.cardOrder` — the stored preference is inert until a reorderable surface lands. Bottom nav order is **not** user-reorderable either.
- **Sub-tab groups inside section views stay** (`.med-tabs`, `.workout-tabs`, `.food-tabs`, `.health-tabs`): use `bindTabGroup()` / `activateTabGroup()`. Health sub-tabs are "Overview" (charts) and "Notes" (diary); Notes loads lazily.
- **Accessibility**: the bottom nav uses `<nav>` with each slot as a `<button aria-current="page">` when active. Section headers use `<header>` with the title as an `<h2>`. The back pill has `aria-label="Back to Today"`. Today's gear has `aria-label="Settings"`. No `role="tablist"` anywhere — navigation is landmark-based, not tab-widget-based.
- **Deep-link router** (`features/deeplink-router.js`, `window.handleDeepLinks`): URL hash and `tgWebAppStartParam` still route to any section by name. Deep links land directly on the section with the bottom nav highlighting it and the sticky header + BackButton visible, bypassing Today.

## Data Flow

### Write path

```
User Action (e.g., log BP reading)
       │
       ▼
offlineAwareApiCall()          ← Layer 3 (sync.js)
       │
       ├── Online? ──→ POST /api/bp ──→ Server ──→ SQLite
       │                    │
       │                    └── Success → invalidate SWR cache (Layer 4)
       │
       └── Offline? ──→ BPStore.save() ──→ IndexedDB (Layer 2)
                              │
                              └── Register SW background sync
                                        │
                                        ▼ (when online again)
                              SyncManager.syncAll()
                                        │
                                        ▼
                              POST /api/bp (for each pending item)
                                        │
                                        └── Success → delete from IndexedDB
```

### Read path

```
Page Load (e.g., BP tab)
       │
       ▼
loadSWR({ cacheKey, fetchFn })     ← Layer 4 (data-store.js)
       │
       ├── Return cached data immediately → render UI
       │
       └── Fetch fresh data in background
              │
              ├── Success → update cache, call onFresh → re-render UI
              └── Failure → keep showing cached data (no error shown)
```
