# Local-First Read Resilience

## Overview

When the app is offline (or the backend returns 5xx behind Traefik), several screens render empty even though we have stale data in IndexedDB. The user-facing complaint: planned medications disappear from the Today dashboard when they should remain visible — *something stale is better than nothing*.

This plan delivers **read resilience first** (no new offline write paths) by:

1. Promoting the existing `api_cache` Dexie store and `cacheApiSnapshot` helper into a first-class read-through wrapper (`cachedFetch`) that every priority section calls.
2. Caching `next_intake` independently so the Today dashboard's "Next Medication" tile renders from local data when `/api/bootstrap` is unreachable.
3. Wrapping Food reads (currently no offline fallback) so today's food log survives offline.
4. Adding a subtle per-section "Updated Xm ago / Offline" badge so users can tell whether they're looking at fresh or stale data.
5. Rolling the badge out to all main sections (Today, BP, Food, Meds, Vitals, Workouts, Weight) by routing their reads through the new helper.

**Out of scope** (explicitly): new offline write queues (food/notes/workouts), cold-start offline (no prior bootstrap), and a full "IndexedDB is source of truth" rewrite.

## Context (from discovery)

**Files/components involved:**
- `web/static/js/db.js` — Dexie schema; `api_cache` store at line 70, get/set/delete helpers at lines 639–668.
- `web/static/js/app.js` — `cacheApiSnapshot` at line 37; bootstrap apply path lines 218–330 already populates `medications`, `next_intake`, `bp`, `weight`, `food_<date>_day`, `settings_bundle`.
- `web/static/js/sync.js` — `offlineAwareApiCall`, `isServerError` (treat 5xx as offline), background sync registration.
- `web/static/sw.js` — network-first for API, stale-while-revalidate for `/api/bootstrap`, 5xx-as-offline policy at lines 204–209.
- `web/static/js/features/today.js` — Today dashboard; reads `next_intake` straight from bootstrap response with no IndexedDB fallback.
- `web/static/js/features/food.js` — `/api/food/log`, `/api/food/products`: **no offline handler today**.
- `web/static/js/features/meds.js`, `bp.js`, `weight.js`, `workout.js`, `health.js` — each has its own ad-hoc cache fallback (or none).
- `web/static/js/data-store.js` — cache invalidation/maintenance (line 286+).
- `web/static/js/tests/` — Vitest + jsdom; existing `data-store.maintenance.test.js` is the closest reference for cache tests.

**Related patterns found:**
- `BPStore`, `WeightStore`, `MedicationStore`, `IntakeHistoryStore`, `WorkoutStore`, `FoodProductsCache` already model the "TTL-on-read" pattern in `db.js`.
- `cacheApiSnapshot(key, value, tags)` writes to `api_cache` with tag tracking; reads are scattered (`db.api_cache.get(...)`).
- `offlineAwareApiCall` already centralizes the read path for BP/weight/medications — it's the natural seam to extend.
- 5xx-as-offline is documented in `docs/technical-decisions.md` and implemented in both SW and `sync.js`. The new helper must inherit this behavior.

**Dependencies identified:**
- No backend changes required for read resilience; this is a frontend-only effort.
- No Dexie schema migration needed — `api_cache` already exists and stores `{ id, timestamp, data }`. We may extend the value shape to include `etag`/`tags` if not already present (verify before adding a Dexie version bump).
- Architecture tests (`tests/architecture.*.test.js`) enforce no inline styles / no new globals — the badge component must use `--wg-*` tokens and be added via a CSS class.

## Development Approach

- **Testing approach**: Regular (code first, tests after). User chose this in planning.
- Complete each task fully before moving to the next.
- Make small, focused changes — one feature module at a time once the helper exists.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - tests are not optional — they are a required part of the checklist
  - `cachedFetch` needs unit tests for fresh-hit, stale-hit, offline-fallback, no-cache-miss, and 5xx-as-offline paths
  - each section migration adds at least one Vitest case proving the offline fallback returns cached data
  - the stale badge gets a component-level test (DOM assertion on label text given a `fetchedAt` timestamp)
