//go:build !mobile

package scheduler

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain"
	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// TestDeleteFutureIntake_RegeneratedByScheduler reproduces the user-reported
// flow: an MCP/agent mistakenly creates a future intake, the user deletes it
// via the domain service, and when the scheduled moment arrives the scheduler
// must recreate a fresh PENDING intake so the user is bugged again and has to
// explicitly skip or take it. Deletion must NOT silently swallow that dose.
func TestDeleteFutureIntake_RegeneratedByScheduler(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	defer db.Close() // #nosec G104

	ctx := context.Background()
	if err := db.Settings.SetMedicationEnabled(ctx, true); err != nil {
		t.Fatalf("SetMedicationEnabled: %v", err)
	}

	userID := int64(123456)
	realNow := time.Now()

	// Pick a future target rounded to minute precision so the schedule
	// HH:MM string lines up exactly with the scheduler's recomputed target.
	// The scheduler clock is later set to `target` itself (not target+ε)
	// so the recomputation lands on the same calendar day in time.Local
	// regardless of when the test runs.
	target := realNow.Add(2 * time.Hour).Round(time.Minute).In(time.Local)
	schedule := fmt.Sprintf(`{"type":"daily","times":["%02d:%02d"]}`, target.Hour(), target.Minute())

	medID, err := db.Medication.Create("Aspirin", "100mg", schedule, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := db.Medication.UpdateCreatedAt(medID, realNow.Add(-24*time.Hour)); err != nil {
		t.Fatalf("UpdateCreatedAt: %v", err)
	}

	// Step 1: an agent mistakenly creates a future intake at the scheduled slot.
	intakeID, err := db.Medication.CreateIntake(medID, userID, target)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}
	pre, err := db.Medication.GetIntake(intakeID)
	if err != nil || pre == nil {
		t.Fatalf("GetIntake setup check: pre=%v err=%v", pre, err)
	}
	if pre.Status != "PENDING" || !pre.ScheduledAt.After(time.Now()) {
		t.Fatalf("test invariant: intake must be PENDING and in the future, got status=%q scheduled_at=%v",
			pre.Status, pre.ScheduledAt)
	}

	// Step 2: the user deletes the future intake via the real domain service.
	svc := domain.NewMedicationService(db.Medication)
	if _, _, _, err := svc.DeleteFutureIntake(intakeID); err != nil {
		t.Fatalf("DeleteFutureIntake: %v", err)
	}
	if got, _ := db.Medication.GetIntake(intakeID); got != nil {
		t.Fatalf("expected intake row removed, got %+v", got)
	}

	// Step 3: time advances to the scheduled moment; the scheduler tick runs
	// against the same database. The scheduler clock is anchored to `target`
	// so its "today" computation matches our schedule HH:MM.
	sched := NewWithNotifiers(db, userID, []notifier.Notifier{&MockNotifier{}})
	sched.MedicationChecker.now = func() time.Time { return target }
	if err := sched.MedicationChecker.Check(ctx); err != nil {
		t.Fatalf("MedicationChecker.Check: %v", err)
	}
	// Match the existing scheduler test pattern: give the fire-and-forget
	// reminder-storing goroutines a moment to settle before db.Close runs,
	// otherwise they log a benign "database is closed" error.
	time.Sleep(10 * time.Millisecond)

	// Step 4: a fresh PENDING intake must exist — the user is "bugged" again
	// and has to explicitly take or skip. The deleted future intake did NOT
	// cause the dose to be silently swallowed.
	pending, err := db.Medication.ListPendingIntakes()
	if err != nil {
		t.Fatalf("ListPendingIntakes: %v", err)
	}

	var fresh *store.IntakeLog
	for i := range pending {
		if pending[i].MedicationID == medID {
			fresh = &pending[i]
			break
		}
	}
	if fresh == nil {
		t.Fatalf("scheduler did not recreate the intake after deletion; pending=%v", pending)
	}
	if fresh.ID == intakeID {
		t.Fatalf("expected a NEW intake row after regeneration, got reuse of deleted id %d", intakeID)
	}
	if fresh.Status != "PENDING" {
		t.Errorf("regenerated intake status: got %q want PENDING", fresh.Status)
	}
	if !fresh.ScheduledAt.Equal(target) {
		t.Errorf("regenerated scheduled_at: got %v, want %v (same instant)", fresh.ScheduledAt, target)
	}
}

