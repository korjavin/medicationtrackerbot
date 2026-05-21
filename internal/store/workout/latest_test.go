package workout

import (
	"context"
	"testing"
	"time"
)

func TestLatestSessionForUser_Empty(t *testing.T) {
	r := setupTestDB(t)
	ctx := context.Background()

	ts, ok, err := r.LatestSessionForUser(ctx, 1)
	if err != nil {
		t.Fatalf("LatestSessionForUser: %v", err)
	}
	if ok {
		t.Errorf("expected found=false on empty table, got true")
	}
	if !ts.IsZero() {
		t.Errorf("expected zero time, got %v", ts)
	}
}

func TestLatestSessionForUser_ReturnsMaxAcrossGroups(t *testing.T) {
	r := setupTestDB(t)
	ctx := context.Background()
	userID := int64(1)

	groupA, err := r.CreateGroup("A", "", false, userID, "[1]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateGroup A: %v", err)
	}
	groupB, err := r.CreateGroup("B", "", false, userID, "[2]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateGroup B: %v", err)
	}
	vA, err := r.CreateVariant(groupA.ID, "VA", nil, "")
	if err != nil {
		t.Fatalf("CreateVariant A: %v", err)
	}
	vB, err := r.CreateVariant(groupB.ID, "VB", nil, "")
	if err != nil {
		t.Fatalf("CreateVariant B: %v", err)
	}

	earlier := time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC)
	middle := time.Date(2026, 1, 10, 0, 0, 0, 0, time.UTC)
	latest := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)

	if _, err := r.CreateSession(groupA.ID, vA.ID, userID, earlier, "09:00"); err != nil {
		t.Fatalf("CreateSession earlier: %v", err)
	}
	if _, err := r.CreateSession(groupB.ID, vB.ID, userID, latest, "09:00"); err != nil {
		t.Fatalf("CreateSession latest: %v", err)
	}
	if _, err := r.CreateSession(groupA.ID, vA.ID, userID, middle, "09:00"); err != nil {
		t.Fatalf("CreateSession middle: %v", err)
	}

	ts, ok, err := r.LatestSessionForUser(ctx, userID)
	if err != nil {
		t.Fatalf("LatestSessionForUser: %v", err)
	}
	if !ok {
		t.Fatal("expected found=true after inserts")
	}
	if !ts.Equal(latest) {
		t.Errorf("expected max=%v (across groups), got %v", latest, ts)
	}
}

func TestLatestSessionForUser_IsolatesPerUser(t *testing.T) {
	r := setupTestDB(t)
	ctx := context.Background()

	group1, err := r.CreateGroup("U1G", "", false, 1, "[1]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateGroup 1: %v", err)
	}
	group2, err := r.CreateGroup("U2G", "", false, 2, "[1]", "09:00", 15)
	if err != nil {
		t.Fatalf("CreateGroup 2: %v", err)
	}
	v1, err := r.CreateVariant(group1.ID, "v1", nil, "")
	if err != nil {
		t.Fatalf("CreateVariant 1: %v", err)
	}
	v2, err := r.CreateVariant(group2.ID, "v2", nil, "")
	if err != nil {
		t.Fatalf("CreateVariant 2: %v", err)
	}

	mine := time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC)
	other := time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC)

	if _, err := r.CreateSession(group1.ID, v1.ID, 1, mine, "09:00"); err != nil {
		t.Fatalf("CreateSession user 1: %v", err)
	}
	if _, err := r.CreateSession(group2.ID, v2.ID, 2, other, "09:00"); err != nil {
		t.Fatalf("CreateSession user 2: %v", err)
	}

	ts, ok, err := r.LatestSessionForUser(ctx, 1)
	if err != nil || !ok {
		t.Fatalf("user 1 latest: ok=%v err=%v", ok, err)
	}
	if !ts.Equal(mine) {
		t.Errorf("user 1 should see only its own data; expected %v, got %v", mine, ts)
	}
}
