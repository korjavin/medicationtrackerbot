package store

import (
	"testing"
	"time"
)

func setupTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := New(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test store: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestCreateMedication(t *testing.T) {
	db := setupTestStore(t)

	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	id, err := db.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, &start, nil, "1191", "aspirin", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}
	if id <= 0 {
		t.Errorf("expected positive ID, got %d", id)
	}

	// Create a second medication without optional fields
	id2, err := db.CreateMedication("Vitamin D", "1000IU", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication without optional fields failed: %v", err)
	}
	if id2 <= id {
		t.Errorf("expected second ID (%d) > first ID (%d)", id2, id)
	}
}

func TestGetMedication(t *testing.T) {
	db := setupTestStore(t)

	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	id, err := db.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00","21:00"]}`, &start, nil, "1191", "aspirin", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	med, err := db.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedication failed: %v", err)
	}
	if med == nil {
		t.Fatal("expected medication, got nil")
	}
	if med.Name != "Aspirin" {
		t.Errorf("expected name 'Aspirin', got %q", med.Name)
	}
	if med.Dosage != "100mg" {
		t.Errorf("expected dosage '100mg', got %q", med.Dosage)
	}
	if med.RxCUI != "1191" {
		t.Errorf("expected rxcui '1191', got %q", med.RxCUI)
	}
	if med.NormalizedName != "aspirin" {
		t.Errorf("expected normalized name 'aspirin', got %q", med.NormalizedName)
	}
	if med.Archived {
		t.Errorf("expected archived=false")
	}
}

func TestGetMedicationNotFound(t *testing.T) {
	db := setupTestStore(t)

	med, err := db.GetMedication(99999)
	if err != nil {
		t.Fatalf("GetMedication for non-existent ID should not error, got: %v", err)
	}
	if med != nil {
		t.Errorf("expected nil medication for non-existent ID, got %+v", med)
	}
}

func TestUpdateMedication(t *testing.T) {
	db := setupTestStore(t)

	id, err := db.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	end := time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC)
	inventory := 30
	err = db.UpdateMedication(id, "Aspirin Updated", "200mg", `{"type":"daily","times":["10:00"]}`, true, nil, &end, "1191", "aspirin", &inventory, "")
	if err != nil {
		t.Fatalf("UpdateMedication failed: %v", err)
	}

	med, err := db.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedication after update failed: %v", err)
	}
	if med.Name != "Aspirin Updated" {
		t.Errorf("expected name 'Aspirin Updated', got %q", med.Name)
	}
	if med.Dosage != "200mg" {
		t.Errorf("expected dosage '200mg', got %q", med.Dosage)
	}
	if !med.Archived {
		t.Errorf("expected archived=true after update")
	}
	if med.RxCUI != "1191" {
		t.Errorf("expected rxcui '1191', got %q", med.RxCUI)
	}
	if med.InventoryCount == nil || *med.InventoryCount != 30 {
		t.Errorf("expected inventory count 30, got %v", med.InventoryCount)
	}
}

func TestSetMedicationSupplement(t *testing.T) {
	db := setupTestStore(t)

	id, err := db.CreateMedication("Magnesium", "200mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	if err := db.SetMedicationSupplement(id, true); err != nil {
		t.Fatalf("SetMedicationSupplement failed: %v", err)
	}

	med, err := db.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedication failed: %v", err)
	}
	if med == nil {
		t.Fatal("expected medication, got nil")
	}
	if !med.Supplement {
		t.Fatal("expected supplement=true")
	}

	meds, err := db.ListMedications(true)
	if err != nil {
		t.Fatalf("ListMedications failed: %v", err)
	}
	found := false
	for _, m := range meds {
		if m.ID == id {
			found = true
			if !m.Supplement {
				t.Fatal("expected supplement=true in list results")
			}
		}
	}
	if !found {
		t.Fatal("created medication not found in list")
	}
}

