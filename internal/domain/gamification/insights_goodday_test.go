package gamification

// insights_goodday_test.go is the one integration test the plan's Testing
// Strategy calls for (docs/plans/2026-07-03-gamification-13-good-day-insight.md):
// the association-scan contract exercised through the real loaders → pairing
// logic → API shape boundary, mirroring insights_test.go's sleep→BP tests.

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	gamstore "github.com/korjavin/medicationtrackerbot/internal/store/gamification"
)

func TestGetInsights_GoodDay_PlantedWorkoutAssociation_ReportsFinding(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 1
	now := time.Date(2026, 7, 1, 15, 0, 0, 0, time.UTC)
	today := utcMidnight(now)
	outcomeStart := today.AddDate(0, 0, -89) // default 90-day window, inclusive of today

	var bp []store.BloodPressure
	var history []store.WorkoutSession
	wantWith, wantWithout := 0, 0
	for d := outcomeStart; !d.After(today); d = d.AddDate(0, 0, 1) {
		i := int(d.Sub(outcomeStart).Hours() / 24)
		prev := d.AddDate(0, 0, -1)
		var systolic int
		if i%2 == 0 {
			// Workout the day before -> in-band morning BP.
			completed := prev.Add(18 * time.Hour)
			history = append(history, store.WorkoutSession{Status: "completed", CompletedAt: &completed})
			systolic = 110
			wantWith++
		} else {
			// No workout the day before -> out-of-band morning BP.
			systolic = 140
			wantWithout++
		}
		bp = append(bp, store.BloodPressure{MeasuredAt: d.Add(8 * time.Hour), Systolic: systolic, Diastolic: 75})
	}

	gam := newMemGam()
	gam.state[userID] = gamstore.State{UserID: userID, Level: 7, InsightTier: 4}
	svc := newFullService(&fullStores{
		settings: fakeSettings{enabled: true},
		bp:       fakeBP{readings: bp},
		workout:  fakeWorkout{history: history},
		gam:      gam,
	})
	svc.now = func() time.Time { return now }

	view, err := svc.GetInsights(ctx, userID)
	if err != nil {
		t.Fatalf("GetInsights: %v", err)
	}
	if view.GoodDay == nil {
		t.Fatal("GoodDay is nil, want a computed insight")
	}
	got := *view.GoodDay
	if got.Locked {
		t.Fatalf("GoodDay = %+v, want Locked=false at tier 4", got)
	}
	if got.Status != InsightStatusEffect {
		t.Fatalf("Status = %q, want %q; findings=%+v insufficient=%+v", got.Status, InsightStatusEffect, got.Findings, got.Insufficient)
	}
	if len(got.Findings) == 0 {
		t.Fatal("Findings is empty, want the workout association")
	}
	f := got.Findings[0]
	if f.Behavior != GoodDayBehaviorWorkout {
		t.Errorf("top finding Behavior = %q, want %q (findings=%+v)", f.Behavior, GoodDayBehaviorWorkout, got.Findings)
	}
	if f.NWith != wantWith || f.NWithout != wantWithout {
		t.Errorf("NWith/NWithout = %d/%d, want %d/%d", f.NWith, f.NWithout, wantWith, wantWithout)
	}
	if math.Abs(f.RateWith-1) > 0.01 || math.Abs(f.RateWithout) > 0.01 {
		t.Errorf("RateWith/RateWithout = %v/%v, want ~1/~0", f.RateWith, f.RateWithout)
	}
	if math.Abs(f.DeltaPP-100) > 1 {
		t.Errorf("DeltaPP = %v, want ~100", f.DeltaPP)
	}
	if got.WindowDays != 90 {
		t.Errorf("WindowDays = %d, want 90", got.WindowDays)
	}
	if got.GoodDayDefinition == "" {
		t.Error("GoodDayDefinition is empty, want the user's band spelled out")
	}
}

func TestGetInsights_GoodDay_SparseWorkoutData_ReportsInsufficient(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 1
	now := time.Date(2026, 7, 1, 15, 0, 0, 0, time.UTC)
	today := utcMidnight(now)

	// Only 3 workout-preceded days logged (with in-band BP) — below the
	// default min-days-per-arm (10) — and no other days at all, so the
	// "without" arm is also empty.
	var bp []store.BloodPressure
	var history []store.WorkoutSession
	for i := 0; i < 3; i++ {
		d := today.AddDate(0, 0, -i)
		prev := d.AddDate(0, 0, -1)
		completed := prev.Add(18 * time.Hour)
		history = append(history, store.WorkoutSession{Status: "completed", CompletedAt: &completed})
		bp = append(bp, store.BloodPressure{MeasuredAt: d.Add(8 * time.Hour), Systolic: 110, Diastolic: 75})
	}

	gam := newMemGam()
	gam.state[userID] = gamstore.State{UserID: userID, Level: 7, InsightTier: 4}
	svc := newFullService(&fullStores{
		settings: fakeSettings{enabled: true},
		bp:       fakeBP{readings: bp},
		workout:  fakeWorkout{history: history},
		gam:      gam,
	})
	svc.now = func() time.Time { return now }

	view, err := svc.GetInsights(ctx, userID)
	if err != nil {
		t.Fatalf("GetInsights: %v", err)
	}
	if view.GoodDay == nil {
		t.Fatal("GoodDay is nil, want the insufficient-data result")
	}
	got := *view.GoodDay
	if got.Status != InsightStatusInsufficientData {
		t.Errorf("Status = %q, want %q", got.Status, InsightStatusInsufficientData)
	}
	if len(got.Findings) != 0 {
		t.Errorf("Findings = %+v, want none", got.Findings)
	}
	found := false
	for _, ins := range got.Insufficient {
		if ins.Behavior == GoodDayBehaviorWorkout {
			found = true
			if ins.NWith != 3 || ins.NWithout != 0 {
				t.Errorf("workout Insufficient = %+v, want NWith=3 NWithout=0", ins)
			}
			if ins.Needed != 10 {
				t.Errorf("Needed = %d, want 10 (default GoodDayMinDaysPerArm)", ins.Needed)
			}
		}
	}
	if !found {
		t.Errorf("Insufficient = %+v, want a %q entry", got.Insufficient, GoodDayBehaviorWorkout)
	}
}

func TestGetInsights_GoodDay_BelowTier4_LockedWhileSleepBPUnlocked(t *testing.T) {
	ctx := context.Background()
	const userID int64 = 1

	gam := newMemGam()
	gam.state[userID] = gamstore.State{UserID: userID, Level: 5, InsightTier: 3}
	svc := newFullService(&fullStores{settings: fakeSettings{enabled: true}, gam: gam})

	view, err := svc.GetInsights(ctx, userID)
	if err != nil {
		t.Fatalf("GetInsights: %v", err)
	}
	if view.Locked {
		t.Errorf("view.Locked = true, want false at tier 3 (SleepBP unlocked)")
	}
	if view.GoodDay == nil || !view.GoodDay.Locked {
		t.Fatalf("GoodDay = %+v, want Locked=true at tier 3", view.GoodDay)
	}
	if view.GoodDay.UnlocksAtLevel != 7 {
		t.Errorf("GoodDay.UnlocksAtLevel = %d, want 7", view.GoodDay.UnlocksAtLevel)
	}
}
