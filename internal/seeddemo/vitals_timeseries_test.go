package seeddemo

import (
	"context"
	"math/rand/v2"
	"reflect"
	"sort"
	"testing"
	"time"
)

// makeTSRng returns a sub-rng using the same seed-derivation generateVitals
// uses, so unit tests exercise the exact bit-stream that production does.
func makeTSRng(seed int64) *rand.Rand {
	return rand.New(rand.NewPCG(uint64(seed)^0xA5A5A5A5A5A5A5A5, uint64(seed)^0x5A5A5A5A5A5A5A5A))
}

func makeContextFromOpts(opts Options) (*vitalsContext, *clock) {
	clk := newClock(opts.Now, opts.Days)
	vc := &vitalsContext{
		sleeps:   nil,
		workouts: computeWorkoutWindows(opts, clk),
	}
	return vc, clk
}

// fixedTSNow keeps these tests independent of wall-clock time.
var fixedTSNow = time.Date(2026, 5, 5, 12, 0, 0, 0, time.UTC)

func TestAlignUpToInterval(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		in       time.Time
		interval int
		want     time.Time
	}{
		{
			name:     "already aligned 15min",
			in:       time.Date(2026, 5, 5, 12, 0, 0, 0, time.UTC),
			interval: 15,
			want:     time.Date(2026, 5, 5, 12, 0, 0, 0, time.UTC),
		},
		{
			name:     "round up 15min",
			in:       time.Date(2026, 5, 5, 12, 1, 0, 0, time.UTC),
			interval: 15,
			want:     time.Date(2026, 5, 5, 12, 15, 0, 0, time.UTC),
		},
		{
			name:     "round up 15min near boundary",
			in:       time.Date(2026, 5, 5, 12, 14, 59, 0, time.UTC),
			interval: 15,
			want:     time.Date(2026, 5, 5, 12, 15, 0, 0, time.UTC),
		},
		{
			name:     "round up 30min",
			in:       time.Date(2026, 5, 5, 12, 10, 0, 0, time.UTC),
			interval: 30,
			want:     time.Date(2026, 5, 5, 12, 30, 0, 0, time.UTC),
		},
		{
			name:     "midnight boundary anchored to UTC 00:00",
			in:       time.Date(2026, 5, 5, 0, 5, 0, 0, time.UTC),
			interval: 15,
			want:     time.Date(2026, 5, 5, 0, 15, 0, 0, time.UTC),
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := alignUpToInterval(c.in, c.interval)
			if !got.Equal(c.want) {
				t.Errorf("alignUpToInterval(%v,%d) = %v; want %v", c.in, c.interval, got, c.want)
			}
		})
	}
}

func TestBuildHeartSamplesIsDeterministic(t *testing.T) {
	t.Parallel()
	opts := Options{UserID: 42, Days: 7, Seed: 1234, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	rng1 := makeTSRng(opts.Seed)
	rng2 := makeTSRng(opts.Seed)

	a := buildHeartSamples(opts, vc, rng1, clk.start, clk.anchor)
	b := buildHeartSamples(opts, vc, rng2, clk.start, clk.anchor)

	if len(a) != len(b) {
		t.Fatalf("sample counts differ: %d vs %d", len(a), len(b))
	}
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("same seed produced different HR samples")
	}
}

