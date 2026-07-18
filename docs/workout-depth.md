# Workout depth — intentions & design

Status: **design proposal** (epic `med-qj4`, 2026-07-18). Cloud-first (bot mode is legacy).

## Why this exists

Our workout module today is a **schedule-and-adherence** tracker: plan a rotating
routine, get reminders, mark exercises done. That is genuinely useful and
differentiated (reminders, rotation, health context, first-party MCP), but for a
user whose mental model is *"I lift and I want to progress the weight,"* we are
missing the entire layer that modern strength loggers are built around.

We benchmarked the two apps a strength user would actually compare us to. Both are
built on the same table-stakes spine:

1. **Per-set logging** — every set's weight × reps (+ effort), not one number per exercise.
2. **Analysis** — estimated 1RM, personal-record detection, per-exercise progress graphs.
3. **Non-destructive history** — a logged workout is a frozen record; editing the plan never rewrites the past.
4. **(Optionally) progression** — suggest/auto-apply the next target.

Our goal is **parity with that spine** — enough that we are a credible strength
logger, not a novelty. We are explicitly **not** trying to out-feature the
category leaders on their own turf.

## What "on par" means (and what it doesn't)

**The parity bar is a clean per-set logger with analysis and honest history — not a
programmable progression engine.** A category-leading logger reaches "good" without
a scripting language; its manual routines don't even auto-progress. So we chase the
spine, and treat progression as a modest, opt-in add-on.

**Out of scope (deliberate):**
- **Social feed / following / leaderboards** — off-mission. This is a personal
  health app, not a social network. We will not build a feed.
- **Apple Watch / Wear OS apps** — nice-to-have, not parity-blocking.
- **A full progression scripting DSL** (à la Liftoscript) — wrong audience and a
  large maintenance surface. Presets (linear, double-progression) cover the real
  use; a DSL is not how you reach parity, it is how one competitor *differentiates*.

## Current state (honest baseline)

- **Aggregate-only logging.** `workout_exercise_logs` stores one row per exercise
  per session — scalar `sets_completed`, `reps_completed`, `weight_kg`, unique on
  `(session_id, exercise_name)`. There is no set-level structure. The MCP
  `workout_log` tool *accepts* a rich `per_set:[{reps, weight_kg}]` payload but
  `mergePayloadValues` collapses it to `sets=count, reps=MAX, weight=MAX` before
  storage — the detail is discarded.
- **No analysis.** No estimated 1RM, no PR detection, no per-exercise weight/1RM
  graph. Only volume/tonnage aggregation and a sessions-per-week chart.
- **Destructive history.** A session stores no exercise snapshot; past sessions
  re-render from the *current* variant, so editing a plan (or renaming a library
  exercise) retroactively changes what history shows. `workout_schedule_snapshots`
  captures only schedule metadata (days/time/name), not exercises or weights.

## Intentions, by phase

Each phase is a sub-epic under `med-qj4`. Phases 2–4 are blocked by Phase 1.

### Phase 1 — Per-set logging foundation (`med-qj4.1`)

**Intent:** store each SET — `{set_index, weight_kg, reps, rpe?, set_type}` where
`set_type ∈ {normal, warmup, drop, failure}` — instead of one aggregate row.

**Why it's first:** it is the foundation everything else needs. You cannot compute a
real estimated 1RM, detect a "best 5-rep set" PR, or graph strength over time from a
single `weight=MAX` number. Warm-up sets must also be *excluded* from PR/volume math,
which requires knowing which sets were warm-ups — impossible today. Notably, our MCP
ingestion already accepts per-set data; we are currently throwing it away. Phase 1 is
largely *stop discarding what we already receive* plus a persistence + UI change.

**Cloud-first scope:** implement in the cloud workout domain (`web/domain/workout.js`
exercise-log record), the cloud router (`apishim.js`), the shared in-workout UI
(`web/static/js/features/workout/sessions.js`), and the MCP `workout_log` path (stop
collapsing). The bot-mode Go store (`internal/store/workout`) gaining per-set columns
is a **deferred follow-up** — bot mode is legacy and must keep working, but it is not
where new depth lands.

### Phase 2 — Non-destructive workout history (`med-qj4.2`)

**Intent:** a completed session becomes an **immutable record** — snapshot its
exercise list + targets at completion, so a later plan edit never rewrites it.

**Why:** trust. A training log that silently changes your past when you edit a
routine is worse than useless — it lies about what you did. Both benchmark apps solve
this by storing each logged workout as an independent record decoupled from the
template; we should too. This also unblocks honest "plan as it was on date X".

### Phase 3 — Analysis: estimated 1RM, PRs, per-exercise graphs (`med-qj4.3`)

**Intent:**
- **Estimated 1RM** via the **Epley formula** (`1RM ≈ weight × (1 + reps/30)`) —
  the de-facto standard both benchmarks use. We adopt it rather than inventing our
  own so numbers are comparable and trusted.
- **PR detection** — heaviest weight, best estimated 1RM, best set volume, best
  session volume, most reps, and per-rep-count "set records." A live "new PR" cue.
- **Per-exercise graphs** — estimated-1RM-over-time and top-weight-over-time, added
  to the existing chart component (today only sessions/volume).

