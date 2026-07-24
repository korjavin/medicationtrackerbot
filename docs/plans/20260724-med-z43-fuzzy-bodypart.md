# med-z43: Fuzzy body-part resolver for workout stats

## Overview
The workout Stats "Body-part Split" section shows ALL exercises as
"Uncategorized" because body-part resolution is EXACT full-name matching against
the verbose 1318-name vendored catalog (`web/static/data/exercises-catalog.json`).
Bare user-logged names ("bench press", "squat", "deadlift", "curl", "plank") are
absent as exact keys — only verbose forms ("barbell bench press") exist — so every
lookup misses. Fix: add a FUZZY fallback resolver in
`web/static/js/features/workout/exercise-catalog.js`, used by BOTH the Stats split
(`stats.js`) and the med-mj4 session chip (`sessions.js`, already calls
`getBodyPart`). Exact match first; on miss, resolve by whole-word token overlap
against the catalog and pick the PLURALITY body_part; build an inverted token index
ONCE at catalog load. `friendlyBodyPart` labels and the catalog JSON stay unchanged
— this is about MATCHING, not labels.

## Context (from discovery)
- Files involved:
  - `web/static/js/features/workout/exercise-catalog.js` — catalog loader; owns
    the exact Map + `getBodyPart` + `friendlyBodyPart`. Add token index +
    `resolveBodyPart`.
  - `web/static/js/features/workout/stats.js` — `_computeBodyPartSplit` /
    `_renderBodyPartSplit` currently do `bodyPartMap.get(key)`. Route through the
    resolver.
  - `web/static/js/tests/features.workout-stats.test.js` — extend the med-s5m.3
    body-part-split describe + the med-mj4 WorkoutExerciseCatalog describe.
- Patterns: single-flight `load()` returns a `Map`; `stats._renderBodyPartSplit`
  awaits `load()` and guards on `map.size === 0` (skip section) — must stay.
- Constraint: catalog JSON and `friendlyBodyPart` MUST NOT change. Do NOT touch
  `web/domain/gamification.js` (sibling executor owns it). `WorkoutExerciseCatalog`
  is already in the globals allowlist; adding a method to it needs no new entry.

## Development Approach
- Regular (code first, then tests) — logic is small and deterministic.
- Complete each task fully; run Node-20 vitest after each change.
- Keep existing tests green: exact-match bucketing, empty-catalog-skips-section,
  failed-fetch-silent, fetch-once.

## Testing Strategy
- Unit/integration: extend `features.workout-stats.test.js` through the existing
  describes. No new `*-branches`/`*-edges` files (project rule 8).
- Node 20 required for vitest (`export PATH="$(ls -d /tmp/node-v20*/bin | head -1):$PATH"`).

## Progress Tracking
- Mark `[x]` immediately when done. ➕ new tasks, ⚠️ blockers.

## Implementation Steps

### Task 1: Add token-index fuzzy resolver to exercise-catalog.js
- [x] add `_tokens(name)` helper: lowercase, split on non-alphanumeric, keep tokens
      length >= 3 (drops noise like "up"/"ab"/"of" that would dominate plurality)
- [x] in `load()`, alongside the exact `Map`, build `_tokenIndex`
      (`Map<token, Map<body_part, entryCount>>`), one vote per distinct token per
      entry so overlap weights naturally; store resolved exact map + index in module
      scope; reset both to null in the `.catch` so a retry rebuilds them
- [x] add `resolveBodyPart(name)`: exact-map hit wins; else tally votes across the
      query's tokens and return the plurality body_part; strict tie or zero → null
- [x] make `getBodyPart` async-wrap `await load()` then `resolveBodyPart(name)`
- [x] export `resolveBodyPart` on `window.WorkoutExerciseCatalog`
- [x] run vitest features.workout-stats.test.js — existing catalog tests must pass

### Task 2: Route stats.js body-part split through the resolver
- [x] change `_computeBodyPartSplit(topExercises, resolveFn)` to call
      `resolveFn(ex.exercise_name) || 'uncategorized'` instead of `bodyPartMap.get`
- [x] in `_renderBodyPartSplit`, keep the `await load()` + `map.size === 0` skip
      guard, then pass `window.WorkoutExerciseCatalog.resolveBodyPart` into
      `_computeBodyPartSplit`
- [x] run vitest features.workout-stats.test.js — existing split tests must pass

### Task 3: Extend tests for fuzzy resolution
- [ ] in the med-s5m.3 describe: add a case with a verbose-form stub catalog
      (e.g. "Barbell Bench Press"→chest, "Barbell Squat"→upper legs, "Barbell
      Deadlift"→upper legs, "Front Plank"→waist) where logged bare names
      "bench press"/"squat"/"deadlift"/"plank" bucket to Chest/Legs/Legs/Core, and
      "Mystery Move" still → Uncategorized
- [ ] in the med-mj4 WorkoutExerciseCatalog describe: add a `resolveBodyPart`/
      `getBodyPart` case proving a bare name resolves via a verbose-form catalog and
      a truly-unknown name → null; assert "up"/2-char-token noise does not spuriously
      match
- [ ] keep exact-match, empty-catalog-skip, failed-fetch-silent, fetch-once green
- [ ] run vitest features.workout-stats.test.js

### Task 4: Verify acceptance criteria
- [ ] `npx vitest run web/static/js/tests/features.workout-stats.test.js web/static/js/tests/architecture` (Node 20) green
- [ ] `npx vitest run` full frontend green
- [ ] `go build ./...` (no-op, sanity)

## Technical Details
- Token index: `Map<token, Map<body_part, count>>`. count = number of catalog
  entries containing that token with that body_part. An entry sharing 2 query
  tokens is counted under both → natural overlap weighting.
- `resolveBodyPart`: exact `_exactMap.get(norm(name))` first; else sum each query
  token's `body_part→count` into a tally; max vote wins; if >1 body_part shares the
  max (tie) or tally is empty → null.
- Min token length 3: makes token equality reject "ab"↔"abduction" AND kills the
  noisy "up" that would otherwise pull "sit-up" away from waist.

## Post-Completion
**Manual verification**: open Workout → Stats with real logged exercises; confirm
bare names bucket correctly and only genuinely-unknown names stay Uncategorized.
