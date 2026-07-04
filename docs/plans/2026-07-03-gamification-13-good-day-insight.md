# Gamification 13 — Second Insight: Your Good-Day Model (tier 4)

> **Run order: last — after plans 10 (levers & gauges), 11 (gauge trends), and
> 12 (weekly review).** The behavior candidates are the plan-10 levers; under
> the levers/gauges model this insight is the attribution engine — the proof
> that *your* levers move *your* gauges.

## Overview

Follows plan 9, which shipped the sleep→BP insight and established the
honesty-gate + card template. The insight ladder's tier 4 — "your good-day
model: which behaviors most predict *your* in-range days" — still reads "soon".
This plan ships it using the plan-9 template:

> "On days after a workout, your morning BP was in range 78% of the time vs 55%
> without (21 / 34 days)."

A deliberately simple, explainable association scan: define a "good day", compare
its rate on days with vs without each candidate behavior (previous-day behavior →
next-day outcome, same temporal framing as the sleep insight), report only
associations that pass the honesty gates. No regression, no ML, no causal claims —
the copy says "was in range more often", never "because".

This completes the shipped insight ladder (tiers 1–4 all real): the
behavior → HP → level → insight loop is now closed at every rung the UI shows.

## Context (from discovery)

- Template to follow: `internal/domain/gamification/insights.go` (plan 9) — pairing
  logic, honesty gates (min pairs, noise floor), status shapes
  (`ok`/`no_effect`/`insufficient_data`/`locked`), Config-held thresholds, tz-aware
  morning cutoff via the narrow `TZStore` seam.
- Tier gating: `InsightTierForLevel` (`internal/domain/gamification/scoring/scoring.go:614`)
  — tier 4 unlocks at level 7; `unlocked_tiers` already flows to the Journey.
- Existing insights surface: `GET /api/gamification/insights`
  (`gamification_handlers.go`, registry op `gamification.insights`) — this plan
  extends its response **additively** with a `good_day` key; no new route.
- Journey ladder: `web/static/js/features/journey.js` `renderLadder` +
  `hasDestination` pattern; tier-3 insight card from plan 9 is the rendering
  template (same `cachedFetch`, same three-state copy discipline).
- Day-level inputs all exist in the store/loaders: BP readings (`internal/store/bp`),
  intake log + miss inference (adherence loader in `scoreday.go`), workout
  completions (`internal/store/workout`), sleep rows with wake-day + bedtime
  (`internal/store/vitals`), steps/day-stats.
- Effective per-user bands (BP band, bedtime window, steps band) come from the
  merged config (`targets.go` overlay onto `DefaultConfig()`), same as scoring.

## Development Approach

- **Testing approach**: NO unit tests. One service-level integration test guarding
  the association contract (seeded data with a planted association → detected with
  correct rates/counts; sparse data → `insufficient_data`).
- Additive JSON only; all thresholds are `Config` constants.
- Computed on read, no new tables (pure function of the log).
- Candidate behaviors are a fixed, small, hand-picked set — this is a scan over
  four booleans, not a correlation framework. (ponytail: framework only if a third
  insight ever wants different math.)
- **CRITICAL: update this plan file when scope changes during implementation.**

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: one, per Development Approach.
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps**: domain computation, additive API, Journey tier-4 card,
  docs.
- **Post-Completion**: plausibility check on real + demo data.

## Implementation Steps

### Task 1: Domain — good-day association scan

- [x] extend `internal/domain/gamification/insights.go` (or sibling
      `insights_goodday.go`): over the trailing 90 days, mark each day as a
      **good day** if it has ≥1 BP reading and its mean systolic sits in the
      user's effective band (the app's primary outcome; days without any BP
      reading are excluded from the denominator, not counted as bad)