// TestDeleteFutureIntake_RejectedAfterScheduledTimePassed covers the case
// where an intake was originally created with a future scheduled_at but the
// user only tries to delete it AFTER that moment has passed. Once the slot
// has elapsed, the user must explicitly take or skip the dose; deletion is
// rejected so history can't be silently rewritten.
func TestDeleteFutureIntake_RejectedAfterScheduledTimePassed(t *testing.T) {
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	defer db.Close() // #nosec G104

	userID := int64(123456)
	medID, err := db.Medication.Create("Aspirin", "100mg",
		`{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Simulate "was-future-when-created, now-past" by inserting a row whose
	// scheduled_at is already in the past while status is still PENDING —
	// the same on-disk shape as an intake that has aged past its slot before
	// the user got around to deleting it.
	pastSched := time.Now().Add(-1 * time.Hour)
	intakeID, err := db.Medication.CreateIntake(medID, userID, pastSched)
	if err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	svc := domain.NewMedicationService(db.Medication)
	_, _, _, err = svc.DeleteFutureIntake(intakeID)
	if !errors.Is(err, domain.ErrNotFutureIntake) {
		t.Fatalf("expected ErrNotFutureIntake once scheduled time has passed, got %v", err)
	}

	// Row must still exist; the user has to explicitly TAKE or SKIP.
	got, err := db.Medication.GetIntake(intakeID)
	if err != nil {
		t.Fatalf("GetIntake: %v", err)
	}
	if got == nil {
		t.Fatalf("intake must be preserved after rejected delete; row was removed")
	}
	if got.Status != "PENDING" {
		t.Errorf("status changed unexpectedly: got %q want PENDING (delete should be a no-op)", got.Status)
	}
}

// TestDeleteFutureIntake_RejectedForPastIntakes guards the audit trail: no
// past intake can be deleted — whether it's a stale PENDING that was missed,
// a TAKEN dose (history of what the user actually did), or a SKIPPED one
// (history of what the user explicitly chose to skip). Deleting any of these
// would silently rewrite the medication log.
func TestDeleteFutureIntake_RejectedForPastIntakes(t *testing.T) {
	cases := []struct {
		name string
		prep func(db *store.Store, medID, userID int64) (intakeID int64, wantStatus string)
	}{
		{
			name: "past PENDING (missed dose)",
			prep: func(db *store.Store, medID, userID int64) (int64, string) {
				id, err := db.Medication.CreateIntake(medID, userID, time.Now().Add(-2*time.Hour))
				if err != nil {
					t.Fatalf("CreateIntake: %v", err)
				}
				return id, "PENDING"
			},
		},
		{
			name: "past TAKEN (recorded history)",
			prep: func(db *store.Store, medID, userID int64) (int64, string) {
				id, err := db.Medication.CreateIntake(medID, userID, time.Now().Add(-2*time.Hour))
				if err != nil {
					t.Fatalf("CreateIntake: %v", err)
				}
				if err := db.Medication.ConfirmIntake(id, time.Now().Add(-1*time.Hour)); err != nil {
					t.Fatalf("ConfirmIntake: %v", err)
				}
				return id, "TAKEN"
			},
		},
		{
			name: "past SKIPPED (recorded history)",
			prep: func(db *store.Store, medID, userID int64) (int64, string) {
				id, err := db.Medication.CreateIntake(medID, userID, time.Now().Add(-2*time.Hour))
				if err != nil {
					t.Fatalf("CreateIntake: %v", err)
				}
				if err := db.Medication.SkipIntake(id); err != nil {
					t.Fatalf("SkipIntake: %v", err)
				}
				return id, "SKIPPED"
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, err := store.New(":memory:")
			if err != nil {
				t.Fatalf("store.New: %v", err)
			}
			defer db.Close() // #nosec G104

			userID := int64(123456)
			medID, err := db.Medication.Create("Aspirin", "100mg",
				`{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
			if err != nil {
				t.Fatalf("Create: %v", err)
			}

			intakeID, wantStatus := tc.prep(db, medID, userID)

			svc := domain.NewMedicationService(db.Medication)
			_, _, _, err = svc.DeleteFutureIntake(intakeID)
			if !errors.Is(err, domain.ErrNotFutureIntake) {
				t.Fatalf("expected ErrNotFutureIntake for past %s intake, got %v", wantStatus, err)
			}

			got, err := db.Medication.GetIntake(intakeID)
			if err != nil {
				t.Fatalf("GetIntake: %v", err)
			}
			if got == nil {
				t.Fatalf("intake row must be preserved; delete was a no-op but row is gone")
			}
			if got.Status != wantStatus {
				t.Errorf("status changed unexpectedly: got %q want %q", got.Status, wantStatus)
			}
		})
	}
}
