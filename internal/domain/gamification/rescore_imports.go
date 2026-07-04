package gamification

import (
	"context"
	"log/slog"
	"sort"
	"time"
)

// RescoreInstants deduplicates instants to UTC-midnight days — plus each of
// those days' week-end day, so a late import that changes a week's trend/share
// also refreshes that week's already-written gauge award (gamification-11
// §Task2: the award lives only on the week's last day, so touching any other
// day in the week would otherwise leave it stale) — and calls ScoreDay for
// each in calendar order, best-effort (failures logged, never returned). Call
// this once after an atomic import completes so every touched historical day
// reflects the new data.
//
// Days are scored oldest-first: the weekly streak fold (advanceStreak) only moves
// when a day is in a later week than LastScoredDay and reads the persisted ledger
// for the intervening weeks. Scoring a later day before an earlier one in the same
// import would fold against a half-populated week and mis-resolve the streak —
// which is exactly why Backfill walks oldest-first (see backfill.go). Callers here
// build the instant set in record order, not calendar order, so we sort.
// ponytail: O(distinct days) ScoreDay calls; bounded by the import set, cheaper
// than the 365-day backfill; widen or move to per-write hooks if SSE-push latency matters.
func RescoreInstants(ctx context.Context, svc GamificationService, userID int64, instants []time.Time) {
	if svc == nil || len(instants) == 0 {
		return
	}
	seen := make(map[time.Time]struct{}, len(instants)*2)
	days := make([]time.Time, 0, len(instants)*2)
	add := func(day time.Time) {
		if _, ok := seen[day]; ok {
			return
		}
		seen[day] = struct{}{}
		days = append(days, day)
	}
	for _, t := range instants {
		day := time.Date(t.UTC().Year(), t.UTC().Month(), t.UTC().Day(), 0, 0, 0, 0, time.UTC)
		add(day)
		_, lastUnix := weekBounds(weekIndex(day))
		add(time.Unix(lastUnix, 0).UTC())
	}
	sort.Slice(days, func(i, j int) bool { return days[i].Before(days[j]) })
	for _, day := range days {
		if err := svc.ScoreDay(ctx, userID, day); err != nil {
			slog.Error("gamification import rescore failed", "error", err, "user_id", userID, "day", day)
		}
	}
}
