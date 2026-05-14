# Centralized cache-key registry

## Overview

The `api_cache` Dexie store is written by 4+ different code paths
(`app.js`, `features/food.js`, `data-store.js` itself, `cached-fetch.js`,
plus direct `db.js:ApiCache` calls). There is no single registry of
*"what cache keys exist, what tag each belongs to, what freshness window
each gets"*. The closest thing is a documentation table inside
`docs/frontend.md` — informative, not enforced.

The cost of this is documented in the codebase itself, three times:

- `web/static/js/data-store.js:144-152` — comment block explaining why
  `hydrateFromDexie` registers tags up-front: *"Without this …
  invalidation that fires while a GET is in flight silently no-ops."*
- `web/static/js/cached-fetch.js:116-129` — same explanation in
  `cachedFetch`: *"on cold/reload paths … `tagToKeys` is empty for the
  key and an invalidation that fires while a GET is in flight silently
  no-ops."*
- `web/static/js/features/workout.js:14-46` — same explanation, third
  copy, with the `WORKOUT_CACHE_KEYS` array as a one-feature workaround
  that eagerly calls `DataStore.registerTags(key, ['workout'])` on
  module load (lines 33-35).

Three comment blocks documenting the same recurring footgun is the
codebase telling you it wants a registry. A central `CACHE_KEYS`
constant referenced by every read/write site would:

1. Eliminate the cold-start race class entirely (registration happens
   once at boot, before any feature code runs).
2. Remove the three explanatory comment blocks.
3. Make freshness-window policy visible in one place instead of
   per-call-site magic numbers.
4. Catch typos: `getCached('medication')` (singular) silently returns
   `null` today; routed through a registry, it would be a known-bad key
   at lookup time.

This plan introduces `web/static/js/core/cache-keys.js` as the single
source of truth, registers all tags at boot, and refactors the
existing call sites incrementally.

**Out of scope:**
- Adding new cache keys for not-yet-cached endpoints.
- Replacing `DataStore.invalidateTags` / `DataStore.registerTags` API
  shape — the registry is additive, not a replacement.
- Eliminating `cached-fetch.js`'s separate freshness defaults
  (`freshAfterMs`, `staleAfterMs`) — they will reference the registry
  values but remain caller-overridable.

From the [2026-05-13 frontend review §13](../2026-05-13-frontend-code-review.md#13-cache-key-ownership-is-scattered)
and recommended-priority item #5.

## Context (from discovery)

- **Existing tag registration entry points**:
  `data-store.js:35-53` (`registerKeyTags`) — the implementation;
  `data-store.js:72-74` (`DataStore.registerTags`) — the public API.
- **All known cache keys** (from `docs/frontend.md` table + grep):
  - `medications` (tag: `medications`) — meds list, food-targets-aware
  - `next_intake` (tag: `medications`) — Today next-med tile
  - `bp` (tag: `bp`)
  - `weight` (tag: `weight`)
  - `history_<days>_<medId>` (tag: `history`) — dynamic key family
  - `food_<YYYY-MM-DD>_day` (tag: `food`) — dynamic key family
  - `food_products_cache` (tag: `food`)
  - `workout_next` / `workout_history` / `workout_groups` /
    `workout_stats` / `exercise_library` (tag: `workout`)
  - `health_overview_<tz>` (tag: `health`) — dynamic key family
  - `diary_notes` (tag: `health-notes`)
  - `settings_bundle` (no tag — never invalidated, only replaced)
- **Dynamic key families** are interesting: `history_<days>_<medId>`
  expands to dozens of concrete keys per user. The registry must
  support a `keyOf(family, ...args)` factory.
- **Existing per-feature workarounds**:
  `features/workout.js:26` `WORKOUT_CACHE_KEYS` const +
  `WORKOUT_CACHE_KEYS.forEach(key => DataStore.registerTags(key, ['workout']))`
  pattern at lines 33-35 and 38-40. The same pattern would apply to
  every other feature; a registry collapses N copies into one.
- **Freshness-window magic numbers** today live inside
  `cached-fetch.js` calls (`freshAfterMs: 5*60*1000`, etc.) and inside
  individual feature loaders. Centralizing them is the second-order win.

## Development Approach

- **Testing approach**: Regular.
- Single PR; ~6 tasks. Backwards-compatible at every step — the
  registry is additive; old call sites continue to work until migrated.
- Each task migrates one feature's keys; the architecture test (last
  task) ensures no new direct `setCached('literal-string', ...)`
  appears.

