package store

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"testing"
	"time"
)

func setupWeightTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func float64Ptr(v float64) *float64 {
	return &v
}

func TestCreateWeightLogAllFields(t *testing.T) {
	db := setupWeightTestStore(t)
	ctx := context.Background()

	now := time.Now().UTC().Truncate(time.Second)
	w := &WeightLog{
		UserID:          123,
		MeasuredAt:      now,
		Weight:          85.5,
		WeightTrend:     float64Ptr(85.0),
		BodyFat:         float64Ptr(18.5),
		BodyFatTrend:    float64Ptr(18.3),
		MuscleMass:      float64Ptr(40.2),
		MuscleMassTrend: float64Ptr(40.0),
		Notes:           "Morning measurement",
	}

	id, err := db.CreateWeightLog(ctx, w)
	if err != nil {
		t.Fatalf("CreateWeightLog failed: %v", err)
	}
	if id == 0 {
		t.Fatal("Expected non-zero ID")
	}
}

func TestCreateWeightLogMinimal(t *testing.T) {
	db := setupWeightTestStore(t)
	ctx := context.Background()

	w := &WeightLog{
		UserID:     123,
		MeasuredAt: time.Now().UTC().Truncate(time.Second),
		Weight:     80.0,
	}

	id, err := db.CreateWeightLog(ctx, w)
	if err != nil {
		t.Fatalf("CreateWeightLog failed: %v", err)
	}
	if id == 0 {
		t.Fatal("Expected non-zero ID")
	}
}

func TestGetWeightLogsOrderedByDateDesc(t *testing.T) {
	db := setupWeightTestStore(t)
	ctx := context.Background()

	base := time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)

	for i := 0; i < 3; i++ {
		w := &WeightLog{
			UserID:     123,
			MeasuredAt: base.Add(time.Duration(i) * 24 * time.Hour),
			Weight:     80.0 + float64(i),
		}
		if _, err := db.CreateWeightLog(ctx, w); err != nil {
			t.Fatalf("CreateWeightLog failed: %v", err)
		}
	}

	logs, err := db.GetWeightLogs(ctx, 123, base.Add(-24*time.Hour))
	if err != nil {
		t.Fatalf("GetWeightLogs failed: %v", err)
	}
	if len(logs) != 3 {
		t.Fatalf("Expected 3 logs, got %d", len(logs))
	}

	// Should be DESC order: newest first
	if logs[0].Weight < logs[1].Weight || logs[1].Weight < logs[2].Weight {
		t.Errorf("Logs not in DESC order: %.1f, %.1f, %.1f", logs[0].Weight, logs[1].Weight, logs[2].Weight)
	}
}

func TestGetWeightLogsSinceFilter(t *testing.T) {
	db := setupWeightTestStore(t)
	ctx := context.Background()

	base := time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)

	for i := 0; i < 5; i++ {
		w := &WeightLog{
			UserID:     123,
			MeasuredAt: base.Add(time.Duration(i) * 24 * time.Hour),
			Weight:     80.0 + float64(i),
		}
		if _, err := db.CreateWeightLog(ctx, w); err != nil {
			t.Fatalf("CreateWeightLog failed: %v", err)
		}
	}

	// Only get logs from day 3 onwards
	since := base.Add(2 * 24 * time.Hour)
	logs, err := db.GetWeightLogs(ctx, 123, since)
	if err != nil {
		t.Fatalf("GetWeightLogs failed: %v", err)
	}
	if len(logs) < 2 {
		t.Fatalf("Expected at least 2 logs since filter, got %d", len(logs))
	}
}

func TestDeleteWeightLogSuccess(t *testing.T) {
	db := setupWeightTestStore(t)
	ctx := context.Background()

	w := &WeightLog{
		UserID:     123,
		MeasuredAt: time.Now().UTC().Truncate(time.Second),
		Weight:     80.0,
	}
	id, err := db.CreateWeightLog(ctx, w)
	if err != nil {
		t.Fatalf("CreateWeightLog failed: %v", err)
	}

	err = db.DeleteWeightLog(ctx, id, 123)
	if err != nil {
		t.Fatalf("DeleteWeightLog failed: %v", err)
	}
}

func TestDeleteWeightLogWrongUser(t *testing.T) {
	db := setupWeightTestStore(t)
	ctx := context.Background()

	w := &WeightLog{
		UserID:     123,
		MeasuredAt: time.Now().UTC().Truncate(time.Second),
		Weight:     80.0,
	}
	id, err := db.CreateWeightLog(ctx, w)
	if err != nil {
		t.Fatalf("CreateWeightLog failed: %v", err)
	}

	err = db.DeleteWeightLog(ctx, id, 999)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("Expected sql.ErrNoRows for wrong user, got: %v", err)
	}
}

func TestDeleteWeightLogNotFound(t *testing.T) {
	db := setupWeightTestStore(t)
	ctx := context.Background()

	err := db.DeleteWeightLog(ctx, 99999, 123)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("Expected sql.ErrNoRows for non-existent log, got: %v", err)
	}
}