func TestDeleteMedication(t *testing.T) {
	db := setupTestStore(t)

	id, err := db.CreateMedication("ToDelete", "50mg", `{"type":"daily","times":["12:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	err = db.DeleteMedication(id)
	if err != nil {
		t.Fatalf("DeleteMedication failed: %v", err)
	}

	med, err := db.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedication after delete should not error: %v", err)
	}
	if med != nil {
		t.Errorf("expected nil after deletion, got %+v", med)
	}
}

func TestCanDeleteMedication(t *testing.T) {
	db := setupTestStore(t)

	// Create a medication
	id, err := db.CreateMedication("CheckDelete", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	// Should be deletable initially
	canDelete, err := db.CanDeleteMedication(id)
	if err != nil {
		t.Fatalf("CanDeleteMedication failed: %v", err)
	}
	if !canDelete {
		t.Error("expected CanDeleteMedication to return true for medication without history")
	}

	// Add an intake
	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	_, err = db.CreateIntake(id, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	// Should no longer be deletable
	canDelete, err = db.CanDeleteMedication(id)
	if err != nil {
		t.Fatalf("CanDeleteMedication failed: %v", err)
	}
	if canDelete {
		t.Error("expected CanDeleteMedication to return false for medication with history")
	}
}

func TestListMedicationsExcludesArchived(t *testing.T) {
	db := setupTestStore(t)

	id1, err := db.CreateMedication("Active Med", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	id2, err := db.CreateMedication("Archived Med", "20mg", `{"type":"daily","times":["10:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	// Archive the second medication
	err = db.UpdateMedication(id2, "Archived Med", "20mg", `{"type":"daily","times":["10:00"]}`, true, nil, nil, "", "", nil, "")
	if err != nil {
		t.Fatalf("UpdateMedication (archive) failed: %v", err)
	}

	// List without archived
	meds, err := db.ListMedications(false)
	if err != nil {
		t.Fatalf("ListMedications(false) failed: %v", err)
	}
	if meds == nil {
		t.Fatal("ListMedications should never return nil slice")
	}

	for _, m := range meds {
		if m.ID == id2 {
			t.Errorf("archived medication (ID=%d) should not appear when showArchived=false", id2)
		}
	}

	found := false
	for _, m := range meds {
		if m.ID == id1 {
			found = true
		}
	}
	if !found {
		t.Errorf("active medication (ID=%d) should appear when showArchived=false", id1)
	}

	// List with archived
	medsAll, err := db.ListMedications(true)
	if err != nil {
		t.Fatalf("ListMedications(true) failed: %v", err)
	}
	if len(medsAll) < 2 {
		t.Errorf("expected at least 2 medications with showArchived=true, got %d", len(medsAll))
	}
}

func TestListMedicationsEmptyReturnsNonNil(t *testing.T) {
	db := setupTestStore(t)

	meds, err := db.ListMedications(false)
	if err != nil {
		t.Fatalf("ListMedications on empty DB failed: %v", err)
	}
	if meds == nil {
		t.Error("ListMedications should return initialized slice, not nil")
	}
	if len(meds) != 0 {
		t.Errorf("expected 0 medications, got %d", len(meds))
	}
}

func TestCreateIntakePending(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	intakeID, err := db.CreateIntake(medID, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	intake, err := db.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake failed: %v", err)
	}
	if intake == nil {
		t.Fatal("expected intake, got nil")
	}
	if intake.Status != "PENDING" {
		t.Errorf("expected status PENDING, got %q", intake.Status)
	}
	if intake.MedicationID != medID {
		t.Errorf("expected medication ID %d, got %d", medID, intake.MedicationID)
	}
	if intake.TakenAt != nil {
		t.Errorf("expected TakenAt to be nil for pending intake")
	}
}

func TestSkipIntake(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	intakeID, err := db.CreateIntake(medID, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	if err := db.SkipIntake(intakeID); err != nil {
		t.Fatalf("SkipIntake failed: %v", err)
	}

	intake, err := db.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake failed: %v", err)
	}
	if intake == nil {
		t.Fatal("expected intake, got nil")
	}
	if intake.Status != "SKIPPED" {
		t.Fatalf("expected status SKIPPED, got %s", intake.Status)
	}
	if intake.TakenAt != nil {
		t.Fatal("expected taken_at to be NULL for skipped intake")
	}

	pending, err := db.GetPendingIntakes()
	if err != nil {
		t.Fatalf("GetPendingIntakes failed: %v", err)
	}
	for _, p := range pending {
		if p.ID == intakeID {
			t.Fatal("skipped intake should not be returned as pending")
		}
	}
}

func TestSnoozeIntake(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	intakeID, err := db.CreateIntake(medID, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	snoozeUntil := scheduled.Add(1 * time.Hour)
	err = db.SnoozeIntake(intakeID, snoozeUntil)
	if err != nil {
		t.Fatalf("SnoozeIntake failed: %v", err)
	}

	intake, err := db.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake failed: %v", err)
	}
	if intake == nil {
		t.Fatal("expected intake, got nil")
	}
	if intake.SnoozedUntil == nil {
		t.Fatal("expected SnoozedUntil to be set")
	}
	if !intake.SnoozedUntil.Equal(snoozeUntil) {
		t.Errorf("expected SnoozedUntil %v, got %v", snoozeUntil, intake.SnoozedUntil)
	}
}

func TestCreateManualIntake(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	takenAt := time.Date(2026, 2, 28, 9, 30, 0, 0, time.UTC)
	intakeID, err := db.CreateManualIntake(medID, 12345, takenAt)
	if err != nil {
		t.Fatalf("CreateManualIntake failed: %v", err)
	}

	intake, err := db.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake failed: %v", err)
	}
	if intake == nil {
		t.Fatal("expected intake, got nil")
	}
	if intake.Status != "TAKEN" {
		t.Errorf("expected status TAKEN, got %q", intake.Status)
	}
	if intake.TakenAt == nil {
		t.Fatal("expected TakenAt to be set for manual intake")
	}
}

func TestConfirmIntake(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	intakeID, err := db.CreateIntake(medID, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	takenAt := time.Date(2026, 2, 28, 9, 15, 0, 0, time.UTC)
	err = db.ConfirmIntake(intakeID, takenAt)
	if err != nil {
		t.Fatalf("ConfirmIntake failed: %v", err)
	}

	intake, err := db.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake after confirm failed: %v", err)
	}
	if intake.Status != "TAKEN" {
		t.Errorf("expected status TAKEN after confirm, got %q", intake.Status)
	}
	if intake.TakenAt == nil {
		t.Fatal("expected TakenAt to be set after confirm")
	}
}

func TestUpdateIntakeStatusNotTakenClearsTakenAt(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	takenAt := time.Date(2026, 2, 28, 9, 30, 0, 0, time.UTC)
	intakeID, err := db.CreateManualIntake(medID, 12345, takenAt)
	if err != nil {
		t.Fatalf("CreateManualIntake failed: %v", err)
	}

	// Update to MISSED should clear taken_at
	err = db.UpdateIntake(intakeID, takenAt, "MISSED")
	if err != nil {
		t.Fatalf("UpdateIntake failed: %v", err)
	}

	intake, err := db.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake after update failed: %v", err)
	}
	if intake.Status != "MISSED" {
		t.Errorf("expected status MISSED, got %q", intake.Status)
	}
	if intake.TakenAt != nil {
		t.Errorf("expected TakenAt to be nil when status is not TAKEN, got %v", intake.TakenAt)
	}

	// Update to TAKEN should set taken_at
	err = db.UpdateIntake(intakeID, takenAt, "TAKEN")
	if err != nil {
		t.Fatalf("UpdateIntake to TAKEN failed: %v", err)
	}

	intake, err = db.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake after TAKEN update failed: %v", err)
	}
	if intake.Status != "TAKEN" {
		t.Errorf("expected status TAKEN, got %q", intake.Status)
	}
	if intake.TakenAt == nil {
		t.Error("expected TakenAt to be set when status is TAKEN")
	}
}

