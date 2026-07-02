# Gamification 8 — Health Score & Habit Strength (legible, backfill-proof scores)

## Overview

Phase C of the gamification redesign (depends on Phases A+B,
`2026-07-02-gamification-6-sync-honesty.md` / `...-7-concentric-rings.md`). "34 HP
today" is illegible — the user can't tell if it's good or what to do about it. This
plan adds the two score layers the research points at, both **pure functions of the
event log** (so backup imports just make them more accurate, never break them):

1. **Health Score 0–100** (Oura/Whoop pattern) — the new headline number. Computed
   from *readings*, not logging acts: named contributors (BP in-range, sleep
   duration + regularity, resting HR vs personal baseline, weight stability,
   medication adherence PDC), each shown as its own mini-bar, 14-day window compared
   against a ~60-day personal baseline. **Missing contributors are omitted and the
   weights renormalized** — a gap dilutes, never zeroes.
2. **Habit strength per pillar** (Loop Habit Tracker EMA) — replaces the weekly
   streak as the continuity mechanic: `m = 0.5^(√f/13)`,
   `score_d = score_{d-1}·m + checkmark_d·(1−m)` (13-day half-life at daily
   frequency). A miss lowers strength, never resets it; flexible frequency
   (movement at 3×/week); recomputes correctly on backfill by construction.

HP + levels + the ledger stay untouched (levels remain the insight-ladder fuel);
what changes is the *presentation layer of motivation*: Health Score becomes the
Today headline, strengths replace the streak card on Journey.

## Context (from discovery)

- Pure engine: `internal/domain/gamification/scoring/scoring.go` — all constants in
  `Config`/`DefaultConfig()` (`:199-253`); trapezoid `RangeMembership` reusable for
  contributor in-range math.
- Read models: `internal/domain/gamification/summary.go` (`GetSummary`),
  `journey.go` (`GetJourney`); per-domain loaders with trailing windows already
  exist in `scoreday.go` (weight uses a 14-day trailing average, movement a trailing
  week; extend the same pattern to 14/60-day windows).
- Derived streak from Phase A lives in `streak.go` (`deriveStreak`); this plan
  demotes it from a Journey card to a footnote (or removes it — decide at
  implementation, keep the derived function either way).
- Handlers pass service JSON through verbatim (`internal/server/gamification_handlers.go`);
  bootstrap embeds `GetSummary` (`internal/server/settings_handlers.go:443-499`);
  shapes frozen additive-only in `docs/api.md#gamification`; MCP `ResponseExample`s
  in `internal/mcp/registry/operations_gamification.go`.
- Frontend consumers: Today tile `web/static/js/features/today.js`, Journey
  `web/static/js/features/journey.js` (streak card, "How this works" explainer card),
  both render token-only.
- Adherence PDC precedent: weekly adherence ≥80% already described in
  `docs/gamification.md` §6.1; the miss-inference rule (PENDING past its slot = miss)
  is documented in §14.1 and implemented in the adherence loader.

## Development Approach