- **CRITICAL: all tests must pass before starting next task** — no exceptions.
- **CRITICAL: update this plan file when scope changes during implementation.**
- Run `pnpm test` after each frontend change; `go test ./...` only if backend touches happen (none expected).
- Maintain backward compatibility — existing `cacheApiSnapshot` callers must keep working. New helper wraps the same store.

## Testing Strategy

- **Unit tests** (Vitest + jsdom): required for every task (see Development Approach above).
- **Architecture tests**: rerun `pnpm test` to ensure no inline-styles / globals regressions from the badge UI.
- **Manual offline verification** (Post-Completion): Chrome DevTools → Application → Service Workers → Offline checkbox. Walk every section, confirm stale data renders + badge shows "Offline" tone.
- **No e2e tests** in this project today; skip that layer.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with ➕ prefix.
- Document issues/blockers with ⚠️ prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): JS module changes, Vitest cases, doc updates.
- **Post-Completion** (no checkboxes): manual offline walkthrough in Chrome DevTools, screenshot review of stale badges.

## Implementation Steps

### Task 1: Build `cachedFetch` read-through helper

- [x] Add `cachedFetch(key, url, opts)` to `web/static/js/sync.js` (or new module `web/static/js/cached-fetch.js` if `sync.js` is too crowded — decide after reading current `sync.js` length). Signature: `({ tags = [], freshAfterMs, staleAfterMs, transform, fetchOpts }) => Promise<{ data, fetchedAt, isFromCache, isStale }>`. Created new module `web/static/js/cached-fetch.js` (sync.js was 874 lines).
- [x] Implementation order inside the helper: (1) read `api_cache` entry; (2) if fresh and online — still revalidate in background, return cached immediately (SWR); (3) if no cache and online — fetch, cache, return; (4) if offline / 5xx — return cached with `isFromCache: true, isStale: ageBeyondStaleAfter`; (5) if no cache and offline — throw a typed `OfflineNoCacheError` so callers can render an empty state explicitly.
- [x] Reuse `isServerError` from `sync.js` for the 5xx-as-offline check; reuse `db.api_cache` reads from `db.js` lines 639–668 (do not duplicate). Helper calls `window.isServerError` when present and falls back to its own inline detector (status >= 500 + 502/503/504 message sniff) so it works whether or not sync.js exposes the function.
- [x] Ensure background revalidation writes via the existing `cacheApiSnapshot` so tag tracking continues to work.
- [x] write tests for `cachedFetch` fresh-hit (network skipped, returns cache, `isFromCache: true`)
- [x] write tests for `cachedFetch` SWR path (returns cache instantly, background fetch updates store)
- [x] write tests for offline fallback returning stale cache with `isStale: true` when age > `staleAfterMs`
- [x] write tests for `OfflineNoCacheError` when no cache exists and network is unavailable
- [x] write tests for 5xx response treated as offline (via mocked `apiCallDirect`)
- [x] run `pnpm test` — must pass before next task

### Task 2: Cache `next_intake` independently and wire Today's Next Medication tile

- [ ] Verify (via grep) that `cacheApiSnapshot('next_intake', ...)` at `app.js:279` is the only writer; if `/api/bootstrap` is the only producer, also expose a thin `/api/next-intake` reader path through `cachedFetch` so non-bootstrap refreshes can update it. If no such endpoint exists, document the gap and rely on bootstrap-only writes for now (note as ⚠️).
- [ ] In `web/static/js/features/today.js`, replace the direct `bootstrap.next_intake` read with a call that resolves from `api_cache['next_intake']` first (via `cachedFetch` with `freshAfterMs` tuned to a short window, e.g. 5 min).
- [ ] Render the tile from cached `next_intake` even when bootstrap fetch fails. If `next_intake` is empty *and* `MedicationStore` has scheduled meds, fall back to deriving "next dose" from the cached medication list (re-use existing schedule logic if available; otherwise stop at "Next dose data unavailable offline" rather than rendering empty).
- [ ] Surface `{ fetchedAt, isStale }` from the helper to the tile so Task 4 can attach the badge.
- [ ] write Vitest case: bootstrap fails (mocked offline), `api_cache.next_intake` populated → tile renders the cached medication name.
- [ ] write Vitest case: bootstrap fails, no `next_intake` cache, `medications` cache present → tile renders the derived next dose (or the documented fallback string).
- [ ] write Vitest case: bootstrap fails, no caches at all → tile shows the explicit empty state, not a JS error.
- [ ] run `pnpm test` — must pass before next task.

