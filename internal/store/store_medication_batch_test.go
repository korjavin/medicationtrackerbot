package store

import (
	"testing"
	"time"
)

func TestBatchGetIntakesBySchedule(t *testing.T) {
	db := setupTestStore(t)
	defer db.Close()

	// Create user
	userID := int64(1)

	// Create medications
	medID1, _ := db.CreateMedication("Med1", "10mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	medID2, _ := db.CreateMedication("Med2", "20mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")

	// Create intakes
	t1 := time.Date(2025, 1, 1, 8, 0, 0, 0, time.UTC)
	t2 := time.Date(2025, 1, 1, 9, 0, 0, 0, time.UTC)

	_, err := db.CreateIntake(medID1, userID, t1)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}
	_, err = db.CreateIntake(medID2, userID, t2)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	// Batch query
	schedules := []MedicationSchedule{
		{MedID: medID1, ScheduledAt: t1},
		{MedID: medID2, ScheduledAt: t2},
		{MedID: medID1, ScheduledAt: t2}, // Not exists
	}

	res, err := db.BatchGetIntakesBySchedule(schedules)
	if err != nil {
		t.Fatalf("BatchGetIntakesBySchedule failed: %v", err)
	}

	if len(res) != 2 {
		t.Fatalf("Expected 2 results, got %d", len(res))
	}

	if _, ok := res[MedicationSchedule{MedID: medID1, ScheduledAt: t1}]; !ok {
		t.Fatalf("Missing Med1")
	}
	if _, ok := res[MedicationSchedule{MedID: medID2, ScheduledAt: t2}]; !ok {
		t.Fatalf("Missing Med2")
	}
}
