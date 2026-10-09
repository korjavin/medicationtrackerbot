# Frontend

The frontend is a browser PWA backed by an end-to-end encrypted vault,
Dexie.js, and the runtime-agnostic JS domain layer under `web/domain/`.
Telegram-specific behavior stays behind the messenger adapter
(`web/static/js/core/messenger-adapter.js`).

## Local-First Architecture

The notes in this section describe the `web/static` cache and sync stack.
Reads resolve through cache layers before the network; writes paint
optimistically and reconcile. The encrypted vault/oplog sync path underneath
lives under `web/cloud/js/` — see [architecture.md](architecture.md).

Four layers:

1. **Service Worker** (`web/cloud/sw.js`) — versioned app-shell precache (`SHELL_CACHE`, med-deq.1) plus push decrypt; see the module header
2. **IndexedDB** — write-ahead queue for offline writes + generic `api_cache` for SWR. `ApiCache.get(key)` returns `data`; `ApiCache.getWithMeta(key)` returns `{ data, timestamp }` for callers that need the cache-write time (e.g. the Today dashboard's offline-stale banner)
3. **SyncManager** (`sync.js`) — `offlineAwareApiCall()` is the entry point for all API calls; handles retry with exponential backoff (5s → 300s cap, resets on success or `online` event)
4. **SWR DataStore** (`data-store.js`) — `loadSWR()` returns cached data immediately and refreshes in the background; on fetch failure with no `onError` handler, defaults to rendering cached data with a console warning

Offline writes are supported for BP readings, weight logs, and medication confirmations. Other writes require connectivity.

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

**`OfflineNoCacheError`** — typed error (`window.OfflineNoCacheError`) raised only when no cache *and* network is unavailable. Every consumer must catch it and render a friendly empty state. Current consumers: `features/today-loader.js` (Today's Next Medication tile), `features/food.js` (daily food log + products cache).

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

**`DataStore.hydrateFromDexie(key, dexieLoader, opts)`** — cold-start hydration primitive used when the app relaunches offline and `/api/bootstrap` never returns. Reads from a feature's Dexie store (e.g. `MedTrackerDB.MedicationStore.loadCache()`) and seeds `DataStore.setCachedWithTags` so subsequent `loadSWR` / `getCached` calls find data on the very first paint. Signature: `(key, async dexieLoader, { transform?, tags? }) => { hydrated, fetchedAt }`. Never throws — empty Dexie or loader errors return `{ hydrated: false }`. Skips the seed if the in-memory cache is already fresher than the Dexie record. Canonical wiring lives in `app.js` early-init (before `await fetchBootstrap()`): `hydrateMedicationsFromDexie()` seeds the `medications` key from `MedTrackerDB.MedicationStore.loadCache()`, and `hydrateSectionsFromDexie()` seeds the remaining section-level `api_cache` rows from `MedTrackerDB.ApiCache.getWithMeta(key)`. Both are gated on a cached auth state (`getCachedAuthState`) so a fully unauthenticated cold start does not surface a former user's cache. Per-section hydration map (every entry is seeded in parallel during `checkAuth()` and consumed by the listed loader):

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
| Settings | `settings_bundle` | `ApiCache.getWithMeta('settings_bundle')` | `loadSettings()` in `features/settings.js` |

Each consumer mounts a `WGStaleBadge.mountFromKey({ slot, key: <same key> })` chip so the freshness of the hydrated row is visible on the cold-start render. Sections that read via `apiCall` (silent null on offline) — BP, Weight, Workouts Exercises, Vitals Notes — additionally use a `renderedSomething` post-`loadSWR` fallback to paint an explicit empty state when neither `onCached` / `onFresh` / `onError` fires (mirrors the meds pattern).

**Out of scope (explicitly)**: this layer is read-only. No new offline write queues (food/notes/workouts), no full "IndexedDB is source of truth" rewrite. Cold-start offline is now in scope for sections that adopt `hydrateFromDexie` (medications first; others follow).

**Architecture guard — `web/static/js/tests/architecture.offline-coverage.test.js`** — every file under `web/static/js/features/*.js` must either use one of the offline-aware primitives (`cachedFetch(`, `loadSWR(`, `hydrateFromDexie(`, `offlineAwareApiCall(`) OR appear in the test's `ALLOWLIST` array with a `reason` string. Adding a new section file therefore forces a choice: route reads through a primitive, or document why it doesn't need one. The test runs four sub-assertions: (1) every features file is either using a primitive or allowlisted; (2) every allowlist entry has a non-empty `reason`; (3) every allowlisted file actually exists under `features/`; (4) no allowlisted file already adopts a primitive (dead entries fail the suite, so the allowlist cannot ossify).

**How to add an allowlist entry** — open `architecture.offline-coverage.test.js`, append to the `ALLOWLIST` const an object of the form `{ file: 'your-file.js', reason: '<one-line justification>' }`, then re-run `pnpm test -- architecture.offline-coverage`. The justification must explain why the file does not need an offline-aware read primitive — current acceptable categories are pure UI helpers (e.g. `auth-flow.js`), event-driven indicators (`call-indicator.js`), pure routing (`deeplink-router.js`), transient one-shot fetches whose failure mode is "the widget simply doesn't appear" (`tz-plan-banner.js`, `elevenlabs-call.js`), DOM observers (`modal-history.js`), and aggregation/render contracts that consume caches seeded elsewhere (`today.js`). If your file does not fit one of those shapes, adopt a primitive instead.

### Optimistic Write Updates

Every online write handler in `web/static/js/features/*.js` paints the post-mutation state **before** the network round-trip resolves, so the user's own action feels instant. The mechanism is `DataStore.applyOptimistic(key, mutator, tags)` (`web/static/js/data-store.js`).

**`applyOptimistic(key, mutator, tags)`** — read the current cached payload, apply `mutator(prev) → next`, write the projected state back via `setCachedWithTags`, and dispatch `datastore:changed` with `{ source: 'optimistic', changedTags: tags }` so `requestTabRefresh` subscribers (Today tiles, list views) repaint synchronously. Returns a handle:

```
const handle = await DataStore.applyOptimistic('bp', prev => ({
    ...prev,
    readings: [newReading, ...(prev?.readings ?? [])],
}), ['bp']);

try {
    const serverPayload = await offlineAwareApiCall('/api/bp', { method: 'POST', body });
    await handle.commit(serverPayload);   // overwrite with authoritative state (pass null to keep optimistic state)
} catch (err) {
    await handle.rollback();              // restore prior snapshot + invalidateTags so next read goes to network
    throw err;
}
```

`commit` / `rollback` are idempotent — calling either a second time is a no-op, so the handle can be threaded through try/catch without double-settle risk. A `null` / `undefined` payload from the mutator clears the cache entry (used by `workout_next` after the current session finishes).

**Why writes use this, not `invalidateTags + loadX`**: `invalidateTags` clears caches but does *not* dispatch `datastore:changed` — that goes through `requestTabRefresh`, which `applyOptimistic` and the cloud sync pull path both call (`data-store.js`, `web/cloud/js/sync.js`). Handlers that cleared the cache and called `loadX()` therefore missed the cache they just emptied, went to network, and held the UI through the round-trip — a same-device latency regression the user perceives as "save lag". The optimistic helper writes the projected state and dispatches the event up-front; the server response reconciles via `commit`.

**Per-surface mutator shapes** — the canonical mutator for each write surface (what gets prepended / flipped / spliced):

| Surface | Cache key(s) | Mutator |
|---------|--------------|---------|
| BP save / delete | `bp` | prepend / filter the reading row |
| Weight save / delete | `weight` | prepend / filter the log row |
| Food save / delete | `food_<YYYY-MM-DD>_v2`, `todayFoodKey(date)` | append / filter the entry, recompute totals |
| Food photo upload | `food_<date>_day` | append returned items into the cached day payload |
| Meals save / delete | meals cache | append / filter the meal definition |
| Products save | products cache | append the new product |
| Medication confirm / skip / log-past / edit-history / delete-future | `medications`, `next_intake`, `history` | flip the matched `intake_log` row's `status`, recompute next via `MedicationUtils.getNextScheduledDate` |
| Medication add / edit / delete / archive | `medications` | upsert / filter the medication row |
| Workout finish | `workout_next`, sessions history cache | null out `workout_next`; flip session status in history |
| Workout add / delete exercise log | session details cache + `WorkoutSessionsState.logs` | push / splice the log (new logs use `local_*` ids, replaced on commit) |
| Workout ad-hoc start / complete / pre-skip / cancel / snooze / skip | `workout_next` | synthesise the post-action session/state |
| Goal milestone ack (Today Goal Line card, med-8tur.5) | `gamification_goal_line` | set `milestone` to `null` |
| Diary add / edit / delete | `diary_notes` | prepend (with `local_*` id, replaced on commit) / patch / filter the note |

**Rollback semantics** — on POST rejection: restore the captured snapshot (or clear the entry if the cache was cold), call `invalidateTags(tags)` so the next read goes to network and authoritatively resyncs, and surface a toast via the existing offline-write error UI where applicable.

**Row deletes** — a list-row delete (BP, Weight, Food log, Notes, Workout history, Meds schedule archive) never confirms first; it goes through `deleteWithUndo({ message, optimistic: [{ key, mutator, tags }], remove })` in `core/utils.js`. The row leaves the cache at once via `applyOptimistic`, a toast offers Undo (rollback, nothing sent), and `remove()` (the feature's `_deleteXApi`) runs when the toast's Undo window closes, the page is hidden, or another row delete starts (one Undo window at a time). While owed, the delete is journaled in localStorage (`wg-pending-deletes`: replay function name + record id, never content) so a page killed mid-window still deletes on the next boot (`replayPendingDeletes` in bootstrap); programmatic reloads (update banner, SW controllerchange) call `flushPendingDelete()` first. The returned `{ undo, flush, done }` is the test seam. Record/account deletes (e.g. permanently deleting an archived medication) stay a dialog.

**Design rule** — write handlers MUST use `applyOptimistic`, never `invalidateTags + loadX`. The latter is reserved for read-only refreshes (e.g. the `invalidateWorkoutCache` helper) and for the rollback path inside `applyOptimistic` itself.

### Cross-section Auto-refresh Invariant

After any local create/update/delete, the originating screen does **both** in one step via `applyOptimistic(key, mutator, tags)` (see [Optimistic Write Updates](#optimistic-write-updates) above):

1. The mutator writes the projected post-mutation state into the cache, so the originating screen's loader (and any other consumer of the same key) repaints immediately on the dispatched `datastore:changed` event.
2. The dispatched event carries `changedTags: tags` so Today tiles and other listeners refresh without a tab switch. On rollback the handle calls `invalidateTags(tags)` so the next read goes to network.

Tag vocabulary: `bp`, `weight`, `medications`, `history`, `food`, `workouts`, `health-notes`.

### Device-Capability Abstractions

Camera and barcode access route through a thin abstraction layer at
`web/static/js/native/` rather than through browser globals in feature code.
The foundation module (`web/static/js/native/index.js`) installs each global as
a stub that throws `NotImplementedError`, and exposes
`registerImpl(capability, 'web', impl)`; the `web/<capability>.js` sibling files
register themselves at script-load time and replace the stub.

| Global | Capability | Implementation |
|---|---|---|
| `window.MediaCapture` | Camera + photo picker | `getUserMedia` + `<input type=file>` |
| `window.Barcode` | Barcode scanning | `BarcodeDetector` (Chrome) / ZXing fallback |
| `window.Bluetooth` | Web Bluetooth heart rate (HR slice) | `navigator.bluetooth` GATT + 0x2A37 parse (med-byks.1) |

**Capability probes** — where a capability may be absent, the check is exposed
as a method so feature code never re-derives it:

| Global | Method | Behavior |
|---|---|---|
| `MediaCapture` | `openCameraStream({facingMode})` | `Promise<MediaStream>` via `getUserMedia` — the file's only `getUserMedia` call site (`takePhoto` reuses it) |
| `Barcode` | `supportsLiveScan()` | `!!window.BarcodeDetector`, probed at call time |
| `Bluetooth` | `isSupported()` | `!!navigator.bluetooth`, probed at call time — false on Safari/iOS/Firefox, where feature UI hides itself |

`features/food/scanner.js` is the reference consumer: it asks
`Barcode.supportsLiveScan()` whether the frame loop is viable and
`MediaCapture.openCameraStream()` for the stream — no `navigator.*`, no
`BarcodeDetector`. Calls are guarded with `typeof fn === 'function'` so a stale
cached bundle degrades gracefully.

**Guard** — `web/static/js/tests/architecture.native-abstractions.test.js` enforces the
boundary. It fails if any file under `web/static/js/` outside `native/` (and
outside `tests/`, which legitimately stubs the seam) mentions
`navigator.mediaDevices`, `getUserMedia`, `BarcodeDetector`,
`navigator.bluetooth`, or `requestDevice` — no allowlist;
`native/` owns device capabilities. It also fails on any reference to
`window.Capacitor` / `isNativePlatform` anywhere in the frontend: the Capacitor
Android shell was removed, so branching on it is dead code.

**Adding a new device capability** — create `web/<capability>.js` calling
`registerImpl()`, add the stub to the foundation module's init list, add one
entry to `architecture.globals.test.js` with justification, and add a
`tests/native.<capability>.test.js` (pure-unit is the right shape — these sit
below the feature-module integration entry point).

### In-Page Dialogs

No native browser dialogs anywhere: `alert()` / `confirm()` / `prompt()` render
the browser's unstyled box. Every dialog goes through `_mountConfirmModal` in
`core/utils.js` — `safeAlert` (single OK), `safeConfirm`, `safePrompt`,
`safeChoose` — or `safeToast` for a non-blocking note. It renders the kit
`.wg-dialog` anatomy with `.wg-btn` actions and `.wg-choice` rows; `opts.icon`
(a `WGIcons` name), `opts.destructive` (filled clay confirm instead of sun) and
`safeConfirm`'s `opts.typedConfirm` (confirm stays disabled until the phrase is
typed — account delete uses it) cover record/account deletes (kit rule 3).
`mt-modal.mt-confirm-modal` stays the JS hook for Back/Esc. Placement rules live
in `web/static/css/dialog.css`, linked after `components.css` by both
`index.html` and the passkey shell `web/cloud/signup.html` (which also loads
`utils.js`, `wg-icons.js`, `mt-elements.js`, `modal-manager.js` and
`modal-history.js`), so `web/cloud/js` modules call
`window.safeConfirm` in either document. In both, an open dialog gets its own
history entry (`modal-history.js`), so Back cancels just the dialog
(`ModalManager.closeTopMostVisibleModal`).

**Modal stack.** `ModalManager.open/close` keep an ordered stack; Back, Esc and
popstate all close the most recently opened modal through its registered close
function (`ModalManager.register(id, fn)`), and `#modal-overlay` hides only when
nothing on the stack is still visible. Nested editors use pushed pages
(`components/wg-page.js`, `WGPage.push`) on the same stack instead of
modal-on-modal. Full-document passkey ceremonies (the Emergency Kit rotation at
`/devices?flow=emergency-kit`, unlock/claim/recover) stay out of it and return
to an in-app deeplink (`?tab=settings&page=devices`, `features/deeplink-router.js`).

**Sheets.** Form and flow modals are kit bottom sheets: an
`<mt-modal class="wg-modal wg-sheet">` with `.wg-sheethead` (eyebrow + title;
forms put Cancel/Save in `.wg-sheethead__acts`) and an optional
`.wg-sheet__foot` for a flow's primary. `components/wg-sheet.js` (`WGSheet`)
builds the header for dynamically created sheets and owns the one keyboard dock
(`visualViewport` → `.wg-scrim--kb` + `--wg-kb-h`). Sheets open and close
through `ModalManager` like any modal.

**Guard** — `web/static/js/tests/architecture.no-native-dialogs.test.js` scans
`web/static/js` and `web/cloud/js` (tests/vendor excluded) for bare or
`window.`-prefixed `alert(` / `confirm(` / `prompt(` on code lines. No allowlist.

## Script Load Order (`index.html`)

Loading order matters — there is no bundler; cross-file communication happens via `window.*` globals.

1. `core/utils.js` — the in-page dialogs `safeAlert` / `safeConfirm` / `safePrompt` / `safeChoose` (an `<mt-modal>` overlay — never a native dialog, see [In-Page Dialogs](#in-page-dialogs)), `safeToast`, format helpers
2. `components/mt-elements.js` — registers `<mt-modal>`, `<mt-setting-toggle>`
3. `components/empty-state.js` (`createEmptyState` / `createOfflineEmptyState` / `createErrorState` / `createSkeleton` — the kit `.wg-empty` / `.wg-error` / `.wg-skel` states every list, chart and pane uses for empty, offline cold-start, error and loading), `stat-card.js`, `wg-row-actions.js` (`WGRowActions.attach(row, {onEdit, onDelete, extra})` — kit swipe tray + overflow `.wg-menu`, the keyboard/screen-reader path; deletes keep their own `deleteWithUndo` handler) — UI primitives
3b. `components/wg-icons.js`, `wg-page.js` / `wg-sheet.js` (pushed pages and bottom sheets on the modal stack), `wg-chip.js` (`WGChip.create` status chips; `WGChip.sync(row)` is the one Pending / Sync-failed row chip; no emoji, `architecture.no-emoji-status.test.js`), `wg-bottom-nav.js`, `wg-sparkline.js`, `wg-ring.js`, `wg-phone-chrome.js`, `wg-bp-chart.js`, `wg-weight-chart.js`, `wg-workout-chart.js`, `wg-macro-bar.js`, `wg-sleep-chart.js`, `wg-steps-chart.js`, `wg-vitals-chart.js` — Wandergeek design-system primitives (icon registry, tab bar, sparkline, single-arc ring gauge, phone-chrome, BP chart, weight chart with optional goal overlay, workout sessions-per-week chart, macro bar, sleep stacked-bar chart with HR overlay, steps bar chart, vitals area+line chart parameterised by `vital`). Must load before `features/bootstrap.js` mounts the tab bar, before `today.js` renders sparklines, before `features/food.js` renders the daily macros card, before `features/workout.js` renders the Stats sub-tab chart, and before `features/health.js` renders the Overview sub-tab sleep/steps/vitals cards.
4. `core/modal-manager.js` — `window.ModalManager`
5. `core/api.js` — `apiCallDirect`, `apiCall` (session-cookie auth; `apiCall` delegates to `window.offlineAwareApiCall`)
6. `core/app-kernel.js` — `window.AppKernel` module registry
7. `core/store.js` — `window.AppStore` pub/sub state
8. `core/modal-controller.js` — `withSubmit` double-submit guard
9. `core/chart-utils.js` — `window.ChartUtils` (splines, gradients, `aggregateToDaily`, `lttbDownsample`)
10. `db.js` — sets up Dexie/IndexedDB stores (`window.MedTrackerDB`)
11. `sync.js` — `offlineAwareApiCall`, `SyncManager`
12. `data-store.js` — uses `window.MedTrackerDB` for cache
13. `app.js` — domain UI and `checkAuth`; then `features/app-nav.js` (`window.AppNav` — tab ↔ section mapping, app-bar actions, Meds badge)
14. `features/food.js`, `features/bp.js`, `features/weight.js`, `features/meds.js`, `features/workout.js`, `features/health.js` — extracted feature modules. Round 2 of the `app.js` split (plan `docs/plans/2026-06-10-finish-app-js-split.md`) carved four view-orchestrator modules out of `app.js` that also load in this band (after `app.js`, before `features/bootstrap.js`): `features/meds-history.js` (`window.MedsHistory` — medication add modal, Meds → History load, confirm/skip modal flow), `features/today-loader.js` (`window.TodayLoader` — the impure Today loading shell: `loadToday` / `_todayRender` / `_todayReadCaches` / `fetchNextIntakePayload`, feeding the pure `features/today.js` renderer), `features/settings.js` (`window.SettingsView` — `loadSettings`, feature toggles, stale badge), and `features/workout/modals.js` (`window.WorkoutModals` — the workout-start push-notification modal flow). Each keeps its bare function names as the live call path; the `window.*` namespace only mirrors the public surface. `features/journey.js` (`window.Gamification` — the gamification Journey screen) also loads in this band, after `today.js` and before `features/bootstrap.js`.
15. `features/auth-flow.js` — auth-cache helpers used by `checkAuth()`
16. `features/modal-history.js` — MutationObserver setup
17. `features/deeplink-router.js` — `window.handleDeepLinks`
19. `features/bootstrap.js` — **must be last**. Runs `checkAuth()`, then `mountCanonicalBottomNav()` (filters `WGBottomNav.DEFAULT_ITEMS` by `window.featureSettings`, mounts the nav into `#app`, and registers an AppKernel module so `switchTab()` mirrors into `ctrl.setActive()`), then the initial `switchTab('today')`, then schedules `maybeUpdateTimezone()` via `queueMicrotask` so the TZ-mismatch prompt (`safeConfirm`'s in-page `<mt-modal>`) runs after first paint and never blocks the visible shell, then `AppBackButton.setup()`, then `handleDeepLinks()`.

## Global Namespace Policy

All explicit `window.*` assignments are tracked in `web/static/js/tests/architecture.globals.test.js`. Adding a new global requires updating the allowlist with a justification.

| Global | Source | Consumed by |
|--------|--------|-------------|
| `window.AppKernel` | `core/app-kernel.js` | module registry |
| `window.AppStore` | `core/store.js` | app.js, feature modules |
| `window.ChartUtils` | `core/chart-utils.js` | bp.js, weight.js, health.js |
| `window.ModalManager` | `core/modal-manager.js` | app.js |
| `window.apiCallDirect` | `core/api.js` | data-store.js (change polling) |
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
| `window.TodayDashboard` | `features/today.js` | `features/today-loader.js` `_todayRender()` |
| `window.TodayLoader` | `features/today-loader.js` | app.js `switchTab()` / `reloadCurrentTab()` (`loadToday`), `features/meds-history.js` (`fetchNextIntakePayload`), `features/food/*.js` + `features/auth-bootstrap.js` (`todayFoodKey`) |
| `window.MedsHistory` | `features/meds-history.js` | app.js medication/notification bindings (arrow wrappers), `features/meds.js` (`typeof`-guarded optimistic helpers) |
| `window.SettingsView` | `features/settings.js` | app.js `switchTab()` / `reloadCurrentTab()` (`loadSettings`), feature-toggle change handlers, `features/auth-bootstrap.js` (`updateFeatureTabVisibility`) |
| `window.WorkoutModals` | `features/workout/modals.js` | app.js notification bindings (arrow wrappers) + `handlePushAction` (workout-start modal flow) |
| `window.Gamification` | `features/journey.js` | app.js `switchTab()` / `reloadCurrentTab()` (Journey screen loader + renderer for the `gamification` feature) |
| `window.DoctorBrief` | `features/brief.js` | `features/today.js` (Doctor brief shortcut tile → `open()`; **cloud-only** — the tile is omitted unless `window.__MEDTRACKER_CLOUD__`, because `GET /api/brief` lives in `apishim.js` and `/js/print-doc.js` is served by the cloud shell). Builds the standalone printable document and hands it to `web/cloud/js/print-doc.js` (`downloadDoc` / `printDoc`, shared with the signup Emergency Kit). The print frame inherits the origin's `style-src 'self'`, so the stylesheet rides along as a 4th argument and is adopted as a constructed sheet. Nothing is uploaded — no privacy-manifest entry |
| `window.AppBackButton` | `features/back-button.js` | features/bootstrap.js |
| `window.WGIcons` | `components/wg-icons.js` | `wg-bottom-nav.js`, `features/today.js` (tile icons) |
| `window.WGBottomNav` | `components/wg-bottom-nav.js` | `features/bootstrap.js` (`mountCanonicalBottomNav`), `features/app-nav.js` (Meds badge) |
| `window.AppNav` | `features/app-nav.js` | `features/bootstrap.js`, `features/back-button.js`, BP / Weight / Health range setters |
| `window.WGSparkline` | `components/wg-sparkline.js` | `features/today.js` (metric tile sparklines) |
| `window.WGRing` | `components/wg-ring.js` | design-system primitive; single-arc gauge; no Today/Journey consumer since med-8tur.2 |
| `window.WGPhoneChrome` | `components/wg-phone-chrome.js` | design-system primitive (no runtime consumer yet) |
| `window.WGMacroBar` | `components/wg-macro-bar.js` | `features/food.js` (daily macros card rows: Energy/Protein/Carbs/Fat) |
| `window.WGWeightChart` | `components/wg-weight-chart.js` | `features/weight.js` (weight history chart panel with optional goal overlay) |
| `window.WGWorkoutChart` | `components/wg-workout-chart.js` | `features/workout.js` (Stats sub-tab sessions-per-week trend chart) |
| `window.WGSleepChart` | `components/wg-sleep-chart.js` | `features/health.js` (Overview sub-tab sleep stacked-bar + HR overlay card) |
| `window.WGStepsChart` | `components/wg-steps-chart.js` | `features/health.js` (Overview sub-tab steps bar card) |
| `window.WGVitalsChart` | `components/wg-vitals-chart.js` | `features/health.js` (Overview sub-tab HR / SpO2 / Stress area+line cards, parameterised by `vital`) |
| `window.WGStaleBadge` | `components/wg-stale-badge.js` | `features/today.js`, `features/food.js`, `features/bp.js`, `features/weight.js`, `features/meds.js`, `features/workout.js`, `features/health.js` (per-section freshness chip) |
| `window.cachedFetch` | `cached-fetch.js` | `features/today-loader.js` (Today next_intake), `features/food.js` (daily log + products) |
| `window.OfflineNoCacheError` | `cached-fetch.js` | same consumers as `cachedFetch` (catch-and-render-empty-state branch) |
| `window.MediaCapture` | `native/index.js` (web impl registers) | `features/food/photo.js`, `features/food/scanner.js` |
| `window.MessengerAdapter` | `core/messenger-adapter.js` | `core/utils.js` (alerts/confirms), `features/back-button.js`, `features/deeplink-router.js` (start param) |
| `window.Barcode` | `native/index.js` (web impl registers) | `features/food/scanner.js` |

## Design Tokens

CSS custom properties defined in `:root` of `web/static/css/styles.css`. See the comment block at the top of that file for the full reference.

Key rules (enforced by architecture tests in `web/static/js/tests/architecture.design-tokens.test.js`):

- **No hardcoded colors in CSS** — use `--wg-*` or `--color-*` tokens
- **No inline styles in JS** — use CSS classes (tests scan for `.style.` assignments)
- **No `--wg-*` token may be referenced from JS** — Wandergeek tokens are CSS-only. JS sets *class names*, CSS resolves values. Narrow exceptions (structural variables only) are allowlisted in `ALLOWED_JS_TOKEN_REFS` inside the architecture test, one file at a time with a justification.
- **Button system (legacy)**: `.btn` base + `.btn-primary` / `.btn-secondary` / `.btn-danger` variants + `.btn-sm` / `.btn-lg` sizes + `.btn-pill` / `.btn-icon` shapes. Being phased out in favor of `.wg-gloss` variants.
- **Spacing / radius / shadow / typography / z-index** all use tokens (`--space-*`, `--radius-*`, `--shadow-*`, `--font-size-*`, `--z-*`, and the Wandergeek `--wg-*` counterparts)
- **Utility classes**: `.flex-row`, `.flex-between`, `.flex-center`, `.text-hint`, `.text-center`, `.hidden`, `.empty-state`, spacing helpers (`.mt-sm`, `.mb-md`, …)

### App UI kit v2: two-file layout

The kit (`docs/design/claude-design/ui_kits/app-v2/`, rules in its `README.md`) ships as two stylesheets, linked in `index.html` in this order:

1. **`web/static/css/styles.css`**: every token, in its **first** `:root` block (the token guards read only that block, and they cut it at the first closing brace, so keep braces out of `:root` comments). Kit tokens sit under the "App UI kit v2 foundations" heading. Where the kit renamed an app token, the app takes the kit value: `--wg-mint` is now the brighter mint, and the old value is `--wg-mint-mid`. The kit's `--wg-bg-stage` is the backdrop for its own demo pages, so the app keeps its own value. `--wg-z-*` maps onto the app's `--z-*` stack.
2. **`web/static/css/components.css`**: the kit's `wg-*` components, ported from the kit's `components.css`. The header comment lists every place the port differs from the source. Each kit selector has one base rule, and it lives here (`architecture.wg-primitives.test.js`). `.wg-card`, `.wg-tag` and `.wg-muted` are wrapped in `:where()` so legacy companion classes still override them.

**Status goes through five token families only**: `--wg-{ok,warn,danger,stale,pending}-{fg,bg,line}`. They replace the per-surface `--wg-bp-status-*`, `--wg-meds-status-*` and `--wg-tag-{normal,high,alert}-*` tokens as screens move onto the kit. The **control scale** is `--wg-s*` (space), `--wg-r-*` (radius), `--wg-h-*` / `--wg-hit` (heights) and `--wg-z-*`. Both are pinned in `REQUIRED_TOKENS`. The hex guard covers both stylesheets, and every `var(--wg-*)` in `components.css` must resolve in the first `:root` (`architecture.design-tokens.test.js`).

### Wandergeek tokens (`--wg-*`)

The canonical visual system. Every new screen and component uses these. Organized by group (see `WANDERGEEK_TOKENS` in the design-tokens architecture test for the authoritative list):

- **Palette** — raw color primitives: `--wg-paper`, `--wg-paper-deep`, `--wg-paper-soft`; `--wg-ink` + its one surviving alpha variant `--wg-ink-70` (the rest of the ramp was retired in med-cue — dark-teal ink on dark surfaces caused three zero-contrast bugs); `--wg-teal`, `--wg-teal-stage` (deep-teal page background `#0f2522`), `--wg-teal-sage`; `--wg-mint`, `--wg-mint-soft`; `--wg-sun` (`#FBBD0D`, primary accent), `--wg-sun-deep`, `--wg-sun-soft`; `--wg-clay` (`#C6553A`, alert), `--wg-clay-soft`.
- **Semantic** — role-based aliases on top of the palette: `--wg-bg-stage`, `--wg-bg-card`, `--wg-bg-card-inset`; foreground alphas `--wg-fg-1` through `--wg-fg-5`; `--wg-border-hairline`, `--wg-border-strong`.
- **Gloss material** — gradient + shadow strings for the convex tile look: `--wg-gloss-bg`, `--wg-gloss-bg-sun`, `--wg-gloss-bg-clay`, `--wg-gloss-bg-inset`; matching `--wg-gloss-shadow`, `--wg-gloss-shadow-sun`, `--wg-gloss-shadow-inset`.
- **Status tags** — triplets per severity: `--wg-tag-normal-bg/-fg/-border`, `--wg-tag-high-*`, `--wg-tag-alert-*`.
- **Typography** — `--wg-font-display` (JetBrains Mono for headlines and numerics), `--wg-font-ui` (Space Grotesk for body text), `--wg-font-mono` (JetBrains Mono, shared family as display — headlines are intentionally mono).
- **Dimensional** — radii (`--wg-radius-gloss/-icon/-card/-pill`), padding (`--wg-card-pad`, `--wg-phone-pad`, etc.), component sizing (`--wg-icon-btn-size`), font sizes (`--wg-font-size-tag`, `--wg-font-size-metric-value`, `--wg-food-kcal-display-size`, `--wg-food-kcal-pct-size`, …). Phone chrome, tab bar, metric tiles, and macros card all expose their fixed dimensions as tokens so `no-hardcoded-px` stays green.
- **Chart theme** — shared tokens consumed by both the BP and Weight chart surfaces so new chart components stay visually flush (introduced in round-2 Task 13): `--wg-chart-card-bg` / `--wg-chart-card-border` / `--wg-chart-card-radius` / `--wg-chart-card-pad` (panel surface), `--wg-chart-guide-stroke` / `--wg-chart-guide-stroke-width` / `--wg-chart-guide-dasharray` (dashed grid guides), `--wg-chart-axis-tick-color` / `--wg-chart-axis-tick-size` (x/y tick labels). All new chart components must consume these rather than reintroduce per-chart colors. Legacy per-chart tokens (e.g. `--wg-bp-chart-guide-*`) are kept as passthrough aliases resolving back to the shared set. Adoption pinned by `architecture.chart-theme.test.js`.

Every new `.wg-*` CSS class block must source its colors/gradients/shadows from `var(--wg-*)` — hex literals inside `.wg-*` blocks are caught by `architecture.wg-primitives.test.js`. Every new token must be added to `WANDERGEEK_TOKENS` in the architecture test in the same commit that introduces it.

**Canonical primary-action placement and modal utilities**: primary section actions (+Log / +Add / +Start / +Take) render **inline** with the tab strip, range selector, or day navigator — never as a floating FAB and never as a bottom CTA dock. The `.wg-fab` class has been retired; compose the action as a `.wg-toolbar-btn wg-toolbar-btn--primary` pill nested in the strip (see `#add-bp-btn` inside `#bp-range-selector`, `#add-btn` inside `.wg-meds-schedule-header`, `#add-weight-btn` inside the weight range-selector row). Food (med-xso6.16) follows the kit instead: its one primary `#add-food-inline-btn` sits in the app bar, not a strip. Workouts is the one section with no strip-level action: med-2fc folded its ad-hoc Start into the next-workout card's own action row (`Ad hoc`, leftmost, `.wg-toolbar-btn--secondary`) rather than keep a second "start" affordance floating above a pane that already had one. `.wg-modal` + `.wg-modal__header` / `.wg-modal__title` / `.wg-modal__body` / `.wg-modal__actions` + the field utilities `.wg-field` / `.wg-field--row` / `.wg-label` / `.wg-input` / `.wg-select` are the shared modal shell — token-driven, teal-stage-aware, with `.wg-gloss` buttons in the actions row. New sections must reuse these utilities rather than introduce scoped `.wg-bp-*` / `.wg-food-*` variants; the BP screen is the reference consumer.

**Buttons are `.wg-btn`** (`--primary` / `--ghost` / `--danger` / `--danger-ghost` / `--icon` / `--sm` / `--lg` / `--block`), one sun `--primary` per view. The cloud shell pages and the first-run overlay already use it; the shell links `components.css` + `fonts.css` from `/static/`, which the base domain serves for exactly those files (`baseDomainStaticAssets`, `internal/cloudserver/router.go`). Legacy systems (`btn btn-*`, `wg-toolbar-btn`, `*-modal__header-btn`, `pwa-update-btn`, `wg-settings-{action,save}-btn`) live on only in the per-file allowlist of `architecture.no-legacy-buttons.test.js`, each entry naming the bead that removes it; the list only shrinks.

**Legacy toolbar-row action button (`.wg-toolbar-btn`)**: introduced in Round-2 defects Task 2 to unify the "primary action pill sitting next to a range/subtab track" pattern across BP, Weight, Meds, Workouts, and Food. The base class owns all sizing/padding/radius (height `var(--wg-toolbar-btn-height)`, currently `36px` to match sibling range pills); the variant modifiers are color-only. Use `.wg-toolbar-btn--primary` for the canonical add/log/start action (yellow sun-gloss fill) and `.wg-toolbar-btn--secondary` for outline/ghost actions on the teal stage (e.g. the Workouts "Next workout" card's Skip / Stop / Next Day, introduced with Round-2 Task 10). Never size the button via a per-section `__add` class — add/replace the variant on the shared base instead. No new uses: the screen beads replace it with `.wg-btn`; `architecture.toolbar-btn.test.js` keeps only the rule's contract while it exists.

## Navigation

Navigation v2 (App UI kit v2, spec `docs/design/claude-design/ui_kits/app-v2/navigation.html`): a five-tab **tab bar** plus an **app bar** on every top-level view, with **Today** as the root of the back stack. Section ids are stable (CLAUDE.md rule 6); tabs are a layer on top of them.

- **Tab bar** (`components/wg-bottom-nav.js`, `window.WGBottomNav`): kit `.wg-tabbar` / `.wg-tab` markup, one row. `DEFAULT_ITEMS` is the source of truth for order and labels (Today · Food · Meds · Train · Health). The Health tab (`health-group`) owns the `bp` / `weight` / `health` sections, so any of them lights it; the Vitals section's id stays `health`. Mounted by `mountCanonicalBottomNav()` in `features/bootstrap.js`, filtered against `window.featureSettings` (a tab disappears only when its whole section set is off); `rebuildCanonicalBottomNav()` re-mounts it after a feature toggle. The only inline style is the kit's `--n` column count. `WGBottomNav.setBadge(id, n)` paints `.wg-tab__badge`.
- **Nav chrome** (`features/app-nav.js`, `window.AppNav`, an `AppKernel` module fired by `switchTab`): maps tabs onto sections. The Health tab reopens the last segment (`mt-health-segment`, written on every switch into one of the three sections, deep links included; falls back to the first enabled one). The BP / Weight / Vitals `.wg-health-seg` strip hides when ≤1 of them is enabled. App-bar actions are markup hooks: `[data-nav-to]` (gear → Settings on every tab, route icon → Journey on Today, hidden when gamification is off), `[data-nav-back]`, `[data-health-seg]`. The Meds badge is missed + overdue doses — PENDING intakes already due (`countDueDoses` over `GET /api/history?days=1`), refreshed on tab switch, `datastore:changed` (history / medications), on return to the app, and by a timer at the next due / snooze-expiry time (at most 15 min while visible).
- **Pages**: Settings and Journey are not tabs. They render a `.wg-pagebar` with Back; `AppStore` `previousTab` (persisted as `mt-page-origin`, so a restored page keeps it) records the tab they were opened from, the tab bar keeps that tab lit, and Back (pagebar or `back-button.js`) returns to it.
- **Settings subpages** (`features/settings.js` `openSettingsPage`): the Settings home is grouped kit `.wg-setting` rows (`[data-settings-open]`) whose `[data-settings-summary]` text is refreshed from the live controls. Each row pushes a `WGPage` whose body is the matching `[data-settings-page]` node, moved out of the hidden `.wg-settings-pages` store and back on close — so every control id stays in the document and its listeners survive. A row hides when every section of its page is hidden. The Targets page's page-bar Save (`saveTargets`) writes Journey bands, then food targets, each via `DataStore.applyOptimistic`.
- **Icon registry** (`components/wg-icons.js`, exposes `window.WGIcons`) is the single source of truth for icon names: its `paths` map holds the original set plus the App UI kit v2 icons (`docs/design/claude-design/ui_kits/app-v2/icons.js`), with `aliases` mapping colliding kit names to the existing icon. `iconSvg(name, { size, stroke })` returns a fresh `<svg>`; `hydrate(root)` fills markup-authored `<i class="wg-ico" data-icon="…">` placeholders (bootstrap hydrates the document once after mount; components that inject such markup hydrate their own subtree). Unknown names throw. Used by the tab bar, app bars and any future toolbar/tile icons — **do not hardcode inline SVG markup in feature code**.
- **Phone chrome** (`components/wg-phone-chrome.js`, exposes `window.WGPhoneChrome`): `WGPhoneChrome.mount(rootEl)` / `WGPhoneChrome.create()` wrap an element in the `.wg-phone` shell (status bar + dynamic island + home indicator). Built and tested as a primitive but **not yet mounted in the runtime** — `index.html` does not load it and `bootstrap.js` does not call `mount()`. It ships for the Phase 3+ screen reskins that will wrap individual views; until then the component is a primitive available to the design system only.
- **App bars**: every top-level view opens with a kit `.wg-appbar` (title, optional `.wg-appbar__sub`, actions, gear last) — the Health views share the title "Health" with the segment named in the subtitle. Screen primaries in the app bar belong to the screen beads.
- **Back button** (`features/back-button.js`, exposes `window.AppBackButton`): `setupAppBackButton()` is called from `features/bootstrap.js` after the initial tab activates. All interactions go through `window.MessengerAdapter` (in-app chevron + `popstate` in the browser PWA): if a modal is open it closes the topmost modal; otherwise it goes to `AppNav.backTarget(tab)` — a page's origin tab, else Today. Visibility tracks the current tab — shown on any non-Today view, hidden on Today. Tapping a nav slot is a lateral jump (no back stack); tapping into a deep view from a card creates a back stack.
- **`tab_order` persistence**: the `tab_order` array in `settings_bundle` and the `POST /api/settings/tab-order` endpoint are still read/written, but the Wandergeek Today layout is fixed (shortcut row → metric grid → food card → workout/sleep row → meds card) and `renderToday()` does not consume `opts.cardOrder` — the stored preference is inert until a reorderable surface lands. Tab order is **not** user-reorderable either.
- **Sub-tab groups inside section views** (`.med-tabs`, `.workout-tabs`, `.health-tabs`): kit `.wg-seg` strips; use `bindTabGroup()` / `activateTabGroup()`, which own `.active` and the `aria-pressed` selection (`TabController.syncPressed` repaints a strip on boot). Meds sub-tabs are History (default) / Schedule / Inventory; Workouts sub-tabs are History / Plans / Exercises / Stats (the "Plans" label keeps the internal `data-tab="groups"` id); Health sub-tabs are Overview (charts) / Notes (diary, loads lazily). Food sub-tabs (`.food-tabs` / `#food-subtabs`) are Log (default) / Food DB — reinstated by med-ejq.3 to replace the collapsible `#food-library-view` accordion; the meals pane went away with it. Food is the one section whose sub-tab has **no storage key**: the markup ships with Log active so a fresh load always opens on the log, but an in-session switch to Food DB stays put across section re-entry — the pane class lives in the DOM and `switchTab('food')` only re-runs `loadFoodLogs()`. Daily vs Weekly is a separate in-card segmented toggle inside `#food-macros-card`. Sub-tab state persists under `mt-<section>-subtab` — `mt-meds-subtab` (values `schedule` / `history` / `inventory`, **default `history`**) uses `sessionStorage` so every fresh launch lands on History regardless of prior in-session picks (round-2 Task 4); legacy `localStorage['mt-meds-subtab']` values are purged on module load. `mt-workouts-subtab` (values `history` / `groups` / `exercises` / `stats`) and `mt-health-subtab` (values `overview` / `notes`) still use `localStorage`. Range selectors use `localStorage` with the same key convention: `mt-bp-range` (values `14` / `30` / `60`, **default `14`** — round-2 Task 2), `mt-weight-range` / `mt-workouts-stats-range` (values `7d` / `30d` / `90d` / `all`, default `30d`), and `mt-health-range` (values `7d` / `30d`, default `7d`).
- **Food screen shell**: `#food-view.view.wg-screen-stage` mirrors the BP backdrop. Kit F1–F3 (med-xso6.16): the app bar holds the one primary `#add-food-inline-btn`; the Log pane stacks the kit `.wg-daynav` (relative-day chip + date), the macros card (Daily/Weekly toggle, "Tracking incomplete" `.wg-toggle` row in its foot, inline "No daily target set" empty state when no targets exist), then `.wg-section` meal groups of `.wg-row` items or a `.wg-empty` day card with Search/Scan/Photo/Describe shortcuts.
- **Gamification surfaces** (gated on the `gamification` feature flag; HP / levels / the Health Score are not rendered anywhere — owner decision, med-8tur): (1) The **Today Goal Line hero** (`features/today.js` `renderGoalLineTile`, cache key `gamification_goal_line` → `GET /api/gamification/goal-line`, tags `gamification/weight/workout/bp/settings`, bootstrap-warmed) shows the weight goal on the trend plus feature-gated workout/BP fact rows and one CTA; tapping it opens Journey (`switchTab('journey')`). (2) The **Journey screen** (`features/journey.js`, `window.Gamification`; a page, not a tab — also opened from the Today app-bar route icon) leads with a goal-context card from the same read-model, then the narrative/gauge cards it loads via `cachedFetch` — the code is the source of truth for the card order. (3) The **Settings targets editor** (`#gamification-targets-settings`, gated by `updateGamificationTargetsVisibility()`) edits the 6 band metrics (`bp_systolic`, `bp_diastolic`, `resting_hr`, `stress`, `sleep_hours`, `steps`) the backend honors; `features/settings.js` populates it from `GET /api/gamification/targets` and saves via `DataStore.applyOptimistic('gamification', …)` → `PUT /api/gamification/targets` with `commit`/`rollback` (Critical Rule #9).
- **Accessibility**: the tab bar is `<nav aria-label="Primary">` with each tab a `<button>` carrying `aria-current="page"` when active; the segment strip is a `role="group"` of `aria-pressed` buttons; icon-only app-bar buttons carry `aria-label`. No `role="tablist"` anywhere — navigation is landmark-based, not tab-widget-based.
- **Deep-link router** (`features/deeplink-router.js`, `window.handleDeepLinks`): URL hash and messenger start param route to any section by name (`#bp`, `#weight`, `#health` land on the Health tab with that segment active). Deep links land directly on the section with its tab lit and the back button visible, bypassing Today.

## Data Flow

Cross-device state converges through the encrypted vault sync (`web/cloud/js/sync.js` pulls on open and after writes); screens repaint from the `datastore:changed` event after optimistic writes, and from `invalidateTags` refreshes otherwise.

### Write path

```
User Action (e.g., log BP reading)
       │
       ▼
offlineAwareApiCall()          ← Layer 3 (sync.js)
       │
       ├── Online? ──→ POST /api/bp ──→ apishim ──→ vault
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

## Testing posture

The frontend test suite (`web/static/js/tests/*.test.js`, run via `pnpm test`) is **integration-first**. Most tests should boot the real app shell through `web/static/js/tests/helpers/frontend-harness.js` (which mounts `index.html` under jsdom and loads the production scripts in their real order) and assert on observable DOM, store state, or API call shape — not on internal helper call counts.

Rules for adding tests:

- **Default to integration.** A new test for a feature behavior belongs in that feature's existing suite (`features.<topic>.test.js` or `<feature>.<aspect>.test.js`, e.g. `bp.render.test.js`, `meds.history.test.js`, `food.modal.test.js`). Extend an existing `describe` block before creating a new file.
- **Pure-unit tests are reserved for layers without an integration entry point.** Acceptable: web components (`components.wg-*.test.js`), the Dexie/IndexedDB layer (`db.*.test.js`), the sync engine (`sync.manager-flow.test.js`, `sync.retry.test.js`), the cached-fetch primitive (`cached-fetch.*.test.js`), and the cross-cutting bootstrap path (`bootstrap.*.test.js`). Anywhere else, prefer the integration entry point.
- **Do not add coverage-driven tests.** Files named `*-branches`, `*-edges`, `*-characterization`, `*-extended`, or otherwise written to lift coverage numbers (rather than to pin a real user-visible behavior) are not added. The 2026-05 prune removed the existing ones; they made the suite brittle without catching regressions the integration suites already caught.
- **No standalone "pin defect #N" or task-stamp files.** A regression for a fixed bug is added as one more `it()` in the owning feature suite, not as `<feature>.<defect-name>-removed.test.js` or `<view>.task<N>.test.js`. The pinned assertion travels with the rest of the feature's coverage and stays discoverable when the feature is rewritten.
- **Parameterize structurally identical suites.** When several modal/section tests differ only by selectors and ids (the original 11 `modals.*.header-actions.test.js` files were the canonical example), collapse them into one `describe.each([...])` table. The consolidated `modals.header-actions.test.js` is the reference.
- **Architecture tests stay narrow.** `architecture.*.test.js` files pin invariants the human reviewer cannot eyeball (globals allowlist, design-token usage, MCP coverage, etc.). They are not a place to assert feature behavior.

File-naming conventions that survived the prune:

| Pattern | Purpose |
|---------|---------|
| `architecture.*.test.js` | Repo-wide invariants — globals, design tokens, MCP coverage, offline-coverage allowlist |
| `components.wg-*.test.js` | Web-component unit tests (one file per `<wg-*>` element) |
| `features.*.test.js` | Cross-feature integration suites that boot the harness and exercise multiple modules together |
| `<feature>.<aspect>.test.js` | Per-feature integration suites — `bp.render`, `meds.history`, `weight.history`, `food.modal`, `workout.next`, `today.subscribe`, etc. One file per feature × aspect, not per task or defect. |
| `modals.header-actions.test.js` | The single parameterized suite covering header-action wiring across every modal. New modals add a row to its `describe.each` table — they do not add a new file. |
| `db.*`, `cached-fetch.*`, `data-store.*`, `sync.*`, `bootstrap.*` | Cross-cutting infra layers without an integration entry point — pure-unit tests live here. |
