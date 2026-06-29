# Gamification — Dynamic Re-scoring (make scores update as data comes in)

## Overview

Gamification HealthPoints/rings are currently computed **exactly once** — a latched
365-day backfill on first view/enable — and then frozen forever. The per-day
scorer `ScoreDay` exists, is idempotent, and is fully wired into the service
interface, but **has zero callers anywhere**. So importing Mi Band data or adding
food writes rows to the source tables, yet nothing re-scores: the ledger + cached
state stay stale and `GetSummary` keeps returning the old numbers.

**This plan adds the missing re-score triggers** so scores update as data arrives:

1. **Live single writes** (food, BP, weight, today's intake, diary, today's
   workout — any transport) reflect on the gamification/Today screen via a
   **recent-window re-score on read** + a **frontend tag co-invalidation** so the
   rings/journey refetch right after a write (no reload).
2. **Bulk/historical imports** (Mi Band/sleep file import, BP import, external
   workout) are treated as **atomic operations: import everything, then re-score
   every affected day** (the affected set can span many days — exactly the
   historical-import case).

**Why this shape (read it before implementing — one deliberate deviation from
"on-write everywhere"):** `ScoreDay` is the single idempotent entry point and the
existing `change_events('gamification')` trigger → SSE → frontend cache-invalidation
plumbing already carries a ledger change to the UI for free. Rather than hooking
~24 individual write paths across two binaries (server handlers **and** the bot,
which has no gamification service), live single-writes route through a recent-window
re-score on the gamification reads (≈5 seams, one area, self-healing for any source
incl. future ones), and only the **bulk importers** get explicit post-write
range re-scores (because a recent-window read can't reach a months-old imported
day). This covers every source and both transports at roughly half the diff.
*If you later want single writes to push live via SSE without any refetch, add
per-handler `ScoreDay` hooks (noted in Post-Completion) — the shared helper from
Task 1 makes that a one-liner each.*

## Context (from discovery)

**Verified file references:**

- **Scorer (no callers):** `internal/domain/gamification/scoreday.go:53` —
  `ScoreDay(ctx, userID, day)`; `day` is normalized to UTC-midnight, gated
  internally (no-op when the flag is off), idempotent (ledger UNIQUE + INSERT OR
  REPLACE). `grep ScoreDay` outside the gamification package returns nothing.
- **Per-user lock lives on the service instance:** `scoreday.go:64`
  (`scoreDayLocked` → `s.scoreMu.lock(userID)`) and `service.go:204` (`scoreMu`).
  ⇒ **the server and the bot must share ONE service instance** or a bot import and
  a server read-rescore for the same user race the stale-overwrite the comments
  warn about (`scoreday.go:88-101`).
- **Re-score idempotency / streak safety:** re-scoring an already-scored day only
  refreshes that day's ledger HP and re-derives lifetime; the streak fold
  "leave[s] the streak untouched" for an earlier-or-equal day
  (`internal/domain/gamification/streak.go:30`), so a recent-window re-score is
  safe in any order.
- **Read-path helper (extend this):** `internal/server/gamification_handlers.go:28`
  `ensureGamificationBackfill` is already called by `handleGamificationSummary`
  (:38), `handleGamificationJourney` (:52), `handleGamificationRings` (:75), and
  the bootstrap builder reads `GetSummary` at `internal/server/settings_handlers.go:444`.
- **Service construction (today, server-only):** `internal/server/server.go:318`
  `gamificationSvc: gamificationsvc.New(s.Medication, s.BP, s.Weight, s.Vitals,
  s.Food, s.Diary, s.Workout, s.Gamification, s.Settings)`. Signature
  `server.New` at `server.go:307`.
- **Wiring order:** `cmd/bot/main_server.go:234` builds `bot.New(botToken,
  allowedUserID, s, foodAI, activityAI, tzUpdater)` **before** `server.New` at
  `:289`. `bot.New` signature: `internal/bot/bot.go:116`.
- **Mi Band / sleep import (bot-driven, has all DateTimes):**
  `internal/bot/sleep_import.go` — `ImportSleepLogs` (:157), `ImportVitals`
  (:191), `ImportDayStats` (:208), `ImportMiBand` (:255). Parsed records carry
  `DateTime`/`Day` fields (the affected-day source).
- **Other importers:** single Mi Band workout `internal/bot/activity_commands.go:85`;
  external workout HTTP `internal/server/external_workout_handlers.go:145`
  (`s.miband.InsertMiBand`); BP import `internal/server/bp_handlers.go:130`
  (`handleImportBloodPressure`).
