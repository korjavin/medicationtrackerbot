# Architecture

## System Overview

MedTrackerBot is a monolithic Go application serving as both a Telegram Bot and an HTTP server, with a vanilla JavaScript PWA frontend. The frontend follows a **Local First** approach: the UI renders from local cache immediately, syncs with the server in the background, and supports offline writes for critical health actions.

```
User
├── Telegram Chat ──→ Bot (commands, callbacks) ──→ SQLite
└── Web App (PWA) ──→ HTTP Server (REST API) ──→ SQLite
                       ↕
                   Scheduler (notifications, reminders)
```

## Backend

### Entry Points

| Binary | Path | Purpose |
|--------|------|---------|
| bot | `cmd/bot/` | Main app: HTTP server + Telegram bot + scheduler |
| mcptool | `cmd/mcptool/` | MCP server for AI integration (read-only) |
| importer | `cmd/importer/` | Apple Health medication import |
| bpimporter | `cmd/bpimporter/` | Blood pressure CSV import |
| genvapid | `cmd/genvapid/` | VAPID key generation for web push |

### Core Packages

| Package | Path | Responsibility |
|---------|------|----------------|
| store | `internal/store/` | SQLite repository, goose migrations, all DB queries |
| server | `internal/server/` | REST API handlers (auth middleware, CORS, routing) |
| bot | `internal/bot/` | Telegram bot logic (commands, inline callbacks, notifications) |
| scheduler | `internal/scheduler/` | Periodic jobs: medication/workout/BP/weight reminders |
| mcp | `internal/mcp/` | Model Context Protocol server (health data tools for AI) |
| rxnorm | `internal/rxnorm/` | Drug interaction checking via NLM RxNorm API |
| webpush | `internal/webpush/` | Web push notification delivery |

### Database

SQLite with 27 goose migrations in `internal/store/migrations/`. Key tables:

- `medications`, `intake_log` — medication management and dose history
- `blood_pressure_readings` — BP tracking
- `weight_logs` — weight with trend (EMA)
- `workout_groups`, `workout_variants`, `workout_exercises` — hierarchical workout structure
- `workout_sessions`, `workout_exercise_logs` — workout history
- `workout_rotation_state` — rotating schedule position
- `sleep_logs` — sleep tracking
- `food_log`, `food_products`, `food_targets` — food intake and nutrition
- `push_subscriptions` — web push subscriptions
- `bp_reminders`, `weight_reminders` — reminder configuration
- `change_events` — server-side change tracking for cache invalidation

Migrations auto-run on startup via `store.New()`. Never modify existing migrations.

### Authentication

Three auth methods, checked in this order by middleware:

1. **Telegram WebApp** — HMAC-SHA256 validation of `initData` (primary for Mini App)
2. **Session cookie** — 30-day httpOnly cookie set after OIDC/Google login
3. **OIDC / Google OAuth** — browser login outside Telegram

All methods resolve to a user ID checked against `ALLOWED_USER_ID`.

### Scheduler

Runs a 1-minute ticker. Each tick:
- Checks medication schedules, sends Telegram + web push notifications 15 min before due time
- Checks workout schedules, creates sessions, sends notifications
- Checks BP/weight reminder schedules
- Handles snooze expiry (re-sends notification when `snooze_until` passes)
- Retries unconfirmed medication reminders hourly

---

## Frontend — Local First Architecture

The web frontend is a vanilla JS PWA (`web/static/`) with four cooperating layers that provide offline capability and instant UI rendering.

### Design Principles

1. **Show cached data immediately**, fetch fresh data in the background
2. **Offline writes for critical actions** (BP, weight, medication intake)
3. **Graceful degradation**: treat HTTP 502/503/504 as "offline" (the app runs behind Traefik, where `navigator.onLine` stays `true` even when the backend is down)
4. **No frameworks**: vanilla JS, Dexie.js for IndexedDB, native Service Worker API

### Layer 1: Service Worker (`web/static/sw.js`)

Intercepts all fetch requests. Strategies by request type:

| Request | Strategy | Details |
|---------|----------|---------|
| Static assets (`/static/*`, `/`) | Cache-first | Pre-cached on install; background update on fetch |
| API GETs (`/api/*`) | Network-first | Success → clone to cache. On 5xx or network error → serve from cache. No cache → synthesize `503 {error: "offline"}` |
| SSE (`/api/changes/stream`) | Passthrough | Never intercepted |
| Non-GET requests | Passthrough | Never cached |

