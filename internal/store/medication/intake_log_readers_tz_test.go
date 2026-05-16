package medication

import (
	"testing"
	"time"
)

// These tests pin the cross-TZ correctness of the intake_log readers after
// the cutover to scheduled_at_unix (INTEGER, see Task 3 of
// docs/plans/2026-05-10-intake-log-utc-unix-fix.md). Each case writes a row
// in one time.Location and reads it back via a bind value in a *different*
// time.Location that represents the same absolute instant — what previously
// broke under SQL text-equality on the modernc.org/sqlite t.String()
// serialisation.

// scenario mirrors the prod-incident shape: the bot binary runs in
// Europe/Berlin while the user lives in America/Los_Angeles.
func crossTZTimes(t *testing.T) (storedLA, queryBerlin time.Time) {
	t.Helper()
	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("LoadLocation(LA): %v", err)
	}
	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("LoadLocation(Berlin): %v", err)
	}
	storedLA = time.Date(2026, 5, 10, 8, 20, 0, 0, la)
	queryBerlin = storedLA.In(berlin)
	return
}

func TestGetIntakeBySchedule_CrossTZ(t *testing.T) {
	db := setupMedicationRepo(t)

	medID, err := db.Create("Med", "5mg", `{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	storedLA, queryBerlin := crossTZTimes(t)
	if _, err := db.CreateIntake(medID, 12345, storedLA); err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	got, err := db.GetIntakeBySchedule(medID, queryBerlin)
	if err != nil {
		t.Fatalf("GetIntakeBySchedule: %v", err)
	}
	if got == nil {
		t.Fatalf("expected match across TZ (LA stored, Berlin query); got nil")
	}
	if !got.ScheduledAt.Equal(storedLA) {
		t.Errorf("ScheduledAt = %v, want same instant as %v", got.ScheduledAt, storedLA)
	}
}

func TestGetTakenIntakesBySchedule_CrossTZ(t *testing.T) {
	db := setupMedicationRepo(t)

	medID, err := db.Create("Med", "5mg", `{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	storedLA, queryBerlin := crossTZTimes(t)
	intakeID, err := db.CreateIntake(medID, 12345, storedLA)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}
	if err := db.ConfirmIntake(intakeID, storedLA.Add(5*time.Minute)); err != nil {
		t.Fatalf("ConfirmIntake: %v", err)
	}

	taken, err := db.ListTakenIntakesBySchedule(12345, queryBerlin)
	if err != nil {
		t.Fatalf("ListTakenIntakesBySchedule: %v", err)
	}
	if len(taken) != 1 {
		t.Fatalf("expected 1 taken row matched across TZ, got %d", len(taken))
	}
	if taken[0].ID != intakeID {
		t.Errorf("ID = %d, want %d", taken[0].ID, intakeID)
	}
}

func TestGetIntake_ScanIntoUTC(t *testing.T) {
	db := setupMedicationRepo(t)

	medID, err := db.Create("Med", "5mg", `{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	storedLA, _ := crossTZTimes(t)
	intakeID, err := db.CreateIntake(medID, 12345, storedLA)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	got, err := db.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake: %v", err)
	}
	if got == nil {
		t.Fatalf("GetIntake returned nil")
	}
	if !got.ScheduledAt.Equal(storedLA) {
		t.Errorf("ScheduledAt = %v, want same instant as %v", got.ScheduledAt, storedLA)
	}
	// Read path normalizes to UTC.
	if loc := got.ScheduledAt.Location(); loc != time.UTC {
		t.Errorf("ScheduledAt.Location() = %v, want UTC", loc)
	}
}

func TestGetIntakeHistory_CrossTZSince(t *testing.T) {
	db := setupMedicationRepo(t)

	medID, err := db.Create("Med", "5mg", `{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	la, _ := time.LoadLocation("America/Los_Angeles")
	// One row 3 days ago (in scope), one row 30 days ago (out of scope).
	now := time.Now().UTC()
	recent := time.Date(now.Year(), now.Month(), now.Day(), 8, 20, 0, 0, la).Add(-3 * 24 * time.Hour)
	old := recent.Add(-27 * 24 * time.Hour)

	if _, err := db.CreateManualIntake(medID, 12345, recent); err != nil {
		t.Fatalf("CreateManualIntake recent: %v", err)
	}
	if _, err := db.CreateManualIntake(medID, 12345, old); err != nil {
		t.Fatalf("CreateManualIntake old: %v", err)
	}

	// The ListIntakeHistory `days` parameter is interpreted as the lookback
	// window; with `days=7` only the 3-day-old row should be returned.
	hist, err := db.ListIntakeHistory(int(medID), 7)
	if err != nil {
		t.Fatalf("ListIntakeHistory: %v", err)
	}
	if len(hist) != 1 {
		t.Fatalf("expected 1 row in 7-day window across TZ, got %d", len(hist))
	}
	if !hist[0].ScheduledAt.Equal(recent) {
		t.Errorf("returned row ScheduledAt = %v, want same instant as %v", hist[0].ScheduledAt, recent)
	}
}

func TestGetPendingIntakesForMedication_ScanIntoUTC(t *testing.T) {
	db := setupMedicationRepo(t)

	medID, err := db.Create("Med", "5mg", `{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	storedLA, _ := crossTZTimes(t)
	if _, err := db.CreateIntake(medID, 12345, storedLA); err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	pending, err := db.ListPendingIntakesForMedication(medID)
	if err != nil {
		t.Fatalf("ListPendingIntakesForMedication: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("expected 1 pending row, got %d", len(pending))
	}
	if !pending[0].ScheduledAt.Equal(storedLA) {
		t.Errorf("ScheduledAt = %v, want same instant as %v", pending[0].ScheduledAt, storedLA)
	}
}

// TestGetIntakeHistory_TakenAtCrossTZ asserts that a TAKEN row written in one
// timezone is read back with TakenAt that compares equal to the original
// instant — covers the taken_at_unix cutover (Task 5).
func TestGetIntakeHistory_TakenAtCrossTZ(t *testing.T) {
	db := setupMedicationRepo(t)

	medID, err := db.Create("Med", "5mg", `{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	la, _ := time.LoadLocation("America/Los_Angeles")
	now := time.Now().UTC()
	// schedule and taken_at both in LA, recent enough to be inside default window
	sched := time.Date(now.Year(), now.Month(), now.Day(), 8, 20, 0, 0, la).Add(-2 * 24 * time.Hour)
	taken := sched.Add(3 * time.Minute)

	id, err := db.CreateIntake(medID, 12345, sched)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}
	if err := db.ConfirmIntake(id, taken); err != nil {
		t.Fatalf("ConfirmIntake: %v", err)
	}

	hist, err := db.ListIntakeHistory(int(medID), 7)
	if err != nil {
		t.Fatalf("ListIntakeHistory: %v", err)
	}
	if len(hist) != 1 {
		t.Fatalf("expected 1 history row, got %d", len(hist))
	}
	if hist[0].TakenAt == nil {
		t.Fatalf("expected non-nil TakenAt for TAKEN row")
	}
	if !hist[0].TakenAt.Equal(taken) {
		t.Errorf("TakenAt=%s, want same instant as %s", hist[0].TakenAt, taken)
	}
	// Read path normalizes to UTC.
	if hist[0].TakenAt.Location() != time.UTC {
		t.Errorf("TakenAt.Location()=%v, want UTC", hist[0].TakenAt.Location())
	}
}

// TestGetIntake_TakenAtCrossTZ — per-id read of a TAKEN row preserves the
// instant across a TZ boundary (write in LA, read normalizes to UTC).
func TestGetIntake_TakenAtCrossTZ(t *testing.T) {
	db := setupMedicationRepo(t)

	medID, err := db.Create("Med", "5mg", `{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	la, _ := time.LoadLocation("America/Los_Angeles")
	sched := time.Date(2026, 5, 10, 8, 20, 0, 0, la)
	taken := sched.Add(7 * time.Minute)

	id, err := db.CreateManualIntake(medID, 12345, taken)
	if err != nil {
		t.Fatalf("CreateManualIntake: %v", err)
	}

	got, err := db.GetIntake(id)
	if err != nil {
		t.Fatalf("GetIntake: %v", err)
	}
	if got == nil || got.TakenAt == nil {
		t.Fatalf("expected non-nil TakenAt")
	}
	if !got.TakenAt.Equal(taken) {
		t.Errorf("TakenAt=%s, want same instant as %s", got.TakenAt, taken)
	}
	if got.TakenAt.Location() != time.UTC {
		t.Errorf("TakenAt.Location()=%v, want UTC", got.TakenAt.Location())
	}
}

func TestGetIntakesSince_CrossTZ(t *testing.T) {
	db := setupMedicationRepo(t)

	medID, err := db.Create("Med", "5mg", `{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	la, _ := time.LoadLocation("America/Los_Angeles")
	berlin, _ := time.LoadLocation("Europe/Berlin")

	// Two rows: one before cutoff, one after.
	cutoffLA := time.Date(2026, 5, 10, 0, 0, 0, 0, la)
	beforeLA := cutoffLA.Add(-2 * time.Hour)
	afterLA := cutoffLA.Add(2 * time.Hour)

	if _, err := db.CreateManualIntake(medID, 12345, beforeLA); err != nil {
		t.Fatalf("CreateManualIntake before: %v", err)
	}
	if _, err := db.CreateManualIntake(medID, 12345, afterLA); err != nil {
		t.Fatalf("CreateManualIntake after: %v", err)
	}

	// Query with the cutoff expressed in Berlin's TZ — same absolute instant.
	cutoffBerlin := cutoffLA.In(berlin)
	rows, err := db.ListIntakesSince(cutoffBerlin)
	if err != nil {
		t.Fatalf("ListIntakesSince: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected 1 row >= cutoff across TZ, got %d", len(rows))
	}
	if !rows[0].ScheduledAt.Equal(afterLA) {
		t.Errorf("returned ScheduledAt = %v, want same instant as %v", rows[0].ScheduledAt, afterLA)
	}
}
