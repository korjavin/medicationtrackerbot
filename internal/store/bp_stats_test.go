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

func TestBPStats_FrequentHighBPDayVsSparseNormal(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	userID := int64(1)

	fixedNow := time.Date(2025, 1, 10, 23, 0, 0, 0, time.UTC)
	origNow := nowFunc
	nowFunc = func() time.Time { return fixedNow }
	t.Cleanup(func() { nowFunc = origNow })

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

	// Days 1-3: 1 normal reading each at 09:00 (120/80)
	for _, dayOffset := range []int{-4, -3, -2} {
		d := fixedNow.AddDate(0, 0, dayOffset)
		add(time.Date(d.Year(), d.Month(), d.Day(), 9, 0, 0, 0, time.UTC), 120, 80)
	}

	// Day 4 (yesterday): 5 high readings over 2 hours starting at 10:00
	day4 := fixedNow.AddDate(0, 0, -1)
	for i := 0; i < 5; i++ {
		add(time.Date(day4.Year(), day4.Month(), day4.Day(), 10, i*30, 0, 0, time.UTC), 150-i*2, 95-i)
	}

	stats, err := db.GetBPDailyWeightedStats(ctx, userID)
	if err != nil {
		t.Fatalf("failed to get stats: %v", err)
	}
	if stats.Stats14 == nil {
		t.Fatalf("expected stats_14 to be present")
	}

	// Each day gets equal weight. 3 days at ~120/80, 1 day at ~145/92 area.
	// Naive mean of 8 readings would be ~133.8. Daily-weighted should be ~127 area.
	if stats.Stats14.Days != 4 {
		t.Fatalf("expected 4 days, got %d", stats.Stats14.Days)
	}
	// The 5 high-BP readings should NOT dominate: period avg should be closer to 120 than 150.
	if stats.Stats14.Systolic > 135 {
		t.Fatalf("frequency bias detected: systolic %d > 135 (5 high readings should not dominate 3 normal days)", stats.Stats14.Systolic)
	}
	if stats.Stats14.Systolic < 120 {
		t.Fatalf("unexpected systolic too low: %d < 120", stats.Stats14.Systolic)
	}
}

func TestBPStats_SingleReadingPerDay(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	userID := int64(1)

	fixedNow := time.Date(2025, 1, 10, 23, 0, 0, 0, time.UTC)
	origNow := nowFunc
	nowFunc = func() time.Time { return fixedNow }
	t.Cleanup(func() { nowFunc = origNow })

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

	// 5 days, each with exactly 1 reading at different times
	readings := []struct {
		dayOffset int
		hour      int
		sys, dia  int
	}{
		{-5, 8, 110, 70},
		{-4, 12, 120, 80},
		{-3, 17, 130, 85},
		{-2, 9, 125, 78},
		{-1, 21, 115, 72},
	}

	for _, r := range readings {
		d := fixedNow.AddDate(0, 0, r.dayOffset)
		add(time.Date(d.Year(), d.Month(), d.Day(), r.hour, 0, 0, 0, time.UTC), r.sys, r.dia)
	}

	stats, err := db.GetBPDailyWeightedStats(ctx, userID)
	if err != nil {
		t.Fatalf("failed to get stats: %v", err)
	}
	if stats.Stats14 == nil {
		t.Fatalf("expected stats_14 to be present")
	}

	// With 1 reading per day, each day's average equals its reading value.
	// Period average = simple mean of all 5 readings.
	expectedSys := int(math.Round((110 + 120 + 130 + 125 + 115) / 5.0))
	expectedDia := int(math.Round((70 + 80 + 85 + 78 + 72) / 5.0))

	if stats.Stats14.Systolic != expectedSys {
		t.Fatalf("systolic: got %d want %d", stats.Stats14.Systolic, expectedSys)
	}
	if stats.Stats14.Diastolic != expectedDia {
		t.Fatalf("diastolic: got %d want %d", stats.Stats14.Diastolic, expectedDia)
	}
	if stats.Stats14.Days != 5 {
		t.Fatalf("days: got %d want 5", stats.Stats14.Days)
	}
}

