package diary

import (
	"context"
	"testing"
	"time"
)

func TestLatestNote_Empty(t *testing.T) {
	r := setupDiaryRepo(t)
	ctx := context.Background()

	ts, ok, err := r.LatestNote(ctx, 7)
	if err != nil {
		t.Fatalf("LatestNote: %v", err)
	}
	if ok {
		t.Errorf("expected found=false on empty table, got true")
	}
	if !ts.IsZero() {
		t.Errorf("expected zero time, got %v", ts)
	}
}

func TestLatestNote_ReturnsMax(t *testing.T) {
	r := setupDiaryRepo(t)
	ctx := context.Background()
	userID := int64(7)

	earlier := time.Date(2026, 1, 10, 8, 0, 0, 0, time.UTC)
	middle := time.Date(2026, 1, 10, 14, 0, 0, 0, time.UTC)
	latest := time.Date(2026, 1, 12, 21, 0, 0, 0, time.UTC)

	for i, ts := range []time.Time{middle, earlier, latest} {
		ts := ts
		r.SetClock(func() time.Time { return ts })
		if _, err := r.Create(ctx, userID, "note", nil); err != nil {
			t.Fatalf("Create #%d: %v", i, err)
		}
	}

	ts, ok, err := r.LatestNote(ctx, userID)
	if err != nil {
		t.Fatalf("LatestNote: %v", err)
	}
	if !ok {
		t.Fatal("expected found=true after inserts")
	}
	if !ts.Equal(latest) {
		t.Errorf("expected max=%v, got %v", latest, ts)
	}
}

func TestLatestNote_IsolatesPerUser(t *testing.T) {
	r := setupDiaryRepo(t)
	ctx := context.Background()

	mine := time.Date(2026, 1, 5, 12, 0, 0, 0, time.UTC)
	other := time.Date(2026, 2, 5, 12, 0, 0, 0, time.UTC)

	r.SetClock(func() time.Time { return other })
	if _, err := r.Create(ctx, 2, "other user", nil); err != nil {
		t.Fatalf("create user 2: %v", err)
	}
	r.SetClock(func() time.Time { return mine })
	if _, err := r.Create(ctx, 1, "my note", nil); err != nil {
		t.Fatalf("create user 1: %v", err)
	}

	ts, ok, err := r.LatestNote(ctx, 1)
	if err != nil || !ok {
		t.Fatalf("user 1 latest: ok=%v err=%v", ok, err)
	}
	if !ts.Equal(mine) {
		t.Errorf("user 1 should see only its own data; expected %v, got %v", mine, ts)
	}
}
