# Workout goal-aware foundation — training_goal + editor cascade (cloud-first)

## Overview

Add a **`training_goal` dimension** that seeds sensible defaults (rep range, target
RIR, progression preset) per the repetition-continuum evidence (`docs/workout-depth.md`
§Science basis, med-qj4.5). Foundation bead med-qj4.6.1 of the goal-aware sub-epic
(med-qj4.6). Cloud-first (bot legacy). Builds on the merged 4-phase core.

**Locked mechanism (owner-decided):** ask the goal at **routine (workout group)
creation** — a `{strength | hypertrophy | endurance | general}` selector, **default
`hypertrophy`**. Exercises **inherit** the routine goal and can **override
per-exercise**. Goal is **stored** (group field + optional per-exercise override) and
drives defaults/emphasis only — it changes **nothing** about how a set is stored.

**Scope of THIS bead (foundation only):** the enum + storage (group + exercise
override), the two selectors (group-create UI + exercise-editor override), and the
**cascade** (choosing a goal pre-fills the exercise editor's default rep-range + RIR +
progression preset). It does NOT include goal-differentiated progression *compute*
(med-qj4.6.3), goal graph emphasis (med-qj4.6.4), or the effort insight (med-qj4.6.5).

**Goal → default table** (from the science basis):
| goal | reps_min | reps_max | target_rir | progression preset |
|------|----------|----------|-----------|--------------------|
| strength | 3 | 6 | 2 | linear |
| hypertrophy (default) | 8 | 12 | 1 | double |
| endurance | 15 | 25 | 1 | double |
| general | 8 | 12 | — | none |

**Acceptance:** a routine can carry a `training_goal` (default hypertrophy), stored +
round-tripped; the group-create UI has a goal selector; an exercise can override the
goal; choosing/​changing the goal in the exercise editor pre-fills the default
rep-range + RIR + progression preset (all still editable). Bot mode degrades (Go
ignores the unknown fields), doesn't break.

## Context (from discovery)

- **Group record:** `createGroup` (`web/domain/workout.js:569`), `updateGroup` (`:603`), `toGroupResponse` (`:137`). Fields today: name, description, is_rotating, days_of_week, scheduled_time, notification_advance_minutes, active. Additive `training_goal` needs no migration (opaque vault blob) — add to create/update + emit in `toGroupResponse` (conditional/defaulted).
- **Exercise record + editor:** `createExercise`/`updateExercise`/`toExerciseResponse` (Phase 4 added `progression_rule` here as the template). Editor `web/static/js/features/workout/exercises.js`: `showEditExerciseModal` populate (~:205-225), `showAddExerciseModal` reset (~:164-171), `saveExercise` payload (~:233-249) — already wires the Phase-4 progression selector (ids `workout-exercise-progression` / `-increment`); mirror that for a `training_goal` override + the cascade.
- **Group editor:** `web/static/js/features/workout/groups.js` — `showEditGroup` populate (~:290), `saveGroup` payload (~:473). Markup in `web/static/index.html` (group modal). Add a `<select id="workout-group-goal">` + wire the three touch points, reusing existing modal classes (rule 3); no new globals (rule 4).
- **Defaults source:** a small pure `web/domain/workout-goals.js` exporting `GOAL_DEFAULTS` (the table above) + a `defaultsForGoal(goal)` helper — pure, reused by the editor cascade and (later) med-qj4.6.3/.4/.5. Purity-guarded by `architecture.domain-purity.test.js`.
- **Tests:** shim-contract for group/exercise round-trip (`cloud.shim-contract.workout-*`), editor tests (`features.workout-exercises.test.js`, and a groups editor test if present). Pure test for `workout-goals.js`.

## Development Approach

