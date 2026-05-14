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

### Local-First Read Resilience

When the app is offline (or the backend returns 5xx behind Traefik) every priority section renders cached data instead of an empty screen — *something stale is better than nothing*. The mechanism is `cachedFetch` (`web/static/js/cached-fetch.js`) on top of the existing `api_cache` Dexie store, plus a small `<wg-stale-badge>` chip that surfaces freshness.

**`cachedFetch(key, url, opts)`** — read-through wrapper, exposed as `window.cachedFetch`. Returns `{ data, fetchedAt, isFromCache, isStale }`. Behaviour matrix:

| State | Behaviour |
|-------|-----------|
| Cache hit, online | Return cached immediately, kick off background revalidation (SWR) |
| Cache miss, online | Fetch, write to cache, return fresh |
| Cache hit, offline / 5xx | Return cached with `isFromCache: true`; sets `isStale: true` if age > `staleAfterMs` |
| Cache miss, offline / 5xx | Throw `OfflineNoCacheError` so callers render an explicit empty state |

Options: `tags` (forwarded to `cacheApiSnapshot`), `freshAfterMs` (default 60s — background revalidate after this), `staleAfterMs` (default 24h — flip the badge tone past this), `transform` (raw → cached value), `fetchOpts.method/body`. The 5xx-as-offline check reuses `window.isServerError` from `sync.js` when available, with an inline fallback so the helper works in isolation.