**Why:** this is the **highest payoff for the least effort** once per-set exists —
it is pure read-side computation over stored sets. And PRs are the single biggest
motivation/retention lever in strength training: seeing "best-ever 5-rep squat" is
why people keep a log at all. It is cheap for us and central for the user.

### Phase 4 — Progression rules, opt-in (`med-qj4.4`)

**Intent:** a per-exercise progression rule `{none | linear | double-progression}`.
After a completed session, compute the suggested next target. Upgrade the existing
`PropagateExerciseToSchedule` seam from "mirror last performance" to "apply the rule."
Optionally expose a **dry-run MCP `workout_progression_preview`** ("what would next
week look like?") — a small idea worth borrowing from the category.

**Why (and why modest):** closing the loop from "I logged" to "here's next week"
is what turns a logger into a coach. But full programmability is over-engineering
for our audience; presets deliver the value. Opt-in per exercise so we never
force a scheme onto someone who just wants to log.

## Data-model decision (Phase 1) — implemented

Per-set is stored **cloud-first** as a **nested `sets:[…]` array on the existing
`exerciselog` record body** (not a new record type). Each entry is
`{set_index, weight_kg>=0, reps>=0, rpe?(1–10), set_type∈{normal,warmup,drop,failure}}`.
Vault records are opaque JSON blobs, so nesting needs **zero** sync / records-port /
apishim-route / MCP-catalog changes — a new `workoutset` type would have added
tag/CRUD/route/catalog/cascade wiring for a collection that has no independent
lifecycle (it is always read/written with its parent log).

The flat scalar aggregates are **derived from `sets` and kept on every write** —
`sets_completed=len(sets)`, `reps_completed=max(reps)`, `weight_kg=max(weight_kg)` —
so `propagateExerciseToSchedule`, stats, and history keep working unchanged. When
`sets` is absent the writer preserves today's flat behavior. Implemented in
`web/domain/workout.js` (`createLog`/`updateLog`/`validateExerciseValues`/`toLogResponse`)
and the shared per-set UI in `web/static/js/features/workout/sessions.js`.

`set_type` is stored but **not yet acted on** — warm-up exclusion from PR/volume math
is Phase 3; storing it now avoids a later migration of historical logs.

**Bot mode is untouched.** The shared `sessions.js` emits `sets` *alongside* the flat
fields; the Go log handlers (`AddExerciseToSession` / `UpdateExerciseLog`) decode with
plain `json.NewDecoder(...).Decode` (no `DisallowUnknownFields`), so the unknown `sets`
key is silently ignored and the flat fields still drive bot storage — no gate, no
migration. The bot-mode Go schema change (per-set columns) remains a deferred
follow-up.

## Progression rules (Phase 4) — implemented

Opt-in per-exercise progression is stored **cloud-first** as an additive
`progression_rule` field on the existing `workoutexercise` record body —
`{type:'none'|'linear'|'double', increment_kg>=0, min_reps?, max_reps?}`. Like
Phase 1's `sets`, the record is an opaque vault blob, so this needs **no**
migration / sync / route / MCP-catalog change. Validated by
`normalizeProgressionRule()` (defaults to `none`) and round-tripped through
`createExercise` / `updateExercise` / `toExerciseResponse` (emitted only when
`type !== 'none'`), all in `web/domain/workout.js`.

**The `propagate` upgrade.** `propagateExerciseToSchedule` — the existing "mirror
last performance" write-back — now branches on the rule after a completed log:

- `none` → today's mirror behavior (unchanged).
- `linear` → if every non-warmup set met `target_reps_max` and set count `>=
  target_sets`, bump `target_weight_kg += increment_kg`.
- `double` → within `[min_reps, max_reps]`: climb reps toward `max_reps`; once all
  work sets hit `max_reps`, bump `target_weight_kg += increment_kg` and reset reps
  to `min_reps`.

The completed log's per-set `sets` array is threaded in from `createLog`/`updateLog`
so the rule inspects real per-set reps; it falls back to `reps_completed` (max) when
`sets` is absent. Compute lives in `propagate` (not `completeSession`) because
`propagate` already loads the exercise and runs per-completed-log.

**Editor UI.** The exercise modal (`web/static/index.html`) carries a
`<select id="workout-exercise-progression">` + increment input, wired through the
three touch points in `web/static/js/features/workout/exercises.js`
(`showEditExerciseModal` set, `showAddExerciseModal` clear, `saveExercise` read).

**Dry-run preview (optional, done).** `progressionPreview` in `web/domain/workout.js`
runs the same rule math over each exercise's latest completed log **without writing**,
exposed as the cloud-only MCP op `workouts.progression_preview` (GET
`/api/workout/progression-preview`) via the med-eas.56 seam
(`web/cloud/js/mcp-catalog.cloud-extra.js` + `apishim.js createApiRouter`), so
`mcp-catalog.generated.js` stays untouched (drift-safe).

Presets are **goal-agnostic**: they progress on hitting the numeric rep target only.
Goal-differentiated presets and RIR-gating (progress only when near failure) are the
goal-aware sub-epic (`med-qj4.6.3`), not this phase.

## Success criteria (the spine, done)

A cloud user can: log each set (weight × reps, mark warm-ups, optional RPE); see a
correct estimated 1RM and get a PR cue when they beat a record; open a per-exercise
graph of strength over time; trust that editing a routine never rewrites a past
workout; and optionally have the next target suggested. No social, no watch, no DSL.
