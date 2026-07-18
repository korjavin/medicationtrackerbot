# Workout Phase 2 — non-destructive history (cloud-first)

## Overview

A completed workout session stores no exercise snapshot, so its exercise list +
targets re-render from the **current** variant. Editing a variant, renaming a
library exercise, or changing targets therefore **retroactively rewrites past
sessions**. This phase makes a completed session an **immutable record**: snapshot
the exercise list + targets at completion so history reflects the plan *as
performed*. Cloud-first (bot legacy). Epic med-qj4, bead med-qj4.2.1.

Already-logged exercises are safe (each `exerciselog` snapshots `exercise_name` at
log time). The leak is the **planned/un-logged** rows + `exercises_count`, which the
UI fills from the live variant. Fix: store an `exercise_snapshot` on the session and
prefer it on read; fall back to the live variant when absent (legacy sessions).

**Acceptance:** after completing a session, editing the variant's exercises /
renaming a library exercise / changing targets does NOT change what that past
session shows; `exercises_count` is stable; sessions completed before this change
(no snapshot) still render via the live variant.

## Context (from discovery)

- **Retroactive leak** — `getSessionDetails` (`web/domain/workout.js:1509-1516`) returns session + logs only; the **frontend** `showWorkoutSessionModal` (`web/static/js/features/workout/sessions.js:259-297`) makes a 2nd call `/api/workout/exercises?variant_id=…` and merges not-yet-logged exercises using the **live** `exercise_name`/`target_*` (`:278-292`). `listSessions` `exercises_count` also counts via live `listExercises` (`web/domain/workout.js:1456,1499`). Mutators: `updateExercise`/`createExercise`/`deleteExercise` (`:590-615`), `updateLibraryItem` (`:678-697`), all surfaced via `toExerciseResponse` (`:168-186`).
- **Session record** — `WORKOUT_RECORD_TYPES.SESSION` (`web/domain/workout.js:43`); fields written in `createAdHocSession`/`getNext`/`schedulePlannedAdHocSession`; exposed by `toSessionResponse` (`:205-221`) with conditional fields (`started_at`/`notes` pattern). **No snapshot today.** Complete point: `completeSession` (`:1012-1020`).
- **Write point (recommended): `completeSession`** — the plan may legitimately change between materialization and performance, so snapshot at completion = "plan as performed." Skip ad-hoc (`variant_id === -1`; `listExercises` returns nothing — ad-hoc already reads only logs).
- **Separable from Phase 1** — Phase 1 (`feat/workout-phase1-perset`, per-set) edits `exerciselog` functions (`createLog`/`updateLog`/`toLogResponse`/`normalizeSets`); Phase 2 edits `workoutsession` functions (`completeSession`/`toSessionResponse`/`listSessions`) + the adjacent `sessions.js` prefill block (`:259-297`). No logical overlap; only a small textual merge in `sessions.js` + the shared test file at merge time.
- **Tests** — `web/static/js/tests/cloud.shim-contract.workout-sessions.test.js` (harness `loadCloudShimFrontendEnv`, drives `window.apiCall`/`apiCallDirect` → real `web/domain/workout.js`). `history.js` renders `${done}/${total}` from `listSessions` (`:298`) — inherits the `exercises_count` fix. No `session-detail.js`; the detail view is the `sessions.js` modal.

## Development Approach

- **Testing approach:** Regular. Cloud domain (`web/domain/workout.js`) + `sessions.js` prefill + JS tests. No new Go, no migration, no route/catalog/sync change (`exercise_snapshot` is an additive field on the opaque session blob).
- **Invariants:** snapshot is an optional field — every reader falls back to today's live-variant behavior when it's absent (legacy + in-flight sessions). No hardcoded styles (rule 3); no new `window.*` globals (rule 4).
- Each task ends with passing tests before the next.

## Testing Strategy

