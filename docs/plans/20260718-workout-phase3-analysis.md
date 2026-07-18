# Workout Phase 3 — analysis: est-1RM, PRs, per-exercise graphs (cloud-first)

## Overview

Phase 1 landed per-set data (`sets:[{set_index, weight_kg, reps, rpe?, set_type}]` on
the `exerciselog` record). Phase 3 is the **read-side analysis** over it: estimated
1RM (Epley), personal-record detection, and per-exercise progress graphs. All
**computed-on-read** from the immutable sets — no storage, no migration. Epic
med-qj4, bead med-qj4.3.1. Cloud-first (bot legacy).

**Acceptance:** for a cloud user with logged sets, (a) estimated 1RM is computed
(Epley), (b) PRs are detected (heaviest weight, best est-1RM, best set volume, best
session volume, most reps, per-rep-count set-records; warm-up sets excluded), (c) a
per-exercise history is available with 1RM/top-weight-over-time graphs, and (d) a PR
cue appears when a set beats a record. Warm-ups (`set_type==='warmup'`) are excluded
from PR/volume/1RM math.

## Context (from discovery)

- **Per-set data (Phase 1, merged):** `web/domain/workout.js` `normalizeSets` (~:267, lowercase `'warmup'` etc.), `deriveSetScalars` (~:298); `toLogResponse` passes `sets` through. Each log carries `sets:[{set_index, weight_kg, reps, rpe?, set_type}]`.
- **Current stats:** `getStats()` (`web/domain/workout.js:~1542`) aggregates LOG records by `exercise_name` using **flat scalars** (`total_volume += sets_completed*reps_completed*weight_kg`, `max_weight`); returns top-8 by volume + a 12-week heatmap. No 1RM/PR. Route `apishim.js:~726 → workout.getStats()`.
- **Chart:** `web/static/js/components/wg-workout-chart.js` — `render({sessions, range, metric})`; metrics today `'sessions'`/`'volume'` via `pickMetric` (~:55-66) + a y-scale branch (~:260-265); normalizes to `{date, value}`. Adding a metric = ~4 lines (a `pickMetric` case + widen the continuous y-scale branch to `metric !== 'sessions'`). `stats.js` (`renderChartInto` ~:230) drives it (currently no `metric` passed → always sessions).
- **No per-exercise history read exists** — `getStats` returns rolled-up scalars only; no dates/sets per session. **Need a new read** `listExerciseLogsByName(name, {limit})` in `web/domain/workout.js` that filters LOG records by `exercise_name`, joins each log's session for `scheduled_date`, returns `{date, sets}` per log; + a shim route (`apishim.js`, near `:726`) e.g. `GET /api/workout/exercises/history?name=`.
- **No PR/1RM concept anywhere** (grep clean) — greenfield. Session log cards live in `sessions.js` (log card header ~:159) — a PR badge attaches there. **No per-exercise detail view exists** (`exercises.js` is CRUD; `history.js` is session-level; `stats.js` "Top Exercises" list ~:304 is closest) — a small per-exercise detail view (graphs + records) is a new surface.
- **Analysis module:** create a pure `web/domain/workout-analysis.js` (mirrors `web/domain/analysis.js`), store-agnostic. Purity enforced by `architecture.domain-purity.test.js`.
- **Tests:** pure-unit `web/static/js/tests/workout-analysis.test.js` (hand-computed Epley/PR); shim-contract extend `web/static/js/tests/cloud.shim-contract.workout-stats.test.js` (seed `sets` across sessions → assert route output); chart `web/static/js/tests/components.wg-workout-chart.test.js`.

## Development Approach

- **Testing approach:** Regular. Compute-on-read (no storage/migration). Epley `1RM = weight * (1 + reps/30)`. Exclude `set_type==='warmup'` from every fold.
- Purity: `workout-analysis.js` stays pure (no browser globals). No hardcoded colors/inline styles in new UI (rule 3); no new `window.*` globals without allowlist (rule 4).
- Each task ends with passing tests before the next.

## Testing Strategy

- Pure `workout-analysis.test.js`: hand-built `sets` arrays → assert Epley (e.g. `100*(1+5/30)=116.67`), PR selection, warm-up exclusion, per-rep-count set-records. Primary correctness net.
- Shim-contract: seed logs with `sets` across ≥2 sessions → hit the new history route → assert 1RM/PR/series. Chart-component test for the new metrics.

## Progress Tracking
- Mark `[x]` immediately. `➕` new, `⚠️` blocker.

## Implementation Steps

