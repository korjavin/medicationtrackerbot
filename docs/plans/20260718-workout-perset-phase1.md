# Workout Phase 1 — per-set logging (cloud-first)

## Overview

Today the workout exercise log stores one aggregate row per exercise per session
(`sets_completed`, `reps_completed`, `weight_kg`). This phase stores **each SET** —
`{set_index, weight_kg, reps, rpe?, set_type}` where `set_type ∈ {normal, warmup,
drop, failure}` — the foundation for est-1RM/PR/graphs (Phase 3) and progression
(Phase 4). See `docs/workout-depth.md` (epic med-qj4, bead med-qj4.1.1).

**Cloud-first, and almost purely additive.** Per the seam research: nest a `sets`
array inside the existing cloud `exerciselog` record (vault records are opaque
JSON blobs, so this needs **zero** sync / records-port / apishim-route / MCP-catalog
changes). The cloud path never collapsed per-set (it never accepted it), so there
is nothing to "un-collapse" — we just accept and persist the array, deriving the
existing scalar aggregates from it. All bot-mode Go store/migration work is
**deferred** (bot is legacy).

**The one risk — keep bot mode intact.** `web/static/js/features/workout/sessions.js`
is shared (unbranched) and its POST hits the Go server in bot mode and the cloud
domain in cloud mode. So the per-set UI must keep emitting the **flat aggregate
fields alongside** `sets` (`sets_completed=len`, `reps_completed=max(reps)`,
`weight_kg=max(weight)`), and we must confirm the Go log handlers ignore the unknown
`sets` key — so bot mode neither regresses nor needs a migration.

**Acceptance:** in cloud, a user can log multiple sets per exercise (weight × reps,
mark warm-ups, optional RPE); the sets round-trip through save → session-details;
the scalar aggregates are still derived and correct; and **bot mode is unchanged**.

## Context (from discovery)

- **Cloud exerciselog** — `web/domain/workout.js`, type `exerciselog` (`WORKOUT_RECORD_TYPES.LOG`, `:44`). Body written in `createLog` (`:1069-1122`) and the placeholder writer (`:898-913`); read projection `toLogResponse` (`:233-248`) is a **whitelist** (must add `sets` to emit it). `updateLog` (`:1130-1168`) auto-promotes placeholder→completed when `sets_completed>=1`. `propagateExerciseToSchedule` (`:1045-1061`) writes the aggregate back to the plan (needs derived scalars). Validation helper `validateExerciseValues` (`:253`). No cloud `workout_log`/collapse exists.
- **Vault/sync** — records are opaque `{recordId, clientTs, deleted, ...body}` blobs, whole-body serialized+encrypted (`web/cloud/js/sync.js:581,910`); `exerciselog: ['workout']` tag (`sync.js:309`). A nested array is invisible to sync — no changes there.
- **apishim routes** (`web/cloud/js/apishim.js:716-724`) — `POST /api/workout/sessions/logs/create → workout.createLog(body)`, `.../update → workout.updateLog(body.id, body)`, `DELETE .../delete`. Body passes through verbatim, so a `sets` field arrives unchanged — **no route edit**.
- **Shared UI** — `web/static/js/features/workout/sessions.js`: single Sets/Reps/Weight number inputs per exercise (`createNumberInputGroup` `:224-226`), state in `updateLocalLog` (`:323`), POST on finish `saveWorkoutSession` (`:567-583`) + quick-add (`:955-961`). Not gated on `__MEDTRACKER_CLOUD__`; `apiCall('/api/workout/...')` hits Go (bot) or the shim→domain (cloud). Same code, two backends.
- **Bot store (DEFERRED)** — `workout_exercise_logs` scalar columns only (mig `012`), `UNIQUE(session_id, exercise_id)` (mig `033`); INSERT/UPDATE at `internal/store/workout/repo.go:1240,1280,1349`. Go NL `mergePayloadValues` (`internal/domain/workout_resolver.go:280-318`) already collapses per_set and never persists the array — leave as-is.
- **Tests** — router-level cloud harness `web/static/js/tests/cloud.shim-contract.workout-sessions.test.js` (drive `window.apiCall` create/update, assert round-trip via `/sessions/details`). UI: `web/static/js/tests/features.workout-sessions.test.js`.

## Development Approach

- **Testing approach:** Regular. Almost entirely `web/domain/workout.js` + `sessions.js` + JS tests. No new Go, no migration, no sync/route/catalog changes.
- **Invariants:** keep flat aggregate fields on every write (bot compat + existing stats/propagation); no hardcoded colors/inline styles in the new UI (rule 3); no new `window.*` globals (rule 4); shared file stays unbranched if possible.
- Each task ends with passing tests before the next.

## Testing Strategy

- Cloud round-trip in `cloud.shim-contract.workout-sessions.test.js`: create/update a log with `sets:[...]` → `/sessions/details` returns the sets; derived `sets_completed/reps_completed/weight_kg` correct; update replaces the array.
- UI in `features.workout-sessions.test.js`: per-set rows render, add/remove a set, set_type + optional RPE captured, and the POST body carries `sets` **and** the derived flat scalars.
- Bot-compat check: a Go handler test (or a read) proving the extra `sets` key is ignored by the log handlers.

