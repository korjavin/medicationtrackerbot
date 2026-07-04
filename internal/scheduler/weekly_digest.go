//go:build !mobile

package scheduler

// weekly_digest.go is the opt-in Sunday-evening bot digest (gamification-12
// Task 5): the same GetWeeklyReview read model the on-demand /week command
// formats (bot.FormatWeeklyReview), delivered unprompted once a week. It is
// server-build only — the mobile build has no bot package to format through
// and no Telegram channel to deliver to (CLAUDE.md build-mode split), so this
// file carries the !mobile tag rather than being wired into New()'s tag-free
// entries list. See docs/plans/2026-07-03-gamification-12-weekly-review.md.

import (
	"context"
	"log/slog"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/bot"
	gamificationsvc "github.com/korjavin/medicationtrackerbot/internal/domain/gamification"
	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// WeeklyDigestHour is the fixed local-evening hour (user tz) the digest
// fires at. No per-user customization in this plan (Technical Details).
const WeeklyDigestHour = 19

// weeklyDigestMinResendGap guards against resending within the same Sunday's
// hour window (the checker polls every 15 min, so up to four ticks land in
// the [19:00,20:00) window).
const weeklyDigestMinResendGap = 6 * 24 * time.Hour

// WeeklyDigestStore is the subset needed by the digest checker.
type WeeklyDigestStore interface {
	GetGamificationEnabled(ctx context.Context) (bool, error)
	GetWeeklyDigestEnabled(ctx context.Context) (bool, error)
	GetWeeklyDigestLastSentAt(ctx context.Context) (*time.Time, error)
	SetWeeklyDigestLastSentAt(ctx context.Context, sentAt time.Time) error
	GetCurrent() (string, error)
}

// WeeklyDigestChecker sends the opt-in Sunday-evening weekly review digest.
// A failure here is best-effort (logged, never retried — ponytail: it's a
// weekly nicety, next week comes) and never affects scoring or other
// reminders.
type WeeklyDigestChecker struct {
	store         WeeklyDigestStore
	sink          ReminderSink
	allowedUserID int64
	gam           gamificationsvc.GamificationService
	now           func() time.Time
}

// NewWeeklyDigestChecker builds the checker from the composition root's
// *store.Repos and shared gamification service. Constructed outside New()
// (see AddEntry) because this file's !mobile tag means New() itself can't
// reference it.
func NewWeeklyDigestChecker(s *store.Repos, sink ReminderSink, allowedUserID int64, gam gamificationsvc.GamificationService) *WeeklyDigestChecker {
	return &WeeklyDigestChecker{store: newStoreAdapter(s), sink: sink, allowedUserID: allowedUserID, gam: gam}
}

func (c *WeeklyDigestChecker) Check(ctx context.Context) error {
	gamOn, err := c.store.GetGamificationEnabled(ctx)
	if err != nil {
		return err
	}
	digestOn, err := c.store.GetWeeklyDigestEnabled(ctx)
	if err != nil {
		return err
	}
	if !gamOn || !digestOn {
		return nil
	}

	nowFn := c.now
	if nowFn == nil {
		nowFn = time.Now
	}
	now := nowFn()
	if tz, err := c.store.GetCurrent(); err != nil {
		slog.Warn("weekly digest: failed to get timezone, falling back to system TZ", "error", err)
	} else if tz != "" {
		if loc, err := time.LoadLocation(tz); err != nil {
			slog.Warn("weekly digest: invalid timezone, falling back to system TZ", "tz", tz, "error", err)
		} else {
			now = now.In(loc)
		}
	}

	if now.Weekday() != time.Sunday || now.Hour() != WeeklyDigestHour {
		return nil
	}

	lastSent, err := c.store.GetWeeklyDigestLastSentAt(ctx)
	if err != nil {
		return err
	}
	if lastSent != nil && now.Sub(*lastSent) < weeklyDigestMinResendGap {
		return nil
	}

	// Match the HTTP read path (ensureGamificationFresh) before reading: the
	// lever counts fold over the ledger, which is only materialized on
	// first-enable backfill and on a gamification read's rescore window. An
	// unprompted digest user who never opens the Journey screen would otherwise
	// get an undercounted week. Guarded by the Sunday/hour + resend checks
	// above, so this runs at most once per week, not on every 15-min tick.
	gamificationsvc.EnsureFresh(ctx, c.gam, c.allowedUserID, nowFn())

	// Anchor the review one day back: at a west-of-UTC Sunday evening the
	// current UTC instant has already rolled into Monday (next ISO week), so
	// weekIndex(now) would point at the just-started week and the digest would
	// report an empty "quiet week" every Sunday. now-24h lands squarely in the
	// week that just ended for every timezone (19:00 local is at most one UTC
	// day ahead, so a single-day rewind never overshoots into the prior week).
	wr, err := c.gam.GetWeeklyReview(ctx, c.allowedUserID, now.Add(-24*time.Hour))
	if err != nil {
		return err
	}

	text := bot.FormatWeeklyReview(wr)
	if _, err := c.sink.NotifySyncToUser(ctx, c.allowedUserID, notifier.Notification{Text: text, Tag: "weekly-digest"}); err != nil {
		slog.Error("weekly digest: send failed", "error", err, "user_id", c.allowedUserID)
		return nil
	}

	slog.Info("Sent weekly digest", "user_id", c.allowedUserID)
	return c.store.SetWeeklyDigestLastSentAt(ctx, now)
}