## Testing Strategy

- **Unit tests**: required for the registry itself (lookup, dynamic
  key construction, eager registration).
- **Per-feature regression tests**: existing tests in
  `web/static/js/tests/` cover most cache hits/misses. Run them
  unchanged after each migration to confirm no behaviour regression.
- **Architecture test**: scan for raw `setCached('...')` /
  `getCached('...')` / `invalidateTags(['...'])` literals outside
  `core/cache-keys.js` and tests; fail with a pointer to the registry.

## Progress Tracking

- Mark completed items with `[x]` immediately.
- Add ➕ for new tasks; ⚠️ for blockers.

## Implementation Steps

### Task 1: Author `core/cache-keys.js`

- [x] create `web/static/js/core/cache-keys.js` with `CACHE_KEYS`
  object: each entry has `key` (literal or factory function), `tag`
  (string), `freshAfterMs`, `staleAfterMs` (both optional), and a
  one-line `description` (consumed by future debug surfaces and the
  architecture test); attach to `window.CacheKeys`
- [x] enumerate every known key from the frontend.md table and the
  list above; for dynamic families (history/food-day/health-overview),
  expose them as factories: `CacheKeys.history(days, medId)` returns
  `'history_'+days+'_'+(medId||'')` and is annotated as the same
  family (i.e. carries the `history` tag)
- [x] add `CacheKeys.registerAll(dataStore)` that iterates static
  entries and calls `dataStore.registerTags(key, [tag])` for each;
  dynamic families register their tag via `registerTagFamily(prefix,
  tag)` so `invalidateByTag('history')` evicts every `history_*` key
  in the cache (extends `data-store.js` if necessary)
- [x] update `web/static/js/tests/architecture.globals.test.js` to
  allow `window.CacheKeys` with a justification entry
- [x] include `core/cache-keys.js` in `web/static/sw.js`
  `STATIC_ASSETS` and in `web/static/index.html` script tags (loaded
  before `data-store.js`)
- [x] write tests in `web/static/js/tests/core.cache-keys.test.js`:
  static entry lookup; dynamic family construction (`history(7, 42)`
  → `'history_7_42'`); `registerAll` populates DataStore tag map;
  unknown key throws (catches typos)
- [x] run `pnpm test core.cache-keys` — must pass before next task

### Task 2: Eager registration at boot + dynamic-tag-family support

- [x] add `DataStore.registerTagFamily(prefix, tag)` to
  `web/static/js/data-store.js` — stores prefix→tag mapping; when
  `invalidateByTag(tag)` runs, also iterates `keyToTags` for any key
  whose `key.startsWith(prefix)` and bumps generation + clears cache
  for those too
- [x] in `features/bootstrap.js` (or whichever module already runs
  earliest with auth presence), after `window.DataStore` is available,
  call `window.CacheKeys.registerAll(window.DataStore)` *before* the
  first `loadSWR` / `cachedFetch` invocation
- [x] write tests for the new family-tag eviction:
  `web/static/js/tests/data-store.tag-family.test.js` covering
  history-family invalidation evicting two concrete keys
  (`history_7_`, `history_30_42`); food-day-family invalidation
  evicting today + yesterday keys
- [x] run `pnpm test data-store.tag-family` — must pass before next
  task

### Task 3: Migrate `features/workout.js` to use the registry

