# Workout Phase 4 — opt-in progression rules (cloud-first)

## Overview

Turn the existing "mirror last performance" write-back into **opt-in per-exercise
progression**: a rule `{none | linear | double-progression}` that, after a completed
session, computes the suggested next target for that exercise. Presets only — **not**
a scripting DSL. Epic med-qj4, bead med-qj4.4.1. Cloud-first (bot legacy). Builds on
Phase 1's per-set `sets` array.

**Acceptance:** an exercise can carry a progression rule; after a completed session
whose sets meet the rule's condition, the exercise's plan target updates per the rule
(e.g. linear → +2.5 kg when the rep target is hit on all work sets). `none` preserves
today's mirror behavior. Optional: a dry-run MCP `workout_progression_preview` that
previews next targets without saving.

## Context (from discovery)

- **The mirror seam:** `propagateExerciseToSchedule` (`web/domain/workout.js:~1093`) — writes last-logged sets/reps/weight into the plan's `target_*` (COALESCE non-zero; widens `target_reps_max`→null when exceeded). Called from `createLog` (~:1176) and `updateLog` (update path), receiving **derived scalars**, not the per-set array. This is the seam to upgrade.
- **Rule storage — additive vault field (like Phase 1 `sets`):** the `workoutexercise` record is created in `createExercise` (~:515) / updated in `updateExercise` (~:590) via `records.put`, opaque blob → adding `progression_rule` needs **no migration/route/catalog change**. BUT the mappers are **allowlist-style**: add the field in `createExercise`, `updateExercise`, AND `toExerciseResponse` (~:168-187, conditional-emit) to round-trip; the UI `saveExercise` must include it in the PUT payload. Validate in a small `normalizeProgressionRule()` next to `normalizeSets`.
- **Compute hook — the `propagate` seam, not `completeSession`:** `completeSession` reads no logs; `propagate` already loads the exercise (now carrying `progression_rule`) and runs per-completed-log. Thread the log's `sets` array into `propagate` (currently gets scalars) so the rule can inspect per-set reps; fall back to `reps_completed` (max) if `sets` absent.
- **UI:** exercise editor `web/static/js/features/workout/exercises.js` — targets read/written by element id in `showEditExerciseModal` (~:213), reset in `showAddExerciseModal` (~:164), collected in `saveExercise` (~:227). Modal markup `web/static/index.html:~1287-1350`. Add a `<select id="workout-exercise-progression">` + increment `<input>`; wire the three touch points. Reuse existing `wg-workouts-exercise-modal__*` classes (rule 3); no new globals (rule 4).
- **MCP preview (optional):** reuse the med-eas.56 cloud-only catalog seam — add an op to `web/cloud/js/mcp-catalog.cloud-extra.js`, a route in `apishim.js createApiRouter`, backed by a pure compute-only fn (no `records.put`). `web/domain/analysis.js` + its routes are the template.
- **Separable from Phases 1/3:** Phase 4 touches the `workoutexercise` record + `propagate` + `exercises.js` (a different record type than Phase 1's `exerciselog` and Phase 3's stats read). Only coupling: `propagate` now receives Phase 1's `sets` (merged).
- **Tests:** `web/static/js/tests/cloud.shim-contract.workout-sessions.test.js` (drive real domain via `window.apiCall`; per-set + ad-hoc/propagation cases are templates). UI selector: `features.workout-exercises.test.js` / `workout.exercises.test.js`.

## Development Approach

- **Testing approach:** Regular. Additive vault field + `propagate` upgrade + editor selector; optional MCP preview via the cloud-only seam. No new mechanisms — presets are a goal-agnostic parameter lookup (goal-aware parameterization is med-qj4.6.3).
- Rule 3 (no hardcoded styles), rule 4 (no new globals). Each task ends with passing tests.

## Testing Strategy

- Shim-contract: create an exercise with `progression_rule:{type:'linear', increment_kg:2.5}` + a target; materialize a session; log all sets hitting `target_reps_max`; complete; then GET the exercise and assert `target_weight_kg` bumped +2.5. Add a double-progression case (reps climb, then weight+reset) and a `none` case (mirror unchanged).

## Progress Tracking
- Mark `[x]` immediately. `➕` new, `⚠️` blocker.

## Implementation Steps

