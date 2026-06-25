package gamification

// streak.go is the weekly-cadence streak/freeze machinery (Task 8) plus the
// insight-tier read. The streak is engineered so a miss is a rest, not a failure
// (§9): the default cadence is weekly, freezes auto-apply on a missed week, and a
// streak never goes negative or costs the user HP/levels. The scoring math itself
// (NextStreak, MaxFreezes) lives in the pure scoring package; this file owns the
// service-side bookkeeping — mapping calendar days onto weeks and deciding which
// weeks count as met from the persisted ledger.

import (
	"context"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

// secondsPerDay is the UTC day length used to bucket day_unix keys into weeks.
const secondsPerDay = 86400

// advanceStreak folds the weekly-cadence streak (§9) forward to the day being
// scored and returns the new (streak, longest, freezes). The streak only moves
// when the scored day belongs to a strictly later week than the last scored day:
// each completed week in the gap is fed to scoring.NextStreak — the week we just
// left counts as met when it accumulated any ledger HP (the forgiving "minimum
// viable day" rule: engage once and the week is kept), and every fully-skipped
// week in between is a miss that auto-applies a banked freeze (else resets to 0).
// The first ever scored day, a re-score of the same week, or an out-of-order
// earlier day leave the streak untouched — keeping ScoreDay idempotent and never
// demoting the user.
func (s *service) advanceStreak(ctx context.Context, userID int64, prev gamstore.State, start time.Time, cfg scoring.Config) (streak, longest, freezes int, err error) {
	streak = prev.CurrentStreak
	longest = prev.LongestStreak
	freezes = prev.Freezes
	if prev.LastScoredDay == nil {
		return streak, longest, freezes, nil
	}
	prevWeek := weekIndex(*prev.LastScoredDay)
	curWeek := weekIndex(start)
	if curWeek <= prevWeek {
		return streak, longest, freezes, nil
	}

	in := scoring.StreakInput{CurrentStreak: streak, Freezes: freezes}
	for w := prevWeek; w < curWeek; w++ {
		met, err := s.weekHadHP(ctx, userID, w)
		if err != nil {
			return 0, 0, 0, err
		}
		in.CurrentStreak, in.Freezes = scoring.NextStreak(in, met, cfg)
		if in.CurrentStreak > longest {
			longest = in.CurrentStreak
		}
	}
	return in.CurrentStreak, longest, in.Freezes, nil
}

// weekHadHP reports whether the user earned any HP during the given week — the
// signal that the week met its minimum. It reads the persisted ledger, so it
// reflects all days already scored in that week (the day currently being scored
// belongs to a later week, so its not-yet-applied entries never affect this). A
// read error is propagated (not silently treated as a miss): swallowing it would
// score the week as missed and irreversibly burn a banked freeze / reset the
// streak on a transient DB blip, which a retry could not undo.
func (s *service) weekHadHP(ctx context.Context, userID int64, week int64) (bool, error) {
	first, last := weekBounds(week)
	rows, err := s.gam.ListLedger(ctx, userID, first, last)
	if err != nil {
		return false, err
	}
	for _, r := range rows {
		if r.HP > 0 {
			return true, nil
		}
	}
	return false, nil
}

// weekIndex buckets a UTC day into a Monday-anchored 7-day window. 1970-01-01 was
// a Thursday, so +3 shifts the bucket boundary onto Monday. Consistent bucketing
// is all the cadence needs; the exact anchor only matters at week edges. (Scored
// days are post-1970, so the integer division never sees a negative day index.)
func weekIndex(day time.Time) int64 {
	unixDays := utcMidnight(day).Unix() / secondsPerDay
	return (unixDays + 3) / 7
}

// weekBounds returns the inclusive [first, last] UTC-midnight day_unix keys of the
// given week index — the inverse of weekIndex — matching ListLedger's inclusive
// range so a week's ledger rows can be summed.
func weekBounds(week int64) (first, last int64) {
	firstDay := week*7 - 3 // inverse of (unixDays + 3) / 7
	return firstDay * secondsPerDay, (firstDay + 6) * secondsPerDay
}

// GetInsightTier returns the user's unlocked insight tier (§8): the depth of
// analysis their level grants. It gates only how much insight detail a transport
// may surface — never raw data, trends, or safety alerts (§8 principle #5), which
// are always available. Gate-off yields 0 (feature hidden); an enabled but
// unscored user is tier 1. The stored tier never decreases (set in recomputeState).
func (s *service) GetInsightTier(ctx context.Context, userID int64) (int, error) {
	enabled, err := s.gate(ctx)
	if err != nil {
		return 0, err
	}
	if !enabled {
		return 0, nil
	}
	st, err := s.gam.GetState(ctx, userID)
	if err != nil {
		return 0, err
	}
	tier := st.InsightTier
	if tier < 1 {
		tier = 1
	}
	return tier, nil
}