### Task 3: Wrap Food reads with `cachedFetch`

- [ ] Migrate `/api/food/log?date=...` calls in `web/static/js/features/food.js` to `cachedFetch` with key `food_<date>_day` (matches the bootstrap apply path at `app.js:311` so the bootstrap-warmed cache is reused).
- [ ] Migrate `/api/food/products` calls to `cachedFetch` with the existing `food_products_cache` key/TTL semantics — but route through the same helper so the badge metadata is uniform. Keep the existing 7-day TTL via `staleAfterMs`.
- [ ] On `OfflineNoCacheError`, render a friendly empty state ("No cached food data — connect to load") instead of the current silent empty list.
- [ ] write Vitest case: food log read offline returns cached groups for today's date with `isStale` flag.
- [ ] write Vitest case: food log read offline with no cache surfaces `OfflineNoCacheError` and the screen renders the explicit empty state.
- [ ] run `pnpm test` — must pass before next task.

### Task 4: Build the stale-data badge component

- [ ] Add a small component `web/static/js/components/wg-stale-badge.js` (or extend an existing component if there's a header pattern). Inputs: `fetchedAt` (ms) and `isOffline` (bool). Output: a compact chip with text like `Updated 5m ago`, `Updated 2h ago`, or `Offline · 3h old`.
- [ ] Style via existing `--wg-*` tokens only — no inline styles, no hardcoded colors. Use a muted tone for fresh, a warning tone for stale (>1h offline) per the Wandergeek system.
- [ ] Choose tone by age: fresh = neutral, >`staleAfterMs` = warning. When `isOffline` is true, prefix label with `Offline · `.
- [ ] No new `window.*` globals (architecture test will fail otherwise). If the component needs to be globally referenced, either keep it module-scoped and import where needed, or add an allowlist entry to `tests/architecture.globals.test.js` with justification.
- [ ] write Vitest case: badge renders `Updated Nm ago` for recent timestamps.
- [ ] write Vitest case: badge renders `Offline · ...` when `isOffline=true`.
- [ ] write Vitest case: badge applies the warning tone class when age exceeds `staleAfterMs`.
- [ ] run `pnpm test` — must pass before next task.

### Task 5: Mount the badge in Today and Food section headers

- [ ] Today (`features/today.js`): add the badge to the section header, fed by the `fetchedAt` from Task 2's `cachedFetch` calls. If multiple sources feed Today, use the oldest `fetchedAt` (worst-case freshness).
- [ ] Food (`features/food.js`): add the badge to the food section header, fed by Task 3's helper.
- [ ] write Vitest case: Today renders the badge with the correct timestamp from a stubbed `cachedFetch` result.
- [ ] write Vitest case: Food renders the badge in offline mode showing `Offline · ...`.
- [ ] run `pnpm test` — must pass before next task.

### Task 6: Roll the badge out to remaining sections

For BP, Weight, Workouts, Meds, and Vitals/Health: the goal is uniform badging. These sections already have section-specific stores; the work is to surface a `fetchedAt` they can pass to the badge.

- [ ] BP (`features/bp.js`): route the existing `/api/bp?days=...` call through `cachedFetch` with the bootstrap-warmed `bp` key; pass `fetchedAt` to the section header badge.
- [ ] Weight (`features/weight.js`): same pattern with the `weight` key.
- [ ] Meds (`features/meds.js`): wrap `/api/medications` and `/api/history` reads. The schedule tab and history tab each get a badge; reuse `MedicationStore` and `IntakeHistoryStore` TTLs as the helper's `staleAfterMs`.
- [ ] Workouts (`features/workout.js`): wrap `/api/workout/sessions` and `/api/workout/groups`.
- [ ] Vitals/Health (`features/health.js`): wrap `/api/health/overview` and `/api/notes`. (Even though the deep-cache work for Vitals wasn't a priority, badging requires the same wiring — it comes nearly free here.)
- [ ] write one Vitest case per section confirming the section's data render survives an offline `cachedFetch` and the badge is present.
- [ ] run `pnpm test` — must pass before next task.

### Task 7: Verify acceptance criteria

- [ ] Verify all Overview goals are implemented: (a) Today's Next Medication tile renders from cache when bootstrap is unreachable; (b) Food today shows cached log offline; (c) every priority section has a stale badge; (d) no new offline write paths were introduced; (e) cold-start behavior unchanged.
- [ ] Verify `OfflineNoCacheError` is handled (not thrown to console) in every section that uses `cachedFetch`.
- [ ] Run full Vitest suite `pnpm test` — all green.
- [ ] Run `go test ./...` (sanity — no backend changes expected, but the architecture/coverage tests must still pass).
- [ ] Verify no new inline-style or globals violations (`tests/architecture.*.test.js`).
- [ ] Verify no Dexie schema version bump was required, OR that the bump is correct and migration is additive only.

### Task 8: Update documentation

- [ ] Add a "Local-first read resilience" subsection to `docs/frontend.md` documenting `cachedFetch`, the badge component, and the per-section freshness windows.
- [ ] Cross-link from `docs/technical-decisions.md`'s 5xx-as-offline section to the new helper.
- [ ] If any new pattern is introduced (e.g., `OfflineNoCacheError` handling in feature modules), add a "Common Tasks" entry to `CLAUDE.md` so future modules follow the same pattern.

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`.*

## Technical Details

**`cachedFetch` shape:**

```js
const { data, fetchedAt, isFromCache, isStale } = await cachedFetch(
  'food_2026-05-09_day',
  '/api/food/log?date=2026-05-09',
  {
    tags: ['food'],
    freshAfterMs: 60_000,     // background-revalidate after 1 min
    staleAfterMs: 24*60*60_000, // badge tone flips to "warning" past 24h
  }
);
```

- Returns immediately from cache when present and online (SWR).
- Returns cache + sets `isStale` when offline or 5xx and age > `staleAfterMs`.
- Throws `OfflineNoCacheError` only when no cache *and* network is unavailable.

**Badge tone rules:**
- `fetchedAt` within `freshAfterMs`: no badge (or muted `Updated just now`).
- Older but online: `Updated Nm/Nh ago` (neutral).
- Offline: `Offline · Nm/Nh old` (warning tone past `staleAfterMs`).

**Compatibility:**
- `cacheApiSnapshot` keeps working — `cachedFetch` writes via the same path.
- Bootstrap continues to seed `next_intake`, `food_<date>_day`, etc. — `cachedFetch` simply reads them.

## Post-Completion

*Items requiring manual intervention or external systems — no checkboxes, informational only.*

**Manual verification:**
- Chrome DevTools → Application → Service Workers → check **Offline** → reload app → walk every priority section, confirm:
  - Today's Next Medication tile shows the cached medication.
  - Food today shows cached groups.
  - Every section header shows the `Offline · ...` badge.
  - No JS errors in console.
- Re-enable network → confirm badges flip back to neutral within `freshAfterMs`.
- Repeat with backend down (Traefik returning 502/503) to confirm 5xx-as-offline still works end-to-end.

**Screenshot review:**
- Take before/after screenshots of Today and Food sections offline; attach to the PR description so reviewers can see the badge tone and copy.

**Future scope (not in this plan):**
- Offline write queues for food, notes, workout completions.
- Cold-start offline (bundle a UI shell with empty-state explanations).
- Health/Vitals deep cache (only the badge is added here; the underlying data is still cached opportunistically by SW only).
