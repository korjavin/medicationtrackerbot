# Instant Load & Offline-First Foundation

## Overview
Make the web app truly local-first: instant render from cached data, full offline read capability, reliable sync with exponential backoff, and a progressive foundation to add more offline writes later.

**Problems solved:**
- App opens slowly, sometimes without data, sometimes flashes stale→fresh
- Completely broken in airplane mode or poor connectivity
- Only 3 write endpoints support offline; reads fail silently

**Key outcomes:**
1. App renders immediately from cached data (SW intercept of `/api/bootstrap`)
2. All static assets precached by SW (currently only 6 of ~25 JS files listed)
3. Exponential backoff retry for queued offline writes
4. Offline UI indicators that don't block interaction
5. Every read endpoint gracefully degrades to cached data

## Context (from discovery)
- **Service Worker** (`web/static/sw.js`): Precaches only 6 JS files; misses all `core/`, `components/`, `features/` modules. API caching is network-first with cache fallback — good but `/api/bootstrap` blocks app startup.
- **IndexedDB** (`web/static/js/db.js`): Has `api_cache` for SWR reads, write-ahead queues for BP/weight/intake. Missing: no cached bootstrap payload in IndexedDB.
- **Data Store** (`web/static/js/data-store.js`): `loadSWR` already serves cached data first — works well. But app never reaches `loadSWR` because `checkAuth()` blocks on network.
- **Bootstrap** (`web/static/js/features/bootstrap.js` + `app.js:291`): `checkAuth()` awaits `/api/bootstrap` before rendering any tab. This is the single biggest blocker.
- **Sync** (`web/static/js/sync.js`): No retry on failure — failed items sit until next `online` event or app reload.

## Development Approach
- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes
- **CRITICAL: all tests must pass before starting next task**
- **CRITICAL: update this plan file when scope changes during implementation**

## Testing Strategy
- **Unit tests**: JS tests in `web/static/js/tests/` using existing test harness
- **Manual verification**: Test in airplane mode, slow 3G throttling, SW cold start

## Progress Tracking
- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Precache all static assets in Service Worker
The SW `STATIC_ASSETS` array lists only 6 JS files but the app has ~25. Missing files fail to load offline.

- [x] Add all missing JS files to `STATIC_ASSETS` in `web/static/sw.js`:
  - `core/utils.js`, `core/api.js`, `core/app-kernel.js`, `core/store.js`, `core/modal-manager.js`, `core/modal-controller.js`
  - `components/mt-elements.js`, `components/empty-state.js`, `components/stat-card.js`, `components/action-row.js`
  - `features/bp.js`, `features/weight.js`, `features/food.js`, `features/health.js`, `features/settings.js`, `features/auth-flow.js`, `features/bootstrap.js`, `features/deeplink-router.js`, `features/modal-history.js`, `features/tabs-dnd.js`
  - `app-shell.js`
- [x] Add vendor files if missing (check `index.html` for all `<script>` tags)
- [x] Write test verifying STATIC_ASSETS covers all scripts loaded by index.html
- [x] Run tests — must pass before next task

### Task 2: SW intercepts `/api/bootstrap` with stale-while-revalidate
Instead of network-first (current), serve cached bootstrap instantly and refresh in background. Notify app when fresh data differs.

- [x] In `sw.js` fetch handler, add special case for `/api/bootstrap`:
  - If cached response exists → return it immediately
  - Fire background fetch → on success, compare with cached → if different, cache new response and `postMessage({ type: 'BOOTSTRAP_UPDATED', data })` to all clients
  - If no cache → fall through to normal network-first behavior
- [x] In `app.js` or `bootstrap.js`, add SW message listener for `BOOTSTRAP_UPDATED`:
  - Call `applyBootstrapPayload(data)` with fresh data
  - Refresh current tab if data changed
- [x] Write SW fetch test for bootstrap SWR behavior (cached hit, cache miss, background update)
- [x] Run tests — must pass before next task

### Task 3: Make `checkAuth()` non-blocking with cached bootstrap
Currently `checkAuth()` awaits network for `/api/bootstrap`. Make it use SW-cached response (which Task 2 makes instant).

- [x] In Telegram path (`app.js:291-303`): `apiCall('/api/bootstrap')` already goes through SW — after Task 2 this returns cached data instantly. No code change needed here, but verify the flow works.
- [x] In non-Telegram path (`app.js:305-378`): Make `/auth/status` check non-blocking:
  - If cached auth exists and SW is active → trust cache, render app immediately
  - Fire `/auth/status` in background → if 401/403 → clear auth and show login
  - If server unavailable → keep using cache (already works)
- [x] Ensure `applyBootstrapPayload()` is idempotent — can be called twice (once from cache, once from fresh) without breaking UI
- [x] Write tests for checkAuth with cached bootstrap (Telegram path, non-Telegram path, stale cache + fresh update)
- [x] Run tests — must pass before next task