func TestGetPendingIntakes(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduled1 := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	scheduled2 := time.Date(2026, 2, 28, 21, 0, 0, 0, time.UTC)

	_, err = db.CreateIntake(medID, 12345, scheduled1)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}
	id2, err := db.CreateIntake(medID, 12345, scheduled2)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	// Confirm one intake
	err = db.ConfirmIntake(id2, scheduled2)
	if err != nil {
		t.Fatalf("ConfirmIntake failed: %v", err)
	}

	pending, err := db.GetPendingIntakes()
	if err != nil {
		t.Fatalf("GetPendingIntakes failed: %v", err)
	}

	for _, p := range pending {
		if p.Status != "PENDING" {
			t.Errorf("GetPendingIntakes returned non-pending intake with status %q", p.Status)
		}
	}
}

func TestGetIntakeNotFound(t *testing.T) {
	db := setupTestStore(t)

	intake, err := db.GetIntake(99999)
	if err != nil {
		t.Fatalf("GetIntake for non-existent ID should not error, got: %v", err)
	}
	if intake != nil {
		t.Errorf("expected nil intake for non-existent ID, got %+v", intake)
	}
}

func TestGetIntakeBySchedule(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	_, err = db.CreateIntake(medID, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	intake, err := db.GetIntakeBySchedule(medID, scheduled)
	if err != nil {
		t.Fatalf("GetIntakeBySchedule failed: %v", err)
	}
	if intake == nil {
		t.Fatal("expected intake by schedule, got nil")
	}
	if intake.MedicationID != medID {
		t.Errorf("expected medication ID %d, got %d", medID, intake.MedicationID)
	}

	// Non-matching schedule should return nil
	other := time.Date(2026, 2, 28, 10, 0, 0, 0, time.UTC)
	intake2, err := db.GetIntakeBySchedule(medID, other)
	if err != nil {
		t.Fatalf("GetIntakeBySchedule for non-matching schedule should not error: %v", err)
	}
	if intake2 != nil {
		t.Errorf("expected nil for non-matching schedule, got %+v", intake2)
	}
}

func TestGetIntakeHistoryFilters(t *testing.T) {
	db := setupTestStore(t)

	med1, err := db.CreateMedication("Med1", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}
	med2, err := db.CreateMedication("Med2", "10mg", `{"type":"daily","times":["10:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	now := time.Now().UTC()
	recent := now.Add(-1 * time.Hour)
	old := now.Add(-48 * time.Hour)

	_, err = db.CreateManualIntake(med1, 12345, recent)
	if err != nil {
		t.Fatalf("CreateManualIntake failed: %v", err)
	}
	_, err = db.CreateManualIntake(med1, 12345, old)
	if err != nil {
		t.Fatalf("CreateManualIntake failed: %v", err)
	}
	_, err = db.CreateManualIntake(med2, 12345, recent)
	if err != nil {
		t.Fatalf("CreateManualIntake failed: %v", err)
	}

	// All intakes, no filter
	all, err := db.GetIntakeHistory(0, 0)
	if err != nil {
		t.Fatalf("GetIntakeHistory(0,0) failed: %v", err)
	}
	if len(all) < 3 {
		t.Errorf("expected at least 3 intakes with no filter, got %d", len(all))
	}

	// Filter by med1 only
	med1History, err := db.GetIntakeHistory(int(med1), 0)
	if err != nil {
		t.Fatalf("GetIntakeHistory(med1,0) failed: %v", err)
	}
	for _, intake := range med1History {
		if intake.MedicationID != med1 {
			t.Errorf("expected all intakes for med1, got medID=%d", intake.MedicationID)
		}
	}
	if len(med1History) != 2 {
		t.Errorf("expected 2 intakes for med1, got %d", len(med1History))
	}

	// Filter by days=1 (last 24 hours)
	recentHistory, err := db.GetIntakeHistory(0, 1)
	if err != nil {
		t.Fatalf("GetIntakeHistory(0,1) failed: %v", err)
	}
	// Should include the recent intakes but not the old one
	for _, intake := range recentHistory {
		if intake.ScheduledAt.Before(now.Add(-25 * time.Hour)) {
			t.Errorf("GetIntakeHistory(0,1) returned intake older than 1 day: %v", intake.ScheduledAt)
		}
	}
}

func TestGetIntakeHistoryEmpty(t *testing.T) {
	db := setupTestStore(t)

	// Fetch history when there's no data
	history, err := db.GetIntakeHistory(1, 7)
	if err != nil {
		t.Fatalf("GetIntakeHistory failed: %v", err)
	}
	if history == nil {
		t.Fatalf("expected empty non-nil slice, got nil")
	}
	if len(history) != 0 {
		t.Fatalf("expected 0 items, got %d", len(history))
	}
}

func TestConfirmIntakesByScheduleSkipsArchived(t *testing.T) {
	db := setupTestStore(t)

	activeMed, err := db.CreateMedication("Active", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}
	archivedMed, err := db.CreateMedication("Archived", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	// Archive the second medication
	err = db.UpdateMedication(archivedMed, "Archived", "10mg", `{"type":"daily","times":["09:00"]}`, true, nil, nil, "", "", nil, "")
	if err != nil {
		t.Fatalf("UpdateMedication (archive) failed: %v", err)
	}

	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	activeIntakeID, err := db.CreateIntake(activeMed, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake for active med failed: %v", err)
	}
	archivedIntakeID, err := db.CreateIntake(archivedMed, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake for archived med failed: %v", err)
	}

	takenAt := time.Date(2026, 2, 28, 9, 5, 0, 0, time.UTC)
	_, err = db.ConfirmIntakesBySchedule(12345, scheduled, takenAt)
	if err != nil {
		t.Fatalf("ConfirmIntakesBySchedule failed: %v", err)
	}

	// Active med intake should be confirmed
	activeIntake, err := db.GetIntake(activeIntakeID)
	if err != nil {
		t.Fatalf("GetIntake for active failed: %v", err)
	}
	if activeIntake.Status != "TAKEN" {
		t.Errorf("expected active intake status TAKEN, got %q", activeIntake.Status)
	}

	// Archived med intake should still be pending
	archivedIntake, err := db.GetIntake(archivedIntakeID)
	if err != nil {
		t.Fatalf("GetIntake for archived failed: %v", err)
	}
	if archivedIntake.Status != "PENDING" {
		t.Errorf("expected archived intake status PENDING (skipped), got %q", archivedIntake.Status)
	}
}

func TestIntakeReminders(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	intakeID, err := db.CreateIntake(medID, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	// Add reminders
	err = db.AddIntakeReminder(intakeID, 1001)
	if err != nil {
		t.Fatalf("AddIntakeReminder failed: %v", err)
	}
	err = db.AddIntakeReminder(intakeID, 1002)
	if err != nil {
		t.Fatalf("AddIntakeReminder failed: %v", err)
	}

	reminders, err := db.GetIntakeReminders(intakeID)
	if err != nil {
		t.Fatalf("GetIntakeReminders failed: %v", err)
	}
	if len(reminders) != 2 {
		t.Errorf("expected 2 reminders, got %d", len(reminders))
	}

	// Empty reminders for non-existent intake
	empty, err := db.GetIntakeReminders(99999)
	if err != nil {
		t.Fatalf("GetIntakeReminders for non-existent should not error: %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("expected 0 reminders for non-existent intake, got %d", len(empty))
	}
}

func TestIncrementInventory(t *testing.T) {
	db := setupTestStore(t)

	// Create a medication
	id, err := db.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	// Set inventory
	inventory := 30
	err = db.UpdateMedication(id, "Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, false, nil, nil, "", "", &inventory, "")
	if err != nil {
		t.Fatalf("UpdateMedication failed: %v", err)
	}

	// Increment inventory
	err = db.IncrementInventory(id, 5)
	if err != nil {
		t.Fatalf("IncrementInventory failed: %v", err)
	}

	med, err := db.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedication failed: %v", err)
	}
	if med.InventoryCount == nil || *med.InventoryCount != 35 {
		t.Errorf("expected inventory count 35, got %v", med.InventoryCount)
	}
}

func TestGetPendingIntakesBySchedule(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00","21:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	otherTime := time.Date(2026, 2, 28, 21, 0, 0, 0, time.UTC)

	_, err = db.CreateIntake(medID, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}
	_, err = db.CreateIntake(medID, 12345, otherTime)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	pending, err := db.GetPendingIntakesBySchedule(12345, scheduled)
	if err != nil {
		t.Fatalf("GetPendingIntakesBySchedule failed: %v", err)
	}

	for _, p := range pending {
		if !p.ScheduledAt.Equal(scheduled) {
			t.Errorf("expected scheduled time %v, got %v", scheduled, p.ScheduledAt)
		}
		if p.Status != "PENDING" {
			t.Errorf("expected status PENDING, got %q", p.Status)
		}
	}
}

func TestGetTakenIntakesBySchedule(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00","21:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	otherTime := time.Date(2026, 2, 28, 21, 0, 0, 0, time.UTC)

	intake1, err := db.CreateIntake(medID, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}
	_, err = db.CreateIntake(medID, 12345, otherTime)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	// Confirm intake1
	err = db.ConfirmIntake(intake1, scheduled.Add(time.Minute))
	if err != nil {
		t.Fatalf("ConfirmIntake failed: %v", err)
	}

	taken, err := db.GetTakenIntakesBySchedule(12345, scheduled)
	if err != nil {
		t.Fatalf("GetTakenIntakesBySchedule failed: %v", err)
	}

	if len(taken) != 1 {
		t.Fatalf("expected 1 taken intake, got %d", len(taken))
	}

	for _, p := range taken {
		if !p.ScheduledAt.Equal(scheduled) {
			t.Errorf("expected scheduled time %v, got %v", scheduled, p.ScheduledAt)
		}
		if p.Status != "TAKEN" {
			t.Errorf("expected status TAKEN, got %q", p.Status)
		}
		if p.ID != intake1 {
			t.Errorf("expected intake ID %d, got %d", intake1, p.ID)
		}
	}
}

func TestGetPendingIntakesForMedication(t *testing.T) {
	db := setupTestStore(t)

	med1, err := db.CreateMedication("Med1", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}
	med2, err := db.CreateMedication("Med2", "10mg", `{"type":"daily","times":["10:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	_, err = db.CreateIntake(med1, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}
	_, err = db.CreateIntake(med2, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	pending, err := db.GetPendingIntakesForMedication(med1)
	if err != nil {
		t.Fatalf("GetPendingIntakesForMedication failed: %v", err)
	}

	for _, p := range pending {
		if p.MedicationID != med1 {
			t.Errorf("expected all pending intakes for med1, got medID=%d", p.MedicationID)
		}
	}
}

func TestDeleteIntake(t *testing.T) {
	db := setupTestStore(t)

	medID, err := db.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication failed: %v", err)
	}

	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	intakeID, err := db.CreateIntake(medID, 12345, scheduled)
	if err != nil {
		t.Fatalf("CreateIntake failed: %v", err)
	}

	err = db.DeleteIntake(intakeID)
	if err != nil {
		t.Fatalf("DeleteIntake failed: %v", err)
	}

	intake, err := db.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake after delete should not error: %v", err)
	}
	if intake != nil {
		t.Errorf("expected nil after deletion, got %+v", intake)
	}
}

func TestGetBatchIntakeReminders(t *testing.T) {
	db := setupTestStore(t)

	// Create some medications and intakes
	med1, _ := db.CreateMedication("Med1", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")

	scheduled := time.Date(2026, 2, 28, 9, 0, 0, 0, time.UTC)
	intake1, _ := db.CreateIntake(med1, 12345, scheduled)
	intake2, _ := db.CreateIntake(med1, 12345, scheduled.Add(24*time.Hour))

	// Add reminders
	_, _ = db.db.Exec("INSERT INTO intake_reminders (intake_id, message_id) VALUES (?, ?), (?, ?)", intake1, 101, intake1, 102)
	_, _ = db.db.Exec("INSERT INTO intake_reminders (intake_id, message_id) VALUES (?, ?)", intake2, 201)

	reminders, err := db.GetBatchIntakeReminders([]int64{intake1, intake2})
	if err != nil {
		t.Fatalf("GetBatchIntakeReminders failed: %v", err)
	}

	if len(reminders) != 2 {
		t.Fatalf("Expected 2 intakes in map, got %d", len(reminders))
	}
	if len(reminders[intake1]) != 2 {
		t.Errorf("Expected 2 reminders for intake1, got %d", len(reminders[intake1]))
	}
	if len(reminders[intake2]) != 1 {
		t.Errorf("Expected 1 reminder for intake2, got %d", len(reminders[intake2]))
	}
}
