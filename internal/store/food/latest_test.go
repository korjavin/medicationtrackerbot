package food

import (
	"context"
	"testing"
	"time"
)

func TestLatestLog_Empty(t *testing.T) {
	r := setupFoodRepo(t)
	ctx := context.Background()

	ts, ok, err := r.LatestLog(ctx, 99)
	if err != nil {
		t.Fatalf("LatestLog: %v", err)
	}
	if ok {
		t.Errorf("expected found=false on empty table, got true")
	}
	if !ts.IsZero() {
		t.Errorf("expected zero time, got %v", ts)
	}
}

func TestLatestLog_ReturnsMax(t *testing.T) {
	r := setupFoodRepo(t)
	ctx := context.Background()
	userID := int64(99)

	earlier := time.Date(2026, 1, 10, 8, 0, 0, 0, time.UTC)
	middle := time.Date(2026, 1, 10, 13, 0, 0, 0, time.UTC)
	latest := time.Date(2026, 1, 10, 19, 30, 0, 0, time.UTC)

	for _, eaten := range []time.Time{middle, earlier, latest} {
		if _, err := r.CreateLog(ctx, &FoodLog{
			UserID: userID, EatenAt: eaten, Weight: 100,
			Carbs: 20, Protein: 10, Fat: 5, Calories: 150, Name: "test",
		}); err != nil {
			t.Fatalf("CreateLog: %v", err)
		}
	}

	ts, ok, err := r.LatestLog(ctx, userID)
	if err != nil {
		t.Fatalf("LatestLog: %v", err)
	}
	if !ok {
		t.Fatal("expected found=true after inserts")
	}
	if !ts.Equal(latest) {
		t.Errorf("expected max=%v, got %v", latest, ts)
	}
}

func TestLatestLog_IsolatesPerUser(t *testing.T) {
	r := setupFoodRepo(t)
	ctx := context.Background()

	mine := time.Date(2026, 1, 5, 12, 0, 0, 0, time.UTC)
	other := time.Date(2026, 2, 5, 12, 0, 0, 0, time.UTC)

	if _, err := r.CreateLog(ctx, &FoodLog{UserID: 1, EatenAt: mine, Weight: 100, Calories: 150, Name: "a"}); err != nil {
		t.Fatalf("create user 1: %v", err)
	}
	if _, err := r.CreateLog(ctx, &FoodLog{UserID: 2, EatenAt: other, Weight: 100, Calories: 150, Name: "b"}); err != nil {
		t.Fatalf("create user 2: %v", err)
	}

	ts, ok, err := r.LatestLog(ctx, 1)
	if err != nil || !ok {
		t.Fatalf("user 1 latest: ok=%v err=%v", ok, err)
	}
	if !ts.Equal(mine) {
		t.Errorf("user 1 should see only its own data; expected %v, got %v", mine, ts)
	}
}