### Task 1: Pure analysis module (web/domain/workout-analysis.js)
- [x] Create `web/domain/workout-analysis.js` exporting pure fns: `estimated1RM(weight, reps)` (Epley), `exercisePRs(logs)` — fold over non-warmup sets across a log list → `{heaviest_weight, best_est_1rm, best_set_volume, best_session_volume, most_reps, set_records: {<reps>: <weight>}}`, and `exerciseSeries(logs)` → `[{date, est_1rm, top_weight, volume}]` per session (session-best est-1RM from its sets).
- [x] Exclude `set_type==='warmup'` at the top of each fold; handle empty/absent sets gracefully.
- [x] Write `web/static/js/tests/workout-analysis.test.js`: Epley values, PR selection, warm-up exclusion, set-records, empty case — all hand-computed.
- [x] Run the analysis + domain-purity suites — must pass before Task 2.

### Task 2: Per-exercise history read + shim route
- [ ] In `web/domain/workout.js`, add `listExerciseLogsByName(name, {limit})`: filter LOG records by `exercise_name`, join each log's session (`scheduled_date`), return newest-first `[{date, sets, session_id}]` (completed logs).
- [ ] Add a route in `web/cloud/js/apishim.js` `createApiRouter` (near the other `/api/workout/*` reads): `GET /api/workout/exercises/history?name=` → `listExerciseLogsByName`. (If MCP-catalogued reads require registry coverage, expose read-only via the router only — this is a UI read, not an MCP op, so no catalog entry.)
- [ ] Extend `web/static/js/tests/cloud.shim-contract.workout-stats.test.js`: seed a library exercise + ≥2 completed sessions with `sets` → hit `/api/workout/exercises/history?name=` → assert the returned per-log sets + dates.
- [ ] Run the shim-contract workout suites — must pass before Task 3.

### Task 3: Chart metrics (est-1rm, top-weight)
- [ ] In `web/static/js/components/wg-workout-chart.js`: add `est-1rm` and `top-weight` cases to `pickMetric` (read `raw.est_1rm`/`raw.top_weight`) and widen the continuous y-scale branch to `metric !== 'sessions'`.
- [ ] Extend `web/static/js/tests/components.wg-workout-chart.test.js`: assert the new metric render paths (y-scale + data attribute).
- [ ] Run the chart component test — must pass before Task 4.

### Task 4: PR badge + per-exercise detail view
- [ ] Add a **PR cue** to the session log card (`web/static/js/features/workout/sessions.js` header ~:159): when a completed set beats a stored record (computed via `workout-analysis` over that exercise's history), render a small "PR" badge (design-token class, no inline style).
- [ ] Add a **per-exercise detail view** (new small surface, reachable from the stats "Top Exercises" rows `stats.js:~304` or the log card): fetches `/api/workout/exercises/history?name=`, runs `workout-analysis` (`exercisePRs` + `exerciseSeries`), and renders the records summary + the `est-1rm`/`top-weight` graphs via `WGWorkoutChart`.
- [ ] Extend `web/static/js/tests/features.workout-stats.test.js` (or a focused test): the detail view renders records + a graph for seeded history; the PR badge appears when a record is beaten.
- [ ] Run the workout feature + shim-contract suites — must pass before Task 5.

### Task 5: Verify acceptance + full suite
- [ ] Verify: est-1RM (Epley), PR detection (all record types, warm-ups excluded), per-exercise graphs, PR cue — all working over per-set data; no storage/migration added.
- [ ] Run the full frontend suite (`pnpm test`) incl. domain-purity + globals, and `go build ./...` + `go build -tags mobile ./...` (untouched) — all must pass.

### Task 6: [Final] Docs
- [ ] Update `docs/workout-depth.md` Phase 3: record est-1RM (Epley), the PR types, compute-on-read, the new `listExerciseLogsByName` read, and the per-exercise detail view. (Also fold the `scratchpad/workout-science-basis.md` "science basis" section here if not already present — but keep Phase-3 scope to analysis; goal-aware emphasis is med-qj4.6.)

## Technical Details

- **Epley** `1RM = weight * (1 + reps/30)`. Est-1RM from >~10-12 rep sets is unreliable (formula degrades) — a low-confidence flag is deferred to the goal-aware sub-epic (med-qj4.6.4), not required here.
- **PR types:** heaviest weight, best est-1RM, best set volume (weight*reps in one set), best session volume (Σ over a session's non-warmup sets), most reps, per-rep-count set-records. All exclude warm-ups.
- **Compute-on-read**, not stored — sets are immutable; PRs/1RM are cheap pure derivations (matches how `getStats` derives live).

## Post-Completion

**Manual verification** (cloud account): log several sessions of an exercise with
increasing weight; open its detail view and confirm the est-1RM graph trends up,
records are correct, and a PR badge fires on a record-beating set.