### Task 1: progression_rule field on the exercise record
- [x] In `web/domain/workout.js`: add `normalizeProgressionRule(input)` (validate `{type:'none'|'linear'|'double', increment_kg>=0, min_reps?, max_reps?}`, default `none`); wire it into `createExercise` (~:515) and `updateExercise` (~:590) to persist on the record body; emit it in `toExerciseResponse` (~:168) when `type !== 'none'`.
- [x] Write shim-contract tests: create/update an exercise with a rule → GET round-trips it; `none`/absent omits it.
- [x] Run the shim-contract workout suites — must pass before Task 2.

### Task 2: Upgrade propagateExerciseToSchedule to apply the rule
- [x] Thread the completed log's `sets` array into `propagateExerciseToSchedule` (from `createLog`/`updateLog`); keep the existing guards.
- [x] Branch on `exercise.progression_rule.type`: `none` → current mirror; `linear` → if every work (non-warmup) set met `target_reps_max` (and set count ≥ `target_sets`), `target_weight_kg += increment_kg`; `double` → within `[min_reps,max_reps]`: bump reps toward max; at max on all sets → `target_weight_kg += increment_kg` and reset reps to `min_reps`. Fall back to `reps_completed` (max) when `sets` absent.
- [x] Write shim-contract tests: linear rule → +increment when rep target met on all sets (and NOT when unmet); double-progression rep-then-weight; `none` unchanged (mirror).
- [x] Run the suites — must pass before Task 3.

### Task 3: Progression-rule selector in the exercise editor
- [ ] Add a `<select id="workout-exercise-progression">` (None / Linear / Double progression) + an increment `<input id="workout-exercise-progression-increment">` to the exercise modal (`web/static/index.html` ~:1347, before Order). Reuse `wg-workouts-exercise-modal__label`/`__input` classes.
- [ ] Wire the three touch points in `web/static/js/features/workout/exercises.js`: set in `showEditExerciseModal` (~:213), clear in `showAddExerciseModal` (~:164), read into `payload` in `saveExercise` (~:227). No hardcoded styles; no new globals.
- [ ] Extend `web/static/js/tests/workout.exercises.test.js` (or `features.workout-exercises.test.js`): the selector renders, round-trips into the save payload, and clears on add.
- [ ] Run the workout exercise suites — must pass before Task 4.

### Task 4: (Optional) MCP progression-preview via the cloud-only seam
- [ ] Add a pure compute-only preview fn (no `records.put`) that runs the Task-2 rule math over each exercise's latest completed log and returns the proposed next targets.
- [ ] Add a cloud-only op to `web/cloud/js/mcp-catalog.cloud-extra.js` (`workouts.progression_preview`, GET `/api/workout/progression-preview`) and a route in `apishim.js createApiRouter` calling the preview fn (mirror `web/domain/analysis.js` wiring). Keep `mcp-catalog.generated.js` untouched (drift-safe).
- [ ] Extend `web/cloud/js/tests/mcp-responder.test.js` coverage (the op routes + response_example) — the sweep requires the route.
- [ ] Run the mcp-responder + shim-contract suites — must pass before Task 5.

### Task 5: Verify acceptance + full suite
- [ ] Verify: rule stored + round-tripped; linear + double-progression compute correct next targets on completion; `none` preserves mirror; optional preview op works and is discoverable.
- [ ] Run the full frontend suite (`pnpm test`) incl. domain-purity + globals + catalog drift (`go test ./internal/mcp/catalogjs/...` if the preview op was added), and `go build ./...` + `-tags mobile` — all must pass.

### Task 6: [Final] Docs
- [ ] Update `docs/workout-depth.md` Phase 4: the rule field, the `propagate` upgrade, the editor selector, and (if added) the preview op. Note goal-differentiated presets + RIR-gating are the goal-aware sub-epic (med-qj4.6.3).

## Technical Details

- **Rule shape:** `progression_rule: { type:'none'|'linear'|'double', increment_kg, min_reps?, max_reps? }` on the `workoutexercise` record body (additive, opaque blob — no migration).
- **"Top of rep range hit on all sets"** = every non-warmup completed set has `reps >= target_reps_max` and set count `>= target_sets`. RIR-gating (only progress when near failure) is deferred to med-qj4.6.3.
- **Compute in `propagate`, not `completeSession`** — `propagate` already loads the exercise + runs per-log; hooking completion would re-load logs and re-implement the guard.

## Post-Completion

**Manual verification** (cloud account): set an exercise to Linear +2.5 kg, log a
session hitting the rep target on all sets, complete it, and confirm the exercise's
target weight increased by 2.5 kg for next time.
