package seeddemo

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"sort"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// sleepWindow is one sleep block in UTC. The continuous HR / SpO2 / stress
// generators dip values inside these windows so the demo Vitals tab shows
// the same nighttime pattern a real wearable would record.
type sleepWindow struct {
	start, end time.Time
}

// workoutWindow is one workout block in UTC. The HR / stress generators add
// a spike inside these windows. Width covers the scheduled session plus a
// short cooldown tail so post-workout HR elevation is visible on the chart.
type workoutWindow struct {
	start, end time.Time
}

// vitalsContext bundles the seeded sleep + workout windows so the three
// continuous-vitals generators can correlate samples without re-querying the
// store. Both slices are expected to be sorted ascending by start; the
// helpers below assume that ordering.
type vitalsContext struct {
	sleeps   []sleepWindow
	workouts []workoutWindow
}

// inSleep reports whether t falls inside any seeded sleep window. The
// inclusive-start / exclusive-end convention matches how sleep_logs is
// queried elsewhere (end_time is the wake instant, not the last in-bed
// sample).
func (vc *vitalsContext) inSleep(t time.Time) bool {
	for _, w := range vc.sleeps {
		if !t.Before(w.start) && t.Before(w.end) {
			return true
		}
	}
	return false
}

// inWorkout reports whether t falls inside any seeded workout window.
func (vc *vitalsContext) inWorkout(t time.Time) bool {
	for _, w := range vc.workouts {
		if !t.Before(w.start) && t.Before(w.end) {
			return true
		}
	}
	return false
}

// computeWorkoutWindows derives the workout windows from the static demo
// specs without consuming the shared rng. The full-seed and top-up paths
// share this so they agree on when HR should spike.
//
// Window width is fixed (60 min for scheduled groups, 45 min for ad-hoc)
// rather than read from the rng-driven session outcome — for HR purposes
// the wearable would still record an elevated reading during the slot
// whether the user finished the planned workout or stopped early.
func computeWorkoutWindows(opts Options, clk *clock) []workoutWindow {
	groups := []groupSpec{demoStrengthGroup, demoCardioGroup}
	out := make([]workoutWindow, 0, opts.Days)

	for _, g := range groups {
		dow := make(map[int]bool, len(g.daysOfWeek))
		for _, d := range g.daysOfWeek {
			dow[d] = true
		}
		for off := 0; off < opts.Days; off++ {
			day := clk.dayOffset(off)
			if !dow[int(day.Weekday())] {
				continue
			}
			start, ok := timeOfDay(day, g.scheduledTime)
			if !ok {
				continue
			}
			out = append(out, workoutWindow{
				start: start,
				end:   start.Add(60 * time.Minute),
			})
		}
	}

	for _, ah := range demoAdHocSessions {
		if ah.dayOffset >= opts.Days {
			continue
		}
		off := opts.Days - ah.dayOffset
		if off < 0 || off >= opts.Days {
			continue
		}
		day := clk.dayOffset(off)
		start := time.Date(day.Year(), day.Month(), day.Day(), ah.hour, ah.minute, 0, 0, time.UTC)
		out = append(out, workoutWindow{
			start: start,
			end:   start.Add(45 * time.Minute),
		})
	}

	sort.Slice(out, func(i, j int) bool { return out[i].start.Before(out[j].start) })
	return out
}

// alignUpToInterval returns the next time-of-day boundary at or after t
// where the minute-of-day is a multiple of intervalMinutes. The result is
// anchored to 00:00 UTC of the same calendar day as t — two top-ups that
// fire at different wall-clock times within one interval window still emit
// samples at the same exact instants, which combined with the (user_id,
// date_time) PK makes the time-series tables idempotent on retry.
func alignUpToInterval(t time.Time, intervalMinutes int) time.Time {
	if intervalMinutes <= 0 {
		return t
	}
	t = t.UTC().Truncate(time.Second)
	midnight := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	delta := t.Sub(midnight)
	step := time.Duration(intervalMinutes) * time.Minute
	stepsFromMidnight := delta / step
	candidate := midnight.Add(stepsFromMidnight * step)
	if candidate.Before(t) {
		candidate = candidate.Add(step)
	}
	return candidate
}

