# Offline Meds Resilience (and Dexie Cold-Start Hydration)

## Overview

Many sections still feel non-local-first: opening the app offline (or relaunching the PWA without connectivity) shows empty shells where stale-but-useful data could be displayed. The user singled out **planned medications** — they don't appear offline even though the schedule logic is fully client-side and the meds list is already persisted in Dexie.

This plan makes the planned-medications experience truly local-first by introducing a **Dexie cold-start hydration primitive** and applying it to the medications section as the canonical reference. Other sections will adopt the same pattern in follow-up plans.

**Problem to solve**

1. **Cold-start offline** — relaunching the app while offline never runs `/api/bootstrap`, so `DataStore`'s in-memory `api_cache` is empty. Sections that rely on `DataStore.setCached(...)` warmed by bootstrap fall through to "No cached data — will load when online", even though Dexie still has the previous values.
2. **Meds list not bootstrap-seeded** — only `next_intake` (the single next dose) is seeded. The full medications list is fetched lazily by `loadMeds()`, so the Today tile and Meds screen both show empty until the network call returns.
3. **Schedule logic offline-capable but ungated** — `renderMeds()` parses `med.schedule` JSON entirely client-side via `getNextScheduledDate()`, so once medications are in memory, planned doses render with zero network. The only missing piece is **getting the cached list into memory before the first network attempt**.

**Key benefit**: a relaunch-while-offline shows the last-known meds list with planned doses bucketed by hour and a stale-badge chip — the rest of the app keeps degrading gracefully behind whatever bootstrap eventually returns.

**Integration with existing system**

- Reuses the four-layer architecture (SW + Dexie + SyncManager + DataStore/cachedFetch) — does not introduce a fifth.
- Adds one new primitive: `hydrateFromDexie(key, dexieLoader)` that reads from `MedTrackerDB` and seeds `DataStore` synchronously during early init, before bootstrap is awaited.
- Backend: extends `/api/bootstrap` to include `medications` in its payload, so freshly-authed cold starts are also covered.

## Context (from discovery)

**Files/components involved**

- `internal/server/` — bootstrap handler (`bootstrap.go` or similar). Add a `medications` field to its response struct.
- `web/static/js/app.js` — bootstrap apply path (~line 1310–1396); add a new "Dexie hydration" preflight before bootstrap is awaited.
- `web/static/js/features/meds.js` — `loadMeds()` (line ~848+), `renderMeds()` (line ~289), the SWR onError branch (line ~925).
- `web/static/js/features/today.js` — next-intake tile (line ~98–99) and aggregator that consumes `bootstrap.__next_intake_meta`.
- `web/static/js/db.js` — `MedicationStore.saveCache`/`loadCache` and the `ApiCache` Dexie store.
- `web/static/js/data-store.js` — `DataStore.setCached`, `DataStore.getCached`, `DataStore.loadSWR`.
- `web/static/js/cached-fetch.js` — `window.cachedFetch` wrapper (used as the model for the new primitive).
- `web/static/js/tests/` — existing patterns: `sections.stale-badge.test.js`, `today.next-intake-cached.test.js`, `food.offline-cached-fetch.test.js`, `offline-read-fallbacks.test.js`, `offline-ui.test.js`.
- `tests/architecture.globals.test.js` — global allowlist (if a new `window.*` is added).

**Related patterns found**

- `cachedFetch` returns `{ data, fetchedAt, isFromCache, isStale }` and throws `OfflineNoCacheError` on offline cache miss — the canonical contract.
- `DataStore.loadSWR()` calls `onCached` synchronously when cache present, then `onFresh` after revalidation; `onError` fires on network failure.
- `WGStaleBadge.mountFromKey({ slot, key })` reads the timestamp from the bootstrap-warmed cache.
- Bootstrap apply path in `app.js` already calls `DataStore.setCachedWithTags('next_intake', ...)` for the Today meds tile.

**Dependencies identified**

- Dexie schema in `db.js` — `MedicationStore` already exists with `saveCache(meds)` / `loadCache()`; no schema migration needed for meds.
- Backend `/api/bootstrap` JSON struct — adding a field is additive and won't break existing clients.
- Service Worker — already caches `/api/bootstrap` and `/api/medications` GETs; no SW change required.

## Development Approach

