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
// EnsureFresh runs the first-read historical backfill, then re-scores yesterday and
// today (UTC-relative to now). The 2-day window is the live-write cover: any food/BP/
// weight/intake/diary write that landed on the current or prior UTC day is reflected on
// the next gamification read without per-handler ScoreDay hooks. All calls are
// best-effort — failures are logged, never surfaced — so reads return the (possibly
// slightly stale) current state rather than an error. Shared verbatim by the HTTP,
// /week bot, and Sunday-digest read paths so the load-bearing window stays identical
// across transports.
// ponytail: 2-day window covers same-day and previous-UTC-day writes; widen to 7d or
// add per-write ScoreDay hooks if late-night edge cases matter.
func EnsureFresh(ctx context.Context, svc GamificationService, userID int64, now time.Time) {
	if err := svc.EnsureBackfilled(ctx, userID); err != nil {
		slog.Error("gamification freshness backfill failed", "error", err, "user_id", userID)
	}
	utc := now.UTC()
	// RescoreInstants scores oldest-first, so yesterday lands before today — the streak
	// fold must run in calendar order when a read-rescore is what advances LastScoredDay
	// across a week boundary (stale backfill latched on a prior day).
	RescoreInstants(ctx, svc, userID, []time.Time{utc.AddDate(0, 0, -1), utc})
}

// EnsureFreshWeek is EnsureFresh widened to the two ISO weeks the weekly review
// folds. GetWeeklyReview sums the entire reviewed week's ledger AND the prior
// week's ledger (closed_last_week), not just today, but food/weight/diary writes
// don't self-hook ScoreDay (only meds/BP/workout do) and EnsureFresh only
// re-scores yesterday+today — so a lever close on an earlier day of either week
// (a Mon–Fri close seen by a Sunday digest, or a backdated write into last week)
// would be missing from the fold, undercounting closed-day counts and even
// reporting a false quiet week. Re-scoring both weeks' elapsed days oldest-first
// (ScoreDay is idempotent + a cheap no-op when the ledger already matches) makes
// both the this-week and last-week folds reflect the full log. The weekly HTTP /
// /week bot / Sunday-digest paths call this instead of EnsureFresh so the
// freshness window matches every ledger range the read consumes.
//
// reviewAnchor selects the reviewed ISO week (the same instant passed to
// GetWeeklyReview — the digest anchors a day back to stay west-of-UTC-safe, so it
// and now can sit in different weeks); the prior week is week−1. now clamps the
// upper bound to the real current day: scoring a future day would write a
// premature weekly gauge award on an incomplete week's end day.
// ponytail: ≤14 idempotent ScoreDay calls per weekly read (prior week is always
// fully elapsed); the per-write cover stays 2 days for the far more frequent
// daily reads.
func EnsureFreshWeek(ctx context.Context, svc GamificationService, userID int64, reviewAnchor, now time.Time) {
	if err := svc.EnsureBackfilled(ctx, userID); err != nil {
		slog.Error("gamification freshness backfill failed", "error", err, "user_id", userID)
	}
	week := weekIndex(reviewAnchor.UTC())
	priorStartUnix, _ := weekBounds(week - 1)
	_, weekEndUnix := weekBounds(week)
	upper := time.Unix(weekEndUnix, 0).UTC()
	if today := utcMidnight(now); today.Before(upper) {
		upper = today
	}
	// Contiguous from the prior week's start, oldest-first (the streak fold needs
	// calendar order). Re-scoring already-scored past days no-ops the streak fold
	// (they're not later than LastScoredDay) and just refreshes their ledger rows.
	for d := time.Unix(priorStartUnix, 0).UTC(); !d.After(upper); d = d.AddDate(0, 0, 1) {
		if err := svc.ScoreDay(ctx, userID, d); err != nil {
			slog.Error("gamification weekly freshness rescore failed", "error", err, "user_id", userID, "day", d)
		}
	}
}

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
