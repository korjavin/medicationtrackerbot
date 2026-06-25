package gamification

// backfill.go is the historical-backfill path (Task 10): when gamification is
// first enabled for a user, Backfill replays the trailing 365 days through the
// same ScoreDay path the online scorer uses, so an existing user lands on a
// populated ledger + cached state instead of starting empty. It reuses ScoreDay
// rather than a parallel scoring path, which keeps the streak fold-forward (§9)
// and the lifetime/level/tier recompute identical to live scoring — the only
// difference is that backfill walks the days in chronological order in one go.
//
// Idempotency falls out of the ledger's UNIQUE key + INSERT OR REPLACE: a second
// Backfill re-scores the same data, replacing each day's rows in place (no count
// change) and recomputing the same state (no value change). EnsureBackfilled adds
// a cheap guard so the 365-day walk runs only once per user — Plan 2 calls it from
// the enable hook.

import "context"

// backfillDays is the historical window Backfill replays, capped per the design
// (365-day historical backfill). Days older than this are never scored even when
// data exists for them; days inside the window with no data simply produce no
// awards, so the effective backfill is naturally bounded by data availability.
const backfillDays = 365

// Backfill scores the trailing backfillDays (oldest day first) for the user,
// persisting each day's HP awards + the running state. Walking chronologically
// lets the weekly-cadence streak machinery fold forward week by week exactly as
// it would online, so the final state is the correct cumulative result — no
// separate end-of-run recompute is needed.
//
// It is a no-op when the feature flag is off: a single pre-check here gates the
// whole walk. Past that gate the loop scores via the ungated scoreDayCore rather
// than ScoreDay, so a flag flip mid-run can't silently no-op the remaining days
// and strand the latch on a partial window. Re-running is idempotent: the
// ledger's UNIQUE key + INSERT OR REPLACE means a second pass replaces each day's
// rows with identical values, and the streak reset below is skipped once the latch
// is set, so row counts and state stay unchanged.
//
// The ENTIRE walk runs under one per-user scoring lock (not lock-per-day) so the
// backfill is atomic per user: a concurrent live ScoreDay can neither interleave
// between days — which would jump LastScoredDay into a later week and no-op the
// streak fold for every remaining (older) day — nor race the streak reset.
func (s *service) Backfill(ctx context.Context, userID int64) error {
	enabled, err := s.gate(ctx)
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}

	unlock := s.scoreMu.lock(userID)
	defer unlock()

	// Rebuild the streak from scratch over the window on the FIRST backfill: zero
	// the streak-tracking fields + clear LastScoredDay so the chronological walk's
	// weekly fold starts fresh. Without this, a live ScoreDay that landed before
	// the backfill (EnsureBackfilled still runs the replay then — only BackfilledAt
	// gates it, not LastScoredDay) would have advanced LastScoredDay into a recent
	// week, and advanceStreak no-ops for every older backfilled day, so the
	// historical streak/freezes would never be reconstructed (the ledger fills but
	// the streak stays stuck). The reset is skipped on a re-run (latch set) so the
	// replay stays an idempotent no-op on the streak.
	if err := s.resetStreakForBackfill(ctx, userID); err != nil {
		return err
	}

	today := utcMidnight(s.now())
	// Oldest first (i = backfillDays-1 → today-364) up to today (i = 0) so the
	// streak advances in calendar order; out-of-order days would no-op the fold.
	for i := backfillDays - 1; i >= 0; i-- {
		day := today.AddDate(0, 0, -i)
		if err := s.scoreDayCore(ctx, userID, day); err != nil {
			return err
		}
	}

	// Stamp the backfill-complete latch only after the WHOLE window replayed
	// successfully — this is the signal EnsureBackfilled keys off, and it must not
	// be set on a partial run (an early scoreDayCore error returns above, latch
	// unset, so a retry resumes the full window). We already hold the per-user
	// lock, so this can't interleave with a concurrent score carrying a stale (nil)
	// latch. The state row is guaranteed to exist: the loop scored at least one
	// day, each of which upserts state. MarkBackfilled is set-once (no-op when the
	// latch is already set), so a redundant direct Backfill re-stamps nothing here.
	return s.gam.MarkBackfilled(ctx, userID, s.now())
}

// resetStreakForBackfill zeroes the streak-tracking state so the chronological
// backfill walk rebuilds the weekly streak from the ledger window. It is a no-op
// once the backfill latch is set: a re-run must not disturb the streak the first
// pass — and any later online scoring — established. Only the streak fields and
// LastScoredDay are cleared; LifetimeHP/Level/InsightTier/BackfilledAt are
// preserved (lifetime is re-derived from the unchanged ledger each scored day and
// level/tier never decrease, so resetting them would be wrong). It writes nothing
// when the state is already fresh, keeping a clean first backfill free of a
// redundant state write. The caller MUST hold the per-user scoring lock.
func (s *service) resetStreakForBackfill(ctx context.Context, userID int64) error {
	st, err := s.gam.GetState(ctx, userID)
	if err != nil {
		return err
	}
	if st.BackfilledAt != nil {
		return nil // already backfilled — preserve the established streak on re-run
	}
	if st.CurrentStreak == 0 && st.LongestStreak == 0 && st.Freezes == 0 && st.LastScoredDay == nil {
		return nil // already fresh — nothing to reset
	}
	st.CurrentStreak = 0
	st.LongestStreak = 0
	st.Freezes = 0
	st.LastScoredDay = nil
	_, err = s.gam.UpsertState(ctx, userID, st)
	return err
}

// EnsureBackfilled runs Backfill once, on the user's first enable. It short-
// circuits when the flag is off (nothing to do) and when the historical window
// has already been fully replayed (BackfilledAt set), so it is cheap to call on
// every enable / boot. Plan 2 wires this into the feature-enable hook; calling
// it repeatedly is safe.
//
// The guard keys off the dedicated BackfilledAt latch, NOT LastScoredDay: the
// latter advances on the very first backfilled day and on every ordinary daily
// score, so using it would (a) treat a backfill that died part-way as complete
// and silently skip the remaining days, and (b) skip the historical replay
// entirely if a live ScoreDay landed before first enable. BackfilledAt is set
// only after a whole 365-day window finishes (see Backfill), so neither case
// fools it; re-running the backfill is idempotent regardless.
func (s *service) EnsureBackfilled(ctx context.Context, userID int64) error {
	enabled, err := s.gate(ctx)
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}
	st, err := s.gam.GetState(ctx, userID)
	if err != nil {
		return err
	}
	if st.BackfilledAt != nil {
		return nil // already backfilled — the full trailing window was replayed before
	}
	return s.Backfill(ctx, userID)
}
