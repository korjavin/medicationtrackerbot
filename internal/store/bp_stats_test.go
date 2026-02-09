package store

import (
	"context"
	"math"
	"testing"
	"time"
)

func TestGetBPDailyWeightedStats_TimeWeightedDailyAverages(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	userID := int64(1)

	fixedNow := time.Date(2025, 1, 10, 12, 0, 0, 0, time.UTC)
	origNow := nowFunc
	nowFunc = func() time.Time { return fixedNow }
	t.Cleanup(func() { nowFunc = origNow })

	base := time.Date(fixedNow.Year(), fixedNow.Month(), fixedNow.Day(), 10, 0, 0, 0, time.UTC)
	day1 := base.AddDate(0, 0, -2)
	day2 := base.AddDate(0, 0, -1)

	add := func(ts time.Time, sys, dia int) {
		t.Helper()
		_, err := db.CreateBloodPressureReading(ctx, &BloodPressure{
			UserID:     userID,
			MeasuredAt: ts,
			Systolic:   sys,
			Diastolic:  dia,
		})
		if err != nil {
			t.Fatalf("failed to insert reading: %v", err)
		}
	}

	// Day 1: 08:00 (120/80), 20:00 (160/100)
	add(time.Date(day1.Year(), day1.Month(), day1.Day(), 8, 0, 0, 0, time.UTC), 120, 80)
	add(time.Date(day1.Year(), day1.Month(), day1.Day(), 20, 0, 0, 0, time.UTC), 160, 100)

	// Day 2: 09:00 (110/70), 09:30 (150/95), 18:00 (120/80)
	add(time.Date(day2.Year(), day2.Month(), day2.Day(), 9, 0, 0, 0, time.UTC), 110, 70)
	add(time.Date(day2.Year(), day2.Month(), day2.Day(), 9, 30, 0, 0, time.UTC), 150, 95)
	add(time.Date(day2.Year(), day2.Month(), day2.Day(), 18, 0, 0, 0, time.UTC), 120, 80)

	stats, err := db.GetBPDailyWeightedStats(ctx, userID)
	if err != nil {
		t.Fatalf("failed to get stats: %v", err)
	}

	day1AvgSys := (12.0*120.0 + 4.0*160.0) / 16.0
	day1AvgDia := (12.0*80.0 + 4.0*100.0) / 16.0

	day2AvgSys := (0.5*110.0 + 8.5*150.0 + 6.0*120.0) / 15.0
	day2AvgDia := (0.5*70.0 + 8.5*95.0 + 6.0*80.0) / 15.0

	expectedSys := int(math.Round((day1AvgSys + day2AvgSys) / 2.0))
	expectedDia := int(math.Round((day1AvgDia + day2AvgDia) / 2.0))

	if stats.Stats30 == nil {
		t.Fatalf("expected stats_30 to be present")
	}
	if stats.Stats60 == nil {
		t.Fatalf("expected stats_60 to be present")
	}
	if stats.Stats14 == nil {
		t.Fatalf("expected stats_14 to be present")
	}

	for _, s := range []*BPPeriodStats{stats.Stats14, stats.Stats30, stats.Stats60} {
		if s.Systolic != expectedSys || s.Diastolic != expectedDia {
			t.Fatalf("unexpected averages: got %d/%d want %d/%d", s.Systolic, s.Diastolic, expectedSys, expectedDia)
		}
		if s.Days != 2 {
			t.Fatalf("unexpected days: got %d want 2", s.Days)
		}
		if s.Readings != 5 {
			t.Fatalf("unexpected readings: got %d want 5", s.Readings)
		}
	}
}