// generateHeartSamples emits heart-rate samples in [from, to] at a 15-min
// waking / 30-min sleeping cadence anchored to 00:00 UTC. Baseline drifts
// around 65 bpm with a small diurnal component; sleep windows dip the
// baseline by ~12 bpm, workout windows lift it by 20–40 bpm.
//
// Returns the number of rows actually inserted (excluding PK collisions
// dropped by INSERT OR IGNORE).
func generateHeartSamples(ctx context.Context, s *store.Store, opts Options, vc *vitalsContext, rng *rand.Rand, from, to time.Time) (int, error) {
	logs := buildHeartSamples(opts, vc, rng, from, to)
	if len(logs) == 0 {
		return 0, nil
	}
	imported, _, err := s.Vitals.ImportVitals(ctx, opts.UserID, logs, nil, nil)
	if err != nil {
		return 0, fmt.Errorf("import heart: %w", err)
	}
	return imported, nil
}

// generateSpO2Samples emits blood-oxygen samples in [from, to] at a 15-min
// cadence anchored to 00:00 UTC. Baseline 97 with ±1 noise, occasional
// dips to 92–94 (slightly more likely during sleep).
func generateSpO2Samples(ctx context.Context, s *store.Store, opts Options, vc *vitalsContext, rng *rand.Rand, from, to time.Time) (int, error) {
	logs := buildSpO2Samples(opts, vc, rng, from, to)
	if len(logs) == 0 {
		return 0, nil
	}
	imported, _, err := s.Vitals.ImportVitals(ctx, opts.UserID, nil, logs, nil)
	if err != nil {
		return 0, fmt.Errorf("import spo2: %w", err)
	}
	return imported, nil
}

// generateStressSamples emits stress samples in [from, to] at a 30-min
// cadence anchored to 00:00 UTC. Baseline 40 with diurnal modulation;
// sleep windows pull it down to 20–40, workouts and meal boundaries push
// it up to 60–80.
func generateStressSamples(ctx context.Context, s *store.Store, opts Options, vc *vitalsContext, rng *rand.Rand, from, to time.Time) (int, error) {
	logs := buildStressSamples(opts, vc, rng, from, to)
	if len(logs) == 0 {
		return 0, nil
	}
	imported, _, err := s.Vitals.ImportVitals(ctx, opts.UserID, nil, nil, logs)
	if err != nil {
		return 0, fmt.Errorf("import stress: %w", err)
	}
	return imported, nil
}

// buildHeartSamples is the value-only side of generateHeartSamples; isolated
// so unit tests can assert sample shape without spinning up a store.
func buildHeartSamples(opts Options, vc *vitalsContext, rng *rand.Rand, from, to time.Time) []store.VitalsHeartLog {
	if !from.Before(to) {
		return nil
	}
	out := make([]store.VitalsHeartLog, 0, 96*opts.Days)
	for t := alignUpToInterval(from, 15); !t.After(to); t = t.Add(15 * time.Minute) {
		inSleep := vc.inSleep(t)
		// During sleep we emit at 30-min cadence, so skip the 15-min slots
		// that aren't aligned to 30 min.
		if inSleep && t.Minute()%30 != 0 {
			continue
		}

		hourFrac := float64(t.Hour()) + float64(t.Minute())/60
		baseline := 65.0 + 3.0*math.Sin(2*math.Pi*(hourFrac-3)/24) // small diurnal bump

		if inSleep {
			baseline -= 12 // 50-ish median during sleep
		}
		if vc.inWorkout(t) {
			baseline += 20 + 20*rng.Float64() // 20-40 bpm spike
		}
		value := int(baseline + gaussian(rng, 0, 2) + 0.5)
		if value < 40 {
			value = 40
		}
		if value > 200 {
			value = 200
		}

		out = append(out, store.VitalsHeartLog{
			UserID:   opts.UserID,
			DateTime: t,
			TzOffset: tzOffsetForTime(t, opts),
			Value:    value,
			Type:     0,
		})
	}
	return out
}