- **Testing approach**: **Regular** (code first, tests after each task — matches the repo's Vitest + Go table-driven conventions).
- Complete each task fully before moving to the next.
- Make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task.
- **CRITICAL: all tests must pass before starting next task** — no exceptions.
- **CRITICAL: update this plan file when scope changes during implementation**.
- Run tests after each change.
- Maintain backward compatibility — no migrations, no removed fields, no breaking API changes.

## Testing Strategy

- **Unit tests**: required for every task.
  - Vitest + jsdom for frontend (`web/static/js/tests/`).
  - Go table-driven tests for backend (`internal/server/*_test.go`).
- **No e2e tests in this repo** — Playwright/Cypress not in use; rely on Vitest + Go integration tests.
- **Architecture tests**: if a new `window.*` global is added, update `tests/architecture.globals.test.js` allowlist with justification.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code changes, tests, doc updates.
- **Post-Completion** (no checkboxes): manual offline testing in a real browser/PWA, deployment notes.

## Implementation Steps

### Task 1: Add `hydrateFromDexie` primitive in `data-store.js`

Add a small async helper that reads a Dexie store and seeds `DataStore.setCached` so subsequent `DataStore.loadSWR()`/`getCached()` calls find data immediately. The primitive accepts a `key`, an async `dexieLoader` function, and an optional `transform` to shape the Dexie record into the in-memory cache value. It is a no-op when the Dexie store is empty.

- [x] add `DataStore.hydrateFromDexie(key, dexieLoader, { transform, tags } = {})` to `web/static/js/data-store.js` — returns `{ hydrated: boolean, fetchedAt }`
- [x] ensure it does not overwrite a cache entry that is already fresher than the Dexie record (compare `fetchedAt`)
- [x] expose as `window.DataStore.hydrateFromDexie` (no new global needed — extends existing one)
- [x] write tests for empty Dexie (no-op, returns `{ hydrated: false }`)
- [x] write tests for populated Dexie (seeds `setCached`, returns `{ hydrated: true, fetchedAt }`)
- [x] write tests for "in-memory cache fresher than Dexie" — does not overwrite
- [x] write tests for `transform` callback applied before seed
- [x] run `pnpm test` — must pass before next task

### Task 2: Hydrate meds list from Dexie before bootstrap completes

Wire the new primitive into the early-init path in `app.js` so the medications list is in memory by the time `loadMeds()` or the Today tile first reads it — even when bootstrap has not yet returned (or never will, if offline).

- [x] in `web/static/js/app.js`, locate the early-init code that runs before `await fetchBootstrap()` resolves
- [x] call `DataStore.hydrateFromDexie('medications', () => MedTrackerDB.MedicationStore.loadCache())` and `await` it before kicking off the first paint of meds-dependent screens
- [x] guarantee it runs before the auth gate decision (so unauthenticated PWA reopens still hydrate from the previous session — gated by an auth-presence check if PII concerns apply, see Technical Details)
- [x] write a test in `web/static/js/tests/app.dexie-hydration.test.js`: stub `MedTrackerDB.MedicationStore.loadCache()` to return a known list, simulate offline bootstrap failure, assert `DataStore.getCached('medications')` returns the seeded list
- [x] write a test for the unauth case — if no auth token, hydration is skipped (or scoped to the prior auth user-id; pick whichever the existing Dexie schema supports)
- [x] run `pnpm test` — must pass before next task

### Task 3: Make `loadMeds()` use hydrated cache as the synchronous first paint

Currently `loadMeds()` (`features/meds.js` line ~848+) calls `DataStore.loadSWR()` which fires `onCached` only if the in-memory cache is populated. With Task 2 done, the in-memory cache is populated. Now make sure `renderMeds()` actually runs synchronously off the cached list and that the stale badge mounts from the Dexie `fetchedAt`.

- [x] in `web/static/js/features/meds.js`, ensure the SWR `onCached` branch unconditionally calls `renderMeds(cachedList)` even when `cachedList.length === 0` (so the empty case is rendered, not skipped)
- [x] replace the `onError` "No cached data — will load when online" branch with: if cache exists → keep showing it + offline chip; if no cache and offline → existing empty-state message
- [x] mount the stale badge via `WGStaleBadge.mountFromKey({ slot, key: 'medications' })` instead of the existing ad-hoc badge call (or confirm the existing call already reads `fetchedAt` from the cache entry)
- [x] write a test in `web/static/js/tests/meds.offline-cold-start.test.js`: with `navigator.onLine = false`, Dexie pre-populated, no bootstrap response — assert planned medications render with hourly buckets and a stale chip
- [x] write a test for "no Dexie data + offline" — asserts the explicit empty state still shows
- [x] write a test for "Dexie data + bootstrap returns updated list" — asserts the SWR refresh swaps in the fresh data without a flash of empty state
- [x] run `pnpm test` — must pass before next task

### Task 4: Seed medications list in `/api/bootstrap` response

Backend change — adds `medications` to the bootstrap payload so first-login cold starts (with no prior Dexie cache) are also covered. Keeps the response additive; existing clients ignore the new field.

- [x] in `internal/server/`, find the bootstrap handler and its response struct (`BootstrapResponse` or similar) — `handleBootstrap` in `internal/server/settings_handlers.go` uses a `map[string]any` rather than a typed struct
- [x] add a `Medications []Medication` field with appropriate JSON tag (`json:"medications,omitempty"`) — already populated under the `"medications"` map key (predates this task); kept as-is to avoid an additive struct refactor
- [x] populate it from the existing medications store call (the same one `/api/medications?archived=true` uses) — `s.meds.ListMedications(true)` matches `handleListMedications` when `archived=true`; documented with a one-line comment in `settings_handlers.go`
- [x] write Go tests for the handler — table-driven: empty user (returns `[]`), user with active meds, user with archived meds (verify the archived flag matches `/api/medications?archived=true`) — `TestHandleBootstrap_IncludesMedications` (table-driven, 3 cases) plus `TestHandleBootstrap_MedicationsMatchesArchivedListEndpoint` (parity guard)
- [x] run `go test ./internal/server/...` — must pass before next task

### Task 5: Apply bootstrapped medications into DataStore + Dexie on bootstrap

Frontend bootstrap apply path — when `/api/bootstrap` returns `medications`, seed both `DataStore` and Dexie so the next cold start (potentially offline) is covered without needing a separate `/api/medications` round-trip.

- [x] in `web/static/js/app.js` bootstrap apply (~line 1310–1396), after parsing the response, call `DataStore.setCachedWithTags('medications', resp.medications, { tags: ['meds'] })` and `MedTrackerDB.MedicationStore.saveCache(resp.medications)` — already wired at `applyBootstrapPayload` lines 262-269 via `cacheApiSnapshot('medications', ...)` (uses tag `['medications']` to match `next_intake`'s invalidation tags rather than introducing a new `'meds'` tag)
- [x] guard against missing field (older backend versions / partial responses) — skip cleanly if `resp.medications` is undefined — `Array.isArray(res.medications)` gate at line 262 handles both `undefined` and non-array values
- [x] write a test in `web/static/js/tests/bootstrap.medications.test.js`: bootstrap returns medications → `DataStore.getCached('medications')` returns same array AND `MedicationStore.loadCache()` returns same array
- [x] write a test for "bootstrap response without medications field" — no error, no overwrite of existing cache (plus a third case for `medications: null` to lock the Array.isArray guard)
- [x] run `pnpm test` — must pass before next task — 166 files / 1734 tests pass

### Task 6: Surface offline state on the Today meds tile

Today's meds tile currently relies on `next_intake` from bootstrap. With Task 5 done, the full medications list is in cache, so the tile can compute its own next intake from `getNextScheduledDate()` if the bootstrap-served `next_intake` is missing or stale.

- [x] in `web/static/js/features/today.js` (~line 98–99), if `bootstrap.__next_intake_meta` is missing or marked stale by `cachedFetch`, fall back to computing the next intake from `DataStore.getCached('medications')` using the same `getNextScheduledDate()` helper that `meds.js` uses — `nextMedCell` now accepts an `opts` arg with `parseMedicationSchedule`/`getNextScheduledDate`; helpers wired through `_todayRender` from `window.*`. `_todayReadCaches` reads the `medications` api_cache key into `bootstrap.medications` (+ `__medications_meta`); fallback grouping mirrors the server's `/api/medications/next-intake` shape (multi-med slots collapse into one card)
- [x] preserve the existing stale badge behavior on the tile — `medications` is added to `_todayReadCaches`'s `keyFeatures` map so its timestamp folds into `oldestCacheTimestamp` → `state.__fetchedAt` → the section-header chip mounted by `renderToday` (`today-stale-badge-row`)
- [x] write a test in `web/static/js/tests/today.next-intake-meds-fallback.test.js`: no `next_intake` cache, but `medications` cache populated → tile renders the soonest planned dose with stale chip — covered by "renders the soonest planned dose from cached medications when next_intake is absent (offline cold start)" plus 4 sibling cases (multi-med grouping, stale-meta fallback, fresh-next_intake precedence, missing-helpers graceful degrade)
- [x] write a test for "neither cache present" — tile shows existing offline empty state — "shows the existing offline empty state when neither next_intake nor medications cache is present" asserts the `Next dose data unavailable offline` kicker
- [x] run `pnpm test` — must pass before next task — 167 files / 1741 tests pass (was 166/1734 after Task 5; +1 file / +7 tests in this task)

### Task 7: Verify acceptance criteria

- [x] verify all requirements from Overview are implemented (cold-start meds, bootstrap-seeded meds, Today tile fallback) — covered by `meds.offline-cold-start.test.js`, `app.dexie-hydration.test.js`, `bootstrap.medications.test.js`, `settings_handlers_test.go`, `today.next-intake-meds-fallback.test.js`
- [x] verify edge cases: empty Dexie + offline, populated Dexie + offline, populated Dexie + bootstrap returns fresh data, no `medications` field from older backend — all four cases covered by the test files above
- [x] run full test suite: `go test ./...` and `pnpm test` — Go: all packages pass; Vitest: 167 files / 1741 tests pass
- [x] run linter / formatter — `go vet ./...` clean; `gofmt -l` reports no issues for `settings_handlers.go` / `settings_handlers_test.go` (pre-existing gofmt drift in untouched files is out of scope for this plan)
- [x] verify test coverage for `data-store.js` and `meds.js` changes is at parity with prior coverage (no regressions) — Task 1 added `data-store.hydrate.test.js` (8 tests); Task 3 added `meds.offline-cold-start.test.js`; all sibling test files still pass
- [x] confirm no new `window.*` globals were added (or if they were, `tests/architecture.globals.test.js` is updated with a `Why:` justification) — `hydrateFromDexie` is a new method on the existing `window.DataStore`; `architecture.globals.test.js` passes unchanged
- [x] confirm no new ad-hoc `.style.` assignments or hardcoded colors were introduced (CLAUDE.md rule 3) — diff scan shows no new `.style.` or hex-color lines in changed JS files; `architecture.inline-styles.test.js` + `architecture.design-tokens.test.js` pass

### Task 8: Update documentation

- [ ] update `docs/frontend.md` "Local-First Read Resilience" section: document `DataStore.hydrateFromDexie()` as the canonical primitive for cold-start hydration, with a short example referencing `meds.js`
- [ ] update `docs/api.md` `/api/bootstrap` entry: note the new `medications` field in the response
- [ ] do not create new `*.md` files — extend existing ones only (CLAUDE.md preference)

## Technical Details

**`hydrateFromDexie` contract**

```js
// data-store.js
DataStore.hydrateFromDexie(key, dexieLoader, opts = {}) -> Promise<{ hydrated, fetchedAt }>
//   key:          cache key, same one used by setCached/loadSWR
//   dexieLoader:  async () => any      (returns Dexie record or null)
//   opts.transform: (record) => value  (maps Dexie shape to in-memory value)
//   opts.tags:    string[]             (cache tags for invalidation)
```

If Dexie is empty or throws, returns `{ hydrated: false }` (never throws — hydration must not block first paint).

**Auth scoping for hydration**

The Dexie `MedicationStore` is already scoped per Telegram user id (single-user device assumption). Confirm the existing schema before Task 2 — if not scoped, add the user-id check to avoid leaking another user's meds when switching accounts. If the codebase only ever has one user per device, no additional scoping is needed.

**Bootstrap response field**

```go
type BootstrapResponse struct {
    // ... existing fields ...
    Medications []Medication `json:"medications,omitempty"`
}
```

`omitempty` keeps the response shape stable when meds are empty. Frontend handles missing field defensively.

**Processing flow (cold-start offline, after this plan)**

1. App boots, no network.
2. `app.js` calls `DataStore.hydrateFromDexie('medications', loadCache)` — meds list now in `DataStore`.
3. User taps Meds → `loadMeds()` → `DataStore.loadSWR('medications', ...)` fires `onCached` synchronously with hydrated list.
4. `renderMeds()` parses schedules and renders planned doses by hour bucket.
5. `WGStaleBadge.mountFromKey` shows "Offline · 2h ago" chip.
6. SWR background refresh fails (offline) → `onError` keeps the rendered list (no empty-state replacement).

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only*

**Manual verification**

- Open the app in a Telegram WebView, then enable airplane mode and relaunch — verify Meds and Today tile both show planned doses with stale chip.
- First-login cold start with throttled connection — verify bootstrap-seeded meds list eliminates a separate `/api/medications` round-trip on first visit.
- Switch users (if multi-user devices are supported) — verify hydration does not surface the prior user's meds.
- Battery / load: hydration runs once on boot and is cheap; no perf testing needed beyond a sanity check.

**Follow-up plans (deferred from comprehensive sweep)**

- Apply the same `hydrateFromDexie` primitive to: BP, Weight, Workouts, Health (overview + notes), Food (products), Settings.
- Audit any remaining sections that still use plain `apiCall` (not `offlineAwareApiCall`).
- Add an architecture test that asserts every section file in `features/` either uses `cachedFetch` / `loadSWR` / `hydrateFromDexie` or is explicitly listed in an exemption file with a reason (mirrors `mcp_coverage_exempt.go` pattern).
- Settings refresh-from-cache mechanism (currently bootstrap-only).
