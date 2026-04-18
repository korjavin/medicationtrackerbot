# Frontend

Vanilla JavaScript (no framework), Dexie.js for IndexedDB, Telegram WebApp SDK for theme integration.

## Local-First Architecture

Four layers:

1. **Service Worker** — precaches all static assets (~25 JS files, CSS, vendor libs, icons, manifest) for a full offline app shell
2. **IndexedDB** — write-ahead queue for offline writes + generic `api_cache` for SWR
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

Polls `/api/changes?since=` every 30s (SSE disabled due to HTTP/2 proxy issues — see [technical-decisions.md](technical-decisions.md)).

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
19. `features/bootstrap.js` — **must be last**. Runs `checkAuth()` then `maybeUpdateTimezone()` (detects browser timezone via `Intl.DateTimeFormat`, compares against `settings_bundle` cache, prompts on change; errors are swallowed).

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

## Design Token System

CSS custom properties defined in `:root` of `web/static/css/styles.css`. See the comment block at the top of that file for the full reference.

Key rules (enforced by architecture tests in `web/static/js/tests/architecture.design-tokens.test.js`):

- **No hardcoded colors in CSS** — use `--color-*` tokens
- **No inline styles in JS** — use CSS classes (tests scan for `.style.` assignments)
- **Button system**: `.btn` base + `.btn-primary` / `.btn-secondary` / `.btn-danger` variants + `.btn-sm` / `.btn-lg` sizes + `.btn-pill` / `.btn-icon` shapes
- **Spacing / radius / shadow / typography / z-index** all use tokens (`--space-*`, `--radius-*`, `--shadow-*`, `--font-size-*`, `--z-*`)
- **Utility classes**: `.flex-row`, `.flex-between`, `.flex-center`, `.text-hint`, `.text-center`, `.hidden`, `.empty-state`, spacing helpers (`.mt-sm`, `.mb-md`, …)

## Tabs and Navigation

- **Tab Reordering** (`tabs-dnd.js`): drag-and-drop for custom tab layouts, persisted via `tab_order` in the bootstrap payload and cached in `settings_bundle`
- **Tab Icons**: inline SVGs (stroke-based, `currentColor`) replace emoji; all tab buttons have `aria-label`
- **Health Sub-Tabs**: "Overview" (vitals/sleep/steps charts) and "Notes" (diary notes) using `bindTabGroup()` / `activateTabGroup()` (same pattern as the Food tab). Notes load lazily on first sub-tab click; default is Overview.

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
