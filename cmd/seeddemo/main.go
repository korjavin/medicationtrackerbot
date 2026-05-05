// Command seeddemo wipes a user's data and seeds 90 days of synthetic
// health-tracking data so the application can be demoed end-to-end.
//
// Usage:
//
//	go run ./cmd/seeddemo -user <telegram_user_id> -db meds.db -days 90 -wipe
//
// The generator is deterministic — re-running with the same -seed
// reproduces the same dataset.
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"

	"github.com/korjavin/medicationtrackerbot/internal/seeddemo"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

func main() {
	userID := flag.Int64("user", 0, "Target user ID (required)")
	dbPath := flag.String("db", "meds.db", "Path to SQLite database")
	days := flag.Int("days", 90, "Days of history to seed")
	wipe := flag.Bool("wipe", true, "Wipe the user's existing data before seeding")
	seed := flag.Int64("seed", 42, "RNG seed for deterministic output")
	flag.Parse()

	if *userID == 0 {
		slog.Error("seeddemo: -user is required and must be non-zero")
		os.Exit(1)
	}

	s, err := store.New(*dbPath)
	if err != nil {
		slog.Error("seeddemo: failed to open database", "error", err, "db", *dbPath)
		os.Exit(1)
	}
	defer func() { _ = s.Close() }()

	ctx := context.Background()
	if _, err := seeddemo.Run(ctx, s, seeddemo.Options{
		UserID: *userID,
		Days:   *days,
		Wipe:   *wipe,
		Seed:   *seed,
	}); err != nil {
		slog.Error("seeddemo: run failed", "error", err)
		os.Exit(1)
	}
}
