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
// persisting each day's HP awards + the running state through ScoreDay. Walking
// chronologically lets ScoreDay's weekly-cadence streak machinery fold forward
// week by week exactly as it would online, so the final state is the correct
// cumulative result — no separate end-of-run recompute is needed.
//
// It is a no-op when the feature flag is off (ScoreDay gates per day, and the
// pre-check here avoids the loop entirely). Re-running is idempotent: the ledger's
// UNIQUE key + INSERT OR REPLACE means a second pass replaces each day's rows
// with identical values, leaving row counts and state unchanged.
func (s *service) Backfill(ctx context.Context, userID int64) error {
	enabled, err := s.gate(ctx)
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}

	today := utcMidnight(s.now())
	// Oldest first (i = backfillDays-1 → today-364) up to today (i = 0) so the
	// streak advances in calendar order; out-of-order days would no-op the fold.
	for i := backfillDays - 1; i >= 0; i-- {
		day := today.AddDate(0, 0, -i)
		if err := s.ScoreDay(ctx, userID, day); err != nil {
			return err
		}
	}
	return nil
}

// EnsureBackfilled runs Backfill once, on the user's first enable. It short-
// circuits when the flag is off (nothing to do) and when the user has already
// been scored (LastScoredDay set), so it is cheap to call on every enable / boot.
// Plan 2 wires this into the feature-enable hook; calling it repeatedly is safe.
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
	if st.LastScoredDay != nil {
		return nil // already backfilled — the trailing window was replayed before
	}
	return s.Backfill(ctx, userID)
}
