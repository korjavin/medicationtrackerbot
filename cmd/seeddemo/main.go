// Command seeddemo wipes a user's data and seeds 90 days of synthetic
// health-tracking data so the application can be demoed end-to-end.
//
// Usage:
//
//	# Full seed (wipes target user first):
//	go run ./cmd/seeddemo -user <telegram_user_id> -db meds.db -days 90 -wipe -seed 42
//
//	# Incremental top-up (no wipe; appends new rows since the last sample):
//	go run ./cmd/seeddemo -user <telegram_user_id> -db meds.db -topup -seed 42
//
// The generator is deterministic — re-running with the same -seed
// reproduces the same dataset. The -now flag (RFC3339) overrides
// time.Now() for deterministic tests; the demo bot's background loop
// also uses TopUp internally.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/seeddemo"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stderr))
}

// run parses CLI flags and dispatches to either seeddemo.Run (full seed) or
// seeddemo.TopUp (incremental). It is split out from main so tests can drive
// it without spawning a subprocess.
func run(args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("seeddemo", flag.ContinueOnError)
	fs.SetOutput(stderr)

	userID := fs.Int64("user", 0, "Target user ID (required)")
	dbPath := fs.String("db", "meds.db", "Path to SQLite database")
	days := fs.Int("days", 90, "Days of history to seed (full-seed mode only)")
	wipe := fs.Bool("wipe", true, "Wipe the user's existing data before seeding (full-seed mode)")
	topup := fs.Bool("topup", false, "Incremental top-up: append new rows since the last sample without wiping")
	seed := fs.Int64("seed", 42, "RNG seed for deterministic output")
	nowStr := fs.String("now", "", "Override time.Now() with RFC3339 timestamp (deterministic tests)")

	if err := fs.Parse(args); err != nil {
		// flag.ContinueOnError already printed the error to stderr.
		return 2
	}

	if *userID == 0 {
		fmt.Fprintln(stderr, "seeddemo: -user is required and must be non-zero")
		return 1
	}

	// Detect whether the operator explicitly passed -wipe so a stray default
	// `wipe=true` doesn't clash with -topup. The mutual-exclusion check fires
	// only when both flags were set on the command line.
	explicit := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { explicit[f.Name] = true })
	if *topup && explicit["wipe"] && *wipe {
		fmt.Fprintln(stderr, "seeddemo: use either -wipe (full re-seed) or -topup (incremental), not both")
		return 2
	}
	if *topup {
		// -topup is strictly additive; force the wipe default off so the
		// uniform code path doesn't accidentally drop the data we're meant
		// to append to.
		*wipe = false
	}

	var nowOverride time.Time
	if *nowStr != "" {
		parsed, err := time.Parse(time.RFC3339, *nowStr)
		if err != nil {
			fmt.Fprintf(stderr, "seeddemo: -now must be RFC3339 (e.g. 2026-05-21T12:00:00Z): %v\n", err)
			return 2
		}
		nowOverride = parsed.UTC()
	}

	sharedDB, err := storedb.Open(*dbPath)
	if err != nil {
		slog.Error("seeddemo: failed to open database", "error", err, "db", *dbPath)
		return 1
	}
	defer func() { _ = sharedDB.Close() }()
	s, err := store.NewWithDB(sharedDB)
	if err != nil {
		slog.Error("seeddemo: failed to initialize store", "error", err, "db", *dbPath)
		return 1
	}

	ctx := context.Background()
	if *topup {
		if _, err := seeddemo.TopUp(ctx, s, seeddemo.TopUpOptions{
			UserID: *userID,
			Now:    nowOverride,
			Seed:   *seed,
			Days:   *days,
		}); err != nil {
			slog.Error("seeddemo: top-up failed", "error", err)
			return 1
		}
		return 0
	}

	if _, err := seeddemo.Run(ctx, s, seeddemo.Options{
		UserID: *userID,
		Days:   *days,
		Wipe:   *wipe,
		Seed:   *seed,
		Now:    nowOverride,
	}); err != nil {
		slog.Error("seeddemo: run failed", "error", err)
		return 1
	}
	return 0
}
