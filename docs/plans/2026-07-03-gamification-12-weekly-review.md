# Gamification 12 — Weekly Review (web card + opt-in bot digest)

> **Run order: after plans 10 (levers & gauges) and 11 (gauge trends).** This
> review is the primary reading cadence for gauges — it consumes plan 11's trend
> models and plan 10's lever rings.

## Overview

Under the levers/gauges model, the weekly review is not a nice-to-have summary —
it is **the cadence at which gauges are meant to be read**. Levers give daily
feedback (rings); gauges answer weekly ("is the weight trend on pace? is the BP
share holding?"). Research groundwork: sustained motivation comes from
competence feedback — visible progress against your own past.

One read model, two presentations:

1. **"Your week" card on the Journey screen** — levers: rings closed per day,
   strength deltas, best day; gauges: weight velocity + acceleration, BP 30-day
   share movement, resting HR drift; Health Score movement week-over-week.
2. **Bot digest** — an on-demand `/week` command, plus an **opt-in** scheduled
   Sunday-evening message with the same content (default OFF — prompts are
   opt-in per design principles #4/#8).

Tone is Gentler-Streak: observation and praise, never "you failed". A week with
no data reads as "a quiet week", not a loss. No new mechanics, no new tables —
pure presentation over already-computed data (the "pure function of the log"
invariant, so backfilled weeks read correctly in retrospect).

## Context (from discovery)

- Read models to draw from: `internal/domain/gamification/summary.go`
  (lever `PeriodRings` after plan 10), `wellbeing.go` (Health Score +
  habit-strength EMA — computable at any anchor date because they are folds over
  the log), `gauges.go` from plan 11 (`GetGauges`: weight velocity/acceleration,
  BP shares, RHR baseline delta), `streak.go` (`deriveStreak`, `weekIndex` —
  the single definition of "week": ISO Mon–Sun in user tz).
- Service seam: `internal/domain/gamification/service.go` — add
  `GetWeeklyReview` to the `GamificationService` interface; handlers/bot call
  only the service (Critical Rule #1).
- HTTP: gamification route block in `internal/server/server.go`, pass-through
  handlers `internal/server/gamification_handlers.go`; every new route needs an
  MCP registry op (`internal/mcp/registry/operations_gamification.go`).
- Bot: `internal/bot/` is a thin channel — parsing + message formatting only;
  follow existing command wiring for `/week`.
- Scheduler: `internal/scheduler/` already runs timed per-user notifications
  (reminders) through the sink; server build sends via Telegram. User timezone
  via `internal/store/tz`.
- Opt-in flag: reuse the generic feature-toggle surface
  (`POST /api/settings/features/{flag}`) the way `gamification_enabled` does;
  new flag `weekly_digest_enabled`, **default 0/OFF** (most flags default ON —
  this one must not; note it in the migration).
- Frontend: Journey `web/static/js/features/journey.js`; `cachedFetch` +
  `gamification` tag; `--wg-*` tokens only.

## Development Approach

- **Testing approach**: NO unit tests. One service-level integration test
  guarding the weekly aggregation contract (seeded two weeks → correct deltas
  and shape).
- Domain returns **structured data**; the bot formats text, the web renders a
  card.
- Additive JSON only; constants (digest hour, week anchor) in `Config`.
- Mobile build: the web card works as-is; the scheduled digest is server-build
  only (bot sink) — do NOT wire `LocalNotificationSink` for it in this plan.
- **CRITICAL: update this plan file when scope changes during implementation.**

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: one — `GetWeeklyReview` through the real service +
  seeded SQLite store: two weeks with a known difference → assert lever counts,
  gauge movement fields, best day, and the empty-week ("quiet week") shape.
- **E2E tests**: none.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps**: domain read model, route+MCP, Journey card, bot
  command, scheduler digest, docs.
- **Post-Completion**: live Sunday-digest observation, tone read-through.

## Implementation Steps

### Task 1: Domain — `GetWeeklyReview` read model

- [x] `internal/domain/gamification/weekly.go` (new): given `now`, resolve the
      current ISO week (Mon–Sun, user tz, `weekIndex`-consistent) and the
      previous week
- [x] **levers section**: per-lever-ring closed-day counts this week vs last,
      days-with-any-HP, best day (most rings closed), strength values now vs 7
      days ago
- [x] **gauges section**: embed plan 11's models — weight velocity + pace status
      + acceleration, BP 30d share now vs a week ago, RHR delta; plus Health
      Score now vs anchored 7 days earlier
- [x] empty-week semantics: zero-HP week returns a valid review with
      `quiet: true`, never an error
- [x] add `GetWeeklyReview` to the service interface, gated on
      `gamification_enabled`
- [x] integration test per Testing Strategy

### Task 2: HTTP route + MCP registration

- [x] `GET /api/gamification/weekly-review` (verbatim pass-through), registered
      in the gamification route block
- [x] registry op `gamification.weekly_review` with description +
      `ResponseExample`
- [x] document the shape in `docs/api.md#gamification`

### Task 3: Journey — "Your week" card

- [x] `journey.js`: collapsible "Your week" card between the Health Score card
      and the Gauges panel; fetch via `cachedFetch` (tag `gamification`,
      `OfflineNoCacheError` → empty state)
- [x] renders: score movement ("Health Score 78 · up 4"), lever line ("Bedtime
      closed 5 of 7 · Movement 4 · Nourishment 6"), gauge lines ("Weight −0.4%/wk
      · on pace · speeding up", "BP in range 82% · up from 76%"), best day
- [x] tone guardrail: neutral-to-positive phrasing only; a down week reads as
      observation ("BP logging was lighter this week"); the quiet week reads as
      "A quiet week — everything picks up where you left off"; no red styling
      for negative deltas

### Task 4: Bot — `/week` command

- [x] register `/week` following the existing bot command pattern; handler calls
      `GetWeeklyReview` and formats the structured data into a short Telegram
      message (thin channel — formatting only), same tone rules
- [x] flag-off / quiet-week / error paths all produce a friendly one-liner,
      never a stack of zeros

### Task 5: Opt-in Sunday digest

- [ ] settings flag `weekly_digest_enabled`, **default OFF** (migration +
      settings accessor), toggleable via the generic
      `POST /api/settings/features/weekly_digest` surface and a Settings UI
      switch next to the gamification toggle
- [ ] scheduler job following the existing reminder pattern: Sunday at a fixed
      local-evening hour (Config, e.g. 19:00 user tz), for users with both
      `gamification_enabled` and `weekly_digest_enabled`, send the formatted
      digest through the bot; server build only
- [ ] digest send is best-effort/logged; a failure never affects scoring or
      other reminders; no retry queue (ponytail: it's a weekly nicety, next week
      comes)

### Task 6: Verify acceptance criteria

- [ ] verify Overview requirements: card + `/week` + opt-in digest, lever/gauge
      structure, tone rules, quiet-week handling, default-OFF digest
- [ ] `go test ./...` passes (incl. MCP coverage guard); mobile build
      `go build -tags mobile ./...` still compiles (digest behind server wiring)
- [ ] `pnpm test` passes
- [ ] `golangci-lint run` + `gofmt` clean

### Task 7: Update documentation

- [ ] `docs/gamification.md`: §14.7 — weekly review as the gauge-reading
      cadence, surfaces, tone rules, digest opt-in
- [ ] `docs/api.md`: weekly-review endpoint; no new env vars (Config constants
      suffice)

## Technical Details

- Week anchor: ISO Monday-start weeks in the user's timezone, matching
  `weekIndex` and plan 11's weekly-award day — one definition of "week"
  everywhere.
- "Score 7 days ago" = the Health Score fold with both windows (14/60d) anchored
  at `now − 7d` — cheap, deterministic, consistent under backfill.
- The bot digest and `/week` share one formatter in the bot package; the web
  card formats independently from the JSON (~20 lines of phrasing duplicated
  across two presentation languages is fine — no shared template layer).
- No per-user digest customization (hour, day) in this plan — one Config
  constant.

## Post-Completion

**Manual verification:**
- Enable the digest on prod, wait one Sunday: message arrives at local evening,
  reads warm and factual on real data.
- Read the "Your week" card after a mixed week and after a backup import that
  retro-fills a lighter week — deltas shift, tone stays neutral.
