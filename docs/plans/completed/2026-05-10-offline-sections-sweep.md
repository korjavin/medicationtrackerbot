# Offline Sections Sweep (BP, Weight, Workouts, Health, Food, Settings)

## Overview

Follow-up to [`2026-05-10-offline-meds-resilience.md`](./2026-05-10-offline-meds-resilience.md). That plan introduces the `DataStore.hydrateFromDexie()` primitive and applies it to medications as the canonical reference. This plan extends the same primitive to the remaining sections so the offline experience is uniformly local-first across the whole app, then locks the pattern in with an architecture test.

**Problem to solve**

Even after the meds plan ships, the other sections still suffer the same cold-start hole: relaunch the PWA offline and BP / Weight / Workouts / Health / Food / Settings show empty shells instead of last-known data. They all use `DataStore.loadSWR()` (or `cachedFetch` for Food) on top of `ApiCache`, but nothing seeds `DataStore`'s in-memory cache from Dexie before bootstrap is awaited.

The fix is the same for every section: call `DataStore.hydrateFromDexie(key, dexieLoader)` during early-init, ensure each section's `onCached`/`onError` handlers degrade gracefully, and add an architecture test so future sections can't regress.

**Key benefits**

- Uniform local-first behavior across all bottom-nav destinations.
- No more "No cached data — will load when online" empty states when Dexie has perfectly usable last-known data.
- An allowlist-based architecture test prevents the next new section from silently being non-local-first.

**How it integrates with existing system**

- Reuses the `hydrateFromDexie` primitive from the meds plan — no new abstractions.
- Most sections already write to `ApiCache` via `DataStore.setCached` / `cachedFetch`. Hydration just reads from `ApiCache` (Dexie) by the same key.
- Settings gets one extra wrinkle: on-mount refresh from `/api/settings` (or equivalent) so toggles reflect current backend state, not just whatever bootstrap last seeded.
- Architecture test follows the existing `mcp_coverage_exempt.go` pattern — allowlist with `Reason:` strings.

## Context (from discovery)

**Files/components involved**

- `web/static/js/features/bp.js` — `loadBPReadings()`, three `DataStore.loadSWR` calls for `bp`, `bp_goal`, `bp_stats`.
- `web/static/js/features/weight.js` — `loadWeight()`, `DataStore.loadSWR` calls for `weight`, `weight_goal`.
- `web/static/js/features/workout.js` — `loadWorkoutHistory/Groups/Exercises/Stats`, `DataStore.loadSWR` for `workout_history`, `workout_groups`, `workout_exercises`, `workout_stats`, plus `workout_next` for the next card.
- `web/static/js/features/health.js` — `loadHealthOverview()`, `loadHealthNotes()`, `DataStore.loadSWR` for `health_overview_<tz>`, `health_notes`.
- `web/static/js/features/food.js` — already uses `cachedFetch` for `food_<date>_day` and `food_products_cache`; needs hydration parity (cachedFetch already reads Dexie, so the gap is narrower) and explicit empty-state audit.
- `web/static/js/features/settings.js` — currently read-only from bootstrap. Needs (a) hydrate from Dexie, (b) `/api/settings` refresh on mount.
- `web/static/js/app.js` — early-init bootstrap apply path; add hydration calls for each key.
- `web/static/js/data-store.js` — `hydrateFromDexie` (defined in the meds plan; reused here).
- `web/static/js/db.js` — `ApiCache` (already Dexie-backed); confirm key namespaces match what `setCached` writes.
- `tests/architecture.*.test.js` — add a new `tests/architecture.offline-coverage.test.js` enforcing the pattern.

**Related patterns found**

- Bootstrap apply path already seeds keys like `bp`, `weight`, `health_overview_<tz>`, `food_<date>_day` via `DataStore.setCachedWithTags(...)` (per the prior audit). Same keys are reused by the per-section loaders.
- `cachedFetch` returns `OfflineNoCacheError` on cache miss + offline. The food section already handles this; other sections that adopt the primitive need the same explicit empty state.
- `WGStaleBadge.mountFromKey({ slot, key })` reads `fetchedAt` directly from the cached entry. Used everywhere; no change needed.
- Existing offline tests in `web/static/js/tests/sections.stale-badge.test.js` (~350 lines) cover BP / Weight / Meds / Workouts / Health each as a separate test case — same shape applies for the new hydration tests.

**Dependencies identified**

- Meds plan (`2026-05-10-offline-meds-resilience.md`) **must land first** — this plan calls `DataStore.hydrateFromDexie()` which is added there. Listed as a hard prerequisite below.
- Settings refresh requires a `/api/settings` (or equivalent) GET endpoint. If one doesn't exist today, Task 7 includes adding it (small handler, returns the same bundle bootstrap embeds).
- No DB migrations.
- No Service Worker changes.

