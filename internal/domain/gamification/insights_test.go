package gamification

// insights_test.go is the one integration test the plan's Testing Strategy
// calls for (docs/plans/2026-07-02-gamification-9-first-insight.md): the
// insight contract, exercised through the real loaders → pairing logic → API
// shape boundary (fakeBP/fakeVitals → computeSleepBPInsight → InsightsView),
// not the pure math in isolation.

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

func TestGetInsights_CorrelatedData_ReportsEffect(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 1
	now := time.Date(2026, 7, 1, 15, 0, 0, 0, time.UTC)
	today := utcMidnight(now)
	start := today.AddDate(0, 0, -89) // 90-day window, inclusive of today

	var sleep []store.SleepLog
	var bp []store.BloodPressure
	wantShort, wantInBand := 0, 0
	for d := start; !d.After(today); d = d.AddDate(0, 0, 1) {
		dayStr := d.Format("2006-01-02")
		i := int(d.Sub(start).Hours() / 24)
		var totalMinutes int
		var systolic int
		if i%2 == 0 {
			totalMinutes, systolic = 6*60, 118 // short night (< 7h band floor)
			wantShort++
		} else {
			totalMinutes, systolic = 8*60, 110 // in-band night
			wantInBand++
		}
		sleep = append(sleep, store.SleepLog{Day: dayStr, StartTime: d.Add(-8 * time.Hour), TotalMinutes: &totalMinutes})
		bp = append(bp, store.BloodPressure{MeasuredAt: d.Add(8 * time.Hour), Systolic: systolic, Diastolic: 75})
	}

	gam := newMemGam()
	gam.state[userID] = gamstore.State{UserID: userID, Level: 5, InsightTier: 3}
	svc := newFullService(&fullStores{
		settings: fakeSettings{enabled: true},
		bp:       fakeBP{readings: bp},
		vitals:   fakeVitals{sleep: sleep},
		gam:      gam,
	})
	svc.now = func() time.Time { return now }

	view, err := svc.GetInsights(ctx, userID)
	if err != nil {
		t.Fatalf("GetInsights: %v", err)
	}
	if !view.Enabled || view.Locked {
		t.Fatalf("view = %+v, want Enabled=true Locked=false", view)
	}
	if view.SleepBP == nil {
		t.Fatal("SleepBP is nil, want a computed insight")
	}
	got := *view.SleepBP
	if got.Status != InsightStatusEffect {
		t.Errorf("Status = %q, want %q", got.Status, InsightStatusEffect)
	}
	if got.NShort != wantShort || got.NInBand != wantInBand {
		t.Errorf("NShort/NInBand = %d/%d, want %d/%d", got.NShort, got.NInBand, wantShort, wantInBand)
	}
	if math.Abs(got.DeltaSystolic-8) > 0.01 {
		t.Errorf("DeltaSystolic = %v, want ~8", got.DeltaSystolic)
	}
	if got.WindowDays != 90 {
		t.Errorf("WindowDays = %d, want 90", got.WindowDays)
	}
	if got.ShortThresholdHours != 7 {
		t.Errorf("ShortThresholdHours = %v, want 7 (default SleepHours.Low)", got.ShortThresholdHours)
	}
}

func TestGetInsights_SparseData_ReportsInsufficientData(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 1
	now := time.Date(2026, 7, 1, 15, 0, 0, 0, time.UTC)
	today := utcMidnight(now)

	// Only 5 paired short nights — below the default min-pairs-per-bucket (8)
	// — and zero in-band nights.
	var sleep []store.SleepLog
	var bp []store.BloodPressure
	for i := 0; i < 5; i++ {
		d := today.AddDate(0, 0, -i)
		dayStr := d.Format("2006-01-02")
		totalMinutes := 6 * 60
		sleep = append(sleep, store.SleepLog{Day: dayStr, StartTime: d.Add(-8 * time.Hour), TotalMinutes: &totalMinutes})
		bp = append(bp, store.BloodPressure{MeasuredAt: d.Add(8 * time.Hour), Systolic: 118, Diastolic: 75})
	}

	gam := newMemGam()
	gam.state[userID] = gamstore.State{UserID: userID, Level: 5, InsightTier: 3}
	svc := newFullService(&fullStores{
		settings: fakeSettings{enabled: true},
		bp:       fakeBP{readings: bp},
		vitals:   fakeVitals{sleep: sleep},
		gam:      gam,
	})
	svc.now = func() time.Time { return now }

	view, err := svc.GetInsights(ctx, userID)
	if err != nil {
		t.Fatalf("GetInsights: %v", err)
	}
	if view.SleepBP == nil {
		t.Fatal("SleepBP is nil, want the insufficient_data result")
	}
	got := *view.SleepBP
	if got.Status != InsightStatusInsufficientData {
		t.Errorf("Status = %q, want %q", got.Status, InsightStatusInsufficientData)
	}
	if got.NShort != 5 || got.NInBand != 0 {
		t.Errorf("NShort/NInBand = %d/%d, want 5/0", got.NShort, got.NInBand)
	}
	if got.Needed != 8 {
		t.Errorf("Needed = %d, want 8 (default InsightMinPairsPerBucket)", got.Needed)
	}
}

func TestGetInsights_BelowTier_ReturnsLockedWithoutData(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 1

	gam := newMemGam()
	gam.state[userID] = gamstore.State{UserID: userID, Level: 3, InsightTier: 2}
	svc := newFullService(&fullStores{settings: fakeSettings{enabled: true}, gam: gam})

	view, err := svc.GetInsights(ctx, userID)
	if err != nil {
		t.Fatalf("GetInsights: %v", err)
	}
	if !view.Enabled || !view.Locked {
		t.Fatalf("view = %+v, want Enabled=true Locked=true", view)
	}
	if view.UnlocksAtLevel != 5 {
		t.Errorf("UnlocksAtLevel = %d, want 5", view.UnlocksAtLevel)
	}
	if view.SleepBP != nil {
		t.Errorf("SleepBP = %+v, want nil below the unlock tier", view.SleepBP)
	}
}