- [x] replace `WORKOUT_CACHE_KEYS` const at `features/workout.js:26`
  with `const WORKOUT_CACHE_KEYS = window.CacheKeys.workoutKeys()` (a
  helper that returns the same array from the registry) — superseded:
  the const had no remaining callers after the boot-time forEach and
  the in-body re-registration both went away, so removing it outright
  satisfies task 6's grep check rather than leaving an unused binding
- [x] replace the boot-time `WORKOUT_CACHE_KEYS.forEach(...)` block at
  lines 33-35 with a single `// tags registered at boot via CacheKeys.registerAll`
  comment (the registration happens upstream now)
- [x] keep `invalidateWorkoutCache` (line 37) — but its body becomes
  one line: `await window.DataStore.invalidateTags(['workout'])`;
  drop the inner re-registration (line 38-40) since registration is
  guaranteed at boot — the `WorkoutStore.clearCache` legacy fallback
  stays (still required by `workout.invalidation.test.js`)
- [x] verify all existing workout tests still pass without changes
- [x] run `pnpm test workout.` — must pass before next task

### Task 4: Migrate cached-fetch and the explanatory comments

- [x] in `cached-fetch.js`, replace the inline `registerTagsWithStore`
  helper at lines 123-129 with a one-liner that defers to the registry
  (the registry guarantees registration at boot, so the eager call is
  no-op safe; keep it as defense in depth but drop the explanatory
  comment block)
- [x] in `data-store.js`, simplify `hydrateFromDexie` (`data-store.js:144-152`)
  similarly — drop the long-form comment about `tagToKeys` being empty;
  registration is now guaranteed
- [x] update `docs/frontend.md` cache-keys table to reference
  `web/static/js/core/cache-keys.js` as the source of truth (the table
  may stay as documentation, but the prose now points at the registry)
- [x] write tests in `web/static/js/tests/cached-fetch.registry.test.js`
  verifying `cachedFetch('medications', '/api/medications')` works
  without an inline `tags: ['medications']` arg (the registry supplies
  it); inline `tags` arg still overrides for one-off keys
- [x] run `pnpm test cached-fetch.` and `pnpm test data-store.` —
  must pass before next task

### Task 5: Migrate `features/food.js` and `app.js` direct cache writes

- [ ] in `features/food.js:1842` replace
  `await window.DataStore.setCached(cacheKey, ...)` with the registry-
  aware variant that includes the `food` tag — easiest to call
  `setCachedWithTags(cacheKey, value, ['food'])` directly, but the
  registry's `CacheKeys.dayFoodKey(date)` should be the cacheKey
  source
- [ ] in `app.js:44, 46` (`cacheApiSnapshot`), no change needed if
  callers already pass tags; verify
- [ ] in `app.js:3266` (`window.DataStore.setCached('settings_bundle',
  cached)`), confirm `settings_bundle` is in the registry as the
  no-tag entry; behaviour unchanged
- [ ] write tests in `web/static/js/tests/food.cache-keys.test.js`
  verifying day-food invalidation uses the family-tag path
- [ ] run `pnpm test food.cache-keys` — must pass before next task

### Task 6: Architecture test prevents recurrence + acceptance

- [ ] add `web/static/js/tests/architecture.cache-keys.test.js` —
  scan all `web/static/js/**.js` (excluding `core/cache-keys.js`,
  `core/api.js`, `data-store.js`, `cached-fetch.js`, `db.js`, and
  `tests/`) for raw string literals matching cache-key patterns:
  `setCached(['"]\w+['"]`, `getCached(['"]\w+['"]`,
  `clearCached(['"]\w+['"]`, `setCachedWithTags(['"]\w+['"]`; assert
  zero matches, with error message pointing at `core/cache-keys.js`
- [ ] run `pnpm test architecture.cache-keys` — must pass
- [ ] full `pnpm test` clean
- [ ] grep for `WORKOUT_CACHE_KEYS` shows only inside
  `core/cache-keys.js`