func TestGetBPDailyWeightedStats_TodayCappedAtNow(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	userID := int64(1)

	fixedNow := time.Date(2025, 1, 10, 12, 0, 0, 0, time.UTC)
	origNow := nowFunc
	nowFunc = func() time.Time { return fixedNow }
	t.Cleanup(func() { nowFunc = origNow })

	dayStart := time.Date(fixedNow.Year(), fixedNow.Month(), fixedNow.Day(), 0, 0, 0, 0, time.UTC)
	r1 := dayStart.Add(1 * time.Hour)
	r2 := dayStart.Add(2 * time.Hour)

	add := func(ts time.Time, sys, dia int) {
		t.Helper()
		_, err := db.CreateBloodPressureReading(ctx, &BloodPressure{
			UserID:     userID,
			MeasuredAt: ts,
			Systolic:   sys,
			Diastolic:  dia,
		})
		if err != nil {
			t.Fatalf("failed to insert reading: %v", err)
		}
	}

	add(r1, 120, 80)
	add(r2, 180, 110)

	stats, err := db.GetBPDailyWeightedStats(ctx, userID)
	if err != nil {
		t.Fatalf("failed to get stats: %v", err)
	}
	if stats.Stats14 == nil {
		t.Fatalf("expected stats_14 to be present")
	}

	dur1 := r2.Sub(r1).Seconds()
	dur2 := fixedNow.Sub(r2).Seconds()
	if dur2 <= 0 {
		t.Fatalf("expected now to be after second reading")
	}

	avgSys := (dur1*120.0 + dur2*180.0) / (dur1 + dur2)
	avgDia := (dur1*80.0 + dur2*110.0) / (dur1 + dur2)
	expectedSys := int(math.Round(avgSys))
	expectedDia := int(math.Round(avgDia))

	if stats.Stats14.Systolic != expectedSys || stats.Stats14.Diastolic != expectedDia {
		t.Fatalf("unexpected averages: got %d/%d want %d/%d", stats.Stats14.Systolic, stats.Stats14.Diastolic, expectedSys, expectedDia)
	}
	if stats.Stats14.Days != 1 {
		t.Fatalf("unexpected days: got %d want 1", stats.Stats14.Days)
	}
	if stats.Stats14.Readings != 2 {
		t.Fatalf("unexpected readings: got %d want 2", stats.Stats14.Readings)
	}
}

func TestGetBPDailyWeightedStats_NoCarryOverAcrossDays(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	userID := int64(1)

	fixedNow := time.Date(2025, 1, 10, 12, 0, 0, 0, time.UTC)
	origNow := nowFunc
	nowFunc = func() time.Time { return fixedNow }
	t.Cleanup(func() { nowFunc = origNow })

	day1 := time.Date(2025, 1, 8, 0, 0, 0, 0, time.UTC)
	day2 := time.Date(2025, 1, 9, 0, 0, 0, 0, time.UTC)

	add := func(ts time.Time, sys, dia int) {
		t.Helper()
		_, err := db.CreateBloodPressureReading(ctx, &BloodPressure{
			UserID:     userID,
			MeasuredAt: ts,
			Systolic:   sys,
			Diastolic:  dia,
		})
		if err != nil {
			t.Fatalf("failed to insert reading: %v", err)
		}
	}

	// Day 1: 23:00 high, Day 2: 09:00 normal.
	add(day1.Add(23*time.Hour), 160, 100)
	add(day2.Add(9*time.Hour), 120, 80)

	stats, err := db.GetBPDailyWeightedStats(ctx, userID)
	if err != nil {
		t.Fatalf("failed to get stats: %v", err)
	}
	if stats.Stats14 == nil {
		t.Fatalf("expected stats_14 to be present")
	}

	// Day 1: only 1 hour (23:00-24:00) at 160/100
	day1AvgSys := 160.0
	day1AvgDia := 100.0
	// Day 2: from 09:00 to 24:00 at 120/80
	day2AvgSys := 120.0
	day2AvgDia := 80.0

	expectedSys := int(math.Round((day1AvgSys + day2AvgSys) / 2.0))
	expectedDia := int(math.Round((day1AvgDia + day2AvgDia) / 2.0))

	if stats.Stats14.Systolic != expectedSys || stats.Stats14.Diastolic != expectedDia {
		t.Fatalf("unexpected averages: got %d/%d want %d/%d", stats.Stats14.Systolic, stats.Stats14.Diastolic, expectedSys, expectedDia)
	}
	if stats.Stats14.Days != 2 {
		t.Fatalf("unexpected days: got %d want 2", stats.Stats14.Days)
	}
	if stats.Stats14.Readings != 2 {
		t.Fatalf("unexpected readings: got %d want 2", stats.Stats14.Readings)
	}
}

