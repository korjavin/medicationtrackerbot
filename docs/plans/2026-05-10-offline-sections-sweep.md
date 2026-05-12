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

- [ ] in `app.js` early-init, resolve the user's current TZ (already done elsewhere in bootstrap) and hydrate `health_overview_<currentTz>` and `health_notes`
- [ ] if no entry for current TZ exists, fall back to the most-recently-written `health_overview_*` entry and mark it as stale (avoid showing zero data when the user simply changed timezone offline)
- [ ] in `web/static/js/features/health.js`, ensure both overview and notes tabs render synchronously from cache
- [ ] add an explicit empty state for the Notes tab (currently missing per the audit)
- [ ] write tests in `web/static/js/tests/health.dexie-hydration.test.js`: hydrated overview + notes render offline with stale chips
- [ ] write tests for "TZ mismatch fallback" — verify the most-recent cache loads with stale chip
- [ ] write tests for "Notes empty + offline" → new empty state copy
- [ ] run `pnpm test` — must pass before next task

### Task 5: Audit Food section + explicit cold-start path

Food already uses `cachedFetch` which reads Dexie ApiCache directly, so the hydration gap is narrower. But: on first paint (before any tab is opened) the food cache isn't *read*, only written when the section mounts. The today-food-tile (if any) and the products picker should both surface cached data on cold start.

- [ ] confirm `cachedFetch` keys `food_<date>_day` and `food_products_cache` survive Dexie restart (likely yes, since they're in `ApiCache`)
- [ ] in `app.js` early-init, hydrate `food_<today>_day` so the Today-screen food summary tile (if present) renders synchronously
- [ ] verify the existing `OfflineNoCacheError` empty state in `features/food.js` covers all entry points (daily log, products picker)
- [ ] write tests in `web/static/js/tests/food.dexie-hydration.test.js`: cold-start offline → food daily log renders cached groups with stale chip
- [ ] write tests for "products picker offline + no cache" → existing empty state copy
- [ ] run `pnpm test` — must pass before next task

### Task 6: Hydrate Settings section from Dexie

Settings is bootstrap-only today. Add Dexie hydration so cold-start offline shows the last-known settings instead of a blank screen.

- [ ] in `app.js` bootstrap apply path, when settings are received, call `DataStore.setCachedWithTags('settings', resp.settings, { tags: ['settings'] })` so `ApiCache` persists the bundle
- [ ] in `app.js` early-init, hydrate `settings` from Dexie before the Settings screen can render
- [ ] in `web/static/js/features/settings.js`, replace direct bootstrap reads with `DataStore.getCached('settings')` (falls back to bootstrap value on first run)
- [ ] write tests in `web/static/js/tests/settings.dexie-hydration.test.js`: cold-start offline → Settings screen renders toggles from last-known cache
- [ ] write tests for "no cache + offline" → degraded empty state (no toggles, "Settings unavailable offline" message)
- [ ] run `pnpm test` — must pass before next task

### Task 7: Settings on-mount refresh via `/api/settings`

Settings should reflect current backend state, not just whatever bootstrap last seeded. Add a `/api/settings` GET handler (if one doesn't exist) and call it via `DataStore.loadSWR('settings', ...)` when the Settings screen opens.

- [ ] in `internal/server/`, check whether a `/api/settings` GET endpoint exists; if not, add a handler that returns the same settings bundle the bootstrap response embeds
- [ ] register the route — and per `CLAUDE.md` "Adding a new HTTP route" rule, either register an MCP operation for it OR add it to `internal/server/mcp_coverage_exempt.go` with a `Reason:` string (settings-bundle reads are likely exempt as a bootstrap/sync route)
- [ ] write Go tests for the handler (table-driven: returns same shape as bootstrap settings bundle, respects auth, handles empty/missing user)
- [ ] in `web/static/js/features/settings.js`, on screen open call `DataStore.loadSWR('settings', () => apiCall('/api/settings'))` — `onCached` keeps showing existing UI, `onFresh` updates toggles, `onError` keeps cached
- [ ] mount a stale badge via `WGStaleBadge.mountFromKey({ slot, key: 'settings' })`
- [ ] write tests in `web/static/js/tests/settings.refresh-on-mount.test.js`: open Settings → SWR fires, fresh response updates toggles
- [ ] write tests for "open Settings offline" → cached values stay, stale chip shows, no error toast
- [ ] run `pnpm test` and `go test ./internal/server/...` — must pass before next task

### Task 8: Architecture test — offline coverage allowlist

Mirror the `mcp_coverage_exempt.go` pattern. Every file in `web/static/js/features/` must either use one of the offline-aware primitives (`cachedFetch`, `DataStore.loadSWR`, `DataStore.hydrateFromDexie`) OR appear in an allowlist with a `Reason:` string. New section files fail CI unless they opt in or are explicitly exempt.

- [ ] add `web/static/js/tests/architecture.offline-coverage.test.js`
- [ ] test walks every `web/static/js/features/*.js`, reads source, asserts at least one occurrence of `cachedFetch(` / `loadSWR(` / `hydrateFromDexie(` / `offlineAwareApiCall(`
- [ ] for files that legitimately don't need offline handling (e.g., a pure UI helper file under `features/`), add them to a top-of-test allowlist array as `{ file: 'foo.js', reason: 'pure UI helper, no API reads' }`
- [ ] run the test against the current state and resolve any pre-existing offenders by either adopting a primitive or adding an allowlist entry with a clear `reason`
- [ ] document the rule in `docs/frontend.md` under the existing "Local-First Read Resilience" section
- [ ] run `pnpm test` — must pass before next task

### Task 9: Verify acceptance criteria

- [ ] verify all sections (BP, Weight, Workouts, Health, Food, Settings) render last-known data when relaunched offline
- [ ] verify all sections show stale chips when offline data is shown
- [ ] verify all sections have explicit empty states when no cache + offline (no console errors, no blank shells)
- [ ] verify architecture test catches a deliberately broken section (add a temporary file that uses plain `apiCall`, assert test fails, then remove the file)
- [ ] run full test suite: `go test ./...` and `pnpm test`
- [ ] run linter / formatter — all issues must be fixed
- [ ] confirm no new `window.*` globals (or any new ones are in `tests/architecture.globals.test.js` with justification)
- [ ] confirm no hardcoded colors / inline `.style.` (CLAUDE.md rule 3)

### Task 10: Update documentation

- [ ] extend `docs/frontend.md` "Local-First Read Resilience" with the per-section hydration table (key → loader location)
- [ ] document the architecture test rule and how to add an allowlist entry
- [ ] update `docs/api.md` with the new `/api/settings` endpoint (if added in Task 7)
- [ ] do not create new `*.md` files — extend existing only

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