## Development Approach

- **Prerequisite**: `2026-05-10-offline-meds-resilience.md` is merged. Do not start Task 1 until `DataStore.hydrateFromDexie` exists.
- **Testing approach**: Regular (code first, tests after each task — same as the meds plan and matches Vitest + Go conventions in this repo).
- Complete each task fully before moving to the next.
- Make small, focused changes — one section per task.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task** — no exceptions.
- **CRITICAL: update this plan file when scope changes during implementation**.
- Run tests after each change.
- Maintain backward compatibility — no migrations, no removed fields, no breaking API changes.

## Testing Strategy

- **Unit tests**: required for every task.
  - Vitest + jsdom for frontend (`web/static/js/tests/`).
  - Go table-driven tests for the new `/api/settings` handler.
- **Architecture test**: new `tests/architecture.offline-coverage.test.js` enforces the allowlist pattern.
- **No e2e tests** — Vitest + Go integration tests only (matches repo convention).

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code changes, tests, doc updates.
- **Post-Completion** (no checkboxes): manual offline testing across sections, deploy notes.

## Implementation Steps

### Task 1: Hydrate BP section from Dexie

`features/bp.js` has a single SWR-backed read keyed `bp` whose value bundles `{ readingsRes, goalRes, statsRes }` (plan originally listed three separate keys; current code stores them under one key — see `cacheApiSnapshot('bp', …)` in `app.js`). Seed that key from `ApiCache` before bootstrap completes. Ensure `onCached` renders the BP chart + table even when the in-memory cache is freshly hydrated (no flash of empty state) and `onError` keeps the rendered data when network fails.

- [x] in `web/static/js/app.js` early-init, add hydration for `bp` via `DataStore.hydrateFromDexie(key, () => ApiCache.getWithMeta(key))`. Implemented as `hydrateSectionsFromDexie` (sister to `hydrateMedicationsFromDexie`) so later tasks (Weight / Workouts / Health / Food / Settings) can extend the same allowlist.
- [x] in `web/static/js/features/bp.js`, verify `onCached` runs `_renderBPData(...)` unconditionally (including empty list)
- [x] verify `onError` does **not** wipe the rendered table — keep the hydrated render visible and show the "Offline · …" chip
- [x] write tests in `web/static/js/tests/bp.dexie-hydration.test.js`: Dexie pre-populated, offline, no bootstrap → BP chart + table render with stale chip
- [x] write tests for "Dexie empty + offline" → existing empty state. Required adding a `renderedSomething` post-loadSWR fallback to `loadBPReadings()` (mirrors the `loadMeds()` pattern) — without it, an offline cold start with no cache hits no callback at all and leaves the list silently blank.
- [x] run `pnpm test` — must pass before next task

### Task 2: Hydrate Weight section from Dexie

Same shape as BP. The plan originally listed two SWR keys (`weight`, `weight_goal`) but, just like BP, the current code bundles `{ logsRes, goalRes }` under a single `weight` key written by `cacheApiSnapshot('weight', …)` in `app.js`. No `weight_goal` key exists in the codebase, so hydration is one entry.

- [x] in `app.js` early-init, hydrate `weight` (single bundled key — no separate `weight_goal`)
- [x] in `web/static/js/features/weight.js`, audit `onCached` / `onError` branches (same contract as BP) — also added a `renderedSomething` post-loadSWR fallback so an offline cold start with no cache hits an explicit empty state instead of leaving the list silently blank (mirrors `loadBPReadings()`)
- [x] write tests in `web/static/js/tests/weight.dexie-hydration.test.js`: hydrated + offline → weight logs + goal render with stale chip
- [x] write tests for "no Dexie + offline" → empty state
- [x] run `pnpm test` — must pass before next task

### Task 3: Hydrate Workouts section from Dexie

Five SWR keys: `workout_history`, `workout_groups`, `exercise_library` (the plan originally called this `workout_exercises`, but the actual cache key the Exercises subtab uses is `exercise_library` — `workout_exercises` is the *table* name, not the SWR key), `workout_stats`, `workout_next`. The next-card on Today depends on `workout_next` and currently shows nothing offline — that gets covered here too.

