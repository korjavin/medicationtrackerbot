# Gamification 11 — Gauge Trends (weight velocity & acceleration, BP as a long game)

> **Run order: after plan 10 (levers & gauges restructure); before plans 12/13.**

## Overview

The gauge half of the levers/gauges model. Gauges (weight, BP, resting HR) are
what the body reports back — delayed and noisy. Today the engine still grades
them **daily** (BP band membership, weight stability band, RHR/SpO₂ bands): one
bad morning visibly earns less, which is exactly the demotivator we're removing.
One or two bad days must be mathematically invisible.

1. **Weight becomes trend velocity + acceleration.** Exponentially-smoothed
   trend line (Hacker's Diet style, ~10%/day EMA — a single heavy day cannot
   move it), then **velocity** vs the user's goal pace ("−0.4%/week · on pace")
   and **acceleration** ("speeding up / holding / slowing") as the headline.
   This finally wires the engine's dormant goal-mode safe-pace scoring — as the
   *only* weight scoring, weekly.
2. **BP becomes a rolling in-range share.** 14-day and 30-day share of readings
   in the personal band vs the 60-day baseline. Two bad days shift a 30-day
   share by a few percent — visible as data, irrelevant as judgment.
3. **Resting HR becomes a trend vs baseline.** SpO₂ drops out of scoring
   (safety-alert data, not a game metric).
4. **The gauge HP economy moves from daily to weekly.** Daily outcome awards for
   BP, weight, resting HR, SpO₂ are removed; one idempotent weekly award per
   gauge replaces them (trend on pace / share held or improved). Integrity
   floors for logging stay daily — honesty is still always rewarded.
5. **A "Gauges" panel on Journey** shows the three trends with sparklines and a
   "why is this moving? → your insights" link into the tier-3/4 cards — the
   attribution loop that makes lever-pulling meaningful.

Everything remains a pure function of the log: late backup imports re-enter the
EMAs and shares automatically.

## Context (from discovery)

- Daily gauge awards to remove: `ScoreBP` (`internal/domain/gamification/scoring/scoring.go:~354`,
  `BPOutcomeMaxHP=10`), `ScoreWeight` (`:~536`, maintenance band, `WeightOutcomeMaxHP=8`),
  `ScoreVitalsAuto` resting-HR/SpO₂ awards (`:~391`; stress already removed in
  plan 10). Their integrity floors stay.
- Dormant goal-mode: safe-pace weight scoring exists in the engine (§6.7,
  ≤1%/week) but was never driven; the app already has a weight-goal surface
  (Settings/targets; `internal/store/weight`).
- Ledger idempotency: UNIQUE `(user_id, day_unix, ring, source_metric, kind)`
  (`internal/store/gamification`) — a weekly award written at the week's last
  day is naturally idempotent under rescore.
- Rescore plumbing: `RescoreInstants` (`rescore_imports.go`) dedupes to UTC days;
  read-path rescores yesterday+today (`gamification_handlers.go:29-38`). Weekly
  awards need affected **week-end days** added to both paths.
- Baseline/window machinery: `wellbeing.go` already computes 14d-vs-60d
  contributor math; week indexing: `streak.go` `weekIndex` (must agree with the
  weekly-review week anchor).
- Journey screen: `web/static/js/features/journey.js`; insights cards (tier 3/4)
  are the link target; sparkline pattern exists (points-history sparkline).
- Routes: gamification block `internal/server/server.go`; registry
  `operations_gamification.go`; coverage guard.

## Development Approach

- **Testing approach**: NO unit tests. One service-level integration test
  guarding the weekly-award idempotency + trend math contract (see Task 5).
- All thresholds/constants in `Config` (EMA α, pace tolerance, acceleration
  deadband, share windows, weekly HP maxima).
- No re-backfill of history: past daily gauge awards stay in the ledger as
  scored (levels never decrease; mixed-rule history documented in plan 10).
- Additive JSON; the gauges panel is a new read, existing shapes untouched.
- **CRITICAL: update this plan file when scope changes during implementation.**

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: one — seeded weight series with a known downward trend
  + goal: assert velocity sign/pace status and acceleration state; seeded BP
  with a bad pair of days: assert the 30-day share barely moves; score a week,
  late-import data into it, rescore → weekly award updated in place, not
  duplicated.
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps**: trend models, HP economy switch, route, panel, docs.
- **Post-Completion**: plausibility on real data; a bad-day sanity check.

## Implementation Steps

### Task 1: Domain — gauge trend models