func TestBPStats_LongGapBetweenDays(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	userID := int64(1)

	fixedNow := time.Date(2025, 2, 15, 12, 0, 0, 0, time.UTC)
	origNow := nowFunc
	nowFunc = func() time.Time { return fixedNow }
	t.Cleanup(func() { nowFunc = origNow })

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

	// Reading on day 1 (50 days ago - only in 60-day window) and day today
	day1 := fixedNow.AddDate(0, 0, -50)
	add(time.Date(day1.Year(), day1.Month(), day1.Day(), 9, 0, 0, 0, time.UTC), 140, 90)
	add(time.Date(fixedNow.Year(), fixedNow.Month(), fixedNow.Day(), 8, 0, 0, 0, time.UTC), 110, 70)

	stats, err := db.GetBPDailyWeightedStats(ctx, userID)
	if err != nil {
		t.Fatalf("failed to get stats: %v", err)
	}

	// 14-day window: only today's reading
	if stats.Stats14 == nil {
		t.Fatalf("expected stats_14 to be present")
	}
	if stats.Stats14.Days != 1 {
		t.Fatalf("stats_14 days: got %d want 1", stats.Stats14.Days)
	}
	if stats.Stats14.Systolic != 110 {
		t.Fatalf("stats_14 systolic: got %d want 110", stats.Stats14.Systolic)
	}

	// 60-day window: both days contribute equally
	if stats.Stats60 == nil {
		t.Fatalf("expected stats_60 to be present")
	}
	if stats.Stats60.Days != 2 {
		t.Fatalf("stats_60 days: got %d want 2", stats.Stats60.Days)
	}
	expectedSys60 := int(math.Round((140 + 110) / 2.0))
	expectedDia60 := int(math.Round((90 + 70) / 2.0))
	if stats.Stats60.Systolic != expectedSys60 || stats.Stats60.Diastolic != expectedDia60 {
		t.Fatalf("stats_60 averages: got %d/%d want %d/%d", stats.Stats60.Systolic, stats.Stats60.Diastolic, expectedSys60, expectedDia60)
	}
}

func TestBPStats_ManyReadingsInShortBurst(t *testing.T) {
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	userID := int64(1)

	fixedNow := time.Date(2025, 1, 10, 23, 0, 0, 0, time.UTC)
	origNow := nowFunc
	nowFunc = func() time.Time { return fixedNow }
	t.Cleanup(func() { nowFunc = origNow })

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

	// Day 1 (yesterday): 10 readings in 30 minutes starting at 09:00 (high BP)
	day1 := fixedNow.AddDate(0, 0, -1)
	for i := 0; i < 10; i++ {
		add(time.Date(day1.Year(), day1.Month(), day1.Day(), 9, i*3, 0, 0, time.UTC), 155, 98)
	}

	// Day 2 (today): 1 reading at 09:00 (normal)
	add(time.Date(fixedNow.Year(), fixedNow.Month(), fixedNow.Day(), 9, 0, 0, 0, time.UTC), 118, 75)

	stats, err := db.GetBPDailyWeightedStats(ctx, userID)
	if err != nil {
		t.Fatalf("failed to get stats: %v", err)
	}
	if stats.Stats14 == nil {
		t.Fatalf("expected stats_14 to be present")
	}

	if stats.Stats14.Days != 2 {
		t.Fatalf("days: got %d want 2", stats.Stats14.Days)
	}
	// With daily weighting: (155 + 118) / 2 ≈ 137
	// Without daily weighting (naive): (10*155 + 118) / 11 ≈ 151.6
	// The burst day must NOT dominate.
	expectedSys := int(math.Round((155 + 118) / 2.0))
	if absDiff(stats.Stats14.Systolic, expectedSys) > 2 {
		t.Fatalf("burst day dominates: systolic %d, expected ~%d (tolerance ±2)", stats.Stats14.Systolic, expectedSys)
	}
	if stats.Stats14.Readings != 11 {
		t.Fatalf("readings: got %d want 11", stats.Stats14.Readings)
	}
}

func absDiff(a, b int) int {
	if a > b {
		return a - b
	}
	return b - a
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