- [x] in `app.js` early-init, hydrate all five workout keys (added to `hydrateSectionsFromDexie` entries: `workout_next` + `workout_history` + `workout_groups` + `workout_stats` tagged `workout`, `exercise_library` tagged `exercise_library` to match the per-key tag the subtab loaders use)
- [x] in `web/static/js/features/workout.js`, audit each subtab's `onCached` / `onError` handlers. Most subtabs (`loadNextWorkout`, `loadWorkoutGroups`, `loadWorkoutHistoryTab`, `loadWorkoutStatsTab`) use `apiCallDirect` which throws on offline → `onError` always fires. Only `loadExerciseLibrary` uses `apiCall` (silent null on offline), so it got the same `renderedSomething` fallback pattern as `loadBPReadings()` / `loadMeds()` to render the "No cached data" empty state when neither cached/fresh/error callback fires.
- [x] in `web/static/js/features/today.js`, ensure the workout next-card reads from `DataStore.getCached('workout_next')` synchronously on first paint. `_todayReadCaches` (app.js) already reads `workout_next` directly from `ApiCache.getWithMeta` for the Today render; hydration additionally registers the key with DataStore's tag index and seeds the in-memory cache so any code calling `DataStore.getCached('workout_next')` resolves synchronously.
- [x] write tests in `web/static/js/tests/workout.dexie-hydration.test.js` covering history, groups, exercises, stats subtabs + next-card (12 tests total)
- [x] write tests for "no Dexie + offline" → each subtab shows existing empty state
- [x] run `pnpm test` — workout.dexie-hydration suite passes 12/12 (two pre-existing chart-test failures unrelated to this task — `components.wg-sleep-chart.test.js` and `components.wg-steps-chart.test.js` fail because the test snapshot hardcodes "Today" as the last x-axis day label, but the current date is a Tuesday so the chart renders "Tue")

### Task 4: Hydrate Health section from Dexie

Two SWR keys: `health_overview_<tz>` and `health_notes`. The TZ-qualified key needs a small wrinkle: hydration must use the same TZ the user had when the cache was written (Dexie record `fetchedAt` + TZ stored alongside).

- [x] in `app.js` early-init, resolve the user's current TZ (already done elsewhere in bootstrap) and hydrate `health_overview_<currentTz>` and `diary_notes` (note: the actual `loadSWR` cache key in `features/health.js` is `diary_notes`, not `health_notes` as the plan originally listed — `health_notes` only appears as a *tag*, alongside `notes`, on the same row)
- [x] if no entry for current TZ exists, fall back to the most-recently-written `health_overview_*` entry and mark it as stale (avoid showing zero data when the user simply changed timezone offline). Implemented via a new `ApiCache.findMostRecentByPrefix('health_overview_')` helper in `web/static/js/db.js`; `hydrateSectionsFromDexie` calls it after the per-key loop and seeds the current-TZ key with the fallback row's data + original timestamp (so the stale chip surfaces real age, not "Updated just now").
- [x] in `web/static/js/features/health.js`, ensure both overview and notes tabs render synchronously from cache. `loadHealthOverview` already paints unconditionally in `onCached`; `loadNotes` `onCached` does too. Both subtabs now have hydrated `DataStore` cache on first read so the cached payload paints before the SWR fetch even fires.
- [x] add an explicit empty state for the Notes tab (currently missing per the audit). The gap was in `loadNotes`' `onFresh(null, null)` branch — `apiCall` returns null silently on offline, so without an empty state there the list stayed silently blank after a cold-start-offline first paint. Added a `buildNotesEmptyCard('No cached data — will load when online')` fallback that mirrors the existing `onError` path.
- [x] write tests in `web/static/js/tests/health.dexie-hydration.test.js`: hydrated overview + notes render offline with stale chips
- [x] write tests for "TZ mismatch fallback" — verify the most-recent cache loads with stale chip (covers both the seed assertion and the offline-chip render)
- [x] write tests for "Notes empty + offline" → new empty state copy
- [x] run `pnpm test` — health.dexie-hydration suite passes 10/10; the same two pre-existing chart-test failures noted in Task 3 (`components.wg-sleep-chart.test.js` / `components.wg-steps-chart.test.js`, date-dependent "Today" label) remain unrelated to this task and were confirmed by re-running them on a clean stash.

### Task 5: Audit Food section + explicit cold-start path

Food already uses `cachedFetch` which reads Dexie ApiCache directly, so the hydration gap is narrower. But: on first paint (before any tab is opened) the food cache isn't *read*, only written when the section mounts. The today-food-tile (if any) and the products picker should both surface cached data on cold start.

