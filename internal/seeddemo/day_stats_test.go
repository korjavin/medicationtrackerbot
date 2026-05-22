package seeddemo

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func TestBuildDayStatsIsDeterministic(t *testing.T) {
	t.Parallel()
	opts := Options{UserID: 42, Days: 14, Seed: 1234, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	rng1 := makeTSRng(opts.Seed)
	rng2 := makeTSRng(opts.Seed)

	a := buildDayStats(opts, vc, rng1, clk.start, clk.anchor)
	b := buildDayStats(opts, vc, rng2, clk.start, clk.anchor)

	if !reflect.DeepEqual(a, b) {
		t.Fatalf("same seed produced different day_stats output")
	}
}

func TestBuildDayStatsDensityAndShape(t *testing.T) {
	t.Parallel()
	opts := Options{UserID: 42, Days: 30, Seed: 7, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	got := buildDayStats(opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)

	// One row per day in [start, anchor] inclusive on the start day boundary,
	// inclusive on the anchor day boundary. 30-day window includes both ends.
	wantRows := 31
	if len(got) != wantRows {
		t.Errorf("row count = %d, want %d (one per UTC day in [start, anchor])", len(got), wantRows)
	}

	seenDays := map[string]bool{}
	for _, st := range got {
		if seenDays[st.Day] {
			t.Errorf("duplicate day in output: %s", st.Day)
		}
		seenDays[st.Day] = true
		if st.UserID != opts.UserID {
			t.Errorf("user_id = %d, want %d", st.UserID, opts.UserID)
		}
		if st.Steps < 2000 || st.Steps > 22000 {
			t.Errorf("steps out of bounds on %s: %d", st.Day, st.Steps)
		}
		if st.Calories < 600 || st.Calories > 3500 {
			t.Errorf("calories out of bounds on %s: %d", st.Day, st.Calories)
		}
		// Distance should track steps with a 0.78m stride; allow ±1m rounding.
		wantDist := int(float64(st.Steps)*0.78 + 0.5)
		if st.Distance != wantDist {
			t.Errorf("distance on %s = %d, want %d (steps=%d)", st.Day, st.Distance, wantDist, st.Steps)
		}
	}
}

func TestBuildDayStatsWorkoutDaysAreHigher(t *testing.T) {
	t.Parallel()
	// 90-day window so we get many workout days vs rest days, smoothing per-day
	// variance.
	opts := Options{UserID: 42, Days: 90, Seed: 42, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	got := buildDayStats(opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)

	var workoutSteps, restSteps []int
	for _, st := range got {
		day, err := time.Parse("2006-01-02", st.Day)
		if err != nil {
			t.Fatalf("parse day: %v", err)
		}
		if dayHasWorkout(vc, day) {
			workoutSteps = append(workoutSteps, st.Steps)
		} else {
			restSteps = append(restSteps, st.Steps)
		}
	}
	if len(workoutSteps) == 0 || len(restSteps) == 0 {
		t.Fatalf("test setup: workout=%d rest=%d (need both)", len(workoutSteps), len(restSteps))
	}
	if med(workoutSteps) <= med(restSteps) {
		t.Errorf("workout-day median (%d) should exceed rest-day median (%d) — the +2500 boost looks unwired",
			med(workoutSteps), med(restSteps))
	}
}

func TestGenerateDayStatsPopulatesStore(t *testing.T) {
	t.Parallel()
	s := newTestStore(t)
	opts := Options{UserID: 4242, Days: 5, Seed: 11, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)

	n, err := generateDayStats(context.Background(), s, opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)
	if err != nil {
		t.Fatalf("generateDayStats: %v", err)
	}
	if n == 0 {
		t.Fatal("expected rows inserted")
	}
	if got := countRows(t, s.DB(), "day_stats"); got != n {
		t.Errorf("day_stats row count = %d, want %d", got, n)
	}
}

func TestFullSeedPopulatesDayStats(t *testing.T) {
	t.Parallel()
	s := newTestStore(t)
	opts := Options{
		UserID: 12345,
		Days:   30,
		Wipe:   true,
		Seed:   42,
		Now:    fixedTSNow,
	}
	summary := runSeeder(t, s, opts)

	if summary.DayStats == 0 {
		t.Error("summary.DayStats == 0; full seed should populate day_stats")
	}
	if got := countRows(t, s.DB(), "day_stats"); got != summary.DayStats {
		t.Errorf("day_stats=%d, summary=%d", got, summary.DayStats)
	}
}

func TestDayHasWorkout(t *testing.T) {
	t.Parallel()
	vc := &vitalsContext{
		workouts: []workoutWindow{
			{
				start: time.Date(2026, 5, 5, 18, 0, 0, 0, time.UTC),
				end:   time.Date(2026, 5, 5, 19, 0, 0, 0, time.UTC),
			},
		},
	}
	if !dayHasWorkout(vc, time.Date(2026, 5, 5, 0, 0, 0, 0, time.UTC)) {
		t.Error("workout day not detected")
	}
	if dayHasWorkout(vc, time.Date(2026, 5, 6, 0, 0, 0, 0, time.UTC)) {
		t.Error("next day should not have workout")
	}
	if dayHasWorkout(vc, time.Date(2026, 5, 4, 0, 0, 0, 0, time.UTC)) {
		t.Error("previous day should not have workout")
	}
}