**`OfflineNoCacheError`** — typed error (`window.OfflineNoCacheError`) raised only when no cache *and* network is unavailable. Every consumer must catch it and render a friendly empty state. Current consumers: `app.js` (Today's Next Medication tile), `features/food.js` (daily food log + products cache).

**`<wg-stale-badge>`** — `web/static/js/components/wg-stale-badge.js`, exposes `window.WGStaleBadge`. Two entry points:
- `WGStaleBadge.render({ fetchedAt, isOffline, staleAfterMs, now })` — returns an HTMLElement chip
- `WGStaleBadge.mountFromKey({ slot, key, staleAfterMs, fallbackFetchedAt })` — reads `api_cache[key].timestamp` and paints the chip into a slot element

Tone classes (defined in `styles.css`, no inline styles): `.wg-stale-badge--neutral`, `.wg-stale-badge--warning`, `.wg-stale-badge--offline`. Label format: `Updated 5m ago` / `Updated 2h ago` (online), `Offline · 12m old` / `Offline · 3h old` (offline), `Offline · no cache` (cold-start offline).

**Per-section freshness windows** — `freshAfterMs` controls how often we revalidate online; `staleAfterMs` flips the badge tone. The canonical list of cache keys, their invalidation tags, and the freshness windows below lives in `web/static/js/core/cache-keys.js`; `CacheKeys.registerAll(window.DataStore)` runs once at boot so tag-based invalidation works regardless of which feature has executed its first loader. Add new keys to that registry rather than passing inline `tags:` arrays at every `cachedFetch` call site. The table below mirrors the registry for reference:

| Section | Cache key(s) | freshAfterMs | staleAfterMs |
|---------|--------------|--------------|--------------|
| Today next-intake | `next_intake` | 5 min | 12 h |
| Food daily log | `food_<date>_day` | 60 s | 24 h |
| Food products | `food_products_cache` | 1 h | 7 d |
| BP / Weight / Meds / Workouts / Vitals | `bp`, `weight`, `medications`, `history_<days>_<medId>`, `workout_next`, `workout_history`, `workout_groups`, `health_overview_<…>`, `diary_notes` | n/a (existing `offlineAwareApiCall` reads) | inherits the badge default (1 h) — chip uses `mountFromKey` against the bootstrap-warmed key (Workouts History reads the older of `workout_next` / `workout_history` so the chip never disagrees with the list below) |

The "rolling-out" sections (BP, Weight, Meds, Workouts, Vitals) keep their existing `offlineAwareApiCall` read paths; only the badge is mounted via `mountFromKey`. Only Today's Next Medication tile and Food (daily log + products) actually route through `cachedFetch` for the read itself.

**Bootstrap interaction**: `/api/bootstrap` continues to seed `medications`, `next_intake`, `bp`, `weight`, `food_<date>_day`, `settings_bundle`, etc. via `cacheApiSnapshot`. `cachedFetch` simply reads from the same store, so bootstrap-warmed entries are immediately usable as the first cache hit on any consumer.

**`DataStore.hydrateFromDexie(key, dexieLoader, opts)`** — cold-start hydration primitive used when the app relaunches offline and `/api/bootstrap` never returns. Reads from a feature's Dexie store (e.g. `MedTrackerDB.MedicationStore.loadCache()`) and seeds `DataStore.setCachedWithTags` so subsequent `loadSWR` / `getCached` calls find data on the very first paint. Signature: `(key, async dexieLoader, { transform?, tags? }) => { hydrated, fetchedAt }`. Never throws — empty Dexie or loader errors return `{ hydrated: false }`. Skips the seed if the in-memory cache is already fresher than the Dexie record. Canonical wiring lives in `app.js` early-init (before `await fetchBootstrap()`): `hydrateMedicationsFromDexie()` seeds the `medications` key from `MedTrackerDB.MedicationStore.loadCache()`, and `hydrateSectionsFromDexie()` seeds the remaining section-level `api_cache` rows from `MedTrackerDB.ApiCache.getWithMeta(key)`. Both are gated on auth presence (Telegram `initData` OR a cached auth state) so a fully unauthenticated cold start does not surface a former user's cache. Per-section hydration map (every entry is seeded in parallel during `checkAuth()` and consumed by the listed loader):

| Section | Cache key | Dexie loader | Consumer (loader) |
|---------|-----------|--------------|-------------------|
| Medications | `medications` | `MedTrackerDB.MedicationStore.loadCache()` | `loadMeds()` in `features/meds.js` (and Today's next-intake tile via the same key) |
| BP | `bp` | `MedTrackerDB.ApiCache.getWithMeta('bp')` | `loadBPReadings()` in `features/bp.js` (bundled `{readingsRes, goalRes, statsRes}`) |
| Weight | `weight` | `MedTrackerDB.ApiCache.getWithMeta('weight')` | `loadWeightLogs()` in `features/weight.js` (bundled `{logsRes, goalRes}`) |
| Workouts — Next | `workout_next` | `ApiCache.getWithMeta('workout_next')` | `loadNextWorkout()` in `features/workout.js` + Today's next-workout tile |
| Workouts — History | `workout_history` | `ApiCache.getWithMeta('workout_history')` | `loadWorkoutHistoryTab()` in `features/workout.js` |
| Workouts — Groups | `workout_groups` | `ApiCache.getWithMeta('workout_groups')` | `loadWorkoutGroups()` in `features/workout.js` |
| Workouts — Exercises | `exercise_library` | `ApiCache.getWithMeta('exercise_library')` | `loadExerciseLibrary()` in `features/workout.js` |
| Workouts — Stats | `workout_stats` | `ApiCache.getWithMeta('workout_stats')` | `loadWorkoutStatsTab()` in `features/workout.js` |
| Vitals — Overview | `health_overview_<tz>` (TZ-qualified; with a most-recent-`health_overview_*` fallback when the current TZ has no row) | `ApiCache.getWithMeta(healthOverviewCacheKey())` + `ApiCache.findMostRecentByPrefix('health_overview_')` | `loadHealthOverview()` in `features/health.js` |
| Vitals — Notes | `diary_notes` | `ApiCache.getWithMeta('diary_notes')` | `loadNotes()` in `features/health.js` |
| Food — Today | `food_<YYYY-MM-DD>_day` (via `todayFoodKey(new Date())`) | `ApiCache.getWithMeta(todayFoodKey)` | `loadFoodLogs()` in `features/food.js` (via `cachedFetch`) + Today's food summary tile |
| Settings | `settings_bundle` | `ApiCache.getWithMeta('settings_bundle')` | `loadSettings()` in `app.js` |

Each consumer mounts a `WGStaleBadge.mountFromKey({ slot, key: <same key> })` chip so the freshness of the hydrated row is visible on the cold-start render. Sections that read via `apiCall` (silent null on offline) — BP, Weight, Workouts Exercises, Vitals Notes — additionally use a `renderedSomething` post-`loadSWR` fallback to paint an explicit empty state when neither `onCached` / `onFresh` / `onError` fires (mirrors the meds pattern).

**Out of scope (explicitly)**: this layer is read-only. No new offline write queues (food/notes/workouts), no full "IndexedDB is source of truth" rewrite. Cold-start offline is now in scope for sections that adopt `hydrateFromDexie` (medications first; others follow).

**Architecture guard — `web/static/js/tests/architecture.offline-coverage.test.js`** — every file under `web/static/js/features/*.js` must either use one of the offline-aware primitives (`cachedFetch(`, `loadSWR(`, `hydrateFromDexie(`, `offlineAwareApiCall(`) OR appear in the test's `ALLOWLIST` array with a `reason` string. Adding a new section file therefore forces a choice: route reads through a primitive, or document why it doesn't need one. The test runs four sub-assertions: (1) every features file is either using a primitive or allowlisted; (2) every allowlist entry has a non-empty `reason`; (3) every allowlisted file actually exists under `features/`; (4) no allowlisted file already adopts a primitive (dead entries fail the suite, so the allowlist cannot ossify).

**How to add an allowlist entry** — open `architecture.offline-coverage.test.js`, append to the `ALLOWLIST` const an object of the form `{ file: 'your-file.js', reason: '<one-line justification>' }`, then re-run `pnpm test -- architecture.offline-coverage`. The justification must explain why the file does not need an offline-aware read primitive — current acceptable categories are pure UI helpers (e.g. `auth-flow.js`), event-driven indicators (`call-indicator.js`), pure routing (`deeplink-router.js`), transient one-shot fetches whose failure mode is "the widget simply doesn't appear" (`tz-plan-banner.js`, `elevenlabs-call.js`), DOM observers (`modal-history.js`), and aggregation/render contracts that consume caches seeded elsewhere (`today.js`). If your file does not fit one of those shapes, adopt a primitive instead.

### Change Detection

Polls `/api/changes?since=` every 30s (SSE disabled due to HTTP/2 proxy issues — see [technical-decisions.md](technical-decisions.md)). When the poll reports invalidated tags, `data-store.js` both calls `window.requestTabRefresh({ changedTags, source })` (debounced 500ms, reloads the active tab) **and** dispatches a `datastore:changed` CustomEvent on `window` with `detail = { changedTags, source }`. Features that need to react without owning the active tab (e.g. the Today dashboard's live-update subscriber) listen on the CustomEvent.

### Cross-section Auto-refresh Invariant

After any local create/update/delete, the originating screen must do **both**:

1. Call its own loader to repaint in place (e.g. `loadBPReadings()`, `loadNotes()`).
2. Call `window.DataStore.invalidateTags([tag])` so Today tiles and other listeners refresh without a tab switch.

Tag vocabulary: `bp`, `weight`, `medications`, `history`, `food`, `workouts`, `health-notes`. Tags are also emitted server-side by SQLite triggers (migration 027+) and surface through the change-polling path above, so remote edits propagate by the same route.

### SW Cache Strategy

- All static assets listed in the `STATIC_ASSETS` array, validated bidirectionally by `architecture.sw-precache.test.js`: every `<script src>` / `<link rel="stylesheet">` in `index.html` must appear in `STATIC_ASSETS` (no offline breakage), and every precached `/static/js/*.js` entry must appear as a `<script src>` in `index.html` or in the test's `SW_SELF_IMPORTS` allowlist (no dead code shipped in the SW cache)
- `/api/bootstrap`: stale-while-revalidate
- Other API GETs: network-first with cache fallback
- Only cache `GET` responses as fallbacks; never cache `POST`/`PATCH`/`DELETE`
- Cache busting via timestamp replacement in Dockerfile

## Script Load Order (`index.html`)

Loading order matters — there is no bundler; cross-file communication happens via `window.*` globals.

1. `core/utils.js` — `safeAlert`, `safeConfirm` (in-app confirm dialog; uses Telegram's `tg.showConfirm` when running inside the Telegram WebApp, falls back to an `<mt-modal>` overlay in a plain browser — never the synchronous native `confirm()`, which would block first paint), format helpers
2. `components/mt-elements.js` — registers `<mt-modal>`, `<mt-setting-toggle>`
3. `components/empty-state.js`, `stat-card.js`, `action-row.js` — UI primitives
3b. `components/wg-icons.js`, `wg-bottom-nav.js`, `wg-sparkline.js`, `wg-phone-chrome.js`, `wg-bp-chart.js`, `wg-weight-chart.js`, `wg-workout-chart.js`, `wg-macro-bar.js`, `wg-sleep-chart.js`, `wg-steps-chart.js`, `wg-vitals-chart.js` — Wandergeek design-system primitives (icon registry, bottom nav, sparkline, phone-chrome, BP chart, weight chart with optional goal overlay, workout sessions-per-week chart, macro bar, sleep stacked-bar chart with HR overlay, steps bar chart, vitals area+line chart parameterised by `vital`). Must load before `features/bootstrap.js` mounts the bottom nav, before `today.js` renders sparklines, before `features/food.js` renders the daily macros card, before `features/workout.js` renders the Stats sub-tab chart, and before `features/health.js` renders the Overview sub-tab sleep/steps/vitals cards.
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
14. `features/food.js`, `features/bp.js`, `features/weight.js`, `features/meds.js`, `features/workout.js`, `features/health.js` — extracted feature modules
15. `features/auth-flow.js` — auth-cache helpers used by `checkAuth()`
16. `features/modal-history.js` — MutationObserver setup
17. `features/deeplink-router.js` — `window.handleDeepLinks`
18. `push.js`, `app-shell.js` — feature extensions
19. `features/bootstrap.js` — **must be last**. Runs `checkAuth()`, then `mountCanonicalBottomNav()` (filters `WGBottomNav.DEFAULT_ITEMS` by `window.featureSettings`, mounts the nav into `#app`, and registers an AppKernel module so `switchTab()` mirrors into `ctrl.setActive()`), then the initial `switchTab('today')`, then schedules `maybeUpdateTimezone()` via `queueMicrotask` so the TZ-mismatch prompt (`safeConfirm` → `<mt-modal>` in browser, `tg.showConfirm` in Telegram) runs after first paint and never blocks the visible shell, then `AppBackButton.setup()`, then `handleDeepLinks()`.

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
| `window.weightUnitPreference` | `app.js` (hydrated from `/api/bootstrap`) | `features/weight.js`, `features/today.js`, `core/utils.js`; `'kg'` or `'lb'`, written back via `PATCH /api/settings/weight-unit` |
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
| `window.AppBackButton` | `features/back-button.js` | features/bootstrap.js |
| `window.WGIcons` | `components/wg-icons.js` | `wg-bottom-nav.js`, `features/today.js` (tile icons) |
| `window.WGBottomNav` | `components/wg-bottom-nav.js` | `features/bootstrap.js` (`mountCanonicalBottomNav`) |
| `window.WGSparkline` | `components/wg-sparkline.js` | `features/today.js` (metric tile sparklines) |
| `window.WGPhoneChrome` | `components/wg-phone-chrome.js` | design-system primitive (no runtime consumer yet) |
| `window.WGMacroBar` | `components/wg-macro-bar.js` | `features/food.js` (daily macros card rows: Energy/Protein/Carbs/Fat) |
| `window.WGWeightChart` | `components/wg-weight-chart.js` | `features/weight.js` (weight history chart panel with optional goal overlay) |
| `window.WGWorkoutChart` | `components/wg-workout-chart.js` | `features/workout.js` (Stats sub-tab sessions-per-week trend chart) |
| `window.WGSleepChart` | `components/wg-sleep-chart.js` | `features/health.js` (Overview sub-tab sleep stacked-bar + HR overlay card) |
| `window.WGStepsChart` | `components/wg-steps-chart.js` | `features/health.js` (Overview sub-tab steps bar card) |
| `window.WGVitalsChart` | `components/wg-vitals-chart.js` | `features/health.js` (Overview sub-tab HR / SpO2 / Stress area+line cards, parameterised by `vital`) |
| `window.WGStaleBadge` | `components/wg-stale-badge.js` | `features/today.js`, `features/food.js`, `features/bp.js`, `features/weight.js`, `features/meds.js`, `features/workout.js`, `features/health.js` (per-section freshness chip) |
| `window.cachedFetch` | `cached-fetch.js` | `app.js` (Today next_intake), `features/food.js` (daily log + products) |
| `window.OfflineNoCacheError` | `cached-fetch.js` | same consumers as `cachedFetch` (catch-and-render-empty-state branch) |

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
- **Dimensional** — radii (`--wg-radius-gloss/-icon/-card/-pill`), padding (`--wg-card-pad`, `--wg-phone-pad`, etc.), component sizing (`--wg-icon-btn-size`, `--wg-nav-icon-size`), font sizes (`--wg-font-size-tag`, `--wg-font-size-metric-value`, `--wg-food-kcal-display-size`, `--wg-food-kcal-pct-size`, …). Phone chrome, bottom nav, metric tiles, and macros card all expose their fixed dimensions as tokens so `no-hardcoded-px` stays green.
- **Chart theme** — shared tokens consumed by both the BP and Weight chart surfaces so new chart components stay visually flush (introduced in round-2 Task 13): `--wg-chart-card-bg` / `--wg-chart-card-border` / `--wg-chart-card-radius` / `--wg-chart-card-pad` (panel surface), `--wg-chart-guide-stroke` / `--wg-chart-guide-stroke-width` / `--wg-chart-guide-dasharray` (dashed grid guides), `--wg-chart-axis-tick-color` / `--wg-chart-axis-tick-size` (x/y tick labels). All new chart components must consume these rather than reintroduce per-chart colors. Legacy per-chart tokens (e.g. `--wg-bp-chart-guide-*`) are kept as passthrough aliases resolving back to the shared set. Adoption pinned by `architecture.chart-theme.test.js`.

Every new `.wg-*` CSS class block must source its colors/gradients/shadows from `var(--wg-*)` — hex literals inside `.wg-*` blocks are caught by `architecture.wg-primitives.test.js`. Every new token must be added to `WANDERGEEK_TOKENS` in the architecture test in the same commit that introduces it.

**Canonical primary-action placement and modal utilities**: primary section actions (+Log / +Add / +Start / +Take) render **inline** with the tab strip, range selector, or day navigator — never as a floating FAB and never as a bottom CTA dock. The `.wg-fab` class has been retired; compose the action as a `.wg-toolbar-btn wg-toolbar-btn--primary` pill nested in the strip (see `#add-bp-btn` inside `#bp-range-selector`, `#add-btn` inside `.wg-meds-schedule-header`, `#start-adhoc-workout-btn` inside `.wg-workouts-subtabs-row`, `#add-weight-btn` inside the weight range-selector row, `#add-food-inline-btn` inside `.wg-food-day-nav`). Round-2 Task 3 removed the food-screen sticky `.wg-food-cta-dock` so the inline day-nav pill is now the only Add-food affordance, matching every other section. `.wg-modal` + `.wg-modal__header` / `.wg-modal__title` / `.wg-modal__body` / `.wg-modal__actions` + the field utilities `.wg-field` / `.wg-field--row` / `.wg-label` / `.wg-input` / `.wg-select` are the shared modal shell — token-driven, teal-stage-aware, with `.wg-gloss` buttons in the actions row. New sections must reuse these utilities rather than introduce scoped `.wg-bp-*` / `.wg-food-*` variants; the BP screen is the reference consumer.

**Shared toolbar-row action button (`.wg-toolbar-btn`)**: introduced in Round-2 defects Task 2 to unify the "primary action pill sitting next to a range/subtab track" pattern across BP, Weight, Meds, Workouts, and Food. The base class owns all sizing/padding/radius (height `var(--wg-toolbar-btn-height)`, currently `36px` to match sibling range pills); the variant modifiers are color-only. Use `.wg-toolbar-btn--primary` for the canonical add/log/start action (yellow sun-gloss fill) and `.wg-toolbar-btn--secondary` for outline/ghost actions on the teal stage (e.g. the Workouts "Next workout" card's Skip / Stop / Next Variant, introduced with Round-2 Task 10). Never size the button via a per-section `__add` class — add/replace the variant on the shared base instead. Adoption is pinned by `architecture.toolbar-btn.test.js` and per-section DOM tests (`bp.render.test.js`, `food.toolbar-row.test.js`, `meds.schedule-add.test.js`, `workout.design-parity.test.js`, `weight.history.test.js`).

## Navigation

The app uses the Wandergeek **bottom nav** as the canonical navigation surface, with **Today** as the root of the back stack. Every real section has its own first-class slot — there is no "More" aggregator.

- **Bottom nav** (`components/wg-bottom-nav.js`, exposes `window.WGBottomNav`): `WGBottomNav.mount(rootEl, { items, active, onChange })` renders an absolute-positioned nav with one gloss tile per section. Canonical order via `WGBottomNav.DEFAULT_ITEMS` (frozen): row 1 `today, bp, food, meds`, row 2 `health, workouts, weight, settings` (8 slots). The `health` slot renders with the label "Vitals"; its internal id stays `health` for deeplink + localStorage stability (URLs like `#health`, the `mt-health-*` storage keys, and the `health` feature-flag key all continue to resolve). Layout is driven by `items.length`: ≤5 → one row, 6–8 → two rows of `Math.ceil(n/2)` columns, >8 throws `RangeError`. Column count is set via the `--wg-nav-cols` CSS variable on the inner grid (the only inline style allowed in the component, allowlisted in `architecture.design-tokens.test.js`). Mounted from `features/bootstrap.js` via `mountCanonicalBottomNav()` before the initial `switchTab('today')`; `DEFAULT_ITEMS` is filtered against `window.featureSettings` (order-preserving `.filter()`) so disabled sections are hidden from the nav without shifting the remaining slots. Slot clicks route through `switchTab(id)`.
- **Nav ↔ active-tab sync** (`core/app-kernel.js`): `switchTab(tab)` in `app.js` fires `window.AppKernel.onTabSwitch(tab)` after activating the view. `mountCanonicalBottomNav` registers a module whose `onTabSwitch` calls `ctrl.setActive(tab)`, so the nav mirrors whichever tab is active (including deep-link entry points and Telegram BackButton pops). Calling `setActive()` on the already-active button is a no-op.
- **Icon registry** (`components/wg-icons.js`, exposes `window.WGIcons`): `iconSvg(name, { size, stroke })` returns a fresh `<svg>` element for a stroke-icon by name (`home, activity, apple, pill, scale, dumbbell, heart, settings`, plus a few extras). Unknown names throw. Used by the bottom nav and any future toolbar/tile icons — **do not hardcode inline SVG markup in feature code**.
- **Phone chrome** (`components/wg-phone-chrome.js`, exposes `window.WGPhoneChrome`): `WGPhoneChrome.mount(rootEl)` / `WGPhoneChrome.create()` wrap an element in the `.wg-phone` shell (status bar + dynamic island + home indicator). Built and tested as a primitive but **not yet mounted in the runtime** — `index.html` does not load it and `bootstrap.js` does not call `mount()`. It ships for the Phase 3+ screen reskins that will wrap individual views; until then the component is a primitive available to the design system only.
- **No section headers**: screens sit directly on the teal stage — the `components/section-header.js` component and the `<div class="section-header-mount" data-title="…">` placeholders have been removed. The bottom-nav active pill is the sole screen indicator. The Telegram `BackButton` (see below) remains the only "go back" affordance on non-Today views.
- **Telegram WebApp BackButton** (`features/back-button.js`, exposes `window.AppBackButton`): `setupAppBackButton()` is called from `features/bootstrap.js` after the initial tab activates. It owns the single Telegram `BackButton.onClick` handler: if a modal is open it calls `ModalManager.closeTopMostVisibleModal()`; otherwise it returns to Today via `switchTab('today')`. Visibility tracks `currentTab` via `AppStore.subscribe('currentTab')` — shown on any non-Today view, hidden on Today. Tapping a nav slot is a lateral jump (no back stack); tapping into a deep view from a card creates a back stack.
- **`tab_order` persistence**: the `tab_order` array in `settings_bundle` and the `POST /api/settings/tab-order` endpoint are still read/written, but the Wandergeek Today layout is fixed (shortcut row → metric grid → food card → workout/sleep row → meds card) and `renderToday()` does not consume `opts.cardOrder` — the stored preference is inert until a reorderable surface lands. Bottom nav order is **not** user-reorderable either.
- **Sub-tab groups inside section views** (`.med-tabs`, `.workout-tabs`, `.health-tabs`): use `bindTabGroup()` / `activateTabGroup()`. Meds sub-tabs are History (default) / Schedule / Inventory; Workouts sub-tabs are History / Groups / Exercises / Stats; Health sub-tabs are Overview (charts) / Notes (diary, loads lazily). The Food screen has **no outer sub-tab strip** — the legacy `.wg-food-subtabs` (log / meals / fooddb) was dropped; Daily vs Weekly now lives as an in-card segmented toggle inside `#food-macros-card`, and My Meals + Food DB are reachable via a collapsible `#food-library-view` entry under the day navigator. Sub-tab state persists under `mt-<section>-subtab` — `mt-meds-subtab` (values `schedule` / `history` / `inventory`, **default `history`**) uses `sessionStorage` so every fresh launch lands on History regardless of prior in-session picks (round-2 Task 4); legacy `localStorage['mt-meds-subtab']` values are purged on module load. `mt-workouts-subtab` (values `history` / `groups` / `exercises` / `stats`) and `mt-health-subtab` (values `overview` / `notes`) still use `localStorage`. Range selectors use `localStorage` with the same key convention: `mt-bp-range` (values `14` / `30` / `60`, **default `14`** — round-2 Task 2), `mt-weight-range` / `mt-workouts-stats-range` (values `7d` / `30d` / `90d` / `all`, default `30d`), and `mt-health-range` (values `7d` / `30d`, default `7d`).
- **Food screen shell**: `#food-view.view.wg-screen-stage` mirrors the BP backdrop. The day navigator sits at the top of `#food-view` and carries an inline `#add-food-inline-btn` sun-gloss "+ Add" pill next to the chevron row; the macros card below it exposes the Daily/Weekly segmented toggle. Round-2 Task 3 removed the previous sticky `.wg-food-cta-dock` at the bottom of `#food-log-tab`; the inline header pill is now the only Add-food entry point, matching `.local/design-reference/project/screens.jsx` FoodScreen.
- **Accessibility**: the bottom nav uses `<nav>` with each slot as a `<button aria-current="page">` when active. Screens have no top-level header element — the bottom-nav active pill is the screen indicator and the Telegram BackButton (`aria-label="Back to Today"` when shown) handles upward navigation. No `role="tablist"` anywhere — navigation is landmark-based, not tab-widget-based.
- **Deep-link router** (`features/deeplink-router.js`, `window.handleDeepLinks`): URL hash and `tgWebAppStartParam` still route to any section by name (including `health`, which renders under the "Vitals" nav label). Deep links land directly on the section with the bottom nav highlighting it and the Telegram BackButton visible, bypassing Today.

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
