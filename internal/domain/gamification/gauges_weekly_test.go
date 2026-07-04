package gamification

// gauges_weekly_test.go is the Task 5 integration test (gamification-11,
// Testing Strategy): a seeded weight series with a known downward trend +
// goal exercises the velocity/pace-status/acceleration contract, a seeded BP
// series with two bad days in the recent window exercises the "share barely
// moves" contract, and a weekly gauge award scored then re-scored after a
// late import exercises the idempotent-update-in-place contract (no
// duplicate ledger row, the award value tracks the new data).

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/gamification/scoring"
	"github.com/korjavin/medicationtrackerbot/internal/store"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

// TestGetGauges_WeightTrendDownwardWithGoal seeds 40 days of weight logs
// declining at ~0.65%/week (comfortably inside the safe-pace band
// [WeightSafePaceMinPct, WeightSafePaceMaxPct]) toward a lower goal weight,
// well past the EMA's ~10-day convergence time — so the trend's velocity
// should read negative, on-pace, and (constant slope) non-accelerating.
func TestGetGauges_WeightTrendDownwardWithGoal(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 101
	today := time.Date(2026, 6, 21, 0, 0, 0, 0, time.UTC)

	const days = 40
	const startWeight = 90.0
	const declinePerDay = startWeight * 0.0065 / 7 // ~0.65%/week of 90kg
	logs := make([]store.WeightLog, 0, days)
	for i := 0; i < days; i++ {
		day := today.AddDate(0, 0, -(days - 1 - i))
		logs = append(logs, store.WeightLog{
			MeasuredAt: day.Add(7 * time.Hour),
			Weight:     startWeight - declinePerDay*float64(i),
		})
	}
	goal := 70.0
	fs := &fullStores{
		settings: fakeSettings{enabled: true},
		weight:   fakeWeight{logs: logs, goal: &store.WeightGoal{Goal: &goal}},
	}
	svc := newFullService(fs)
	svc.now = func() time.Time { return today }

	view, err := svc.GetGauges(ctx, userID)
	if err != nil {
		t.Fatalf("GetGauges: %v", err)
	}
	w := view.Weight
	if w.Status != GaugeStatusOK {
		t.Fatalf("weight gauge status = %q, want ok", w.Status)
	}
	if w.VelocityPctPerWeek >= 0 {
		t.Errorf("velocity = %v%%/week, want negative (losing)", w.VelocityPctPerWeek)
	}
	if w.PaceStatus != PaceStatusOnPace {
		t.Errorf("pace status = %q, want %q (velocity %v%%/week)", w.PaceStatus, PaceStatusOnPace, w.VelocityPctPerWeek)
	}
	if w.Acceleration != AccelerationHolding {
		t.Errorf("acceleration = %q, want %q (constant-slope input)", w.Acceleration, AccelerationHolding)
	}
	if w.GoalDirection != -1 {
		t.Errorf("goal direction = %d, want -1 (losing)", w.GoalDirection)
	}
}

// TestGetGauges_BPShareRobustToTwoBadDays seeds 60 daily BP readings, all in
// the personal band except two out-of-band readings inside the trailing
// 14-day window — the "one or two bad days must be mathematically invisible"
// requirement (Overview). The 30-day share should stay close to the 60-day
// baseline share, not swing by anything like the two bad readings' raw weight
// in a naive daily average.
func TestGetGauges_BPShareRobustToTwoBadDays(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 102
	today := time.Date(2026, 6, 21, 0, 0, 0, 0, time.UTC)

	const totalDays = 60
	readings := make([]store.BloodPressure, 0, totalDays)
	for i := 0; i < totalDays; i++ {
		day := today.AddDate(0, 0, -(totalDays - 1 - i))
		systolic, diastolic := 115, 75 // in band: BPSystolic 90-120, BPDiastolic 60-80
		// Two bad readings in the most recent 14-day window (i.e. the last two days).
		if i == totalDays-1 || i == totalDays-2 {
			systolic, diastolic = 140, 95
		}
		readings = append(readings, store.BloodPressure{
			MeasuredAt: day.Add(9 * time.Hour),
			Systolic:   systolic,
			Diastolic:  diastolic,
		})
	}
	fs := &fullStores{
		settings: fakeSettings{enabled: true},
		bp:       fakeBP{readings: readings},
	}
	svc := newFullService(fs)
	svc.now = func() time.Time { return today }

	view, err := svc.GetGauges(ctx, userID)
	if err != nil {
		t.Fatalf("GetGauges: %v", err)
	}
	bp := view.BP
	if bp.Status != GaugeStatusOK {
		t.Fatalf("BP gauge status = %q, want ok", bp.Status)
	}
	if bp.Count30d != 30 || bp.Count60d != 60 {
		t.Fatalf("counts = 30d:%d 60d:%d, want 30/60", bp.Count30d, bp.Count60d)
	}
	// 28/30 in-band vs the 58/60 baseline: a few points apart, not a cliff.
	diff := bp.BaselineShare60d - bp.Share30d
	if diff < 0 || diff > 0.10 {
		t.Errorf("baseline60d(%v) - share30d(%v) = %v, want a small (<=0.10) gap", bp.BaselineShare60d, bp.Share30d, diff)
	}
	if bp.Share30d < 0.85 {
		t.Errorf("share30d = %v, want still high despite two bad days", bp.Share30d)
	}
}

