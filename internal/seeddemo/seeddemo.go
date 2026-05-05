// Package seeddemo wipes a target user's data and seeds a deterministic
// catalogue of synthetic health-tracking data so the application can be
// demoed without manual data entry. It is intentionally only callable
// from the cmd/seeddemo CLI; the package never registers HTTP or bot
// surface area.
package seeddemo

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// Options controls what the seeder does. Fields mirror the CLI flags on
// cmd/seeddemo/main.go.
type Options struct {
	UserID int64
	Days   int
	Wipe   bool
	Seed   int64
	// Now is the anchor for the synthetic time window. Tests inject a
	// fixed value; the CLI defaults to time.Now().
	Now time.Time
}

// Summary records per-domain row counts produced by a single Run.
type Summary struct {
	Medications     int
	Intakes         int
	BPReadings      int
	WeightLogs      int
	SleepLogs       int
	FoodProducts    int
	FoodLogs        int
	WorkoutSessions int
	ExerciseLogs    int
	DiaryNotes      int
	TimezoneEvents  int
}

// Run executes the seeder against the provided store. It is the single
// entry point used by both the CLI and tests.
func Run(ctx context.Context, s *store.Store, opts Options) (*Summary, error) {
	if opts.UserID == 0 {
		return nil, fmt.Errorf("seeddemo: UserID is required")
	}
	if opts.Days <= 0 {
		opts.Days = 90
	}
	if opts.Now.IsZero() {
		opts.Now = time.Now()
	}

	if opts.Wipe {
		if err := WipeUser(ctx, s, opts.UserID); err != nil {
			return nil, fmt.Errorf("wipe user: %w", err)
		}
	}

	rng := rand.New(rand.NewPCG(uint64(opts.Seed), uint64(opts.Seed)^0x9E3779B97F4A7C15))
	clk := newClock(opts.Now, opts.Days)
	summary := &Summary{}

	// Future tasks (2-6) plug in here:
	//   meds.Generate(ctx, s, opts, clk, rng, summary)
	//   vitals.Generate(...)
	//   food.Generate(...)
	//   workouts.Generate(...)
	//   misc.Generate(...)
	_ = clk
	_ = rng

	slog.Info("seeddemo: completed",
		"user_id", opts.UserID,
		"days", opts.Days,
		"medications", summary.Medications,
		"intakes", summary.Intakes,
		"bp_readings", summary.BPReadings,
		"weight_logs", summary.WeightLogs,
		"sleep_logs", summary.SleepLogs,
		"food_products", summary.FoodProducts,
		"food_logs", summary.FoodLogs,
		"workout_sessions", summary.WorkoutSessions,
		"exercise_logs", summary.ExerciseLogs,
		"diary_notes", summary.DiaryNotes,
		"timezone_events", summary.TimezoneEvents,
	)
	return summary, nil
}