- [x] candidate behaviors evaluated on the **previous** day (behavior yesterday →
      good day today), aligned to the plan-10 levers: completed a workout;
      **bedtime in window** (the night bridging into the outcome day — reuse the
      plan-10 bedtime-membership predicate, NOT sleep duration, which is a
      gauge); steps in band; all expected doses taken on time (reuse the
      adherence loader's miss inference — adherence is demoted from the daily
      loop but stays a valid candidate here: the scan may confirm it matters, or
      that it doesn't)
- [x] per behavior: rate of good days with vs without, difference in percentage
      points, `n_with` / `n_without`
- [x] honesty gates (Config constants): ≥10 days in *each* arm per behavior, else
      that behavior is `insufficient_data`; report a behavior as a finding only if
      the rate difference ≥ 15 pp (noise floor); order findings by difference,
      cap at top 3; all behaviors gated/quiet → overall `insufficient_data` or
      `no_effect` with counts (both are honest results and must render as such)
- [x] result shape (additive under a `good_day` key in the existing `GetInsights`
      payload): `{status, window_days, good_day_definition, findings:[{behavior,
      rate_with, rate_without, delta_pp, n_with, n_without}], insufficient:[...]}`;
      tier gate: requires `InsightTier ≥ 4` (level 7), below → `{locked:true,
      unlocks_at_level:7}` — same depth-not-data gating as tier 3
- [x] integration test: seed 90 days where workout-preceded days carry in-band BP
      at a markedly higher rate → assert the finding's sign/rates/counts; seed too
      few workout days → assert that behavior lands in `insufficient`

### Task 2: API surface (no new route)

- [x] `GET /api/gamification/insights` response gains the `good_day` key (verbatim
      pass-through — no handler changes beyond none); update the
      `ResponseExample` for `gamification.insights` in
      `operations_gamification.go` to show both insights
- [x] document the extended shape in `docs/api.md#gamification`

### Task 3: Journey — tier-4 destination card

- [ ] `journey.js`: tier 4 becomes `hasDestination` → "Unlocked → view" revealing
      the good-day card (same inline-expand pattern as tier 3; no new nav slot)
- [ ] card copy, three states in plain language: findings ("On days after a
      workout, morning BP in range 78% vs 55% · 21/34 days" — one line per
      finding, max 3), no-effect ("No single habit stands out yet — your good
      days look evenly spread."), insufficient-data ("Not enough contrast yet ·
      keep logging — 6 of 10 workout days needed")
- [ ] a `good_day_definition` sub-line states what "good day" means in the user's
      own numbers ("in range = systolic 90–120"), so the model is never a black
      box (the Oura contributor-transparency lesson)
- [ ] locked state (level <7) keeps the honest "Unlocks at Lvl 7" row; ladder no
      longer contains any "soon" tier

### Task 4: Verify acceptance criteria

- [ ] verify Overview requirements: tier 4 real, all three states honest,
      level-gated, additive API, no causal language anywhere in copy
- [ ] `go test ./...` passes (incl. MCP coverage guard)
- [ ] `pnpm test` passes
- [ ] `golangci-lint run` + `gofmt` clean

### Task 5: Update documentation

- [ ] `docs/gamification.md` §8: mark tier 4 shipped; note the fixed
      candidate-behavior set and the gates; state that the ladder is now fully
      real and future insights are additions, not unlocks
- [ ] `docs/api.md`: extended insights shape

## Technical Details

- Temporal framing: behavior on local day D−1 (workout/doses/steps) or the night
  bridging D−1→D (bedtime, wake-day D) predicts the outcome on day D — consistent
  with the tier-3 insight so the two cards read as one system.
- Also surface the findings from the plan-11 Gauges panel ("why is this
  moving? → your insights" already links here) — no extra work beyond the
  anchor existing.
- Day boundaries: same tz resolution as plan 9 (`TZStore`, UTC fallback).
- Behaviors are intentionally binary; bedtime/steps reuse the effective
  windows/bands (incl. the plan-10 `bedtime` target) so a user's custom targets
  flow into the model automatically.
- Thresholds: min 10 per arm, 15 pp noise floor, 90-day window, top 3 findings —
  all `Config` constants next to the plan-9 ones.

## Post-Completion

**Manual verification:**
- Run against the real database once level 7 is reached (or temporarily lower the
  gate locally): findings plausible, copy non-alarmist, definition line correct
  against the user's actual band.
- Demo-mode check: the seeded demo data (correlated workouts/sleep/BP trends)
  should produce at least one presentable finding for demos.