- **Frontend cache + tag plumbing:** gamification cache keys `gamification`
  (journey) and `gamification_rings` (Today tile), both tag `gamification`
  (`web/static/js/core/cache-keys.js:95-105`). Change-poll invalidates whatever
  tags the backend reports (`web/static/js/data-store.js:706`
  `invalidateTags(changedTags)`). The `gamification` tag is currently invalidated
  **only** on a targets save (`web/static/js/features/settings.js:391`); scored
  writes invalidate their own tags (`food`/`bp`/`weight`/…) but never
  `gamification`. Scored client-write sites: `features/today-loader.js` (food),
  `features/bp.js:150,720`, `features/weight.js:420,1205`, `features/meds.js`
  (intakes), `features/health.js` (notes/diary), `features/food/*` (photo/ai).
- **Live-update mechanism (free):** migration 073 already installs INS/UPD/DEL
  triggers on the three gamification tables that `INSERT INTO change_events(tag)
  VALUES ('gamification')`. So any `ScoreDay` that writes the ledger (incl. the
  import range re-scores) propagates to the frontend via the existing SSE path —
  no frontend change needed for the import case.

**Build modes:** the bot is stripped in the mobile build
(`//go:build mobile`). Task 1's shared-instance wiring lives in
`cmd/bot/main_server.go` (server build only); `cmd/bot/main_mobile.go` has no bot,
so the server keeps building its own instance there. Both tags must keep
compiling. `internal/domain/gamification` stays build-tag-free.

## Development Approach

- **Testing approach:** NO unit tests. One backend integration test only — it
  guards the real regression boundary ("a scored write/import now flows into the
  score"), which manual checking can't guarantee against future drift.
- Re-score calls are **best-effort**: log on failure, never fail the originating
  write/read (mirror `ensureGamificationBackfill` at `gamification_handlers.go:29`).
- Keep store/domain/handlers **build-tag-free**; only `cmd/bot/main_{server,mobile}.go`
  are tagged seams.
- Frontend follows existing tag conventions — no new mechanism, just add
  `'gamification'` to existing `invalidateTags` arrays.
- Complete each task (builds + existing tests green) before the next. Update this
  plan as scope shifts (`➕` new task, `⚠️` blocker).

## Testing Strategy

- **Unit tests:** none.
- **Integration test (exactly one):** in `internal/server`, POST a food log for
  today, then GET `/api/gamification/summary` and assert `today_hp` /
  nourishment-ring HP reflects it (proves read-rescore wires the food→score flow
  end-to-end). This is the one real boundary the bug lived at.
- **E2E:** none (no change to an existing e2e suite is required).

## Progress Tracking

- Mark `[x]` immediately when done. `➕` newly discovered tasks, `⚠️` blockers.

## What Goes Where

- **Implementation Steps** (checkboxes): wiring, helper, import re-scores,
  frontend tag edits, the one integration test, docs — all in-repo.
- **Post-Completion** (no checkboxes): manual smoke + the optional full-SSE-live
  per-handler hook extension.

## Implementation Steps

### Task 1: Share one gamification service instance across server + bot
- [x] in `cmd/bot/main_server.go`, build the gamification service **once** from the
  store (`gamificationsvc.New(s.Medication, s.BP, s.Weight, s.Vitals, s.Food,
  s.Diary, s.Workout, s.Gamification, s.Settings)`) before constructing the bot and
  the server
- [x] add a `gamificationSvc gamificationsvc.GamificationService` param to
  `server.New` (`internal/server/server.go:307`) and assign it to the
  `gamificationSvc` field instead of building it inline at `server.go:318`
- [x] add a `gamificationSvc gamificationsvc.GamificationService` param to
  `bot.New` (`internal/bot/bot.go:116`) and store it on the `Bot` struct; pass the
  shared instance from `main_server.go`
- [x] `cmd/bot/main_mobile.go`: keep the server's own instance (no bot in this
  build) — adjust the `server.New` call to build + pass an instance so the new
  signature compiles under `-tags mobile`
- [x] confirm `go build ./...` and `go build -tags mobile ./...` both succeed

### Task 2: Recent-window re-score on gamification reads (covers all live writes)
- [x] extend the read-path helper in `internal/server/gamification_handlers.go`
  (the `ensureGamificationBackfill` at :28 — rename to `ensureGamificationFresh`
  or add a sibling) to, after `EnsureBackfilled`, best-effort re-score **yesterday
  then today** (UTC) via `s.gamificationSvc.ScoreDay`; log failures, never surface
- [x] call it from `handleGamificationSummary`, `handleGamificationJourney`,
  `handleGamificationRings`, and the bootstrap gamification block
  (`settings_handlers.go:444`) — replace/augment the existing
  `ensureGamificationBackfill` calls so every read path refreshes the recent window
