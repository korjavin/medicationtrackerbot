package bp

import (
	"context"
	"testing"
	"time"
)

func TestLatestReading_Empty(t *testing.T) {
	r := setupBPRepo(t)
	ctx := context.Background()

	ts, ok, err := r.LatestReading(ctx, 42)
	if err != nil {
		t.Fatalf("LatestReading: %v", err)
	}
	if ok {
		t.Errorf("expected found=false on empty table, got true")
	}
	if !ts.IsZero() {
		t.Errorf("expected zero time, got %v", ts)
	}
}

func TestLatestReading_ReturnsMax(t *testing.T) {
	r := setupBPRepo(t)
	ctx := context.Background()
	userID := int64(42)

	earlier := time.Date(2026, 1, 10, 8, 0, 0, 0, time.UTC)
	middle := time.Date(2026, 1, 10, 18, 0, 0, 0, time.UTC)
	latest := time.Date(2026, 1, 12, 7, 30, 0, 0, time.UTC)

	for _, m := range []time.Time{middle, earlier, latest} {
		if _, err := r.CreateReading(ctx, &BloodPressure{
			UserID:     userID,
			MeasuredAt: m,
			Systolic:   120,
			Diastolic:  80,
		}); err != nil {
			t.Fatalf("CreateReading: %v", err)
		}
	}

	ts, ok, err := r.LatestReading(ctx, userID)
	if err != nil {
		t.Fatalf("LatestReading: %v", err)
	}
	if !ok {
		t.Fatal("expected found=true after inserts")
	}
	if !ts.Equal(latest) {
		t.Errorf("expected max=%v, got %v", latest, ts)
	}
}

func TestLatestReading_IsolatesPerUser(t *testing.T) {
	r := setupBPRepo(t)
	ctx := context.Background()

	mineLater := time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC)
	otherLater := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)

	if _, err := r.CreateReading(ctx, &BloodPressure{UserID: 1, MeasuredAt: mineLater, Systolic: 120, Diastolic: 80}); err != nil {
		t.Fatalf("create user 1: %v", err)
	}
	if _, err := r.CreateReading(ctx, &BloodPressure{UserID: 2, MeasuredAt: otherLater, Systolic: 120, Diastolic: 80}); err != nil {
		t.Fatalf("create user 2: %v", err)
	}

	ts, ok, err := r.LatestReading(ctx, 1)
	if err != nil || !ok {
		t.Fatalf("user 1 latest: ok=%v err=%v", ok, err)
	}
	if !ts.Equal(mineLater) {
		t.Errorf("user 1 should see only its own data; expected %v, got %v", mineLater, ts)
	}
}