- **Testing approach:** Regular. Additive vault fields + two selectors + a pure defaults map + the cascade. No migration/route/catalog change. Rule 3 (no hardcoded styles), rule 4 (no new globals).
- **Run vitest with Node 20** (`/tmp/node-v20.18.1-linux-x64/bin` on PATH; `node node_modules/vitest/vitest.mjs run <file>` — pnpm/corepack broken; Node 18 default can't run vitest). Do NOT skip the frontend suite.
- Each task ends with passing tests before the next.

## Progress Tracking
- Mark `[x]` immediately. `➕` new, `⚠️` blocker.

## Implementation Steps

### Task 1: Pure goal-defaults module
- [x] Create `web/domain/workout-goals.js`: `GOAL_DEFAULTS` map (strength/hypertrophy/endurance/general → `{reps_min, reps_max, target_rir, progression: 'none'|'linear'|'double'}`) + `defaultsForGoal(goal)` (falls back to hypertrophy for unknown/empty). Pure, no browser globals.
- [x] Pure test `web/static/js/tests/workout-goals.test.js` asserting the table + fallback.
- [x] Run it + `architecture.domain-purity.test.js` (Node 20) — must pass before Task 2.

### Task 2: training_goal on the group record + group-create UI
- [x] `web/domain/workout.js`: add `training_goal` to `createGroup` (`:569`, default `'hypertrophy'`), `updateGroup` (`:603`), and `toGroupResponse` (`:137`). Validate against the enum (default hypertrophy on invalid/empty). Uses `normalizeGoal` from `workout-goals.js`.
- [x] `web/static/index.html` + `web/static/js/features/workout/groups.js`: add a `<select id="workout-group-goal">` (Strength/Hypertrophy/Endurance/General) to the group modal; populate it in `showEditGroup`; include `training_goal` in the `saveGroup` payload; default the add-modal to hypertrophy.
- [x] Shim-contract test: create/update a group with `training_goal` → GET round-trips it; default is hypertrophy.
- [x] Run the group + shim-contract suites (Node 20) — must pass before Task 3.

### Task 3: Per-exercise goal override + cascade in the exercise editor
- [x] `web/domain/workout.js`: add optional `training_goal` to `createExercise`/`updateExercise`/`toExerciseResponse` (emit only when set; absent = inherit from the routine).
- [x] `web/static/js/features/workout/exercises.js` + `index.html`: add a `<select id="workout-exercise-goal">` with an "Inherit from routine" default + the four goals; populate in `showEditExerciseModal` (`:205`), reset in `showAddExerciseModal` (`:164`), read into the `saveExercise` payload (`:233`).
- [x] **Cascade:** on goal-selector change (and when the editor opens with a goal), pre-fill the target rep-range (`reps_min`/`reps_max`), the progression preset (`workout-exercise-progression`), and — if a target-RIR field exists or is added — the RIR, from `defaultsForGoal(effectiveGoal)`. All fields stay editable (the cascade only fills defaults; it never locks). "Inherit" resolves the routine's goal. (RIR skipped — no target-RIR field in the exercise editor.)
- [x] Extend `features.workout-exercises.test.js`: the goal selector renders + round-trips; changing the goal pre-fills the rep-range + progression preset; "inherit" uses the routine goal; existing fields stay editable.
- [x] Run the exercise editor + shim-contract suites (Node 20) — must pass before Task 4.

### Task 4: Verify + full suite
- [x] Verify: routine goal stored + selectable (default hypertrophy); exercise override + cascade pre-fills defaults; bot mode unaffected (Go ignores unknown `training_goal` — both `go build ./...` and `-tags mobile` pass).
- [x] Run the full frontend suite (`pnpm test` equivalent via `node node_modules/vitest/vitest.mjs run`, **Node 20**) incl. domain-purity + globals, and `go build ./...` + `-tags mobile` — all pass (318 files / 3784 tests; one WorkoutVariantModal layout test is a pre-existing order-dependent flake, green in isolation and on re-run).

### Task 5: [Final] Docs
- [x] Update `docs/workout-depth.md` (goal-aware section / med-qj4.6.1): the training_goal field (group + exercise override), the group-create selector, the editor cascade, and the goal→defaults table as implemented. Note progression/graphs/insight goal-differentiation are med-qj4.6.3/.4/.5.

## Technical Details

- **Storage:** `training_goal` on the `workoutgroup` record (default hypertrophy) + optional override on the `workoutexercise` record (absent = inherit). Additive opaque-blob fields — no migration/route/catalog change.
- **Cascade is fill-only:** choosing a goal pre-fills defaults but never overwrites values the user has already typed beyond the fill moment, and never disables editing. Effective goal for an exercise = its override, else the routine's goal.
- **Bot safety:** the shared editors send `training_goal`; the Go server ignores unknown JSON keys (same as Phase 1's `sets` and Phase 4's `progression_rule`). No auto-behavior in bot; no breakage.

## Post-Completion

**Manual verification** (cloud account): create a routine with goal = Strength; add an
exercise (inherits Strength → editor pre-fills 3–6 reps + linear); override one
exercise to Hypertrophy and confirm its defaults switch to 8–12 + double.