func TestGetBPDailyWeightedStats_IgnoreCalcReadingsExcluded(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	userID := int64(1)

	fixedNow := time.Date(2025, 1, 10, 12, 0, 0, 0, time.UTC)
	origNow := nowFunc
	nowFunc = func() time.Time { return fixedNow }
	t.Cleanup(func() { nowFunc = origNow })

	day := time.Date(2025, 1, 9, 0, 0, 0, 0, time.UTC)

	_, err = db.CreateBloodPressureReading(ctx, &BloodPressure{
		UserID:     userID,
		MeasuredAt: day.Add(8 * time.Hour),
		Systolic:   120,
		Diastolic:  80,
	})
	if err != nil {
		t.Fatalf("failed to insert reading: %v", err)
	}

	_, err = db.CreateBloodPressureReading(ctx, &BloodPressure{
		UserID:     userID,
		MeasuredAt: day.Add(12 * time.Hour),
		Systolic:   180,
		Diastolic:  110,
		IgnoreCalc: true,
	})
	if err != nil {
		t.Fatalf("failed to insert ignored reading: %v", err)
	}

	stats, err := db.GetBPDailyWeightedStats(ctx, userID)
	if err != nil {
		t.Fatalf("failed to get stats: %v", err)
	}
	if stats.Stats14 == nil {
		t.Fatalf("expected stats_14 to be present")
	}

	// Only the non-ignored reading should be used.
	if stats.Stats14.Systolic != 120 || stats.Stats14.Diastolic != 80 {
		t.Fatalf("unexpected averages: got %d/%d want 120/80", stats.Stats14.Systolic, stats.Stats14.Diastolic)
	}
	if stats.Stats14.Readings != 1 {
		t.Fatalf("unexpected readings: got %d want 1", stats.Stats14.Readings)
	}
}

func TestGetBPDailyWeightedStats_SameTimestampUsesLast(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	userID := int64(1)

	fixedNow := time.Date(2025, 1, 10, 12, 0, 0, 0, time.UTC)
	origNow := nowFunc
	nowFunc = func() time.Time { return fixedNow }
	t.Cleanup(func() { nowFunc = origNow })

	day := time.Date(2025, 1, 9, 0, 0, 0, 0, time.UTC)
	t1 := day.Add(8 * time.Hour)
	t2 := day.Add(20 * time.Hour)

	add := func(ts time.Time, sys, dia int) {
		t.Helper()
		_, err := db.CreateBloodPressureReading(ctx, &BloodPressure{
			UserID:     userID,
			MeasuredAt: ts,
			Systolic:   sys,
			Diastolic:  dia,
		})
		if err != nil {
			t.Fatalf("failed to insert reading: %v", err)
		}
	}

	// Two readings at the same timestamp; last should win for the interval to 20:00.
	add(t1, 120, 80)
	add(t1, 160, 100)
	add(t2, 120, 80)

	stats, err := db.GetBPDailyWeightedStats(ctx, userID)
	if err != nil {
		t.Fatalf("failed to get stats: %v", err)
	}
	if stats.Stats14 == nil {
		t.Fatalf("expected stats_14 to be present")
	}

	dayAvgSys := (12.0*160.0 + 4.0*120.0) / 16.0
	dayAvgDia := (12.0*100.0 + 4.0*80.0) / 16.0
	expectedSys := int(math.Round(dayAvgSys))
	expectedDia := int(math.Round(dayAvgDia))

	if stats.Stats14.Systolic != expectedSys || stats.Stats14.Diastolic != expectedDia {
		t.Fatalf("unexpected averages: got %d/%d want %d/%d", stats.Stats14.Systolic, stats.Stats14.Diastolic, expectedSys, expectedDia)
	}
}

func TestGetBPDailyWeightedStats_PartialPeriodOnlyIn60Days(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	userID := int64(1)

	fixedNow := time.Date(2025, 1, 10, 12, 0, 0, 0, time.UTC)
	origNow := nowFunc
	nowFunc = func() time.Time { return fixedNow }
	t.Cleanup(func() { nowFunc = origNow })

	day := fixedNow.AddDate(0, 0, -40)
	readingTime := time.Date(day.Year(), day.Month(), day.Day(), 9, 0, 0, 0, time.UTC)

	_, err = db.CreateBloodPressureReading(ctx, &BloodPressure{
		UserID:     userID,
		MeasuredAt: readingTime,
		Systolic:   130,
		Diastolic:  85,
	})
	if err != nil {
		t.Fatalf("failed to insert reading: %v", err)
	}

	stats, err := db.GetBPDailyWeightedStats(ctx, userID)
	if err != nil {
		t.Fatalf("failed to get stats: %v", err)
	}

	if stats.Stats14 != nil {
		t.Fatalf("expected stats_14 to be nil")
	}
	if stats.Stats30 != nil {
		t.Fatalf("expected stats_30 to be nil")
	}
	if stats.Stats60 == nil {
		t.Fatalf("expected stats_60 to be present")
	}
	if stats.Stats60.Systolic != 130 || stats.Stats60.Diastolic != 85 {
		t.Fatalf("unexpected averages: got %d/%d want 130/85", stats.Stats60.Systolic, stats.Stats60.Diastolic)
	}
	if stats.Stats60.Days != 1 {
		t.Fatalf("unexpected days: got %d want 1", stats.Stats60.Days)
	}
}