func TestGetLastWeightLogReturnsMostRecent(t *testing.T) {
	db := setupWeightTestStore(t)
	ctx := context.Background()

	base := time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)

	// Insert older entry
	w1 := &WeightLog{
		UserID:     123,
		MeasuredAt: base,
		Weight:     80.0,
	}
	if _, err := db.CreateWeightLog(ctx, w1); err != nil {
		t.Fatalf("CreateWeightLog failed: %v", err)
	}

	// Insert newer entry
	w2 := &WeightLog{
		UserID:     123,
		MeasuredAt: base.Add(48 * time.Hour),
		Weight:     81.5,
	}
	if _, err := db.CreateWeightLog(ctx, w2); err != nil {
		t.Fatalf("CreateWeightLog failed: %v", err)
	}

	last, err := db.GetLastWeightLog(ctx, 123)
	if err != nil {
		t.Fatalf("GetLastWeightLog failed: %v", err)
	}
	if last == nil {
		t.Fatal("Expected non-nil result")
	}
	if last.Weight != 81.5 {
		t.Errorf("Expected weight 81.5, got %.1f", last.Weight)
	}
}

func TestGetLastWeightLogEmpty(t *testing.T) {
	db := setupWeightTestStore(t)
	ctx := context.Background()

	last, err := db.GetLastWeightLog(ctx, 123)
	if err != nil {
		t.Fatalf("GetLastWeightLog failed: %v", err)
	}
	if last != nil {
		t.Fatalf("Expected nil for empty table, got %+v", last)
	}
}

func TestGetHighestWeightRecord(t *testing.T) {
	db := setupWeightTestStore(t)
	ctx := context.Background()

	base := time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)

	weights := []float64{80.0, 95.3, 82.1, 78.0}
	for i, w := range weights {
		log := &WeightLog{
			UserID:     123,
			MeasuredAt: base.Add(time.Duration(i) * 24 * time.Hour),
			Weight:     w,
		}
		if _, err := db.CreateWeightLog(ctx, log); err != nil {
			t.Fatalf("CreateWeightLog failed: %v", err)
		}
	}

	highest, err := db.GetHighestWeightRecord(ctx, 123)
	if err != nil {
		t.Fatalf("GetHighestWeightRecord failed: %v", err)
	}
	if highest == nil {
		t.Fatal("Expected non-nil result")
	}
	if highest.Weight != 95.3 {
		t.Errorf("Expected highest weight 95.3, got %.1f", highest.Weight)
	}
}

func TestGetHighestWeightRecordEmpty(t *testing.T) {
	db := setupWeightTestStore(t)
	ctx := context.Background()

	highest, err := db.GetHighestWeightRecord(ctx, 123)
	if err != nil {
		t.Fatalf("GetHighestWeightRecord failed: %v", err)
	}
	if highest != nil {
		t.Fatalf("Expected nil for empty table, got %+v", highest)
	}
}

func TestSetAndGetWeightGoal(t *testing.T) {
	db := setupWeightTestStore(t)

	targetDate := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	err := db.SetWeightGoal(75.0, targetDate)
	if err != nil {
		t.Fatalf("SetWeightGoal failed: %v", err)
	}

	goal, err := db.GetWeightGoal()
	if err != nil {
		t.Fatalf("GetWeightGoal failed: %v", err)
	}
	if goal == nil {
		t.Fatal("Expected non-nil goal")
	}
	if goal.Goal == nil {
		t.Fatal("Expected non-nil Goal value")
	}
	if *goal.Goal != 75.0 {
		t.Errorf("Expected goal weight 75.0, got %.1f", *goal.Goal)
	}
	if goal.GoalDate == nil {
		t.Fatal("Expected non-nil GoalDate")
	}
}

func TestGetWeightGoalEmpty(t *testing.T) {
	db := setupWeightTestStore(t)

	goal, err := db.GetWeightGoal()
	if err != nil {
		t.Fatalf("GetWeightGoal failed: %v", err)
	}
	if goal == nil {
		t.Fatal("Expected non-nil WeightGoal (empty struct)")
	}
	// Empty goal should have nil pointers
	if goal.Goal != nil {
		t.Errorf("Expected nil Goal for empty store, got %v", *goal.Goal)
	}
}

func TestCalculateWeightTrendNilPrevious(t *testing.T) {
	result := CalculateWeightTrend(85.0, nil)
	if result != 85.0 {
		t.Errorf("Expected 85.0 for nil previous trend, got %.1f", result)
	}
}

func TestCalculateWeightTrendWithPrevious(t *testing.T) {
	previous := 80.0
	current := 85.0

	result := CalculateWeightTrend(current, &previous)

	// EMA: 0.1 * current + 0.9 * previous = 0.1*85 + 0.9*80 = 8.5 + 72 = 80.5
	expected := 0.1*current + 0.9*previous
	if math.Abs(result-expected) > 0.001 {
		t.Errorf("Expected %.3f, got %.3f", expected, result)
	}
}

func TestCalculateWeightTrendConvergence(t *testing.T) {
	// Simulate multiple readings at 85.0 with initial trend of 80.0
	trend := 80.0
	for i := 0; i < 50; i++ {
		trend = CalculateWeightTrend(85.0, &trend)
	}

	// After many iterations, trend should converge toward 85.0
	if math.Abs(trend-85.0) > 0.1 {
		t.Errorf("Trend should converge to 85.0, got %.3f", trend)
	}
}