// buildSpO2Samples is the value-only side of generateSpO2Samples.
func buildSpO2Samples(opts Options, vc *vitalsContext, rng *rand.Rand, from, to time.Time) []store.VitalsSpO2Log {
	if !from.Before(to) {
		return nil
	}
	out := make([]store.VitalsSpO2Log, 0, 96*opts.Days)
	for t := alignUpToInterval(from, 15); !t.After(to); t = t.Add(15 * time.Minute) {
		inSleep := vc.inSleep(t)
		base := 97.0 + gaussian(rng, 0, 0.5)
		// Cosmetic dips: ~3% during sleep, ~1% awake.
		dipChance := 0.01
		if inSleep {
			dipChance = 0.03
		}
		if rng.Float64() < dipChance {
			base = 92 + 2*rng.Float64() // 92..94
		}
		value := int(base + 0.5)
		if value < 85 {
			value = 85
		}
		if value > 100 {
			value = 100
		}
		out = append(out, store.VitalsSpO2Log{
			UserID:   opts.UserID,
			DateTime: t,
			TzOffset: tzOffsetForTime(t, opts),
			Value:    value,
			Type:     0,
		})
	}
	return out
}

// buildStressSamples is the value-only side of generateStressSamples.
func buildStressSamples(opts Options, vc *vitalsContext, rng *rand.Rand, from, to time.Time) []store.VitalsStressLog {
	if !from.Before(to) {
		return nil
	}
	out := make([]store.VitalsStressLog, 0, 48*opts.Days)
	for t := alignUpToInterval(from, 30); !t.After(to); t = t.Add(30 * time.Minute) {
		inSleep := vc.inSleep(t)
		hourFrac := float64(t.Hour()) + float64(t.Minute())/60
		baseline := 40.0 + 8.0*math.Sin(2*math.Pi*(hourFrac-9)/24)

		if inSleep {
			baseline = 20 + 20*rng.Float64() // 20..40 nighttime
		}
		if vc.inWorkout(t) {
			baseline = math.Max(baseline, 60+20*rng.Float64()) // 60..80
		} else if isMealSlot(t) {
			baseline = math.Max(baseline, 50+15*rng.Float64()) // 50..65 around meals
		}
		value := int(baseline + gaussian(rng, 0, 3) + 0.5)
		if value < 0 {
			value = 0
		}
		if value > 100 {
			value = 100
		}
		out = append(out, store.VitalsStressLog{
			UserID:   opts.UserID,
			DateTime: t,
			TzOffset: tzOffsetForTime(t, opts),
			Value:    value,
			Type:     0,
		})
	}
	return out
}

// isMealSlot reports whether t lands within 30 min of a typical meal hour
// (08:00, 13:00, 19:00). The stress generator uses this so peri-meal stress
// samples sit slightly above baseline, mirroring a real wearable's "you
// just ate" inference.
func isMealSlot(t time.Time) bool {
	hour := t.Hour()
	minute := t.Minute()
	for _, m := range []int{8, 13, 19} {
		if hour == m && minute <= 30 {
			return true
		}
		if hour == m-1 && minute >= 30 {
			return true
		}
	}
	return false
}

// tzOffsetForTime maps a UTC instant back to the JS-style minutes-west-of-UTC
// the wearable would have stamped on the sample. Mirrors the same time
// partitioning generateSleep uses via tzOffsetMinutesAtDay.
func tzOffsetForTime(t time.Time, opts Options) int {
	if opts.Now.IsZero() {
		return 0
	}
	daysFromAnchor := int(opts.Now.UTC().Sub(t).Hours() / 24)
	if daysFromAnchor < 0 {
		daysFromAnchor = 0
	}
	return tzOffsetMinutesAtDay(daysFromAnchor)
}