## Progress Tracking

- Mark items `[x]` immediately. `➕` new tasks, `⚠️` blockers.

## Implementation Steps

### Task 1: Persist per-set in the cloud exerciselog domain
- [ ] In `web/domain/workout.js` `createLog` (`:1069`) and `updateLog` (`:1130`): accept optional `input.sets` = array of `{set_index, weight_kg, reps, rpe?, set_type}`; validate each entry (extend `validateExerciseValues`: `set_type ∈ {normal,warmup,drop,failure}` default `normal`, `weight_kg>=0`, `reps>=0`, `rpe` optional 1–10); store the normalized array on the record body.
- [ ] Derive and keep the scalar aggregates from `sets` when present: `sets_completed=len(sets)`, `reps_completed=max(reps)`, `weight_kg=max(weight_kg)` (mirrors the Go `mergePayloadValues` contract) so `propagateExerciseToSchedule`, stats, and history keep working; when `sets` is absent, preserve today's flat behavior.
- [ ] `toLogResponse` (`:233`): emit `sets` when present (whitelist add). Placeholder writer (`:898-913`): default `sets: []` (optional).
- [ ] Extend `web/static/js/tests/cloud.shim-contract.workout-sessions.test.js`: create + update a log with a multi-set `sets` array, assert round-trip via `/sessions/details` returns the sets and the derived scalars; a warm-up-tagged set is stored with its `set_type`.
- [ ] Run the cloud shim-contract workout suites — must pass before Task 2.

### Task 2: Per-set entry UI in the shared sessions.js
- [ ] In `web/static/js/features/workout/sessions.js`, replace the single Sets/Reps/Weight row (`renderWorkoutSessionExercise` / `createNumberInputGroup` `:200-250`) with N **repeatable set rows**: per row `weight`, `reps`, optional `rpe`, and a `set_type` selector; add-set / remove-set controls. Update `updateLocalLog` (`:323`) to hold the array.
- [ ] In `saveWorkoutSession` (`:567-583`) and the quick-add path (`:955-961`), include `sets: [...]` in the create/update body **and** keep the derived flat fields (`sets_completed=len`, `reps_completed=max(reps)`, `weight_kg=max(weight)`) so bot mode and existing consumers are unaffected.
- [ ] No hardcoded colors / inline `.style.` (rule 3 — use tokens/classes); no new `window.*` global (rule 4); keep the file unbranched (no `__MEDTRACKER_CLOUD__` gate) if the flat-fields approach holds.
- [ ] Extend `web/static/js/tests/features.workout-sessions.test.js`: per-set rows render + add/remove, `set_type`/`rpe` captured, and the POST body carries both `sets` and the derived scalars.
- [ ] Run the workout feature + cloud shim-contract suites — must pass before Task 3.

### Task 3: Confirm bot mode is not regressed (the coupling risk)
- [ ] Read the Go log handlers (`internal/server/workout_handlers.go` `AddExerciseToSession` / `UpdateExerciseLog` request decoding): confirm they use plain `json.Unmarshal` / `json.NewDecoder` WITHOUT `DisallowUnknownFields`, so the extra `sets` key is silently ignored and the flat fields still drive bot storage.
- [ ] If (and only if) unknown-field rejection is enabled anywhere on that path, gate the `sets` field out of the body in bot mode (`!window.__MEDTRACKER_CLOUD__`) rather than changing Go. Document the decision in `docs/workout-depth.md`.
- [ ] Run `go build ./...` + `go test ./internal/server/... -run Workout` — must pass (bot unchanged) before Task 4.

### Task 4: Verify acceptance + full suite
- [ ] Verify: cloud logs multiple sets/exercise (weight×reps, warm-up flag, optional RPE) round-tripping through save → session-details; derived scalars correct; bot mode unchanged.
- [ ] Run the full frontend suite (`pnpm test`) incl. domain-purity + globals, and `go build ./...` + `go build -tags mobile ./...` — all must pass.

### Task 5: [Final] Docs
- [ ] Update `docs/workout-depth.md` Phase 1: record the implemented data-model decision (nested `sets` array on `exerciselog`, flat scalars derived, bot untouched via unknown-field tolerance).

## Technical Details

- **Set record shape:** `{ set_index:int, weight_kg:number>=0, reps:int>=0, rpe?:number(1–10), set_type:'normal'|'warmup'|'drop'|'failure' }`. Stored as `sets:[...]` on the exerciselog record body; scalars derived for back-compat.
- **Why nested, not a new record type:** the set collection has no independent lifecycle (always read/written with its parent log); a new vault type would add tag/CRUD/route/catalog/cascade wiring for nothing. Opaque-blob storage makes the nested array free.
- **Phase 1 stores `set_type` but does not yet act on it** (warm-up exclusion from PR/volume math is Phase 3). Storing it now avoids a later migration of historical logs.

## Post-Completion

**Manual verification** (needs a cloud account): start a workout, log 3 sets of an
exercise with different weights + one warm-up + an RPE, finish, reopen the session
detail, and confirm all sets persisted. Then confirm bot mode logging still works.
