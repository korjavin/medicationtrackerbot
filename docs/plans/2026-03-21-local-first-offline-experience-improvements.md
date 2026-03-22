# Local-First Offline Experience Improvements

## Overview

Systematically fix offline behavior across all app sections. Three concrete bugs exist plus missing stale-data indicators and two write categories not yet queued offline. After this plan: every section shows cached data offline with a minimal amber dot indicator (hover to see age), food log and workout exercise writes go into the Dexie queue and sync when online (same pattern as BP/weight/meds), and the food cache corruption bug is fixed.

## Context

- Files involved:
  - `web/static/js/db.js` — Dexie schema, add food/workout offline queues and getWithMeta
  - `web/static/js/sync.js` — SyncManager, extend syncAll() for food and workout queues
  - `web/static/js/data-store.js` — DataStore, add getCachedMeta
  - `web/static/js/core/utils.js` — add stale dot indicator helpers
  - `web/static/js/app.js` — fix renderNextIntakeTrigger, add stale indicators to loadMeds
  - `web/static/js/features/food.js` — fix cache corruption bug, route writes through offlineAwareApiCall, add stale indicator
  - `web/static/js/features/bp.js` — add stale indicator
  - `web/static/js/features/weight.js` — add stale indicator
  - `web/static/js/features/health.js` — add stale indicator
  - `web/static/js/workout.js` — route exercise log writes through offlineAwareApiCall, add stale indicator
  - `web/static/js/features/settings.js` — add stale indicator
  - `web/static/index.html` — stale dot CSS + tooltip
  - Test files in `web/static/js/tests/`
- Related patterns: existing `BPStore`, `WeightStore`, `MedConfirmStore` in `db.js` as offline queue tables; `SyncManager.syncAll()` in `sync.js`; `offlineAwareApiCall()` entry point; `DataStore.loadSWR` with `onCached`/`onFresh`/`onError` callbacks
- Known bugs confirmed:
  1. `renderNextIntakeTrigger` uses `DataStore.fetchFresh` — never serves IndexedDB cache when offline, shows nothing even though bootstrap cached `next_intake`
  2. `loadFoodLogs` overwrites IndexedDB cache with `{ groups: [], weekStats: null }` when `apiCall` returns null offline — corrupts valid cached data, re-renders "No food logs"
  3. No stale-data indicator in any section

## Development Approach

- **Testing approach**: Regular (code first, then tests)
- Complete each task fully before moving to the next
- **CRITICAL: every task MUST include new/updated tests**
- **CRITICAL: all tests must pass before starting next task**

## Implementation Steps

### Task 1: Add cache-timestamp access and extend Dexie schema for food/workout queues

**Files:**
- Modify: `web/static/js/db.js`
- Modify: `web/static/js/data-store.js`

- [x] In `db.js`: add `getWithMeta(key)` to `ApiCache` — returns `{ data, cachedAt }` using the existing `timestamp` field, or null if not found
- [x] In `db.js`: bump Dexie schema version, add `food_log_queue` table (`++id, url, method, body, timestamp`) and `workout_log_queue` table (`++id, url, method, body, timestamp`) following the same shape as existing offline queue tables
- [x] In `data-store.js`: add `DataStore.getCachedMeta(key)` — calls `window.MedTrackerDB.ApiCache.getWithMeta(key)` and returns `{ cachedAt }` or null
- [x] Write unit tests in `db.unit.test.js` for `getWithMeta` (returns meta with timestamp, returns null on miss, food/workout queue tables exist)
- [x] Write unit tests in `data-store.unit.test.js` for `getCachedMeta`
- [x] Run frontend tests — must pass before task 2

### Task 2: Extend SyncManager to flush food and workout queues

**Files:**
- Modify: `web/static/js/sync.js`

- [x] In `SyncManager.syncAll()`: add a flush loop for `food_log_queue` — dequeue each entry, call `apiCallDirect(entry.url, entry.method, entry.body)`, delete on success, leave on failure (same pattern as existing BP/weight sync)
- [x] Add equivalent flush loop for `workout_log_queue`
- [x] After successful food log sync, call `DataStore.invalidate('food_log')` (or the relevant cache key) so the section auto-refreshes
- [x] After successful workout log sync, call `DataStore.invalidate('workout_sessions')` / the relevant key
- [x] Write tests: food_log_queue item syncs and is deleted; failure leaves item in queue
- [x] Run frontend tests — must pass before task 3

### Task 3: Add stale dot indicator utility and CSS

**Files:**
- Modify: `web/static/js/core/utils.js`
- Modify: `web/static/index.html`

