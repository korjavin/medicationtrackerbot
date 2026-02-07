package store

import (
	"os"
	"testing"
	"time"
)

// setupTestDB creates a temporary test database
func setupTestDB(t *testing.T) (*Store, func()) {
	tmpFile, err := os.CreateTemp("", "test_*.db")
	if err != nil {
		t.Fatalf("Failed to create temp db: %v", err)
	}
	dbPath := tmpFile.Name()
	tmpFile.Close()

	store, err := New(dbPath)
	if err != nil {
		os.Remove(dbPath)
		t.Fatalf("Failed to create store: %v", err)
	}

	// Initialize settings table with test user to avoid migration issues
	_, err = store.db.Exec("INSERT OR IGNORE INTO settings (id, last_download) VALUES (1, datetime('now'))")
	if err != nil {
		store.Close()
		os.Remove(dbPath)
		t.Fatalf("Failed to initialize settings: %v", err)
	}

	cleanup := func() {
		store.Close()
		os.Remove(dbPath)
	}

	return store, cleanup
}

func TestUpdateMedication_ArchivingDeletesPendingIntakes(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	userID := int64(1)
	now := time.Now()

	// Create a medication
	medID, err := store.CreateMedication("Test Med", "10mg", "08:00", nil, nil, "", "")
	if err != nil {
		t.Fatalf("Failed to create medication: %v", err)
	}

	// Create multiple intakes: pending, taken, and missed
	pendingIntake1, err := store.CreateIntake(medID, userID, now.Add(1*time.Hour))
	if err != nil {
		t.Fatalf("Failed to create pending intake 1: %v", err)
	}

	pendingIntake2, err := store.CreateIntake(medID, userID, now.Add(2*time.Hour))
	if err != nil {
		t.Fatalf("Failed to create pending intake 2: %v", err)
	}

	takenIntake, err := store.CreateIntake(medID, userID, now.Add(-1*time.Hour))
	if err != nil {
		t.Fatalf("Failed to create taken intake: %v", err)
	}
	if err := store.ConfirmIntake(takenIntake, now); err != nil {
		t.Fatalf("Failed to confirm taken intake: %v", err)
	}

	// Archive the medication
	err = store.UpdateMedication(medID, "Test Med", "10mg", "08:00", true, nil, nil, "", "", nil)
	if err != nil {
		t.Fatalf("Failed to archive medication: %v", err)
	}

	// Verify pending intakes are deleted
	intake1, err := store.GetIntake(pendingIntake1)
	if err != nil {
		t.Fatalf("Failed to get pending intake 1: %v", err)
	}
	if intake1 != nil {
		t.Errorf("Expected pending intake 1 to be deleted, but it still exists")
	}

	intake2, err := store.GetIntake(pendingIntake2)
	if err != nil {
		t.Fatalf("Failed to get pending intake 2: %v", err)
	}
	if intake2 != nil {
		t.Errorf("Expected pending intake 2 to be deleted, but it still exists")
	}

	// Verify taken intake still exists
	takenLog, err := store.GetIntake(takenIntake)
	if err != nil {
		t.Fatalf("Failed to get taken intake: %v", err)
	}
	if takenLog == nil {
		t.Errorf("Expected taken intake to still exist, but it was deleted")
	}
	if takenLog != nil && takenLog.Status != "TAKEN" {
		t.Errorf("Expected taken intake status to be TAKEN, got %s", takenLog.Status)
	}
}

