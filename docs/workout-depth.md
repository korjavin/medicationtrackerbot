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

### Phase 3 — Analysis: estimated 1RM, PRs, per-exercise graphs (`med-qj4.3`) — implemented

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

**As implemented (cloud-first; bot legacy):**
- **Estimated 1RM** — Epley `1RM = weight × (1 + reps/30)`, computed on read; a set
  over ~10–12 reps degrades the estimate, but a low-confidence flag is deferred to
  the goal-aware sub-epic (`med-qj4.6.4`).
- **PR types** — heaviest weight, best est-1RM, best set volume (`weight × reps` in
  one set), best session volume (Σ over a session's non-warmup sets), most reps, and
  per-rep-count set-records (`{<reps>: <weight>}`). **Warm-ups (`set_type==='warmup'`)
  are excluded from every fold.**
- **Compute-on-read, no storage/migration** — sets are immutable; the pure module
  `web/domain/workout-analysis.js` exports `estimated1RM`, `exercisePRs(logs)`, and
  `exerciseSeries(logs)` (per-session best est-1RM / top-weight / volume). Purity is
  enforced by `architecture.domain-purity.test.js`.
- **Per-exercise history read** — `listExerciseLogsByName(name, {limit})` in
  `web/domain/workout.js` filters LOG records by `exercise_name`, joins each log's
  session for `scheduled_date`, and returns newest-first `[{date, sets, session_id}]`.
  Exposed via the router only (a UI read, not an MCP op) as
  `GET /api/workout/exercises/history?name=` in `web/cloud/js/apishim.js`.
- **UI** — `wg-workout-chart` gained `est-1rm` / `top-weight` metrics; a new
  per-exercise detail view (`web/static/js/features/workout/exercise-detail.js`)
  renders the records summary + graphs, and a "PR" cue badge appears on a
  record-beating completed set in the session log card. The static frontend has no
  bundler, so the detail view dynamic-imports `/domain/workout-analysis.js` (served
  in cloud); in bot mode there is no `/domain/`, so the records/PR badge degrade
  silently.

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

## Goal-aware foundation (`med-qj4.6.1`) — implemented

A **`training_goal` dimension** seeds sensible defaults per the repetition-continuum
evidence. The goal is asked at **routine (workout group) creation** —
`{strength | hypertrophy | endurance | general}`, **default `hypertrophy`**.
Exercises **inherit** the routine goal and can **override per-exercise**. The goal is
**stored** (group field + optional per-exercise override) and drives
defaults/emphasis only — it changes **nothing** about how a set is stored.

**Goal → default table** (the science basis, in `web/domain/workout-goals.js`):

| goal | reps_min | reps_max | target_rir | progression preset |
|------|----------|----------|------------|--------------------|
| strength | 3 | 6 | 2 | linear |
| hypertrophy (default) | 8 | 12 | 1 | double |
| endurance | 15 | 25 | 1 | double |
| general | 8 | 12 | — | none |

**Defaults module.** `web/domain/workout-goals.js` is a pure, browser-global-free map
(`GOAL_DEFAULTS`) plus `defaultsForGoal(goal)` (falls back to hypertrophy) and
`normalizeGoal(goal)` (validates against `TRAINING_GOALS`, defaults hypertrophy).
Purity is enforced by `architecture.domain-purity.test.js`. `GOAL_DEFAULTS` /
`defaultsForGoal` are staged for the goja side and the later goal-differentiated
progression/graphs/insight (`med-qj4.6.3/.4/.5`); today only `normalizeGoal` /
`TRAINING_GOALS` have callers (`web/domain/workout.js`). The plain-script editor
cascade can't import ES modules, so it duplicates the table as
`WORKOUT_GOAL_DEFAULTS` in `exercises.js` — the two are hand-synced.

**Storage (additive vault blobs, no migration).** `training_goal` on the
`workoutgroup` record (default hypertrophy) round-trips through `createGroup` /
`updateGroup` / `toGroupResponse`; an optional `training_goal` override on the
`workoutexercise` record round-trips through `createExercise` / `updateExercise` /
`toExerciseResponse` (**emitted only when set** — absent means inherit from the
routine). All in `web/domain/workout.js`, validated via `normalizeGoal`.

**Selectors.** The group modal (`web/static/index.html` +
`web/static/js/features/workout/groups.js`) carries a
`<select id="workout-group-goal">` (Strength/Hypertrophy/Endurance/General), wired
through `showEditGroup` populate, `saveGroup` payload, and add-modal default
(hypertrophy). The exercise modal (`web/static/js/features/workout/exercises.js`) adds
a `<select id="workout-exercise-goal">` with an **"Inherit from routine"** default plus
the four goals, wired through `showEditExerciseModal` / `showAddExerciseModal` /
`saveExercise`.

**Cascade (fill-only).** On goal-selector change — and when the exercise editor opens
with a goal — the effective goal (the override, else the routine's goal) pre-fills the
target **rep-range** (`reps_min`/`reps_max`) and the **progression preset**
(`workout-exercise-progression`) from the editor's `WORKOUT_GOAL_DEFAULTS[effectiveGoal]`
(the hand-synced copy of `GOAL_DEFAULTS`). All fields stay
editable; the cascade only fills defaults, never locks. (RIR is in the defaults table
for the later sub-epics but not surfaced — the exercise editor has no target-RIR field
yet.)

**Bot safety.** The shared editors send `training_goal`; the Go log/group handlers
decode without `DisallowUnknownFields`, so the unknown key is silently ignored (same as
Phase 1's `sets` and Phase 4's `progression_rule`) — no gate, no migration, no
breakage. Goal-differentiated progression *compute* (`med-qj4.6.3`), goal graph
emphasis (`med-qj4.6.4`), and the effort insight (`med-qj4.6.5`) are later beads.

## Success criteria (the spine, done)

A cloud user can: log each set (weight × reps, mark warm-ups, optional RPE); see a
correct estimated 1RM and get a PR cue when they beat a record; open a per-exercise
graph of strength over time; trust that editing a routine never rewrites a past
workout; and optionally have the next target suggested. No social, no watch, no DSL.

## Science basis — loading, effort, and goals (med-qj4.5)

Source: Schoenfeld, Grgic, Van Every, Plotkin (2021), "Loading Recommendations for
Muscle Strength, Hypertrophy, and Local Endurance: A Re-Examination of the Repetition
Continuum." *Sports* 9(2):32. DOI 10.3390/sports9020032 · PMC7927075 · PubMed 33671664.

**What the evidence says (departing from the classic continuum):**
- **Strength is load-dependent** — heavy (>60% 1RM) beats light for 1RM (meta ES ≈ 0.58),
  but the advantage largely vanishes on non-specific tests (isometric ES ≈ 0.16) — so
  it's substantially a *specificity* effect: train heavy, in the movement you want strong.
- **Hypertrophy is load-INdependent across ~30–85%+ 1RM** — high-vs-low-load difference
  is trivial (ES ≈ 0.03) **provided sets are taken to/near failure**. Below ~30% 1RM gains
  drop (≈half at 20%). Moderate (8–12) is the *efficient* default, not a magic zone.
- **Local endurance** — evidence weak/equivocal; the classic light=endurance mapping
  mostly isn't supported on relative tests.
- **Elevated above load:** proximity-to-failure (RIR/RPE), volume (hard sets, ~linear for
  hypertrophy), specificity, individual variation. One line: *pick load by
  preference/joint-tolerance/time, drive sets near failure, accumulate volume.*

**Default rep/load/effort by goal** (seed defaults behind `training_goal`):

| Goal | Reps | %1RM | Sets | Target RIR |
|------|------|------|------|-----------|
| Strength | 3–6 | 80–90% | 3–5 | RIR 1–3 |
| Hypertrophy (default) | 6–15 (anchor 8–12) | ~65–80% | 3–4 | RIR 0–2 (near failure) |
| Endurance | 15–25+ | ~40–60% | 2–3 | RIR 0–2 on the top set |

**How this becomes product** (the **goal-aware sub-epic, med-qj4.6**, layered on the
4-phase core): a `training_goal {strength|hypertrophy|endurance|general}` dimension —
**asked at routine (group) creation, default Hypertrophy, inherited by exercises with a
per-exercise override** — drives default rep-range + target RIR + progression preset +
graph emphasis + a near-failure effort insight. It changes defaults/emphasis only,
never how a set is stored. Progression is **RIR-gated**: a load bump fires only when
`reps ≥ target AND RIR ≤ threshold` — hitting reps far from failure triggers the effort
insight, not more weight. Full progression scripting (a DSL) remains out of scope.
