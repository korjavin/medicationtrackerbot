# Fix workout-history hang: eliminate the per-session full-store getAll N+1

bd: **med-9z3.2** (epic med-9z3)

## Overview

In cloud mode, **workout history** spins in "Loading…" seemingly forever while
**workout stats** renders fast — same IndexedDB mirror, different access pattern.

Root cause is an N+1 over full-store scans in `web/domain/workout.js`
`listSessions` (:1133-1190):

- Every `records.list(type)` resolves via `web/cloud/js/sync.js:596`
  `listRecords` → `readAllRecords()` = `store.getAll()` over the **entire**
  `records` object store (all domains: bp, weight, food, all vitals samples, all
  workout rows), then filters in JS. There is no index / key-range / LIMIT.
- `listSessions` loops up to 50 sessions and, **per session**, calls:
  - `listExercises(session.variant_id)` (:1141) → `activeRecords(EXERCISE)` → one full-store `getAll`
  - `findByNumericId(records, GROUP, session.group_id)` (:1164) → one full-store `getAll`
  - `findByNumericId(records, VARIANT, session.variant_id)` (:1165) → one full-store `getAll`
- That is **~3 full-store deserializations per session × 50 = ~150 sequential
  `getAll()` scans** of a store bloated by unbounded vitals samples. It does
  resolve eventually, so the UI presents a permanent spinner
  (`web/static/js/features/workout/history.js` clears "Loading…" only on the
  fetcher's `onFresh`/`onError`).
- `getStats` (:1227) is fast precisely because it does a fixed ~2 scans and
  indexes logs in a `Map` — the pattern this fix copies.

**Fix:** hoist the GROUP / VARIANT / EXERCISE reads out of the per-session loop
into single passes indexed by numeric id in `Map`s, then look up from the maps
inside the loop. ~150 scans → ~5. No change to the rendered history output.

DONE = workout history renders in well under a second on a large import, with
byte-identical view output to today's slow path.

## Context (from discovery)

Files/components involved:
- `web/domain/workout.js` — `listSessions` (:1133), the loop bodies at :1141 and
  :1163-1168; helpers `activeRecords` (:263), `findByNumericId` (:95),
  `listExercises` (:470), `toExerciseResponse`, `sortSessions` (:1117),
  `WORKOUT_RECORD_TYPES` (:38).
- `web/cloud/js/sync.js:596` `listRecords` — the `getAll`+filter primitive (the
  durable fix for this lives in bead med-9z3.4; this task is the tactical hoist).
- `web/static/js/features/workout/history.js` — the caller (SWR loader) that
  shows "Loading…" until the fetcher resolves; unchanged by this task.

Related patterns found:
- `getStats` (:1227-1290) already loads `LOG` once and indexes by session in a
  `Map` — mirror that shape for GROUP/VARIANT/EXERCISE here.
- `findByNumericId` matches `!r.deleted && r.id === id`; `listExercises` filters
  `EXERCISE` by `variant_id` and sorts by `order_index` then maps
  `toExerciseResponse`. The map-building must preserve exactly these semantics.

## Development Approach

- **Testing approach**: NO unit tests. This is a pure performance refactor with a
  strict "same output" contract. If the workout feature suite
  (`tests/` frontend harness) already exercises cloud-shim `listSessions`, reuse
  it as the regression guard; only add an integration case if none covers the
  enriched history view. Do not stand up new infra.
- Small, single-file change; verify output parity before optimizing further.
- Maintain backward compatibility (identical view objects).

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: reuse the existing workout feature suite as the parity
  guard; add one case only if `listSessions` enrichment is currently uncovered.
- **E2E tests**: none.

## Progress Tracking

- Mark `[x]` immediately; ➕ new tasks; ⚠️ blockers; keep this file synced.

## Implementation Steps

### Task 1: Pre-index GROUP / VARIANT / EXERCISE once in listSessions

- [ ] In `web/domain/workout.js` `listSessions`, after loading `sessions` and
      `allLogs`, load `activeRecords(GROUP)`, `activeRecords(VARIANT)`, and
      `activeRecords(EXERCISE)` **once each** (3 scans total, not per-session).
- [ ] Build `Map`s by numeric id: `groupById` (id → group), `variantById`
      (id → variant), and `exercisesByVariantId` (variant_id → sorted, mapped
      `toExerciseResponse[]`, replicating `listExercises`' `order_index` sort +
      map exactly).
- [ ] Replace the per-session `listExercises(session.variant_id)` (:1141) with an
      `exercisesByVariantId.get(session.variant_id) || []` lookup.
- [ ] Replace the per-session `findByNumericId(GROUP…)` / `findByNumericId(VARIANT…)`
      (:1164-1165) with `groupById.get(...)` / `variantById.get(...)` lookups
      (preserve the `!deleted` semantics when building the maps).
- [ ] Confirm the ad-hoc branch (`group_id === ADHOC_ID`, :1145-1162) is
      unchanged — it derives its name from logs, touches no group/variant/exercise
      scan.

### Task 2: Verify parity + performance

- [ ] Confirm the returned `views` objects (`group_name`, `variant_name`,
      `exercises_count`, `exercises_completed`, `total_volume`,
      `toSessionResponse`) are identical to the pre-change output for the same
      data (ad-hoc and normal sessions, missing group/variant → "Unknown").
- [ ] Confirm the number of `records.list` calls in `listSessions` is now O(1) in
      session count (~5 total), not O(3n).
- [ ] Run the existing frontend suite (`pnpm test`) — must pass.
- [ ] Run the linter — all issues fixed.

### Task 3: [Final] Note the tactical/durable split

- [ ] Add a short `// ponytail:`-style comment pointing at bead med-9z3.4 (the
      durable indexed-read fix in `sync.js`) so the next reader knows this hoist
      is a tactical shortcut around the full-store `getAll` primitive, not the
      final shape.

## Technical Details

- No new dependencies, single file (`web/domain/workout.js`); `sync.js` untouched.
- Map keys are the numeric `id` (group/variant) and `variant_id` (exercises),
  matching `findByNumericId`/`listExercises` lookups.
- `getSessionDetails` (:1194) is a single-session read (already O(1) scans) and is
  out of scope; only the list path has the ×50 amplification.

## Post-Completion

**Manual verification:**
- Open the workout **history** tab in cloud mode after a large import; confirm it
  renders in under a second and matches stats-tab counts.

**External:** none. (Independent of med-9z3.1, but the app must not be wedged by
the snapshot loop first for this to be observable end to end.)
