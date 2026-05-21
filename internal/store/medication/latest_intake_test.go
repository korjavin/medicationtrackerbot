package medication

import (
	"context"
	"testing"
	"time"
)

func TestLatestScheduledIntake_Empty(t *testing.T) {
	r := setupMedicationRepo(t)
	ctx := context.Background()

	medID, err := r.Create("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create med: %v", err)
	}

	ts, ok, err := r.LatestScheduledIntake(ctx, medID)
	if err != nil {
		t.Fatalf("LatestScheduledIntake: %v", err)
	}
	if ok {
		t.Errorf("expected found=false for med with no intakes, got true")
	}
	if !ts.IsZero() {
		t.Errorf("expected zero time, got %v", ts)
	}
}

func TestLatestScheduledIntake_ReturnsMax(t *testing.T) {
	r := setupMedicationRepo(t)
	ctx := context.Background()

	medID, err := r.Create("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create med: %v", err)
	}

	earlier := time.Date(2026, 1, 10, 9, 0, 0, 0, time.UTC)
	middle := time.Date(2026, 1, 11, 9, 0, 0, 0, time.UTC)
	latest := time.Date(2026, 1, 12, 9, 0, 0, 0, time.UTC)

	for _, sched := range []time.Time{middle, earlier, latest} {
		if _, err := r.CreateIntake(medID, 1, sched); err != nil {
			t.Fatalf("CreateIntake %v: %v", sched, err)
		}
	}

	ts, ok, err := r.LatestScheduledIntake(ctx, medID)
	if err != nil {
		t.Fatalf("LatestScheduledIntake: %v", err)
	}
	if !ok {
		t.Fatal("expected found=true after inserts")
	}
	if !ts.Equal(latest) {
		t.Errorf("expected max=%v, got %v", latest, ts)
	}
}

func TestLatestScheduledIntake_IsolatesPerMed(t *testing.T) {
	r := setupMedicationRepo(t)
	ctx := context.Background()

	medA, err := r.Create("A", "1mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("create med A: %v", err)
	}
	medB, err := r.Create("B", "1mg", `{"type":"daily","times":["21:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("create med B: %v", err)
	}

	tA := time.Date(2026, 1, 5, 9, 0, 0, 0, time.UTC)
	tB := time.Date(2026, 3, 5, 21, 0, 0, 0, time.UTC)

	if _, err := r.CreateIntake(medA, 1, tA); err != nil {
		t.Fatalf("CreateIntake medA: %v", err)
	}
	if _, err := r.CreateIntake(medB, 1, tB); err != nil {
		t.Fatalf("CreateIntake medB: %v", err)
	}

	ts, ok, err := r.LatestScheduledIntake(ctx, medA)
	if err != nil || !ok {
		t.Fatalf("medA latest: ok=%v err=%v", ok, err)
	}
	if !ts.Equal(tA) {
		t.Errorf("medA should see only its own intakes; expected %v, got %v", tA, ts)
	}
}