func TestBuildHeartSamplesValueRange(t *testing.T) {
	t.Parallel()
	opts := Options{UserID: 42, Days: 14, Seed: 7, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	samples := buildHeartSamples(opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)
	if len(samples) == 0 {
		t.Fatal("expected non-zero HR samples")
	}
	for _, s := range samples {
		if s.Value < 40 || s.Value > 200 {
			t.Errorf("HR out of spec: %d at %v", s.Value, s.DateTime)
		}
		if s.UserID != opts.UserID {
			t.Errorf("user_id=%d, want %d", s.UserID, opts.UserID)
		}
	}
}

func TestBuildHeartSamplesDensity(t *testing.T) {
	t.Parallel()
	opts := Options{UserID: 42, Days: 7, Seed: 7, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	samples := buildHeartSamples(opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)

	// Baseline cadence is 15 min waking, 30 min sleep. With no sleeps in vc,
	// every 15-min slot fires → ~96 samples/day. Allow some tolerance for
	// the window starting / ending mid-day.
	perDay := float64(len(samples)) / float64(opts.Days)
	if perDay < 80 || perDay > 100 {
		t.Errorf("HR samples per day = %.1f, want roughly 96", perDay)
	}
}

func TestBuildHeartSamplesSleepDip(t *testing.T) {
	t.Parallel()
	opts := Options{UserID: 42, Days: 7, Seed: 99, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)

	// Inject a full night of sleep on every day in the window so we have a
	// large bucket of sleep-window samples to compare against.
	for off := 0; off < opts.Days; off++ {
		day := clk.dayOffset(off)
		start := time.Date(day.Year(), day.Month(), day.Day(), 23, 0, 0, 0, time.UTC)
		end := start.Add(7 * time.Hour)
		vc.sleeps = append(vc.sleeps, sleepWindow{start: start, end: end})
	}

	samples := buildHeartSamples(opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)
	var sleepHR, wakingHR []int
	for _, s := range samples {
		if vc.inSleep(s.DateTime) {
			sleepHR = append(sleepHR, s.Value)
		} else {
			wakingHR = append(wakingHR, s.Value)
		}
	}
	if len(sleepHR) < 10 || len(wakingHR) < 10 {
		t.Fatalf("not enough samples to compare: sleep=%d waking=%d", len(sleepHR), len(wakingHR))
	}
	if med(sleepHR) >= med(wakingHR) {
		t.Errorf("expected sleep HR median (%d) to be lower than waking HR median (%d)",
			med(sleepHR), med(wakingHR))
	}
}

func TestBuildSpO2SamplesValueRange(t *testing.T) {
	t.Parallel()
	opts := Options{UserID: 42, Days: 14, Seed: 5, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	samples := buildSpO2Samples(opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)
	if len(samples) == 0 {
		t.Fatal("expected non-zero SpO2 samples")
	}
	for _, s := range samples {
		if s.Value < 85 || s.Value > 100 {
			t.Errorf("SpO2 out of spec: %d at %v", s.Value, s.DateTime)
		}
	}
}

func TestBuildSpO2SamplesIsDeterministic(t *testing.T) {
	t.Parallel()
	opts := Options{UserID: 42, Days: 7, Seed: 1234, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	a := buildSpO2Samples(opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)
	b := buildSpO2Samples(opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)
	if !reflect.DeepEqual(a, b) {
		t.Fatal("same seed produced different SpO2 samples")
	}
}

func TestBuildStressSamplesValueRange(t *testing.T) {
	t.Parallel()
	opts := Options{UserID: 42, Days: 14, Seed: 5, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	samples := buildStressSamples(opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)
	if len(samples) == 0 {
		t.Fatal("expected non-zero stress samples")
	}
	for _, s := range samples {
		if s.Value < 0 || s.Value > 100 {
			t.Errorf("stress out of spec: %d at %v", s.Value, s.DateTime)
		}
	}
}

func TestBuildStressSamplesIsDeterministic(t *testing.T) {
	t.Parallel()
	opts := Options{UserID: 42, Days: 7, Seed: 1234, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	a := buildStressSamples(opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)
	b := buildStressSamples(opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)
	if !reflect.DeepEqual(a, b) {
		t.Fatal("same seed produced different stress samples")
	}
}

func TestBuildStressSamplesSleepDip(t *testing.T) {
	t.Parallel()
	opts := Options{UserID: 42, Days: 7, Seed: 99, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	for off := 0; off < opts.Days; off++ {
		day := clk.dayOffset(off)
		start := time.Date(day.Year(), day.Month(), day.Day(), 23, 0, 0, 0, time.UTC)
		end := start.Add(7 * time.Hour)
		vc.sleeps = append(vc.sleeps, sleepWindow{start: start, end: end})
	}
	samples := buildStressSamples(opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)
	var sleepStress, wakingStress []int
	for _, s := range samples {
		if vc.inSleep(s.DateTime) {
			sleepStress = append(sleepStress, s.Value)
		} else {
			wakingStress = append(wakingStress, s.Value)
		}
	}
	if med(sleepStress) >= med(wakingStress) {
		t.Errorf("expected sleep stress median (%d) to be lower than waking median (%d)",
			med(sleepStress), med(wakingStress))
	}
}

func TestComputeWorkoutWindowsCoverScheduledAndAdHoc(t *testing.T) {
	t.Parallel()
	opts := Options{UserID: 42, Days: 90, Seed: 1, Now: fixedTSNow}
	clk := newClock(opts.Now, opts.Days)
	wins := computeWorkoutWindows(opts, clk)

	if len(wins) < 30 {
		t.Errorf("expected ≥30 workout windows in 90 days, got %d", len(wins))
	}
	for i := 1; i < len(wins); i++ {
		if wins[i].start.Before(wins[i-1].start) {
			t.Fatal("workout windows are not sorted ascending")
		}
	}

	// Each ad-hoc session should produce one window — easiest check is that
	// the total count is strictly larger than the scheduled-only count.
	scheduledOnly := 0
	for _, g := range []groupSpec{demoStrengthGroup, demoCardioGroup} {
		for off := 0; off < opts.Days; off++ {
			day := clk.dayOffset(off)
			for _, d := range g.daysOfWeek {
				if int(day.Weekday()) == d {
					scheduledOnly++
				}
			}
		}
	}
	if len(wins) != scheduledOnly+len(demoAdHocSessions) {
		t.Errorf("expected scheduled+adhoc = %d windows, got %d",
			scheduledOnly+len(demoAdHocSessions), len(wins))
	}
}

func TestVitalsContextInSleepInWorkout(t *testing.T) {
	t.Parallel()
	mid := time.Date(2026, 5, 5, 23, 30, 0, 0, time.UTC)
	wake := time.Date(2026, 5, 6, 6, 30, 0, 0, time.UTC)
	vc := &vitalsContext{
		sleeps: []sleepWindow{{start: mid, end: wake}},
		workouts: []workoutWindow{{
			start: time.Date(2026, 5, 5, 18, 0, 0, 0, time.UTC),
			end:   time.Date(2026, 5, 5, 19, 0, 0, 0, time.UTC),
		}},
	}
	if !vc.inSleep(time.Date(2026, 5, 6, 0, 0, 0, 0, time.UTC)) {
		t.Error("expected midnight to be inSleep")
	}
	if vc.inSleep(wake) {
		t.Error("end_time is exclusive — wake instant should not count as sleep")
	}
	if !vc.inWorkout(time.Date(2026, 5, 5, 18, 30, 0, 0, time.UTC)) {
		t.Error("expected 18:30 to be inWorkout")
	}
	if vc.inWorkout(time.Date(2026, 5, 5, 19, 0, 0, 0, time.UTC)) {
		t.Error("workout end is exclusive — 19:00 should not be inWorkout")
	}
}

func TestGenerateHeartSamplesPopulatesStore(t *testing.T) {
	t.Parallel()
	s := newTestStore(t)
	opts := Options{UserID: 4242, Days: 3, Seed: 11, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	n, err := generateHeartSamples(context.Background(), s, opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)
	if err != nil {
		t.Fatalf("generateHeartSamples: %v", err)
	}
	if n == 0 {
		t.Fatal("expected rows inserted")
	}
	if got := countRows(t, s.DB(), "vitals_heart"); got != n {
		t.Errorf("vitals_heart row count = %d, want %d", got, n)
	}
}

func TestGenerateSpO2SamplesPopulatesStore(t *testing.T) {
	t.Parallel()
	s := newTestStore(t)
	opts := Options{UserID: 4242, Days: 3, Seed: 11, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	n, err := generateSpO2Samples(context.Background(), s, opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)
	if err != nil {
		t.Fatalf("generateSpO2Samples: %v", err)
	}
	if n == 0 {
		t.Fatal("expected rows inserted")
	}
	if got := countRows(t, s.DB(), "vitals_spo2"); got != n {
		t.Errorf("vitals_spo2 row count = %d, want %d", got, n)
	}
}

func TestGenerateStressSamplesPopulatesStore(t *testing.T) {
	t.Parallel()
	s := newTestStore(t)
	opts := Options{UserID: 4242, Days: 3, Seed: 11, Now: fixedTSNow}
	vc, clk := makeContextFromOpts(opts)
	n, err := generateStressSamples(context.Background(), s, opts, vc, makeTSRng(opts.Seed), clk.start, clk.anchor)
	if err != nil {
		t.Fatalf("generateStressSamples: %v", err)
	}
	if n == 0 {
		t.Fatal("expected rows inserted")
	}
	if got := countRows(t, s.DB(), "vitals_stress"); got != n {
		t.Errorf("vitals_stress row count = %d, want %d", got, n)
	}
}

func TestFullSeedPopulatesVitalsTimeseries(t *testing.T) {
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

	if summary.HeartSamples == 0 {
		t.Error("summary.HeartSamples == 0; full seed should populate vitals_heart")
	}
	if summary.SpO2Samples == 0 {
		t.Error("summary.SpO2Samples == 0; full seed should populate vitals_spo2")
	}
	if summary.StressSamples == 0 {
		t.Error("summary.StressSamples == 0; full seed should populate vitals_stress")
	}
	if got := countRows(t, s.DB(), "vitals_heart"); got != summary.HeartSamples {
		t.Errorf("vitals_heart=%d, summary=%d", got, summary.HeartSamples)
	}
	if got := countRows(t, s.DB(), "vitals_spo2"); got != summary.SpO2Samples {
		t.Errorf("vitals_spo2=%d, summary=%d", got, summary.SpO2Samples)
	}
	if got := countRows(t, s.DB(), "vitals_stress"); got != summary.StressSamples {
		t.Errorf("vitals_stress=%d, summary=%d", got, summary.StressSamples)
	}
}

// med returns the median of an integer slice. Used in correlation smoke
// assertions so a single outlier doesn't trip the dip checks.
func med(xs []int) int {
	if len(xs) == 0 {
		return 0
	}
	cp := append([]int(nil), xs...)
	sort.Ints(cp)
	return cp[len(cp)/2]
}