- [x] `internal/domain/gamification/gauges.go` (new): weight — EMA over trailing
      ~120 days (α=0.10/day, gaps carried forward), velocity = smoothed change
      over the last 14 days in %bodyweight/week, pace status vs the user's goal
      direction+rate (no goal → trend-only, no judgment), acceleration =
      velocity now vs 14 days ago with a deadband → speeding/holding/slowing
- [x] BP — in-range share (existing effective band) over 14d and 30d vs the 60d
      baseline share, with reading counts; resting HR — 14d mean vs 60d baseline
      delta
- [x] every gauge carries honest `insufficient_data` below minimum sample counts
      (Config); all computed on read, no new tables
- [x] `GetGauges` on the `GamificationService` interface, feature-gated like all
      reads

### Task 2: HP economy — daily gauge awards → weekly gauge awards

- [ ] remove daily outcome awards: `ScoreBP` outcome, `ScoreWeight` outcome,
      `ScoreVitalsAuto` resting-HR + SpO₂ outcomes; keep every integrity floor
      (BP reading, weigh-in) exactly as is
- [ ] add weekly awards written at each week's last day (`day_unix` = week-end,
      new `KindOutcome` rows with weekly source metrics, e.g.
      `weight_trend_week`, `bp_share_week`): weight — full HP when velocity is
      on safe pace toward the goal (or stable in maintenance), trapezoid falloff
      for too-fast/wrong-direction (never negative, as always); BP — HP scaled
      by the week's contribution to holding/improving the 30d share
- [ ] wire week-end days into rescore: `RescoreInstants` adds the week-end day
      of every affected week; the read-path recent-window rescore includes the
      current week's end day (an in-progress week scores its partial data —
      idempotent rewrite as the week fills)
- [ ] check `ringScores()`/`goals.go` for any leftover daily-gauge references
      (vitals no longer produce a ring after plan 10 — this task only cleans the
      award streams)

### Task 3: HTTP route + MCP registration

- [ ] `GET /api/gamification/gauges` (verbatim pass-through) in the gamification
      route block; registry op `gamification.gauges` with `ResponseExample`;
      `docs/api.md#gamification` updated

### Task 4: Journey — Gauges panel

- [ ] `journey.js`: "Gauges" card (below Health Score, above rings): weight —
      sparkline of the smoothed trend + "−0.4%/week · on pace · speeding up"
      line; BP — "in range 82% of last 30 days · baseline 76%"; resting HR —
      "62 avg · 3 below your baseline"; `insufficient_data` states in plain
      language; `cachedFetch` + `gamification` tag + `OfflineNoCacheError`
      empty state
- [ ] "why is this moving? → your insights" link scrolling to the tier-3/4
      insight cards
- [ ] tone: numbers and direction words only, token-neutral colors — a slowing
      trend is an observation, never red

### Task 5: Verify acceptance criteria

- [ ] integration test per Testing Strategy
- [ ] verify Overview requirements: no daily gauge HP anywhere, weekly awards
      idempotent under late import, panel honest under sparse data
- [ ] `go test ./...` passes (incl. MCP coverage guard)
- [ ] `pnpm test` passes
- [ ] `golangci-lint run` + `gofmt` clean

### Task 6: Update documentation

- [ ] `docs/gamification.md`: §6.2/6.3/6.7 rewritten to weekly gauge scoring
      (trend velocity/acceleration, rolling shares); §14.8 records the HP
      economy change and the week-end-day rescore mechanism
- [ ] `docs/api.md`: gauges endpoint + weekly award metrics

## Technical Details

- EMA: `trend_d = trend_{d-1} + α·(weight_d − trend_{d-1})`, α=0.10; velocity
  from the trend line, not raw weights; %bodyweight units so pace compares to
  the safe ceiling (≤1%/week) and the user's goal rate.
- Acceleration deadband (expressed as velocity delta over 14d) so "holding" is
  the default state — flapping between speeding/slowing on noise would
  reintroduce micro-anxiety.
- Weekly award day: ISO week (Mon–Sun) end in the user's tz, same `weekIndex`
  anchor as the derived streak and plan 12's review — one definition of "week"
  across the system.
- SpO₂: keep the dangerous-reading alert path untouched (safety is not a game
  mechanic, principle §6.2); it simply earns no HP.
- Health Score is unchanged by this plan (its contributors already use windowed
  shares/baselines); only the *award* streams move from daily to weekly.

## Post-Completion

**Manual verification:**
- Real data: weight headline matches intuition (direction, pace vs goal);
  deliberately imagine the worst BP day — confirm nothing on any surface gets
  worse in a way you can feel; weekly award appears once per week and updates
  in place after a backup import.