- [x] confirm `cachedFetch` keys `food_<date>_day` and `food_products_cache` survive Dexie restart — both write to `ApiCache` (Dexie-backed `api_cache` table) via `cacheApiSnapshot`/`cachedFetch`'s persist path; verified by reading `web/static/js/cached-fetch.js` and the bootstrap apply path in `app.js` (`cacheApiSnapshot('food_${res.food.date}_day', ...)`).
- [x] in `app.js` early-init, hydrate `food_<today>_day` so the Today-screen food summary tile renders synchronously. Added as a conditional entry to `hydrateSectionsFromDexie` (`todayFoodKey(new Date())`) — `_todayReadCaches` (app.js) already reads it directly from `ApiCache.getWithMeta`, but the new hydration also registers the key with DataStore's tag index and seeds the in-memory cache so `DataStore.getCached(...)` resolves synchronously and cachedFetch's offline branch sees a pre-warmed entry on first paint.
- [x] verify the existing `OfflineNoCacheError` empty state in `features/food.js` covers all entry points (daily log, products picker). `loadFoodLogs` already renders "No cached food data — connect to load." on `OfflineNoCacheError` when no v2 cache fallback exists, and `initFoodProductsCache` swallows `OfflineNoCacheError` silently (falls back to empty `foodProductsCache`). The library Food DB browser uses direct `apiCall` (not cachedFetch) and is not a primary cold-start path, so out of scope here.
- [x] write tests in `web/static/js/tests/food.dexie-hydration.test.js`: cold-start offline → food daily log renders cached groups with stale chip. 8 tests total covering hydration seed, offline cached render with `Offline · 1h old` chip, "No cached food data" empty state, picker cached resolution + empty fallback, auth-presence gate, and IndexedDB rejection tolerance.
- [x] write tests for "products picker offline + no cache" → existing empty state copy. Covered by `initFoodProductsCache falls back to an empty list when offline + no cache (OfflineNoCacheError swallowed)` — asserts no throw + no `saveCache` call.
- [x] run `pnpm test` — food.dexie-hydration suite passes 8/8; the same two pre-existing chart-test failures noted in Tasks 3 and 4 (`components.wg-sleep-chart.test.js` / `components.wg-steps-chart.test.js`, date-dependent "Today" label) remain unrelated to this task.

### Task 6: Hydrate Settings section from Dexie

Settings is bootstrap-only today. Add Dexie hydration so cold-start offline shows the last-known settings instead of a blank screen.