### Task 4: Exponential backoff retry for offline sync
Currently `SyncManager.syncAll()` runs once on `online` event, no retry on failure.

- [x] Add retry state to `SyncManager` in `sync.js`:
  - `retryDelayMs` starting at 5000, doubling each failure, capped at 300000 (5 min)
  - `retryTimer` reference for cleanup
  - Reset delay to 5000 on any successful sync
- [x] After `syncAll()` completes with pending items still remaining (partial failure):
  - Schedule `setTimeout(syncAll, retryDelayMs)` with doubled delay
  - Cancel pending retry if `syncAll()` called externally (online event, manual)
- [x] On `online` event: reset backoff, trigger immediate `syncAll()`
- [x] Update `updateStatusBar()` to show retry countdown when retrying
- [x] Write tests for retry scheduling: backoff doubling, cap at 5min, reset on success, cancel on manual sync
- [x] Run tests — must pass before next task

### Task 5: Offline read fallbacks for all data types
Several endpoints return empty/error offline. Ensure every `loadSWR` consumer handles the offline case gracefully.

- [x] Audit all `loadSWR` calls across feature modules (`bp.js`, `weight.js`, `food.js`, `health.js`, `workout.js`, `app.js` medications):
  - Every `onError` must check for cached data and render it (not show empty state)
  - If no cache exists, show "No cached data — will load when online" instead of error
- [x] Ensure BP/weight goal, stats, and other secondary fetchers in composite SWR calls degrade gracefully:
  - If main data cached but stats/goals fail → render main data, show placeholder for stats
- [x] In `data-store.js` `loadSWR`: if `fetcher` throws and no `onError` provided, default to rendering cached data silently (don't swallow — log warning)
- [x] Write tests for offline fallback in each feature module's loadSWR error path
- [x] Run tests — must pass before next task

### Task 6: Offline status UI improvements
Make the offline state clear but non-intrusive. Users should know they're offline but not be blocked.

- [ ] When offline, show a persistent slim banner (not the full status bar) at top: "Offline — showing cached data"
  - Use CSS class, not inline styles
  - Dismiss automatically when back online
- [ ] Disable (grey out, don't hide) write buttons for unsupported offline operations (food, sleep, notes, workouts)
  - Show tooltip: "Available when online"
- [ ] For supported offline writes (BP, weight, medication confirm): show "(saved locally)" confirmation instead of success
- [ ] Write tests for offline banner show/hide, button disable states
- [ ] Run tests — must pass before next task

### Task 7: Verify acceptance criteria
- [ ] Verify all requirements from Overview are implemented
- [ ] Test in airplane mode: app loads instantly with cached data, can enter BP/weight, shows offline banner
- [ ] Test with slow 3G: app renders from cache, background sync completes, UI updates
- [ ] Test cold start after SW installed: all assets served from cache
- [ ] Test sync retry: queue writes offline, go online with flaky connection, verify exponential backoff
- [ ] Run full test suite (unit tests)
- [ ] Run linter — all issues must be fixed

### Task 8: [Final] Update documentation
- [ ] Update CLAUDE.md Local First section if architecture changed significantly
- [ ] Update service worker section of CLAUDE.md with new precache strategy

## Technical Details

### SW Bootstrap Intercept (Task 2)
```
fetch handler for /api/bootstrap:
  cachedResponse = await caches.match(request)
  if (cachedResponse):
    // Serve stale
    event.respondWith(cachedResponse.clone())
    // Revalidate in background
    event.waitUntil(
      fetch(request).then(fresh => {
        cache.put(request, fresh.clone())
        // Notify clients if data changed
        clients.matchAll().forEach(c => c.postMessage({
          type: 'BOOTSTRAP_UPDATED'
        }))
      })
    )
  else:
    // No cache — network first (existing behavior)
```

### Exponential Backoff (Task 4)
```
Initial delay: 5s
Schedule: 5s → 10s → 20s → 40s → 80s → 160s → 300s (cap)
Reset: on any successful item sync
Cancel: on online event (immediate retry), on manual syncAll()
```

### Offline Read Fallback Chain (Task 5)
```
loadSWR → ApiCache (IndexedDB) → render cached
       → fetch fresh in background
       → on success → update cache, call onFresh
       → on failure → if cached was rendered, do nothing (already showing data)
                    → if no cache → show "no data yet" placeholder
```

## Post-Completion

**Manual verification:**
- Test in Telegram WebApp with airplane mode enabled
- Test behind Traefik with backend down (502 scenario)
- Measure time-to-first-paint before and after changes
- Test SW update flow (new version deploys, old cache served, then update)

**Follow-up work (separate plans):**
- Add offline writes for food logging
- Add offline writes for sleep logging
- Add offline writes for diary notes
- Add offline workout session logging
- Consider full IndexedDB replica instead of write-ahead queue (for true offline-first)
