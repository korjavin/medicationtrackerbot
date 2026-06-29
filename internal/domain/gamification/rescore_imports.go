package gamification

import (
	"context"
	"log/slog"
	"time"
)

// RescoreInstants deduplicates instants to UTC-midnight days and calls ScoreDay
// for each, best-effort (failures logged, never returned). Call this once after
// an atomic import completes so every touched historical day reflects the new data.
// ponytail: O(distinct days) ScoreDay calls; bounded by the import set, cheaper
// than the 365-day backfill; widen or move to per-write hooks if SSE-push latency matters.
func RescoreInstants(ctx context.Context, svc GamificationService, userID int64, instants []time.Time) {
	if svc == nil || len(instants) == 0 {
		return
	}
	seen := make(map[time.Time]struct{}, len(instants))
	for _, t := range instants {
		day := time.Date(t.UTC().Year(), t.UTC().Month(), t.UTC().Day(), 0, 0, 0, 0, time.UTC)
		if _, ok := seen[day]; ok {
			continue
		}
		seen[day] = struct{}{}
		if err := svc.ScoreDay(ctx, userID, day); err != nil {
			slog.Error("gamification import rescore failed", "error", err, "user_id", userID, "day", day)
		}
	}
}