- [x] `ponytail:` comment noting the 2-day window is the live-write cover and the
  upgrade path (widen window or add per-write hooks) if it proves too narrow
- [x] `go build ./...` + existing `internal/server` tests green

### Task 3: Import = atomic, then re-score all affected days
- [x] add a small best-effort helper that takes a set of instants, dedups to UTC
  days, and calls `ScoreDay` per day (one place; reused by bot + server importers)
- [x] `internal/bot/sleep_import.go`: after the sleep/vitals/day-stats/Mi Band
  imports complete, collect the union of affected UTC days from the parsed records'
  `DateTime`/`Day` fields and re-score them (the "can be many" historical case),
  best-effort/logged
- [x] `internal/bot/activity_commands.go:85`: re-score the single imported Mi Band
  workout's day
- [x] `internal/server/external_workout_handlers.go` (after `InsertMiBand` at :145):
  re-score the inserted workout's day
- [x] `internal/server/bp_handlers.go` `handleImportBloodPressure` (:130): re-score
  the union of imported readings' days
- [x] `go build ./...` + `go build -tags mobile ./...` succeed (bot file compiles
  server-only; importers tag-free)

### Task 4: Frontend — co-invalidate `gamification` on scored writes
- [x] add `'gamification'` to the `invalidateTags([...])` arrays on the scored
  client-write paths so the rings (`gamification_rings`) + journey (`gamification`)
  caches evict and refetch immediately after a write (the refetch then hits the
  Task 2 read-rescore and renders fresh, no reload):
  food (`features/food/log.js`, `features/food/photo.js`, `features/food/ai-undo.js`),
  BP (`features/bp.js`), weight (`features/weight.js`), intakes (`features/meds.js`,
  `features/meds-history.js`), diary/notes (`features/health.js`)
- [x] `pnpm test` — existing frontend suite stays green (no new tests authored here)

### Task 5: Verify acceptance criteria
- [x] integration test (`internal/server`): POST `/api/food/log` for today → GET
  `/api/gamification/summary` reflects today's nourishment HP / `today_hp`
- [x] run full `go test ./...` — all packages pass
- [x] run `pnpm test` — frontend suite passes
- [x] `golangci-lint run ./...` clean; `go vet ./...` clean
- [x] confirm `go build ./...` and `go build -tags mobile ./...` both succeed

### Task 6: [Final] Update documentation
- [ ] add a note to `docs/gamification.md` §14: scores re-score on read (recent
  window) and on import (full affected range); the shared single service instance;
  the frontend `gamification` co-invalidation
- [ ] update `docs/architecture.md` only if a new shared-wiring pattern warrants it

## Technical Details

- **Re-score primitive:** `ScoreDay(ctx, userID, day)` — UTC-midnight normalized,
  gated, idempotent. All triggers funnel through it; no parallel scoring path.
- **Recent window:** today + yesterday (UTC). Two `ScoreDay` calls per gamification
  read; cheap on single-user SQLite. Yesterday catches last-night sleep / late
  entries that land on the prior UTC day. Streak fold is untouched for
  already-scored days (`streak.go:30`).
- **Import affected-day set:** the union of UTC days across the parsed import
  records (sleep/heart/spo2/stress/day-stats/workout `DateTime`/`Day`). Re-scored
  after the atomic import so a months-long import refreshes every touched day. A
  very large import does O(distinct-days) `ScoreDay` calls — bounded by, and
  cheaper than, the 365-day backfill; acceptable for a rare heavy op
  (`ponytail:` note the ceiling).
- **Shared instance / lock:** one `gamificationsvc` for the whole process so the
  per-user `scoreMu` serializes bot imports against server read-rescores.
- **Frontend propagation:** import re-scores write the ledger → migration-073
  trigger emits `change_events('gamification')` → SSE → auto-invalidate (free);
  live single writes rely on the Task 4 client-side `gamification` co-invalidation
  → refetch → Task 2 read-rescore.

## Post-Completion

*Informational — manual checks and optional extensions, no checkboxes.*

**Manual smoke:**
- Add a food log → open Today/Journey → nourishment ring/HP reflects it (no reload).
- Send a Mi Band export to the bot covering several past days → those days' rings
  and lifetime HP update; the open client refreshes via SSE.
- Toggle the gamification flag off → all re-score paths no-op (service gate).

**Optional extension (only if you want single writes to push live via SSE without
a refetch):** add a best-effort `s.gamificationSvc.ScoreDay(ctx, userID, day)` at
each scored single-write seam (food×5, BP create/delete, weight create/delete,
med-intake confirm/skip/log-past, diary, workout completion — server handlers and
the matching bot callbacks). The shared helper from Task 1/3 makes each a one-liner;
this then makes Task 4's frontend co-invalidation redundant for those paths.
