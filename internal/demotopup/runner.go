// Package demotopup runs the seeddemo.TopUp orchestrator on a fixed cadence
// inside the server build's main process, so a long-running DEMO_MODE=1
// deployment keeps its synthetic dataset fresh without an external cron job.
//
// The loop is intentionally narrow: it owns a ticker, calls a TopUpFunc on
// each tick (and once at startup), logs the resulting Summary, and exits on
// ctx.Done(). Errors are logged but never propagate — a top-up failure must
// never take down the demo bot.
package demotopup

import (
	"context"
	"log/slog"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/seeddemo"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// TopUpFunc is the contract Runner depends on. The package's Run injects
// seeddemo.TopUp in production; tests pass a stub that records calls without
// touching SQLite.
type TopUpFunc func(ctx context.Context, s *store.Store, opts seeddemo.TopUpOptions) (*seeddemo.Summary, error)

// Config holds the wiring for one top-up loop instance. It is passed by value
// into Run because every field is either an int, a duration, or a function
// pointer — there is no shared mutable state.
type Config struct {
	// Store is the *store.Store the loop hands to TopUp on every tick.
	Store *store.Store
	// UserID is the demo user whose streams get topped up. Must be non-zero;
	// Run returns immediately with a log warning if it is.
	UserID int64
	// Interval is the cadence between top-up calls. Run logs a warning and
	// returns if Interval <= 0.
	Interval time.Duration
	// Seed is the deterministic seed forwarded to seeddemo.TopUpOptions on
	// every tick. seeddemo.TopUp XORs this with the current calendar day so
	// the per-day sample shape is stable across restarts.
	Seed int64
	// Days is forwarded to TopUpOptions for the catalog-scale trend math.
	// Defaults to 90 inside seeddemo.TopUp when zero, so the server build
	// can leave this unset and inherit the demo's canonical 90-day shape.
	Days int

	// TopUp is the function called on every tick. Production callers leave
	// this nil and the runner substitutes seeddemo.TopUp. Tests inject a
	// stub.
	TopUp TopUpFunc
	// Now returns the "current" time on every tick. Production callers
	// leave this nil and the runner substitutes time.Now. Tests inject a
	// fake clock so the per-tick seed math is deterministic.
	Now func() time.Time
}

// Run drives the demo top-up loop until ctx is cancelled. The first tick
// fires immediately on startup so a freshly-deployed demo gets data right
// away; subsequent ticks fire every Interval. Errors from TopUp are logged
// via slog.Error and swallowed — a failed tick must not crash the bot.
//
// Run blocks; callers wire it as `go demotopup.Run(ctx, cfg)` from
// cmd/bot/main_server.go.
func Run(ctx context.Context, cfg Config) {
	if cfg.UserID == 0 {
		slog.Warn("demotopup: UserID is zero, not starting top-up loop")
		return
	}
	if cfg.Interval <= 0 {
		slog.Warn("demotopup: non-positive interval, not starting top-up loop", "interval", cfg.Interval)
		return
	}
	if cfg.Store == nil {
		slog.Warn("demotopup: nil store, not starting top-up loop")
		return
	}
	topup := cfg.TopUp
	if topup == nil {
		topup = seeddemo.TopUp
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}

	slog.Info("demotopup: starting top-up loop", "user_id", cfg.UserID, "interval", cfg.Interval)

	tick := func() {
		start := time.Now()
		opts := seeddemo.TopUpOptions{
			UserID: cfg.UserID,
			Now:    now(),
			Seed:   cfg.Seed,
			Days:   cfg.Days,
		}
		summary, err := topup(ctx, cfg.Store, opts)
		if err != nil {
			slog.Error("demotopup: top-up tick failed", "error", err, "duration", time.Since(start))
			return
		}
		added := 0
		if summary != nil {
			added = summary.Intakes + summary.BPReadings + summary.WeightLogs +
				summary.SleepLogs + summary.HeartSamples + summary.SpO2Samples +
				summary.StressSamples + summary.FoodLogs + summary.WorkoutSessions +
				summary.DiaryNotes
		}
		slog.Info("demotopup: tick completed", "added_rows", added, "duration", time.Since(start))
	}

	// First tick on startup so a freshly-deployed demo has up-to-date data
	// before the first interval elapses.
	tick()

	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			slog.Info("demotopup: context cancelled, exiting top-up loop")
			return
		case <-ticker.C:
			tick()
		}
	}
}