- [ ] grep for `tagToKeys` (the underlying map) shows only inside
  `data-store.js` (proves the explanatory comments referenced it
  correctly and we didn't leave behind a leak of the internal name)
- [ ] confirm three comment blocks (`data-store.js:144-152`,
  `cached-fetch.js:116-129`, `features/workout.js:14-46`) are
  shortened or removed

## Technical Details

### `cache-keys.js` shape (sketch)

```javascript
const STATIC_KEYS = {
    medications:       { key: 'medications',       tag: 'medications', staleAfterMs: 24 * 3600_000 },
    next_intake:       { key: 'next_intake',       tag: 'medications', freshAfterMs: 5  * 60_000, staleAfterMs: 12 * 3600_000 },
    bp:                { key: 'bp',                tag: 'bp',          staleAfterMs:  3 * 24 * 3600_000 },
    weight:            { key: 'weight',            tag: 'weight',      staleAfterMs:  3 * 24 * 3600_000 },
    workout_next:      { key: 'workout_next',      tag: 'workout' },
    workout_history:   { key: 'workout_history',   tag: 'workout' },
    workout_groups:    { key: 'workout_groups',    tag: 'workout' },
    workout_stats:     { key: 'workout_stats',     tag: 'workout' },
    exercise_library:  { key: 'exercise_library',  tag: 'workout' },
    food_products_cache: { key: 'food_products_cache', tag: 'food', staleAfterMs: 7 * 24 * 3600_000 },
    diary_notes:       { key: 'diary_notes',       tag: 'health-notes' },
    settings_bundle:   { key: 'settings_bundle',   tag: null }, // never invalidated, only replaced
};

const FAMILIES = [
    { prefix: 'history_',         tag: 'history',     factory: (days, medId) => `history_${days}_${medId || ''}` },
    { prefix: 'food_',            tag: 'food',        factory: (date)         => `food_${date}_day` },
    { prefix: 'health_overview_', tag: 'health',      factory: (tz)           => `health_overview_${tz}` },
];

window.CacheKeys = {
    static: STATIC_KEYS,
    families: FAMILIES,
    history: FAMILIES[0].factory,
    dayFoodKey: FAMILIES[1].factory,
    healthOverviewKey: FAMILIES[2].factory,
    workoutKeys: () => ['workout_next', 'workout_history', 'workout_groups', 'workout_stats'],
    registerAll(dataStore) {
        Object.values(STATIC_KEYS).forEach(({ key, tag }) => {
            if (tag) dataStore.registerTags(key, [tag]);
        });
        FAMILIES.forEach(({ prefix, tag }) => dataStore.registerTagFamily?.(prefix, tag));
    },
};
```

### Family-tag invalidation in `data-store.js`

```javascript
const tagFamilies = new Map(); // tag → Set<prefix>

DataStore.registerTagFamily = function (prefix, tag) {
    if (!tagFamilies.has(tag)) tagFamilies.set(tag, new Set());
    tagFamilies.get(tag).add(prefix);
};

// inside invalidateByTag(tag):
const families = tagFamilies.get(tag);
if (families && window.MedTrackerDB?.db?.api_cache) {
    const allKeys = await window.MedTrackerDB.db.api_cache.toCollection().primaryKeys();
    for (const key of allKeys) {
        for (const prefix of families) {
            if (key.startsWith(prefix)) {
                fetchGeneration.set(key, (fetchGeneration.get(key) || 0) + 1);
                inFlight.delete(key);
                await this.clearCached(key);
                break;
            }
        }
    }
}
```

This is the only structural change to `DataStore` — additive, opt-in
via the new `registerTagFamily` call. Existing `registerTags` keys
keep working.

## Post-Completion

**Manual verification** (optional):
- Open the app, change a food log on day D, change another on day D-1,
  then trigger a refresh; both `food_<D>_day` and `food_<D-1>_day`
  should evict (proves family-tag invalidation works in the wild).

**No external system updates needed.**