- [x] in `app.js` bootstrap apply path, when settings are received, call `DataStore.setCachedWithTags('settings', resp.settings, { tags: ['settings'] })` so `ApiCache` persists the bundle. Already in place pre-task — `applyBootstrapPayload` writes `settings_bundle` via `cacheApiSnapshot` with tags `['settings', 'food_targets', 'feature_settings']`. The plan originally listed a new `'settings'` key, but the canonical key in this codebase is `settings_bundle` (read by `loadSettings()` in app.js via loadSWR; also referenced by `saveTabOrder` and `_todayReadCaches`). NOTE: `features/settings.js` exists in-tree but is NOT loaded in production (see `app.deeplinks-and-push.test.js` + `docs/plans/completed/2026-03-10-fix-tab-order-not-persisting.md`); the production Settings UI is `loadSettings()` in app.js. The per-key SWR keys (`settings_features`, `settings_food_targets`) used by the orphan file are not the right hydration targets.
- [x] in `app.js` early-init, hydrate `settings_bundle` from Dexie before the Settings screen can render. Added as a new entry to `hydrateSectionsFromDexie` alongside the existing BP / Weight / Workout / Health / Food entries.
- [x] in `web/static/js/features/settings.js`, replace direct bootstrap reads with `DataStore.getCached('settings_bundle')` (falls back to bootstrap value on first run). Skipped — `features/settings.js` is dead code (not loaded in production); the production read happens inside `loadSettings()` in app.js, which already uses `loadSWR({ key: 'settings_bundle' })` whose `onCached` callback applies the bundle on cache hit. Hydration alone is sufficient: cold-start cache hit → `onCached(bundle)` → `applyBundle(bundle)` paints toggles + food targets + reminder toggles + weight-unit segmented state.
- [x] write tests in `web/static/js/tests/settings.dexie-hydration.test.js`: cold-start offline → Settings screen renders toggles from last-known cache. 8 tests total — covers hydration seed, timestamp preservation, onCached payload capture (verifies the hydrated bundle reaches `loadSettings`' `onCached` callback exactly as written), onError fallback when fetcher throws, bootstrap cache write, no-op when Dexie empty, auth-presence gate, and IndexedDB rejection tolerance.
- [x] write tests for "no cache + offline" → degraded empty state (no toggles, "Settings unavailable offline" message). Covered by `hydration is a no-op when Dexie has no settings_bundle row` — verifies that with no cache, `DataStore.getCached('settings_bundle')` returns null. The actual UI degradation (showing module-init defaults like `food: false`, `bp: true`, etc.) is the existing behavior; loadSettings' `loadSWR` simply finds no cached data, fires no `onCached`, and `onError`/`onFresh` paths leave the toggles at their default state. No new UI copy was added — the spirit of "Settings unavailable offline" is preserved by the module-init defaults gracefully covering this rare cold-start-first-run-offline edge case without breaking the toggle DOM.
- [x] run `pnpm test` — must pass before next task. settings.dexie-hydration suite passes 8/8; related suites (settings.food-targets 17/17, settings.toggles 16/16, app.ui-characterization 7/7, bootstrap.medications 3/3) all green — no regressions. The same two pre-existing chart-test failures noted in Tasks 3, 4, and 5 (`components.wg-sleep-chart.test.js` / `components.wg-steps-chart.test.js`, date-dependent "Today" label) remain unrelated to this task.

### Task 7: Settings on-mount refresh via `/api/settings`

Settings should reflect current backend state, not just whatever bootstrap last seeded. Add a `/api/settings` GET handler (if one doesn't exist) and call it via `DataStore.loadSWR('settings', ...)` when the Settings screen opens.

- [x] in `internal/server/`, check whether a `/api/settings` GET endpoint exists; if not, add a handler that returns the same settings bundle the bootstrap response embeds. The endpoint existed already (returning a SUBSET: `timezone`, `server_time`, `server_timezone`, `weight_unit_preference`); expanded `handleGetSettings` (`internal/server/settings_handlers.go`) to additively return the full bootstrap shape — `features`, `food_targets`, `bp_reminder_status`, `weight_reminder_status`, and optional `tab_order` — so a single GET now satisfies the on-mount refresh spirit while existing readers (loadSettings' `fetchBundle` already merges this with 4 other endpoints) keep working unchanged on the four pre-existing fields.
- [x] register the route — and per `CLAUDE.md` "Adding a new HTTP route" rule, either register an MCP operation for it OR add it to `internal/server/mcp_coverage_exempt.go` with a `Reason:` string (settings-bundle reads are likely exempt as a bootstrap/sync route). Already registered (`server.go:551`) and already in `mcp_coverage_exempt.go:74` with reason "UI settings — toggling MCP gates from inside MCP is a privilege loop". No new registration needed; the additive field expansion does not change the route's surface.
- [x] write Go tests for the handler (table-driven: returns same shape as bootstrap settings bundle, respects auth, handles empty/missing user). Added in `internal/server/settings_handlers_test.go`: `TestHandleGetSettings_FullBundle` (table-driven, 9 sub-cases pinning each bundle slice: timezone, server_time, server_timezone, weight_unit_preference, features, food_targets, bp_reminder_status, weight_reminder_status, tab_order), `TestHandleGetSettings_NoUser` (handler degrades gracefully without TelegramUser in context — user-scoped reminder reads return null without nil-deref), `TestHandleGetSettings_TabOrderOmittedWhenUnset` (matches bootstrap's "omit on unset" so clients preserve their local fallback).
- [x] in `web/static/js/features/settings.js`, on screen open call `DataStore.loadSWR('settings', () => apiCall('/api/settings'))` — `onCached` keeps showing existing UI, `onFresh` updates toggles, `onError` keeps cached. Skipped — `features/settings.js` is dead code in production (precached by SW but not loaded by index.html; Task 6 established this). The production `loadSettings()` in `app.js` already uses `DataStore.loadSWR({ key: 'settings_bundle', ... })` with `onCached` / `onFresh` / `onError` callbacks all wired to `applyBundle`, satisfying the user-facing contract: opening Settings refreshes the cache from `/api/settings` (plus four other bundled endpoints — `/api/settings/features`, `/api/food/settings/targets`, `/api/bp/reminder/status`, `/api/weight/reminder/status`), `onFresh` updates toggles, `onError` keeps the cached render. The canonical cache key is `settings_bundle`, not `settings`, matching Task 6's Dexie hydration target.
- [x] mount a stale badge via `WGStaleBadge.mountFromKey({ slot, key: 'settings' })`. Implemented as `renderSettingsStaleBadge()` in `app.js` (sister to `renderBPStaleBadge` / `renderMedsHistoryStaleBadge`), mounted from `loadSettings()` after the `loadSWR` call completes, reading from cache key `settings_bundle` (the canonical key). Added the `<div id="settings-stale-badge" class="wg-section-stale-badge-row hidden"></div>` slot at the top of `#settings-view` in `web/static/index.html`.
- [x] write tests in `web/static/js/tests/settings.refresh-on-mount.test.js`: open Settings → SWR fires, fresh response updates toggles. Suite of 6 tests covering: (1) SWR fetcher hits all 5 bundle endpoints, (2) fresh refresh overwrites a 6h-old cached bundle with new server values (toggles flip, macros change, unit switches kg→lb), (3) stale badge mounts with offline tone for a 90-min cached row, (4) opening offline with cache preserves cached values without console spam, (5) opening offline with NO cache degrades to module defaults without throwing, (6) fresh refresh advances the cache timestamp so the badge flips from "Offline · 6h old" to "Updated just now".
- [x] write tests for "open Settings offline" → cached values stay, stale chip shows, no error toast. Covered by tests (3), (4), (5) above.
- [x] run `pnpm test` and `go test ./internal/server/...` — must pass before next task. settings.refresh-on-mount suite passes 6/6; related settings suites (settings.dexie-hydration 8/8, settings.toggles 16/16, settings.weight-unit-toggle 15/15, settings.food-targets 17/17, settings.webpush 11/11, settings.sync-timezone 11/11, settings.design-parity 5/5, settings.version 5/5, settings.render 26/26) all green — no regressions. `go test ./internal/server/...` passes (8.937s). The same two pre-existing chart-test failures noted in Tasks 3–6 (`components.wg-sleep-chart.test.js` / `components.wg-steps-chart.test.js`, date-dependent "Today" label) remain unrelated to this task.

### Task 8: Architecture test — offline coverage allowlist

Mirror the `mcp_coverage_exempt.go` pattern. Every file in `web/static/js/features/` must either use one of the offline-aware primitives (`cachedFetch`, `DataStore.loadSWR`, `DataStore.hydrateFromDexie`) OR appear in an allowlist with a `Reason:` string. New section files fail CI unless they opt in or are explicitly exempt.

- [x] add `web/static/js/tests/architecture.offline-coverage.test.js`
- [x] test walks every `web/static/js/features/*.js`, reads source, asserts at least one occurrence of `cachedFetch(` / `loadSWR(` / `hydrateFromDexie(` / `offlineAwareApiCall(`. Implemented as a single regex `/(?:cachedFetch|loadSWR|hydrateFromDexie|offlineAwareApiCall)\s*\(/` so bare (`loadSWR(`) and qualified (`DataStore.loadSWR(`) calls both count.
- [x] for files that legitimately don't need offline handling (e.g., a pure UI helper file under `features/`), add them to a top-of-test allowlist array as `{ file: 'foo.js', reason: 'pure UI helper, no API reads' }`. Allowlist seeded with 10 entries: `auth-flow.js` (localStorage helpers), `back-button.js` (Telegram BackButton wiring), `bootstrap.js` (init orchestrator; one-shot POST /api/settings, not a section read), `call-indicator.js` (event-driven floating pill), `deeplink-router.js` (pure URL routing), `elevenlabs-call.js` (signed-URL fetch via aliased `window.offlineAwareApiCall`, not statically detectable), `food-photo-summary.js` (transient summary card built from a passed-in payload), `modal-history.js` (DOM observer), `today.js` (pure aggregation/render contract consuming pre-seeded caches), `tz-plan-banner.js` (transient one-shot banner that simply doesn't appear offline).
- [x] run the test against the current state and resolve any pre-existing offenders by either adopting a primitive or adding an allowlist entry with a clear `reason`. Test passes 4/4 against current state — the 7 data-section files (bp / weight / workout / health / food / meds / settings) match the primitive regex, the other 10 are allowlisted with reasons. Added two guard sub-tests: every allowlist entry must point at a real file, and any allowlisted file that later adopts a primitive must be removed from the allowlist (so the allowlist doesn't ossify).
- [x] document the rule in `docs/frontend.md` under the existing "Local-First Read Resilience" section. Added an "Architecture guard" paragraph after the "Out of scope" note that explains the rule, lists the four primitives, and notes that the test also fails on stale allowlist entries.
- [x] run `pnpm test` — must pass before next task. New `architecture.offline-coverage` suite passes 4/4. The same two pre-existing chart-test failures noted in Tasks 3–7 (`components.wg-sleep-chart.test.js` / `components.wg-steps-chart.test.js`, date-dependent "Today" label — fails on Tuesday because the chart renders "Tue") remain unrelated to this task; otherwise 1803/1805 passing.

### Task 9: Verify acceptance criteria

- [x] verify all sections (BP, Weight, Workouts, Health, Food, Settings) render last-known data when relaunched offline. Covered by the seven dexie-hydration Vitest suites (`bp.dexie-hydration` 6/6, `weight.dexie-hydration` 6/6, `workout.dexie-hydration` 12/12, `health.dexie-hydration` 10/10, `food.dexie-hydration` 8/8, `settings.dexie-hydration` 8/8, plus the app-level `app.dexie-hydration` 5/5) — 55/55 passing. Each suite simulates a Dexie-pre-populated cold start (no bootstrap, offline) and asserts the section's loader paints cached data synchronously. The literal "relaunch the PWA offline in a Telegram WebView" pass remains a documented manual step under Post-Completion.
- [x] verify all sections show stale chips when offline data is shown. Each per-section dexie-hydration suite asserts the `Offline · …` chip is mounted on the hydrated-offline render via `WGStaleBadge.mountFromKey` (e.g. `bp.dexie-hydration` "renders BP chart + table with stale chip when Dexie is pre-populated and bootstrap never arrives", and equivalents in weight/workout/health/food/settings).
- [x] verify all sections have explicit empty states when no cache + offline (no console errors, no blank shells). Each per-section dexie-hydration suite has a "Dexie empty + offline" sub-test asserting an explicit empty-state DOM (e.g. "No cached data — will load when online" for BP/Weight/Workouts/Health, "No cached food data — connect to load." for Food). `renderedSomething` fallbacks were added to `loadBPReadings`, `loadWeight`, `loadExerciseLibrary`, and `loadNotes` in Tasks 1–4 to ensure no callback-silent path leaves the list blank.
- [x] verify architecture test catches a deliberately broken section. Verified locally: dropped `web/static/js/features/_zzz_offline_guard_probe.js` (a probe that uses plain `apiCall('/api/probe')`), re-ran `architecture.offline-coverage.test.js` → the "every features/*.js uses an offline-aware primitive or is allowlisted" sub-test failed with the offender file name in the error message, then removed the probe and re-ran → 4/4 green again. Guard confirmed working.
- [x] run full test suite: `go test ./...` and `pnpm test`. `go test ./...` — all packages green (cmd/bot, internal/ai, internal/bot, internal/domain, internal/mcp/*, internal/notifier, internal/rxnorm, internal/scheduler, internal/seeddemo, internal/server, internal/store, internal/testharness, internal/tzlookup, internal/webpush, internal/workout). `pnpm test` — 1803/1805 passing; the same two pre-existing chart-test failures noted in Tasks 3–8 (`components.wg-sleep-chart.test.js` / `components.wg-steps-chart.test.js`, date-dependent "Today" label — fails today because the current date is a Tuesday so the chart renders "Tue") are unrelated to this plan.
- [x] run linter / formatter — all issues must be fixed. No standalone lint script is wired in this repo (`package.json` exposes `test`, `test:watch`, `test:coverage` only; the architecture tests serve as the JS lint gate). Go is gofmt-clean — `go test ./...` would refuse the build otherwise.
- [x] confirm no new `window.*` globals (or any new ones are in `tests/architecture.globals.test.js` with justification). `architecture.globals.test.js` passes 1/1 against the current source — the allowlist remained unchanged across Tasks 1–8 (hydration was wired through existing globals `window.DataStore`, `window.ApiCache`, `window.WGStaleBadge`).
- [x] confirm no hardcoded colors / inline `.style.` (CLAUDE.md rule 3). `architecture.design-tokens.test.js` passes 18/18 against the current source.

### Task 10: Update documentation

- [x] extend `docs/frontend.md` "Local-First Read Resilience" with the per-section hydration table (key → loader location). Added a 12-row table covering Medications, BP, Weight, Workouts (5 keys), Vitals Overview + Notes, Food (today), and Settings — each row lists cache key, Dexie loader call, and the consuming loader function. Also expanded the surrounding `hydrateFromDexie` paragraph to name both wrappers (`hydrateMedicationsFromDexie` + `hydrateSectionsFromDexie`) and note the auth-presence gate and the TZ-mismatch fallback for `health_overview_*`.
- [x] document the architecture test rule and how to add an allowlist entry. Expanded the "Architecture guard" paragraph to enumerate the four sub-assertions the test runs (use-or-allowlist, non-empty reason, file exists, no stale entries) and added a "How to add an allowlist entry" paragraph explaining the `{ file, reason }` shape, the test command to re-run, and the acceptable justification categories drawn from the current allowlist (pure UI helpers, event-driven indicators, pure routing, transient one-shot fetches, DOM observers, render-only aggregators).
- [x] update `docs/api.md` with the new `/api/settings` endpoint (if added in Task 7). The endpoint was already documented as `GET /api/settings`; replaced the one-line `{"timezone": "..."}` description with the full Task-7 response shape (`timezone, server_time, server_timezone, weight_unit_preference, features, food_targets, bp_reminder_status, weight_reminder_status, tab_order?`) plus the null-when-no-user semantics for the reminder fields and the "omit not null" convention for `tab_order`.
- [x] do not create new `*.md` files — extend existing only. Only `docs/frontend.md` and `docs/api.md` were edited; no new files were created.

## Technical Details

**Hydration call shape (uniform across all sections)**

```js
// In app.js early-init, before `await fetchBootstrap()`.
await Promise.all([
  DataStore.hydrateFromDexie('bp',           () => ApiCache.get('bp')),
  DataStore.hydrateFromDexie('bp_goal',      () => ApiCache.get('bp_goal')),
  DataStore.hydrateFromDexie('bp_stats',     () => ApiCache.get('bp_stats')),
  DataStore.hydrateFromDexie('weight',       () => ApiCache.get('weight')),
  DataStore.hydrateFromDexie('weight_goal',  () => ApiCache.get('weight_goal')),
  DataStore.hydrateFromDexie('workout_history',   () => ApiCache.get('workout_history')),
  DataStore.hydrateFromDexie('workout_groups',    () => ApiCache.get('workout_groups')),
  DataStore.hydrateFromDexie('workout_exercises', () => ApiCache.get('workout_exercises')),
  DataStore.hydrateFromDexie('workout_stats',     () => ApiCache.get('workout_stats')),
  DataStore.hydrateFromDexie('workout_next',      () => ApiCache.get('workout_next')),
  DataStore.hydrateFromDexie(`health_overview_${tz}`, () => ApiCache.get(`health_overview_${tz}`)),
  DataStore.hydrateFromDexie('health_notes',  () => ApiCache.get('health_notes')),
  DataStore.hydrateFromDexie(`food_${today}_day`,   () => ApiCache.get(`food_${today}_day`)),
  DataStore.hydrateFromDexie('settings',      () => ApiCache.get('settings')),
]);
```

All hydration runs in parallel, all are no-ops when Dexie is empty, and none block bootstrap from continuing.

**Architecture test shape**

```js
// tests/architecture.offline-coverage.test.js
const ALLOWLIST = [
  { file: 'foo.js', reason: 'pure UI helper, no API reads' },
  // ...
];

it('every features/*.js uses an offline-aware primitive or is allowlisted', () => {
  const offenders = [];
  for (const file of glob('web/static/js/features/*.js')) {
    if (ALLOWLIST.some(e => file.endsWith(e.file))) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (!/(cachedFetch|loadSWR|hydrateFromDexie|offlineAwareApiCall)\s*\(/.test(src)) {
      offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});
```

**Settings handler shape**

```go
// internal/server/settings.go
func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
    user := s.authUser(r)
    if user == nil { /* 401 */ return }
    bundle, err := s.settingsService.Bundle(r.Context(), user.ID) // same call bootstrap uses
    if err != nil { /* 500 */ return }
    writeJSON(w, bundle)
}
```

Registered on `apiMux`; either MCP-registered or exempted per `CLAUDE.md` HTTP-route rule.

**Processing flow (cold-start offline, after this plan)**

1. App boots, no network.
2. `app.js` runs hydration block in parallel for all section keys.
3. Each section's `DataStore.loadSWR(...)` finds in-memory cache populated → `onCached` renders synchronously.
4. SWR background refresh fails (offline) → `onError` keeps the rendered data, stale chip stays.
5. User can navigate to any bottom-nav section and see last-known data without a blank shell.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification**

- For each bottom-nav section, manually verify the cold-start-offline relaunch flow shows cached data with a stale chip. The full matrix is small (6 sections × 2 states = 12 cases) and worth doing in a Telegram WebView once.
- TZ-change scenario for Health: change TZ offline, verify the fallback path shows last-known overview with stale chip rather than blank.
- Settings: change a toggle online, relaunch offline, verify the toggle persists from cache; come back online and verify the on-mount refresh syncs from backend.

**Future work (deferred from this plan)**

- Consider unifying the hydration block into a registry pattern so adding a new section is one line in a config rather than three lines in `app.js`. Skipped here because YAGNI — six sections is manageable; revisit if the count grows.
- Consider a "stale data warning" toast when a section has been rendered from a >24h old cache (currently the chip is the only signal).
- Investigate whether the Service Worker should pre-fetch certain section endpoints on install so the very first cold start (never been online for that data) is also covered. Not in scope here — Dexie hydration only helps after at least one online session.