- `cloud.shim-contract.workout-sessions.test.js`: complete a session → `exercise_snapshot` stored; then mutate the plan three ways (update exercise targets/list, rename library item) → re-fetch `/api/workout/sessions/details?id=` and assert the snapshot-derived list/targets are unchanged; assert `/api/workout/sessions?limit=` `exercises_count` stable. Negative case: a session with no snapshot still resolves via the live variant.

## Progress Tracking

- Mark items `[x]` immediately. `➕` new tasks, `⚠️` blockers.

## Implementation Steps

### Task 1: Snapshot exercise list + targets at completion (cloud domain)
- [x] In `web/domain/workout.js` `completeSession` (`:1012`): when `variant_id !== -1`, build `exercise_snapshot = (await listExercises(variant_id)).map(e => ({ exercise_name, target_sets, target_reps_min, target_reps_max, target_weight_kg, order_index }))` and write it onto the session record (alongside the status→completed update). Skip ad-hoc.
- [x] `toSessionResponse` (`:205`): emit `exercise_snapshot` when present (mirror the conditional-field pattern of `started_at`/`notes`).
- [x] `listSessions` (`:1448`): compute `exercises_count` from `session.exercise_snapshot.length` when present, else today's live `listExercises` count (`:1456,1499`).
- [x] Extend `web/static/js/tests/cloud.shim-contract.workout-sessions.test.js`: complete a session → snapshot present; edit the variant's exercises + rename the library item + change targets → the completed session's detail + `exercises_count` are unchanged; a snapshot-less session falls back to the live variant.
- [x] Run the cloud shim-contract workout-sessions suite — must pass before Task 2.

### Task 2: Frontend prefers the snapshot in the session modal
- [x] In `web/static/js/features/workout/sessions.js` `showWorkoutSessionModal` (`:259-297`): when `data.session.exercise_snapshot` is present, build the planned/un-logged rows from it instead of calling `/api/workout/exercises?variant_id=…`; keep the live-variant path as the fallback when the snapshot is absent. (Snapshot rows carry no `exercise_id`, so the snapshot path dedupes logged rows by `exercise_name`.)
- [x] No hardcoded colors / inline `.style.` (rule 3); no new `window.*` global (rule 4).
- [x] Extend the session-modal test (`features.workout-sessions.test.js`): a completed session with a snapshot prefills the snapshot's list/targets and does NOT call the live-variant endpoint; a snapshot-less session falls back to `/api/workout/exercises`.
- [x] Run the workout feature + shim-contract suites — must pass before Task 3.

### Task 3: Verify acceptance + full suite
- [ ] Verify: complete → edit plan (all three ways) → past session unchanged; `exercises_count` stable; legacy (snapshot-less) sessions still render.
- [ ] Run the full frontend suite (`pnpm test`) incl. domain-purity + globals, and `go build ./...` + `go build -tags mobile ./...` (untouched — confirm nothing broke).

### Task 4: [Final] Docs
- [ ] Update `docs/workout-depth.md` Phase 2: record the implemented snapshot field + write-at-completion + read-prefer-snapshot-else-live-variant decision.

## Technical Details

- **Snapshot shape:** `exercise_snapshot: [{ exercise_name, target_sets, target_reps_min, target_reps_max, target_weight_kg, order_index }]` on the `workoutsession` record body (opaque vault blob — additive, no migration/route/catalog change).
- **Write at completion, not materialization:** the plan can change between a session being materialized (pending) and performed; completion captures the plan as actually performed. Ad-hoc sessions (`variant_id === -1`) are skipped — they already render exclusively from logs.
- **Legacy fallback:** the field is optional; absent → every reader keeps today's live-variant behavior, so pre-existing completed and in-flight sessions are unaffected.

## Post-Completion

**Manual verification** (cloud account): complete a workout, then edit that routine's
exercises and rename an exercise in the library; reopen the completed session and
confirm it still shows the original exercises + targets.