- **Testing approach**: NO unit tests. One service-level integration test guarding
  the contributor-renormalization contract (the "missing data must dilute, not
  zero" guarantee) — through the real service + seeded SQLite store.
- All JSON additive; old clients ignore new fields.
- No new tables: both scores are derived on read (composes with the existing
  read-time rescore); no transactional state — that is the entire point.
- Constants (half-life 13d, windows 14/60, contributor weights) live in `Config`
  like every other tunable.
- **CRITICAL: update this plan file when scope changes during implementation.**

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: one — seed only BP + adherence data (no sleep/HR/weight),
  assert Health Score is computed from present contributors with renormalized
  weights and absent contributors are listed as `missing`, not scored 0. Guards the
  real cross-component boundary (loaders → composite → API shape).
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps**: engine math, service read models, API/MCP surface,
  frontend swap, docs.
- **Post-Completion**: manual sanity of score plausibility on real data.

## Implementation Steps

### Task 1: Engine — habit-strength EMA and health-score composite (pure, DB-free)

- [x] `internal/domain/gamification/scoring/`: add `HabitStrength(checkmarks []float64, frequency float64) float64`
      — EMA fold, `m = 0.5^(√f/13)`; checkmarks are fractional 0..1 (a day's
      adherence ratio is a valid checkmark), oldest-first; document the Loop
      provenance + half-life constant in `Config`
      (deviation: signature takes a trailing `cfg Config` param, matching every
      other scorer in the file, so `HalfLifeDays` is a real tunable rather than
      a hardcoded literal)
- [x] add `HealthScoreInput` / `HealthScoreResult` types: named contributors, each
      with `Value` (0..1 membership vs band or vs baseline), `Weight`, `Present bool`;
      composite = weighted mean over present contributors only (renormalize), scaled
      to 0–100; result carries per-contributor breakdown + the list of missing ones
      (`ComputeHealthScore`; `Score` is `*float64`, nil below `HealthScoreMinContributors`)
- [x] contributor definitions reuse `RangeMembership` and the baseline-vs-absolute
      "kinder of the two" pattern already used by `ScoreVitalsAuto`
      (`HealthContributorBP/Sleep/RestingHR/Weight/Adherence`; exported
      `BaselineRelative`/`RampUp`, formerly unexported, so both this package and
      the Task 2 service can reuse them)
- [x] weights + windows (14d recent vs 60d baseline) in `Config`/`DefaultConfig()`

### Task 2: Service — compute both scores on read

- [x] `internal/domain/gamification/wellbeing.go` (new): build contributor inputs
      from the existing per-domain repos over trailing windows — BP in-range share,
      sleep duration/regularity, resting HR vs 60d baseline, weight stability vs
      trailing average, adherence PDC (14d, reusing the miss-inference rule)
- [x] pillar strengths: meds (checkmark = day's taken/expected ratio, f=1), movement
      (workout-day checkmark, f=3/7), measurement (any BP/weight/food log that day,
      f=1) — fed from the same loaders
- [x] extend `GetSummary` / `GetJourney` results additively:
      `health_score {value, contributors[{key,label,score,weight,missing}], missing[]}`
      and `strengths [{key,label,value,frequency}]`
      (deviation: `GetJourney` gets these fields for free via its embedded
      `Summary` — no separate wiring needed there)
- [x] integration test per Testing Strategy (renormalization contract)

### Task 3: API + MCP surface

- [x] handlers pass the new fields through (no handler logic — Critical Rule 1);
      bootstrap summary carries them for free
      (deviation: no code change needed — `handleGamificationSummary`/`handleGamificationJourney`
      already `writeJSON` the whole `Summary`/`Journey` struct verbatim, and Task 2
      added `HealthScore`/`Strengths` directly to `Summary`, which `Journey` embeds
      and `/api/bootstrap` already serializes; the pass-through was automatic)
- [x] update frozen shapes in `docs/api.md#gamification`; refresh `ResponseExample`s
      in `internal/mcp/registry/operations_gamification.go` (coverage guard stays
      green — no new routes)

### Task 4: Frontend — Health Score headline + strengths card

- [x] Today tile (`today.js`): headline becomes the Health Score (0–100 with a
      qualitative band word, e.g. Good/Fair — token-colored), replacing the raw
      "N HP today" number; rings/legend/"your move" from Phases A+B unchanged
      (deviation: the slim `/api/gamification/rings` payload `today.js` reads
      didn't carry `health_score` — Task 3 only wired it onto `Summary`/`Journey`.
      Extended `ringsView` in `internal/server/gamification_handlers.go` with an
      additive `health_score` field passed through verbatim from `sum.HealthScore`,
      same pattern as `enabled`/`level`/`today_hp`; mirrored into the
      `auth-bootstrap.js` bootstrap→`gamification_rings` cache projection so a
      cold relaunch also has it. Updated the `gamification.rings` MCP
      ResponseSummary/Example and the `docs/api.md` rings row to document the
      new field.)
- [x] Journey (`journey.js`): new "Health Score" card — big number + one mini-bar
      per contributor (label, bar, "no data" state for missing ones); replaces
      nothing, sits above the rings card
- [x] Journey: streak card becomes the "Strengths" card — one gauge per pillar
      (meds / movement / measurement), derived streak demoted to a single footnote
      line inside it (e.g. "12 weeks active") or dropped if it reads as noise
      (deviation: footnote reads "N-day streak · best M" — the plan's "12 weeks"
      example doesn't match the backend's day-granularity `current_streak`/
      `longest_streak` fields, so kept the unit consistent with the real data)
- [x] update the "How this works" explainer card: HP→levels stays, streak paragraph
      replaced by strength + health-score one-liners in plain language
      (deviation: the explainer never had a streak term to begin with — added
      "Health Score" and "Strengths" terms in plain language instead of replacing
      a nonexistent one)

### Task 5: Verify acceptance criteria

- [x] verify Overview requirements: score legible, contributors named, missing data
      renormalized, strengths EMA live, backfill import shifts both scores without
      any state reset
      (verified: `ComputeHealthScore`/`HabitStrength` in `scoring.go` are pure
      functions of their inputs with no persisted state; `HealthScoreMinContributors`
      guards the null-below-threshold case; `TestGetSummary_HealthScore_RenormalizesOverPresentContributorsOnly`
      in `wellbeing_test.go` exercises the renormalization contract end-to-end
      through the real service; both scores compute on read per Task 2, so a
      backfill import re-enters the math on next read with no reset)
- [x] `go test ./...` passes
- [x] `pnpm test` passes
- [x] `golangci-lint run` + `gofmt` clean on touched packages
      (gofmt flagged only pre-existing unrelated files outside this plan's
      touched-file set; golangci-lint reports 0 issues on
      `internal/domain/gamification/...`, `internal/mcp/registry/...`,
      `internal/server/...`, `internal/store/gamification/...`)

### Task 6: Update documentation

- [x] `docs/gamification.md`: new §14.6 — the two score layers, formulas, constants,
      and the "pure function of the log" invariant; mark the weekly-streak mechanic
      as superseded by strengths (§9 note)
      (deviation: landed as §14.7, not §14.6 — Plan 7's concentric-rings write-up
      already claimed §14.6 by the time this task ran; added a superseded-by note
      in §9 pointing at §14.7)
- [x] `docs/api.md#gamification`: new fields documented
      (already satisfied — Task 3's `handleGamificationSummary`/`journey` deviation
      note and Task 4's `rings` deviation both updated `docs/api.md#gamification`
      inline as they shipped: `health_score` and `strengths` are documented on the
      summary/journey/rings rows)

## Technical Details

- **Loop EMA provenance**: uhabits `Score.kt` — `multiplier = 0.5^(√freq/13)`;
  daily habit ≈ 0.9481/day; ~1 month daily completion → ~0.8, ~3 months → ~0.99.
  Fractional checkmarks are supported by the fold naturally.
- **Renormalization**: `score = 100 · Σ(w_i·v_i)/Σ(w_i)` over present contributors;
  if fewer than 2 contributors are present, report the score as `null` ("not enough
  data") rather than a misleadingly confident number.
- **Windows**: recent = 14d, baseline = 60d (Oura pattern); both trailing from the
  request day, so late imports re-enter the math automatically on next read.
- Everything computes inside the existing read path (`ensureGamificationFresh` →
  read models); measured cost is a handful of window queries on single-user SQLite.
  (ponytail: compute-on-read, add caching only if a read ever gets slow.)

## Post-Completion

**Manual verification:**
- Sanity-check the score against real data: a week with in-range BP + good sleep
  should read clearly higher than a rough week; run a backup import and watch the
  score/strengths shift without any reset artifacts.
- Confirm the Today headline reads well at a glance on the emulator.
