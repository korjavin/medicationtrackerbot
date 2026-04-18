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
	medID1, err := db.CreateMedication("Med1", "10mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}
	medID2, err := db.CreateMedication("Med2", "20mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	// Create intakes
	t1 := time.Date(2025, 1, 1, 8, 0, 0, 0, time.UTC)
	t2 := time.Date(2025, 1, 1, 9, 0, 0, 0, time.UTC)

	_, err = db.CreateIntake(medID1, userID, t1)
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
	// Test chunking logic with empty input
	resEmpty, err := db.BatchGetIntakesBySchedule(nil)
	if err != nil {
		t.Fatalf("BatchGetIntakesBySchedule with nil failed: %v", err)
	}
	if len(resEmpty) != 0 {
		t.Fatalf("Expected 0 results, got %d", len(resEmpty))
	}

	// Test boundary logic
	schedulesLarge := make([]MedicationSchedule, 505)
	for i := 0; i < 505; i++ {
		schedulesLarge[i] = MedicationSchedule{MedID: int64(100 + i), ScheduledAt: t1}
	}
	resLarge, err := db.BatchGetIntakesBySchedule(schedulesLarge)
	if err != nil {
		t.Fatalf("BatchGetIntakesBySchedule with 505 items failed: %v", err)
	}
	if len(resLarge) != 0 {
		t.Fatalf("Expected 0 results for fake med IDs, got %d", len(resLarge))
	}
}

// TestBatchGetIntakesBySchedule_NonUTCLocation regresses the bug where the
// scheduler stored intakes with a user-local-tz target time but BatchGet
// queried with the UTC-converted time, missing the match because the
// underlying driver serialises time.Time via t.String() which preserves
// the original Location.
func TestBatchGetIntakesBySchedule_NonUTCLocation(t *testing.T) {
	db := setupTestStore(t)
	defer db.Close()

	userID := int64(1)
	medID, err := db.CreateMedication("Med1", "10mg", `{"type":"daily","times":["10:13"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("LoadLocation: %v", err)
	}

	scheduledLocal := time.Date(2026, 4, 18, 10, 13, 0, 0, berlin)
	if _, err := db.CreateIntake(medID, userID, scheduledLocal); err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	res, err := db.BatchGetIntakesBySchedule([]MedicationSchedule{
		{MedID: medID, ScheduledAt: scheduledLocal},
	})
	if err != nil {
		t.Fatalf("BatchGetIntakesBySchedule failed: %v", err)
	}
	if len(res) != 1 {
		t.Fatalf("expected 1 row for local-tz match, got %d (scheduler would resend notifications)", len(res))
	}
}
