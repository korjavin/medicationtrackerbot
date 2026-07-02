# Gamification 6 — Sync Honesty (stop lying about backfilled data)

## Overview

Phase A of the gamification redesign (A → B → C → D, sequential). The system currently
cannot tell "the user didn't do it" from "the data hasn't synced yet", and the weekly
streak is transactional state that late imports cannot repair. Both make the
gamification actively misleading for a user whose sleep / night vitals / step data
arrive days later via Mi Band backup import. This plan fixes trust before any visual
redesign:

1. **Sync-pending ring state.** Rings whose outcome source is device-synced (Mind ←
   sleep, Movement ← steps) stop rendering as "you failed today" when no sample has
   arrived yet: they get an explicit `sync_pending` state, are excluded from the
   "your move" prompt, and the Today headline notes them separately.
2. **Derived (backfill-proof) streak.** The weekly streak is recomputed on read as a
   pure fold over the ledger instead of being advanced transactionally at score time.
   A late import that fills a "failed" week now repairs the streak automatically —
   same semantics (weekly cadence, freezes), zero stranded state.
3. **Honest insight ladder tier 2.** Tier 2 ("per-domain trend charts") gets a real
   destination: the app's existing trend charts. No more "soon" for something that
   already exists.

## Context (from discovery)

- Streak fold only moves forward: `internal/domain/gamification/streak.go:39-43`
  (`advanceStreak` returns unchanged when `curWeek <= prevWeek`), so `RescoreInstants`
  on import adds HP to a past week but never re-folds it. Only the one-time
  `Backfill` (latched on `backfilled_at_unix`, `backfill.go`) ever rebuilds streaks.
- Streak math is already pure: `scoring.NextStreak` (`internal/domain/gamification/scoring/scoring.go:639`),
  week membership via `weekHadHP` (`streak.go:66-78`) reads the ledger.
- Ring view model: `RingScore` (`internal/store/gamification/repo.go`, fields
  `Closed`, `Progress`, `Goal`) populated in `internal/domain/gamification/summary.go`
  (`ringScores()`); per-domain loaders in `scoreday.go` already fetch today's sleep
  and steps rows.
- "Your move" prompt + "N of 5 rings closed" headline: `web/static/js/features/today.js`
  (`renderRingsTile`, ~1039-1202). Journey rings card + insight ladder:
  `web/static/js/features/journey.js` (`renderLadder`, tier destinations gated by
  `hasDestination`, ~278-324).
- API shapes are frozen additive-only: `docs/api.md#gamification`; JSON passes through
  handlers verbatim (`internal/server/gamification_handlers.go`).
- Existing trend charts live in the BP / Weight / Vitals sections (canvas graphs) —
  tier 2's promised "per-domain trend charts" already exist as product surfaces.

## Development Approach

- **Testing approach**: NO unit tests. Integration tests only where they cover a real
  boundary. This plan has exactly one: the streak-repair-on-late-import guarantee
  (the regression the user actually hit).
- Complete each task fully before moving to the next.
- All JSON changes are additive (old clients ignore new fields).
- Frontend renders via `--wg-*` tokens only (CLAUDE.md rule 3); no new globals.
- **CRITICAL: update this plan file when scope changes during implementation.**
- Maintain backward compatibility: `gamification_state` streak columns keep being
  written (harmless), reads switch to the derived fold.

## Testing Strategy

- **Unit tests**: none.
- **Integration tests**: one — late-import streak repair through the real service +
  store (see Task 2). Guards the cross-component guarantee that transactional state
  can't provide.
- **E2E tests**: none (no existing e2e suite).

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope

## What Goes Where

- **Implementation Steps**: code + docs changes achievable in this repo.
- **Post-Completion**: manual emulator/browser smoke, real-device backup-import check.

## Implementation Steps

### Task 1: Backend — `sync_pending` ring state

- [x] add `SyncPending bool` to `RingScore` (`internal/store/gamification/repo.go`),
      JSON tag `sync_pending`, additive
- [x] populate it in `ringScores()` (`internal/domain/gamification/summary.go`) for
      **today's** rings only: `mind` → no sleep row for today AND not closed;
      `movement` → no steps/day-stats row for today AND not closed. Reuse the loaders
      `scoreday.go` already calls — expose "has synced sample today" alongside the
      existing recent-window re-score rather than adding new queries
