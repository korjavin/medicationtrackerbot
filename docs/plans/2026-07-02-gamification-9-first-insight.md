# Gamification 9 — First Real Insight (sleep → next-morning BP)

## Overview

Phase D of the gamification redesign (depends on Phase C,
`2026-07-02-gamification-8-health-score-strength.md`, for the Journey layout; data
requirements are independent). The design's keystone promise — "the reward for
healthy behavior is self-knowledge" — is currently unfulfilled: insight-ladder tiers
3–4 say "soon" and the loop never closes. This plan ships the first *real* personal
insight as the tier-3 unlock:

> "Across your last 90 days, nights under X hours preceded a next-morning systolic
> reading ~N mmHg higher (based on M nights)."

Computed from the user's own sleep + BP history — data that already sits in the
store. Honest by construction: if there aren't enough paired nights, the card says
"not enough data yet — keep logging" instead of inventing a number. One genuine
insight is enough to close the behavior → HP → level → insight loop for the first
time.

## Context (from discovery)

- Insight gating exists: `InsightTierForLevel` (`internal/domain/gamification/scoring/scoring.go:614`),
  tiers unlock at L3/L5/L7 (tier 3 = level 5); `unlocked_tiers` already flows to the
  Journey via `GetJourney` (`internal/domain/gamification/journey.go`).
- Ladder rendering + honest destination gating: `web/static/js/features/journey.js`
  `renderLadder` (~278-324), `hasDestination` pattern from plan 5; Phase A wired
  tier 2 to existing charts — tier 3 follows the same pattern with a new card.
- Sleep rows carry duration + a wake-up `Day` (`internal/store/vitals/`); BP readings
  are timestamped (`internal/store/bp/`); the gamification service already holds
  narrow store interfaces to both (`internal/domain/gamification/service.go`,
  loaders in `scoreday.go`).
- New route policy: must be MCP-registered or exempt
  (`internal/mcp/registry/operations_gamification.go`,
  `TestMCPCoverage_AllRoutesEitherRegisteredOrExempt`).
- Route registration: `internal/server/server.go:966-970` (gamification block),
  handlers in `internal/server/gamification_handlers.go` (pass-through only).

## Development Approach

- **Testing approach**: NO unit tests. One service-level integration test guarding
  the insight contract (seeded correlated data → correct sign/magnitude bucket;
  sparse data → explicit insufficient-data result). Real boundary: loaders → pairing
  logic → API shape.
- Simple, explainable statistics only: bucket comparison of means, report `n`. No
  regression models, no causality claims — the card's copy says "preceded", not
  "caused".
- Computed on read, no new tables (pure function of the log — same invariant as
  Phase C).
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

- **Implementation Steps**: domain computation, one route, Journey card, docs.
- **Post-Completion**: plausibility check against real user data.

## Implementation Steps

### Task 1: Domain — sleep→BP insight computation

- [ ] `internal/domain/gamification/insights.go` (new): over the trailing 90 days,
      pair each night's sleep duration with the next morning's first systolic
      reading (before 12:00 in the user's timezone; skip days without a morning
      reading)
- [ ] split pairs into "short nights" (below the user's sleep band floor, default
      <7h from the effective config) vs "in-band nights"; compute mean systolic per
      bucket and the difference
- [ ] honesty gate: require ≥8 pairs in *each* bucket, else return
      `{status:"insufficient_data", pairs_short, pairs_in_band, needed}`; if the
      difference is under a noise floor (e.g. <3 mmHg), return
      `{status:"no_effect"}` with the numbers — "no effect found" is itself an
      insight and must render as one
- [ ] result shape: `{status, short_threshold_hours, delta_systolic, n_short,
      n_in_band, window_days}`; add `GetInsights` to the `GamificationService`
      interface, gated on `gamification_enabled` + `InsightTier ≥ 3` (below tier 3
      return `{locked:true, unlocks_at_level:5}` — gate depth, never raw data,
      per principle #5)
- [ ] integration test: seed 90 days where short nights carry systolic +8 → assert
      status/delta/counts; seed 5 short nights only → assert `insufficient_data`

### Task 2: HTTP route + MCP registration

- [ ] `GET /api/gamification/insights` in `gamification_handlers.go` (verbatim
      pass-through), registered in the server's gamification route block
- [ ] registry op `gamification.insights` with description, `ResponseExample`
      (both a real-effect sample and the insufficient-data sample noted in the
      description) in `operations_gamification.go` — coverage guard stays green
- [ ] document the shape in `docs/api.md#gamification`

### Task 3: Journey — tier-3 destination card

- [ ] `journey.js`: tier 3 becomes `hasDestination` → "Unlocked → view" revealing an
      insight card (inline expand or scroll target on the Journey screen — no new
      nav slot, CLAUDE.md rule 6)
- [ ] card renders all three states in plain language: the effect ("Nights under 7h →
      next-morning systolic ~+8 mmHg · 23 nights"), no-effect ("Your morning BP looks
      steady regardless of sleep length — solid."), and insufficient-data ("Not
      enough paired nights yet · 5 of 8 — keep logging")
- [ ] locked state (level <5) keeps the existing "Unlocks at Lvl 5" row untouched;
      tier 4 stays honest "soon"
- [ ] fetch via `cachedFetch` with an `OfflineNoCacheError` empty state and a
      `gamification` cache tag (local-first read pattern, docs/frontend.md)

### Task 4: Verify acceptance criteria

- [ ] verify Overview requirements: tier 3 unlock is real, honest in all three
      states, gated by level, computed from the user's own log
- [ ] `go test ./...` passes (incl. MCP coverage guard)
- [ ] `pnpm test` passes
- [ ] `golangci-lint run` + `gofmt` clean

### Task 5: Update documentation

- [ ] `docs/gamification.md` §8: mark tier 3 as shipped, describe the honesty gate
      (min pairs, noise floor) as the template for future insights
- [ ] `docs/api.md`: insights endpoint

## Technical Details

- Timezone: "next morning" uses the user's tz history (`internal/store/tz/`) the
  same way daily scoring resolves days — a night credited to wake-up `Day` D pairs
  with the first BP reading on D before noon local.
- Thresholds (min pairs 8, noise floor 3 mmHg, morning cutoff 12:00, window 90d) are
  `Config` constants like every other tunable.
- This is deliberately the *only* insight in the plan: the honesty-gate + card
  pattern is the template; more insights (tier 4 "good-day model") are future plans
  once this one proves the loop. (ponytail: one insight ships the loop; a
  correlation framework does not.)

## Post-Completion

**Manual verification:**
- Run against the real database: check the computed delta is plausible and the copy
  reads as personal and non-alarmist; verify the locked → unlocked transition by
  level.
- Demo-mode check: seeded demo data (which has correlated sleep/BP trends) should
  produce a presentable insight for demos.
