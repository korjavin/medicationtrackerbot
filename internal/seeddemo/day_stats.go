package seeddemo

import (
	"context"
	"fmt"
	"math/rand/v2"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// generateDayStats emits one day_stats row per UTC calendar day in [from, to],
// populating steps / calories / distance with values shaped like a real
// wearable export. Workout days get a step boost so the demo Vitals tab shows
// an obvious correlation between scheduled training and daily activity.
//
// Idempotency: ImportDayStats's UPSERT is keyed on (user_id, day) and updates
// only when the incoming values are LARGER than the stored row, so re-running
// a top-up with the same day → same deterministic values is a no-op insert.
// The returned count reflects rows actually written (new days), matching the
// time-series streams' "inserted, not generated" semantics.
func generateDayStats(ctx context.Context, s *store.Store, opts Options, vc *vitalsContext, rng *rand.Rand, from, to time.Time) (int, error) {
	stats := buildDayStats(opts, vc, rng, from, to)
	if len(stats) == 0 {
		return 0, nil
	}
	imported, _, err := s.Vitals.ImportDayStats(ctx, opts.UserID, stats)
	if err != nil {
		return 0, fmt.Errorf("import day_stats: %w", err)
	}
	return imported, nil
}

// buildDayStats is the value-only side of generateDayStats. Each day's row is
// computed from a per-day sub-rng derived from the day's unix-day index so two
// top-ups that overlap on the same calendar day produce identical values —
// any later UPSERT then short-circuits on the value-comparison WHERE clause.
//
// Shape:
//   - baseline ~8500 steps with a small weekly seasonality (weekends -1000,
//     work-from-home midweek bumps).
//   - workout days: +2500 ± 800 steps (the gym commute + warm-up adds real
//     foot traffic on top of the cardio/strength session).
//   - occasional "very active" day (~6% probability) adds another 4000±1500.
//   - floor 2000 / ceiling 22000 — outside that range the data looks fake.
//   - calories = 400 (BMR offset for the active component) + steps * 0.04,
//     bounded [600, 3500].
//   - distance = round(steps * 0.78) meters (75–80cm stride is the wearable
//     industry default).
func buildDayStats(opts Options, vc *vitalsContext, rng *rand.Rand, from, to time.Time) []store.DayStat {
	if !from.Before(to) {
		return nil
	}
	day := startOfDayUTC(from)
	endDay := startOfDayUTC(to)
	out := make([]store.DayStat, 0)
	for ; !day.After(endDay); day = day.AddDate(0, 0, 1) {
		// Per-day sub-rng so the value for "2026-05-21" is stable regardless
		// of the rest of the run's RNG consumption.
		dayIdx := uint64(day.Unix() / 86400)
		drng := rand.New(rand.NewPCG(uint64(opts.Seed)^dayIdx^0xC0DEC0DEC0DEC0DE, uint64(opts.Seed)^dayIdx^0xD0DAD0DAD0DAD0DA))
		_ = rng // shared rng intentionally unused — keeps determinism across other generators

		steps := 8500.0
		switch day.Weekday() {
		case time.Saturday, time.Sunday:
			steps -= 1000
		case time.Wednesday:
			steps += 400
		default:
		}
		steps += gaussian(drng, 0, 700)

		if dayHasWorkout(vc, day) {
			steps += 2500 + gaussian(drng, 0, 800)
		}
		if drng.Float64() < 0.06 {
			steps += 4000 + gaussian(drng, 0, 1500)
		}

		stepsI := int(steps + 0.5)
		if stepsI < 2000 {
			stepsI = 2000
		}
		if stepsI > 22000 {
			stepsI = 22000
		}

		calories := 400 + int(float64(stepsI)*0.04+0.5)
		if calories < 600 {
			calories = 600
		}
		if calories > 3500 {
			calories = 3500
		}

		distance := int(float64(stepsI)*0.78 + 0.5)

		out = append(out, store.DayStat{
			UserID:   opts.UserID,
			Day:      day.Format("2006-01-02"),
			Steps:    stepsI,
			Calories: calories,
			Distance: distance,
		})
	}
	return out
}

// dayHasWorkout reports whether any seeded workout window starts on the given
// UTC day. The HR generator uses inWorkout for per-minute correlation; for the
// daily aggregate we collapse to a per-day boolean — the wearable's daily
// summary doesn't know how long the workout was, just that one happened.
func dayHasWorkout(vc *vitalsContext, day time.Time) bool {
	nextDay := day.AddDate(0, 0, 1)
	for _, w := range vc.workouts {
		if !w.start.Before(day) && w.start.Before(nextDay) {
			return true
		}
	}
	return false
}