func TestUpdateMedication_ArchivingDeletesNotifications(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	userID := int64(1)
	now := time.Now()

	// Create a medication
	medID, err := store.CreateMedication("Test Med With Notifications", "5mg", "09:00", nil, nil, "", "")
	if err != nil {
		t.Fatalf("Failed to create medication: %v", err)
	}

	// Create pending intake with reminder messages
	intakeID, err := store.CreateIntake(medID, userID, now.Add(1*time.Hour))
	if err != nil {
		t.Fatalf("Failed to create pending intake: %v", err)
	}

	// Add reminder messages (simulating sent notifications)
	err = store.StoreReminderMessage(userID, intakeID, "telegram", "12345")
	if err != nil {
		t.Fatalf("Failed to save telegram reminder: %v", err)
	}

	err = store.StoreReminderMessage(userID, intakeID, "web_push", "abcdef")
	if err != nil {
		t.Fatalf("Failed to save web_push reminder: %v", err)
	}

	// Verify reminders exist before archiving
	reminders, err := store.GetReminderMessages(intakeID)
	if err != nil {
		t.Fatalf("Failed to get reminders: %v", err)
	}
	if len(reminders) != 2 {
		t.Fatalf("Expected 2 reminders, got %d", len(reminders))
	}

	// Archive the medication
	err = store.UpdateMedication(medID, "Test Med With Notifications", "5mg", "09:00", true, nil, nil, "", "", nil)
	if err != nil {
		t.Fatalf("Failed to archive medication: %v", err)
	}

	// Verify reminders are deleted (due to intake deletion with CASCADE)
	reminders, err = store.GetReminderMessages(intakeID)
	if err != nil {
		t.Fatalf("Failed to get reminders after archive: %v", err)
	}
	if len(reminders) != 0 {
		t.Errorf("Expected 0 reminders after archiving, got %d", len(reminders))
	}
}

func TestConfirmIntakesBySchedule_ExcludesArchivedMedications(t *testing.T) {
	store, cleanup := setupTestDB(t)
	defer cleanup()

	userID := int64(1)
	scheduledTime := time.Date(2026, 2, 7, 10, 0, 0, 0, time.UTC)
	takenTime := time.Now()

	// Create two medications
	activeMedID, err := store.CreateMedication("Active Med", "10mg", "10:00", nil, nil, "", "")
	if err != nil {
		t.Fatalf("Failed to create active medication: %v", err)
	}

	archivedMedID, err := store.CreateMedication("Archived Med", "20mg", "10:00", nil, nil, "", "")
	if err != nil {
		t.Fatalf("Failed to create archived medication: %v", err)
	}

	// Archive the second medication
	err = store.UpdateMedication(archivedMedID, "Archived Med", "20mg", "10:00", true, nil, nil, "", "", nil)
	if err != nil {
		t.Fatalf("Failed to archive medication: %v", err)
	}

	// Create pending intakes for both medications at the same scheduled time
	activeIntakeID, err := store.CreateIntake(activeMedID, userID, scheduledTime)
	if err != nil {
		t.Fatalf("Failed to create active intake: %v", err)
	}

	archivedIntakeID, err := store.CreateIntake(archivedMedID, userID, scheduledTime)
	if err != nil {
		t.Fatalf("Failed to create archived intake: %v", err)
	}

	// Confirm all intakes at the scheduled time (simulating "Confirm All" button)
	err = store.ConfirmIntakesBySchedule(userID, scheduledTime, takenTime)
	if err != nil {
		t.Fatalf("Failed to confirm intakes by schedule: %v", err)
	}

	// Verify active medication's intake is confirmed
	activeIntake, err := store.GetIntake(activeIntakeID)
	if err != nil {
		t.Fatalf("Failed to get active intake: %v", err)
	}
	if activeIntake == nil || activeIntake.Status != "TAKEN" {
		t.Errorf("Expected active intake to be TAKEN, got %v", activeIntake)
	}

	// Verify archived medication's intake is NOT confirmed
	archivedIntake, err := store.GetIntake(archivedIntakeID)
	if err != nil {
		t.Fatalf("Failed to get archived intake: %v", err)
	}
	if archivedIntake == nil {
		t.Fatalf("Archived intake was unexpectedly deleted")
	}
	if archivedIntake.Status != "PENDING" {
		t.Errorf("Expected archived intake to remain PENDING, got %s", archivedIntake.Status)
	}
}