- [x] Add CSS in `index.html` `<style>` block for `.stale-dot`: 6px circle, positioned absolute at top-right of nearest `position:relative` parent, amber color `#f59e0b`, hidden by default, cursor `help`
- [x] Add `.stale-dot::after` CSS tooltip: appears on `:hover`, reads from `data-cache-age` attribute, small dark pill, 11px font, z-index 100
- [x] Add `showStaleIndicator(containerEl, cachedAt)` in `core/utils.js` — creates/finds `.stale-dot` inside `containerEl`, computes relative age ("2h ago", "3d ago"), sets `data-cache-age="Cached 2h ago"`, makes visible
- [x] Add `hideStaleIndicator(containerEl)` — hides the dot
- [x] Expose as `window.showStaleIndicator` / `window.hideStaleIndicator`; add both to allowlist in `tests/architecture.globals.test.js`
- [x] Write unit tests (dot created, age text set, hidden on call)
- [x] Run frontend tests — must pass before task 4

### Task 4: Fix next_intake — replace fetchFresh with loadSWR

**Files:**
- Modify: `web/static/js/app.js`

- [x] Change `renderNextIntakeTrigger()` to use `DataStore.loadSWR` instead of `DataStore.fetchFresh`
- [x] `onCached(cached)`: render card with cached data; get `cachedAt` via `DataStore.getCachedMeta('next_intake')`; call `showStaleIndicator(container, cachedAt)`
- [x] `onFresh(fresh)`: if data exists render card and call `hideStaleIndicator(container)`; if null/empty clear container
- [x] `onError(_e, cached)`: if cached exists keep it (dot already showing); else clear container
- [x] Write/update tests: offline scenario → onCached called, card rendered, stale dot shown
- [x] Run frontend tests — must pass before task 5

### Task 5: Fix food logs — prevent cache corruption, route writes through offline queue

**Files:**
- Modify: `web/static/js/features/food.js`

- [x] In `loadFoodLogs()`: add `if (groups !== null)` guard around `DataStore.setCached(cacheKey, ...)` so null offline result never overwrites valid cache
- [x] In cached-read path: call `DataStore.getCachedMeta(cacheKey)` then `showStaleIndicator(list.parentElement, cachedAt)`
- [x] After successful fresh-data write: call `hideStaleIndicator(list.parentElement)`
- [x] In `saveFoodLog()` (and food delete handler): replace direct `apiCall` with `offlineAwareApiCall` passing `'food_log_queue'` as the queue target — writes go to Dexie when offline, sync automatically when online
- [x] Write tests: offline path → setCached NOT called, stale dot shown, cached data rendered; write while offline → item in food_log_queue
- [x] Run frontend tests — must pass before task 6

### Task 6: Route workout writes through offline queue and add stale indicators

**Files:**
- Modify: `web/static/js/workout.js`

- [x] In workout exercise log submit handler: replace direct `apiCall` with `offlineAwareApiCall` using `'workout_log_queue'` — exercise logs queue offline, sync when online
- [x] Workout snooze/skip handlers: same treatment (queue them)
- [x] In the workout section's `loadSWR` `onCached` callback: call `showStaleIndicator(container, cachedAt)` using `DataStore.getCachedMeta`
- [x] In `onFresh`: call `hideStaleIndicator(container)`
- [x] Write tests: offline exercise log write → item in workout_log_queue; onCached shows stale dot
- [x] Run frontend tests — must pass before task 7

### Task 7: Add stale indicators to remaining SWR sections

**Files:**
- Modify: `web/static/js/features/bp.js`
- Modify: `web/static/js/features/weight.js`
- Modify: `web/static/js/features/health.js`
- Modify: `web/static/js/features/settings.js`
- Modify: `web/static/js/app.js` (loadMeds onCached)

Pattern for each: onCached → `showStaleIndicator(container, cachedAt)` via `DataStore.getCachedMeta(key)`; onFresh → `hideStaleIndicator(container)`

- [x] `bp.js` with key `'bp'`
- [x] `weight.js` with key `'weight'`
- [x] `health.js` with key `'health_overview'`
- [x] `settings.js` with key `'settings_bundle'`
- [x] `app.js` loadMeds with key `'medications'`
- [x] Write at least 2 representative tests (BP onCached calls showStaleIndicator, BP onFresh calls hideStaleIndicator)
- [x] Run frontend tests — must pass before task 8

### Task 8: Verify acceptance criteria

- [ ] Run full frontend test suite
- [ ] Run Go test suite: `go test ./...`

### Task 9: Update documentation

- [ ] Update `CLAUDE.md` global namespace table with `window.showStaleIndicator` and `window.hideStaleIndicator` entries
- [ ] Move this plan to `docs/plans/completed/`