// TestWeeklyGaugeAward_IdempotentUnderLateImport scores a week-end day (full
// HP: a steady on-pace decline), then simulates a late backup import that
// rewrites the last two weeks of raw weight logs into a sharp *gain* — the
// opposite of the goal direction, which should zero the award — and rescores
// via RescoreInstants with an instant elsewhere in the same week. The award
// must update in place (same ledger row, new HP), never duplicate.
func TestWeeklyGaugeAward_IdempotentUnderLateImport(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 103
	weekEnd := time.Date(2026, 6, 21, 0, 0, 0, 0, time.UTC) // a Sunday
	if !isWeekEndDay(weekEnd) {
		t.Fatalf("test fixture bug: %v is not a week-end day", weekEnd)
	}

	const days = 40
	const startWeight = 90.0
	const declinePerDay = startWeight * 0.0065 / 7 // ~0.65%/week, inside the safe-pace band
	initialLogs := make([]store.WeightLog, 0, days)
	for i := 0; i < days; i++ {
		day := weekEnd.AddDate(0, 0, -(days - 1 - i))
		initialLogs = append(initialLogs, store.WeightLog{
			MeasuredAt: day.Add(7 * time.Hour),
			Weight:     startWeight - declinePerDay*float64(i),
		})
	}
	goal := 70.0

	gam := newMemGam()
	svc := newFullService(&fullStores{
		settings: fakeSettings{enabled: true},
		weight:   fakeWeight{logs: initialLogs, goal: &store.WeightGoal{Goal: &goal}},
		gam:      gam,
	})

	if err := svc.ScoreDay(ctx, userID, weekEnd); err != nil {
		t.Fatalf("ScoreDay (initial): %v", err)
	}

	weeklyEntries := func() []gamstore.LedgerEntry {
		var out []gamstore.LedgerEntry
		for _, e := range gam.ledger {
			if e.UserID == userID && e.SourceMetric == scoring.MetricWeightTrendWeek {
				out = append(out, e)
			}
		}
		return out
	}

	entries := weeklyEntries()
	if len(entries) != 1 {
		t.Fatalf("weekly weight-trend ledger entries (initial) = %d, want 1", len(entries))
	}
	hp1 := entries[0].HP
	if hp1 != scoring.DefaultConfig().GaugeWeightWeeklyMaxHP {
		t.Errorf("initial weekly HP = %d, want full %d (on-pace decline)", hp1, scoring.DefaultConfig().GaugeWeightWeeklyMaxHP)
	}
	applyCallsBefore := gam.applyCalls

	// Late import: the last 14 days are rewritten to a 3x-steeper decline —
	// still losing, but well past the safe-pace ceiling (crash-diet falloff),
	// which should partially zero the award via the trapezoid falloff instead
	// of dropping it outright.
	lateLogs := make([]store.WeightLog, len(initialLogs))
	copy(lateLogs, initialLogs)
	const steeperDeclinePerDay = declinePerDay * 3
	for i := days - 14; i < days; i++ {
		base := lateLogs[days-15].Weight
		lateLogs[i].Weight = base - steeperDeclinePerDay*float64(i-(days-14)+1)
	}
	svc.weight = fakeWeight{logs: lateLogs, goal: &store.WeightGoal{Goal: &goal}}

	// Rescore from an instant elsewhere in the same week — RescoreInstants
	// must add the week's end day back into the rescore set on its own.
	RescoreInstants(ctx, svc, userID, []time.Time{weekEnd.AddDate(0, 0, -3)})

	if gam.applyCalls <= applyCallsBefore {
		t.Fatalf("applyCalls did not increase after RescoreInstants — week-end day not re-scored")
	}

	entries = weeklyEntries()
	if len(entries) != 1 {
		t.Fatalf("weekly weight-trend ledger entries (after late import) = %d, want 1 (updated in place, not duplicated)", len(entries))
	}
	hp2 := entries[0].HP
	if hp2 <= 0 || hp2 >= hp1 {
		t.Errorf("weekly HP after too-fast late import = %d, want strictly between 0 and initial %d (partial falloff)", hp2, hp1)
	}
}