The SW also handles:
- **Background sync** — listens for `sync` events and delegates to the main thread via `postMessage`
- **Push notifications** — displays notifications and handles action buttons (confirm/snooze/skip) directly from the SW

**Important limitation**: Background sync delegates to the main thread. If no app tab is open when sync fires, pending items won't sync until the app is opened again.

### Layer 2: IndexedDB Local Store (`web/static/js/db.js`)

Uses Dexie.js (IndexedDB wrapper). Schema v5:

| Store | Purpose | TTL |
|-------|---------|-----|
| `bp_readings` | Offline write queue for BP | Until synced |
| `weight_logs` | Offline write queue for weight | Until synced |
| `intake_queue` | Offline write queue for medication confirmations | Until synced |
| `medication_cache` | Full medications list | 7 days |
| `intake_history_cache` | History tab results | 30 minutes |
| `workout_cache` | Workout groups/sessions | 30 minutes |
| `food_products_cache` | Recent food products | 7 days |
| `api_cache` | Generic SWR store (all API responses) | No TTL on reads; pruned by key type (3–14 days) |

**Write queues** use `syncStatus`: `pending` → `synced` → removed. After successful sync, records are deleted from IndexedDB (it's a write-ahead queue, not a full offline replica).

### Layer 3: Sync Manager (`web/static/js/sync.js`)

Coordinates online/offline transitions and provides `offlineAwareApiCall()` — the main entry point for all API calls in the app.

**`offlineAwareApiCall(endpoint, method, body)` logic:**

```
Is offline (or network error)?
├── Write to supported endpoint? → Queue in IndexedDB, return optimistic response
├── GET request? → Return from IndexedDB cache
└── Other write? → Return null (silently fails)

Is online?
├── Try network request
├── Success → Return response
└── Network error / 5xx?
    ├── Write to supported endpoint? → Queue in IndexedDB
    ├── GET? → Return from cache
    └── Other → Return null
```

**Offline-writable endpoints** (only these three):
- `POST /api/bp` — blood pressure readings
- `POST /api/weight` — weight logs
- `POST /api/medications/confirm-schedule` — medication intake confirmation

All other writes require a network connection and silently return `null` when offline.

**Network error detection** (`isNetworkError`): catches `TypeError` from fetch, checks `navigator.onLine`, and also matches error messages containing "502", "503", "504", "Bad Gateway", "Service Unavailable", "Gateway Timeout" — because behind a reverse proxy the browser stays "online" but gets 5xx responses.

**Sync status bar**: visible indicator showing Offline / Syncing / N items pending / Synced.

### Layer 4: Data Store / SWR (`web/static/js/data-store.js`)

Top-level caching layer implementing Stale-While-Revalidate with tag-based invalidation.

**`loadSWR(options)`**: returns cached data immediately via `onCached` callback, then fetches fresh data and calls `onFresh`. In-flight request deduplication prevents redundant parallel fetches.

**Change detection**: polls `GET /api/changes?since={cursor}` every 30 seconds. When the server reports changed tags (e.g., `bp`, `weight`, `medications`), matching cache entries are invalidated and a tab refresh is triggered.

**Why polling, not SSE**: SSE over HTTP/2 behind reverse proxies (Traefik, nginx) is fundamentally broken — server-side stream closes send `RST_STREAM` which surfaces as `ERR_HTTP2_PROTOCOL_ERROR` in the browser. Polling at 30s is lightweight and reliable. The SSE code exists in `data-store.js` but is intentionally disabled.

**Cache pruning**: once per 24h, stale `api_cache` entries are removed:
- 3 days: `bp`, `weight`, `workout_*`
- 7 days: `history_*`, `food_*`
- 14 days: everything else

### Frontend Module Structure (`web/static/js/`)

The frontend is split across several files, each with a clear responsibility:

| File | Role |
|------|------|
| `core/utils.js` | Shared utilities: `safeAlert`, `formatDateTimeLocalForInput`, `downloadBlobAsFile` |
| `core/api.js` | HTTP client: `apiCallDirect` (raw fetch + auth header) and `apiCall` (offline-aware wrapper) |
| `core/modal-manager.js` | Central modal open/close registry (`window.ModalManager`) for all domain modals |
| `core/app-kernel.js` | Module registry + lifecycle hooks (`onTabSwitch`, `onAuth`, `onReady`); `window.AppKernel` |
| `components/mt-elements.js` | Custom element definitions: `<mt-modal>` and `<mt-setting-toggle>` |
| `app.js` | Domain UI: health-data handlers, tab switching, charts, auth flow (`checkAuth`) |
| `features/auth-flow.js` | Stateless auth-cache helpers (`saveAuthState`, `getCachedAuthState`, `clearAuthState`) |
| `features/bootstrap.js` | Post-auth orchestration: runs `checkAuth()` then starts polling, SyncManager, PushManager, and deep links |
| `features/deeplink-router.js` | URL routing: path deep links, query-param actions, Telegram `start_param` |
| `features/modal-history.js` | Browser history / Telegram BackButton integration for modal open/close |
| `workout.js` | Workout-specific UI: groups, variants, exercises, sessions |
| `push.js` | Web Push subscription management (`PushManager`) |
| `app-shell.js` | PWA shell: service-worker registration and update-toast UI (`initServiceWorker`, `showUpdateToast`) |
| `sync.js` | Offline-write queue and `offlineAwareApiCall()` |
| `data-store.js` | Stale-While-Revalidate cache, change polling, tag-based invalidation |
| `db.js` | Dexie/IndexedDB stores for offline queue and SWR cache |

**Script load order in `index.html`** (loading order matters for dependency resolution):
1. `core/utils.js` — no deps; provides `safeAlert`, format helpers
2. `components/mt-elements.js` — no deps; registers `<mt-modal>` and `<mt-setting-toggle>`
3. `core/modal-manager.js` — no deps; provides `window.ModalManager`
4. `core/api.js` — depends on `safeAlert` (utils.js); reads `window.userInitData` lazily; provides `apiCallDirect`, `apiCall`
5. `core/app-kernel.js` — no deps; provides `window.AppKernel` module registry
6. `db.js` — must load before sync.js; sets up Dexie/IndexedDB stores (`window.MedTrackerDB`)
7. `sync.js` — depends on `db.js`; provides `offlineAwareApiCall` and `SyncManager`
8. `data-store.js` — depends on `window.MedTrackerDB` (db.js) for cache storage; uses `window.apiCallDirect` (core/api.js) lazily at change-poll time; no direct dependency on sync.js exports
9. `app.js` — depends on `DataStore`, `ModalManager`, `apiCall`; defines domain UI and `checkAuth`
10. `features/auth-flow.js` — provides auth-cache helpers called by `checkAuth()` in app.js
11. `features/modal-history.js` — sets up MutationObserver before DOMContentLoaded
12. `features/deeplink-router.js` — registers `window.handleDeepLinks`
13. `workout.js`, `push.js`, `app-shell.js` — feature extensions
14. `features/bootstrap.js` — **must be last**; runs `checkAuth()` to start the app

**Global namespace policy**: `app.js` exposes key functions on `window` — those referenced by tests, feature files, or the bootstrap orchestrator. The current total across all frontend files is 15 explicit `window.*` assignments (Stage 3 target: ≤8).

### Auth Caching (`features/auth-flow.js` + `app.js`)

Auth state is cached in `localStorage` with a 30-day TTL (matching the server cookie).

On startup:
1. **In Telegram**: always authenticated; fetches `/api/bootstrap`
2. **In browser**: tries `/api/bootstrap`. On `200` → authorized. On `401/403` → show login. On `5xx` or network error → fall back to cached auth (allows offline browsing of cached data)

### Bootstrap Endpoint

`GET /api/bootstrap` returns all initial data in a single request: medications, next intake, default history, BP readings/goal/stats, weight logs/goal, and user settings. This pre-warms all caches on first load.

### Data Flow Diagram

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

---

## API Endpoints

### Health Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bootstrap` | All initial data in one request |
| GET | `/api/medications` | List medications |
| POST | `/api/medications` | Create medication |
| PATCH | `/api/medications/:id` | Update medication |
| POST | `/api/medications/confirm-schedule` | Confirm dose intake |
| GET | `/api/medications/intake-history` | Dose history |
| GET | `/api/medications/next-intake` | Next scheduled dose |
| GET | `/api/bp` | BP readings |
| POST | `/api/bp` | Log BP reading |
| GET | `/api/bp/stats` | BP statistics |
| GET | `/api/bp/goal` | BP goal |
| POST | `/api/bp/goal` | Set BP goal |
| GET | `/api/weight` | Weight logs |
| POST | `/api/weight` | Log weight |
| GET | `/api/weight/goal` | Weight goal |
| POST | `/api/weight/goal` | Set weight goal |
| GET | `/api/food/log` | Food log entries |
| POST | `/api/food/log` | Log food |
| GET | `/api/food/search` | Search Open Food Facts |
| GET | `/api/food/targets` | Nutrition targets |
| POST | `/api/food/targets` | Set nutrition targets |
| GET | `/api/sleep` | Sleep logs |
| POST | `/api/sleep` | Log sleep |

### Workouts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/workout/groups` | List workout groups |
| POST | `/api/workout/groups/create` | Create group |
| PUT | `/api/workout/groups/update` | Update group |
| GET | `/api/workout/variants` | List variants |
| POST | `/api/workout/variants/create` | Create variant |
| GET | `/api/workout/exercises` | List exercises |
| POST | `/api/workout/exercises/create` | Create exercise |
| PUT | `/api/workout/exercises/update` | Update exercise |
| DELETE | `/api/workout/exercises/delete` | Delete exercise |
| GET | `/api/workout/sessions` | Session history |
| GET | `/api/workout/sessions/details` | Session details with logs |
| GET | `/api/workout/stats` | 30-day statistics |
| GET | `/api/workout/rotation/state` | Current rotation position |
| POST | `/api/workout/rotation/initialize` | Initialize rotation |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/changes` | Change events since cursor (for cache invalidation) |
| GET | `/api/settings` | User settings |
| POST | `/api/settings` | Update settings |
| POST | `/api/push/subscribe` | Register push subscription |
| POST | `/api/push/unsubscribe` | Remove push subscription |
| GET | `/auth/oidc/login` | OIDC login redirect |
| GET | `/auth/oidc/callback` | OIDC callback |
| GET | `/auth/google/login` | Google login redirect |
| GET | `/auth/google/callback` | Google callback |

---

## Technical Decisions

### Why polling instead of SSE for change detection

SSE (Server-Sent Events) over HTTP/2 behind reverse proxies like Traefik and nginx is unreliable. When the server closes the stream, it sends an HTTP/2 `RST_STREAM` frame that browsers surface as `ERR_HTTP2_PROTOCOL_ERROR`. This causes spurious reconnection loops and error noise. Polling every 30 seconds with a cursor-based `GET /api/changes?since=` is lightweight (empty responses are ~50 bytes) and works reliably through any proxy stack.

### Why only three endpoints support offline writes

Adding offline write support requires: IndexedDB schema, optimistic UI rendering, conflict resolution on sync, and error handling for rejected writes. We limit this to the three most time-sensitive health actions (BP readings, weight logs, medication confirmations) where missing a data point is worse than the implementation complexity. Other writes (editing medications, creating workouts) are infrequent and can wait for connectivity.

### Why 5xx responses are treated as "offline"

When the app runs behind Traefik (or any reverse proxy), `navigator.onLine` stays `true` even when the backend Go process is down — the browser has a TCP connection to Traefik, just not to the app. HTTP 502/503/504 from the proxy are functionally identical to being offline, so the SW and sync layer treat them the same way: serve cached responses for reads, queue writes locally.

### Why IndexedDB is a write-ahead queue, not a full replica

After successful sync, records are deleted from IndexedDB rather than kept as "synced" copies. This keeps the local store small and avoids the complexity of bidirectional sync and conflict resolution. The SW cache and `api_cache` in IndexedDB already provide read-only offline access to previously fetched data.

### Why vanilla JS instead of a framework

The app is single-user, self-hosted, and runs primarily inside Telegram's WebView. A framework would add bundle size and build complexity for little benefit. The four-layer local-first architecture (SW → IndexedDB → SyncManager → SWR DataStore) is straightforward to implement with vanilla JS and Dexie.js.