- [x] period (weekly) rings always `sync_pending=false` (mirrors the existing
      `Progress`-only-for-today rule)
- [x] pass the field through summary / journey / rings / bootstrap unchanged; update
      the frozen shapes in `docs/api.md#gamification` and the `ResponseExample`s in
      `internal/mcp/registry/operations_gamification.go`

### Task 2: Backend — derived streak (pure fold over the ledger)

- [x] add a repo query returning weekly HP sums for a user over the trailing 52 weeks
      (`internal/store/gamification/ledger_state.go`, single GROUP BY over
      `gamification_ledger`)
- [x] add `deriveStreak()` in `internal/domain/gamification/streak.go`: replay
      `scoring.NextStreak` oldest-first over those weekly sums starting from the first
      week with any HP in the window (freezes replay deterministically: earn 1 per met
      week, bank ≤4, auto-spend on a miss — identical semantics to today)
- [x] switch `GetSummary` / `GetJourney` to report the derived current streak +
      freezes; `LongestStreak = max(persisted, derived)` so history is never lost
- [x] keep `recomputeState`'s transactional writes (state row stays warm for
      compatibility), but no read path depends on them for the current streak anymore
- [x] integration test (service + real SQLite store): score week N, leave week N+1
      empty past its end, verify streak reset/freeze-spent in summary; then import
      late data into week N+1 via `RescoreInstants` and verify the summary streak is
      repaired. This is the boundary guarantee of the whole plan

### Task 3: Frontend — sync-aware Today tile and Journey rings

- [x] `web/static/js/features/today.js` `renderRingsTile`: rings with `sync_pending`
      render dimmed with a "syncs later" sub-line (token-only styling), instead of an
      empty "failed" arc
- [x] exclude `sync_pending` rings from the "your move" candidate list (first open
      *actionable* ring wins)
- [x] headline stays "N of 5 rings closed" but appends "· M waiting for sync" when
      M > 0; all-actionable-closed + only-sync-pending-remaining reads as a positive
      state, not a nag
- [x] `web/static/js/features/journey.js` rings card: same dimmed sync-pending
      treatment + sub-line

### Task 4: Frontend — insight ladder tier 2 gets a real destination

- [x] `journey.js` `renderLadder`: tier 2 ("per-domain trend charts") becomes
      `hasDestination` → "Unlocked → view" deep-linking to the existing trends surface
      (`switchTab('health')` — the Vitals section's charts; matches the tier's copy)
- [x] tiers 3-4 keep the honest "Unlocks at Lvl N · soon" until plans 8/9 ship their
      destinations

### Task 5: Verify acceptance criteria

- [x] verify all Overview requirements implemented (sync_pending end-to-end, derived
      streak repairs on late import, tier 2 links)
- [x] `go test ./...` passes
- [x] `pnpm test` passes
- [x] `golangci-lint run` + `gofmt` on touched packages — clean

### Task 6: Update documentation

- [ ] `docs/gamification.md`: new §14.5 recording sync-honesty semantics (sync_pending,
      derived streak, why transactional streak state was retired from the read path)
- [ ] `docs/api.md#gamification`: `sync_pending` field documented

## Technical Details

- `sync_pending` is a **display state**, not a scoring change: HP/ledger math is
  untouched; only the view model and prompts change.
- Derived streak is O(52) rows per read after one GROUP BY — negligible on
  single-user SQLite, and it composes with the existing read-time
  `RescoreInstants(yesterday, today)` refresh (`gamification_handlers.go:29-38`).
- The one-time `Backfill` streak reconstruction becomes redundant for the *current*
  streak but is left in place (it still seeds `LongestStreak` history).
- Week indexing must match the existing `weekIndex` (`streak.go`) so derived and
  historical folds agree.

## Post-Completion

**Manual verification:**
- Real-device flow: leave sleep unsynced for a day → Today shows Mind "syncs later"
  and never prompts it as "your move"; run a Mi Band backup import covering a missed
  week → Journey streak visibly repairs without toggling the feature flag.
- Browser + Android emulator smoke of the Today tile states (all closed / some
  sync-pending / nothing logged).
