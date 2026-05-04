package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// TestMedicationCheckerTZAware covers timezone-aware scheduling and transition plan execution.
func TestMedicationCheckerTZAware(t *testing.T) {
	t.Run("no plan, user TZ affects target computation", func(t *testing.T) {
		// Medication scheduled at 09:00 (clock time).
		// User timezone: UTC+5 (Asia/Yekaterinburg).
		// now = 2024-03-15T04:05:00Z = 09:05 in UTC+5.
		// Expected target: 09:00 UTC+5 = 04:00 UTC. since now (04:05) > target (04:00) → fires.
		db := mustNewDB(t)
		db.SetMedicationEnabled(context.Background(), true) //nolint:errcheck
		if err := db.RecordTimezone("Asia/Yekaterinburg"); err != nil {
			t.Fatalf("RecordTimezone: %v", err)
		}

		id, err := db.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 4, 5, 0, 0, time.UTC)
		if err := db.UpdateMedicationCreatedAt(id, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		pending, _ := db.GetPendingIntakes()
		if len(pending) != 1 {
			t.Errorf("expected 1 pending intake, got %d", len(pending))
		}
	})

	t.Run("no plan, user TZ: not yet due in user local time", func(t *testing.T) {
		// Medication scheduled at 09:00 (clock time).
		// User timezone: UTC+5.
		// now = 2024-03-15T03:55:00Z = 08:55 in UTC+5.
		// Target: 09:00 UTC+5 = 04:00 UTC. now (03:55) < target (04:00) → does not fire.
		db := mustNewDB(t)
		db.SetMedicationEnabled(context.Background(), true) //nolint:errcheck
		if err := db.RecordTimezone("Asia/Yekaterinburg"); err != nil {
			t.Fatalf("RecordTimezone: %v", err)
		}

		id, err := db.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 3, 55, 0, 0, time.UTC)
		if err := db.UpdateMedicationCreatedAt(id, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		pending, _ := db.GetPendingIntakes()
		if len(pending) != 0 {
			t.Errorf("expected 0 pending intakes (not yet due in user TZ), got %d", len(pending))
		}
	})

	t.Run("approved plan: step time used instead of normal schedule", func(t *testing.T) {
		// Medication normally at 09:00 UTC. An approved plan has a step at 11:00 UTC.
		// now = 11:05 UTC → plan step fires, normal schedule does not.
		db := mustNewDB(t)
		db.SetMedicationEnabled(context.Background(), true) //nolint:errcheck

		medID, err := db.CreateMedication("Warfarin", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 11, 5, 0, 0, time.UTC)
		if err := db.UpdateMedicationCreatedAt(medID, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		// Create approved plan.
		planID, err := db.CreateTZTransitionPlan(&store.TZTransitionPlan{
			OldTZ:      "UTC",
			NewTZ:      "Europe/Berlin",
			Status:     "APPROVED",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-approved",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		if _, err := db.SetTZTransitionPlanApproved(planID, nowTime.Add(-5*time.Minute)); err != nil {
			t.Fatalf("SetTZTransitionPlanApproved: %v", err)
		}

		stepTime := time.Date(2024, 3, 15, 11, 0, 0, 0, time.UTC)
		if err := db.CreateTZTransitionSteps([]store.TZTransitionStep{
			{PlanID: planID, MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step 1"},
		}); err != nil {
			t.Fatalf("CreateTZTransitionSteps: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		pending, _ := db.GetPendingIntakes()
		if len(pending) != 1 {
			t.Errorf("expected 1 pending intake (from plan step), got %d", len(pending))
		}
		if len(pending) > 0 && !pending[0].ScheduledAt.Equal(stepTime) {
			t.Errorf("intake scheduled_at = %v, want %v", pending[0].ScheduledAt, stepTime)
		}

		// Verify the step was marked consumed.
		remaining, _ := db.GetPendingStepsForPlan(planID)
		if len(remaining) != 0 {
			t.Errorf("expected 0 pending steps after consumption, got %d", len(remaining))
		}
	})

	t.Run("approved plan: future step blocks normal scheduling", func(t *testing.T) {
		// Plan has a step for Warfarin at 14:00 UTC, but now is 09:05 UTC.
		// Normal schedule is also 09:00 UTC. The plan step is not yet due, but the
		// med is in the plan → normal scheduling must be suppressed.
		db := mustNewDB(t)
		db.SetMedicationEnabled(context.Background(), true) //nolint:errcheck

		medID, err := db.CreateMedication("Warfarin", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 9, 5, 0, 0, time.UTC)
		if err := db.UpdateMedicationCreatedAt(medID, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		planID, err := db.CreateTZTransitionPlan(&store.TZTransitionPlan{
			OldTZ:      "UTC",
			NewTZ:      "Europe/Berlin",
			Status:     "APPROVED",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-future",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		if _, err := db.SetTZTransitionPlanApproved(planID, nowTime.Add(-5*time.Minute)); err != nil {
			t.Fatalf("SetTZTransitionPlanApproved: %v", err)
		}

		futureStepTime := time.Date(2024, 3, 15, 14, 0, 0, 0, time.UTC)
		if err := db.CreateTZTransitionSteps([]store.TZTransitionStep{
			{PlanID: planID, MedicationID: medID, StepNumber: 1, ScheduledAt: futureStepTime, Note: "future step"},
		}); err != nil {
			t.Fatalf("CreateTZTransitionSteps: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		// Normal schedule would have fired at 09:00 UTC; plan suppresses it.
		pending, _ := db.GetPendingIntakes()
		if len(pending) != 0 {
			t.Errorf("expected 0 pending intakes (plan suppresses normal schedule), got %d", len(pending))
		}
	})

	t.Run("partially consumed plan: only remaining steps used", func(t *testing.T) {
		// Plan has 2 steps. Step 1 already consumed. Step 2 at 14:00 UTC.
		// now = 14:05 UTC → only step 2 fires.
		db := mustNewDB(t)
		db.SetMedicationEnabled(context.Background(), true) //nolint:errcheck

		medID, err := db.CreateMedication("Warfarin", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 14, 5, 0, 0, time.UTC)
		if err := db.UpdateMedicationCreatedAt(medID, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		planID, err := db.CreateTZTransitionPlan(&store.TZTransitionPlan{
			OldTZ:      "UTC",
			NewTZ:      "Europe/Berlin",
			Status:     "APPROVED",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-partial",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		if _, err := db.SetTZTransitionPlanApproved(planID, nowTime.Add(-6*time.Hour)); err != nil {
			t.Fatalf("SetTZTransitionPlanApproved: %v", err)
		}

		step1Time := time.Date(2024, 3, 15, 11, 0, 0, 0, time.UTC)
		step2Time := time.Date(2024, 3, 15, 14, 0, 0, 0, time.UTC)
		if err := db.CreateTZTransitionSteps([]store.TZTransitionStep{
			{PlanID: planID, MedicationID: medID, StepNumber: 1, ScheduledAt: step1Time, Note: "step 1"},
			{PlanID: planID, MedicationID: medID, StepNumber: 2, ScheduledAt: step2Time, Note: "step 2"},
		}); err != nil {
			t.Fatalf("CreateTZTransitionSteps: %v", err)
		}

		// Mark step 1 already consumed (and create its intake).
		steps, _ := db.GetPendingStepsForPlan(planID)
		var step1ID int64
		for _, s := range steps {
			if s.StepNumber == 1 {
				step1ID = s.ID
				break
			}
		}
		if step1ID == 0 {
			t.Fatal("could not find step 1 ID")
		}
		if _, err := db.CreateIntake(medID, 123456, step1Time); err != nil {
			t.Fatalf("CreateIntake for step 1: %v", err)
		}
		if err := db.MarkStepConsumed(step1ID, step1Time.Add(2*time.Minute)); err != nil {
			t.Fatalf("MarkStepConsumed: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		pending, _ := db.GetPendingIntakes()
		// step 1 intake is in PENDING state; step 2 intake just created → 2 total
		if len(pending) != 2 {
			t.Errorf("expected 2 pending intakes (step1 existing + step2 new), got %d", len(pending))
		}

		// Verify step 2 was consumed.
		remaining, _ := db.GetPendingStepsForPlan(planID)
		if len(remaining) != 0 {
			t.Errorf("expected 0 remaining steps, got %d", len(remaining))
		}
	})

	t.Run("pending plan: preserves old timezone for normal scheduling", func(t *testing.T) {
		// Medication at 09:00. Stored TZ = Europe/Berlin (UTC+2), so without fix the
		// scheduler would build target = 09:00 CEST = 07:00 UTC. With the fix, it must
		// use the old TZ (UTC from the plan's OldTZ) and build target = 09:00 UTC.
		// now = 09:05 UTC → dose fires at 09:00 UTC (old TZ), not 07:00 UTC.
		db := mustNewDB(t)
		db.SetMedicationEnabled(context.Background(), true) //nolint:errcheck
		if err := db.RecordTimezone("Europe/Berlin"); err != nil {
			t.Fatalf("RecordTimezone: %v", err)
		}

		medID, err := db.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 9, 5, 0, 0, time.UTC)
		if err := db.UpdateMedicationCreatedAt(medID, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		planID, err := db.CreateTZTransitionPlan(&store.TZTransitionPlan{
			OldTZ:      "UTC",
			NewTZ:      "Europe/Berlin",
			Status:     "PENDING_APPROVAL",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-pending",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		_ = planID // plan exists but not approved

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		pending, _ := db.GetPendingIntakes()
		if len(pending) != 1 {
			t.Errorf("expected 1 pending intake (using old UTC timezone), got %d", len(pending))
			return
		}
		// The intake must be scheduled at 09:00 UTC (old TZ), not 07:00 UTC (new TZ).
		wantTarget := time.Date(2024, 3, 15, 9, 0, 0, 0, time.UTC)
		if !pending[0].ScheduledAt.Equal(wantTarget) {
			t.Errorf("intake scheduled_at = %v, want %v (old timezone preserved)", pending[0].ScheduledAt, wantTarget)
		}
	})

	t.Run("cancelled plan: normal scheduling resumes", func(t *testing.T) {
		// Plan exists but is CANCELLED → GetLatestActiveOrPendingTZTransitionPlan returns nil.
		// Normal schedule at 09:00 UTC fires at 09:05 UTC.
		db := mustNewDB(t)
		db.SetMedicationEnabled(context.Background(), true) //nolint:errcheck

		medID, err := db.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 9, 5, 0, 0, time.UTC)
		if err := db.UpdateMedicationCreatedAt(medID, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		// Create a CANCELLED plan (should be ignored).
		planID, err := db.CreateTZTransitionPlan(&store.TZTransitionPlan{
			OldTZ:      "UTC",
			NewTZ:      "Europe/Berlin",
			Status:     "PENDING_APPROVAL",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-cancelled",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		if err := db.UpdateTZTransitionPlanStatus(planID, "CANCELLED", "superseded", "PENDING_APPROVAL"); err != nil {
			t.Fatalf("UpdateTZTransitionPlanStatus: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		pending, _ := db.GetPendingIntakes()
		if len(pending) != 1 {
			t.Errorf("expected 1 pending intake (normal scheduling resumed), got %d", len(pending))
		}
	})

	t.Run("idempotent: intake already exists for plan step", func(t *testing.T) {
		// An intake already exists at step.ScheduledAt. Running Check again should not
		// create a duplicate intake but should mark the step consumed.
		db := mustNewDB(t)
		db.SetMedicationEnabled(context.Background(), true) //nolint:errcheck

		medID, err := db.CreateMedication("Warfarin", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 11, 5, 0, 0, time.UTC)
		if err := db.UpdateMedicationCreatedAt(medID, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		planID, err := db.CreateTZTransitionPlan(&store.TZTransitionPlan{
			OldTZ:      "UTC",
			NewTZ:      "Europe/Berlin",
			Status:     "APPROVED",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-idempotent",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		if _, err := db.SetTZTransitionPlanApproved(planID, nowTime.Add(-10*time.Minute)); err != nil {
			t.Fatalf("SetTZTransitionPlanApproved: %v", err)
		}

		stepTime := time.Date(2024, 3, 15, 11, 0, 0, 0, time.UTC)
		if err := db.CreateTZTransitionSteps([]store.TZTransitionStep{
			{PlanID: planID, MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step 1"},
		}); err != nil {
			t.Fatalf("CreateTZTransitionSteps: %v", err)
		}

		// Pre-create the intake (simulates a previous tick already creating it).
		if _, err := db.CreateIntake(medID, 123456, stepTime); err != nil {
			t.Fatalf("pre-CreateIntake: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		// No new intake created (existing one already there), step marked consumed.
		pending, _ := db.GetPendingIntakes()
		if len(pending) != 1 {
			t.Errorf("expected 1 pending intake (no duplicate), got %d", len(pending))
		}

		remaining, _ := db.GetPendingStepsForPlan(planID)
		if len(remaining) != 0 {
			t.Errorf("expected step marked consumed, got %d remaining", len(remaining))
		}
	})

	t.Run("approved plan: consumed step suppresses overlapping normal doses", func(t *testing.T) {
		// Reproduces the user-reported "duplicate evening dose" after a westbound
		// flight: a flexible-policy single-step plan was approved and the user
		// took the transition step. Now the plan is fully consumed and the
		// scheduler falls back to normal scheduling. Two normal targets land
		// inside the consumed step's exclusion window:
		//   * 08:20 PDT today is BEFORE the step time → would have fired in
		//     the old timezone; must be skipped.
		//   * 21:30 PDT today is exactly minInterval (7.2h for flexible / 12h
		//     interval) after the step → would re-prompt the user for a dose
		//     they just took; must be skipped.
		// The tomorrow morning 08:20 PDT slot is well outside the window and
		// stays available.
		db := mustNewDB(t)
		db.SetMedicationEnabled(context.Background(), true) //nolint:errcheck
		if err := db.RecordTimezone("America/Los_Angeles"); err != nil {
			t.Fatalf("RecordTimezone: %v", err)
		}

		medID, err := db.CreateMedication("Metformin", "1000mg",
			`{"type":"daily","times":["08:20","21:30"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}

		la, _ := time.LoadLocation("America/Los_Angeles")
		// now = 21:35 PDT — past both 08:20 PDT and 21:30 PDT today.
		nowTime := time.Date(2024, 3, 15, 21, 35, 0, 0, la)
		if err := db.UpdateMedicationCreatedAt(medID, nowTime.Add(-30*24*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		planID, err := db.CreateTZTransitionPlan(&store.TZTransitionPlan{
			OldTZ:      "Europe/Copenhagen",
			NewTZ:      "America/Los_Angeles",
			Status:     "APPROVED",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-overlap-guard",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		if _, err := db.SetTZTransitionPlanApproved(planID, nowTime.Add(-8*time.Hour)); err != nil {
			t.Fatalf("SetTZTransitionPlanApproved: %v", err)
		}

		// Single transition step at 14:18 PDT (the user-reported scenario).
		stepTime := time.Date(2024, 3, 15, 14, 18, 0, 0, la)
		if err := db.CreateTZTransitionSteps([]store.TZTransitionStep{
			{PlanID: planID, MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step 1"},
		}); err != nil {
			t.Fatalf("CreateTZTransitionSteps: %v", err)
		}
		// Mark step consumed: the user took it, the scheduler matched the
		// intake, and consumed_at was stamped.
		steps, _ := db.GetPendingStepsForPlan(planID)
		if len(steps) != 1 {
			t.Fatalf("expected 1 pending step, got %d", len(steps))
		}
		if _, err := db.CreateIntake(medID, 123456, stepTime); err != nil {
			t.Fatalf("CreateIntake for step: %v", err)
		}
		if err := db.MarkStepConsumed(steps[0].ID, stepTime.Add(2*time.Minute)); err != nil {
			t.Fatalf("MarkStepConsumed: %v", err)
		}
		// Mark the existing intake TAKEN so it is not in the PENDING set we
		// assert on below — this isolates the new-intake creation from the
		// pre-existing transition-step intake.
		stepIntake, err := db.GetIntakeBySchedule(medID, stepTime)
		if err != nil || stepIntake == nil {
			t.Fatalf("GetIntakeBySchedule for step: intake=%v err=%v", stepIntake, err)
		}
		if err := db.ConfirmIntake(stepIntake.ID, stepTime.Add(2*time.Minute)); err != nil {
			t.Fatalf("ConfirmIntake: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		// Both today's 08:20 PDT (predates the consumed step) and 21:30 PDT
		// (within minInterval after the step) must be suppressed. Without the
		// guard, two new PENDING intakes would land here.
		pending, _ := db.GetPendingIntakes()
		if len(pending) != 0 {
			for _, p := range pending {
				t.Logf("unexpected pending intake: med=%d scheduled=%v", p.MedicationID, p.ScheduledAt)
			}
			t.Errorf("expected 0 pending intakes (consumed-step guard suppresses both today targets), got %d", len(pending))
		}
	})
}

// mustNewDB creates an in-memory store for testing. Fatals on error.
func mustNewDB(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.New(":memory:")
	if err != nil {
		t.Fatalf("store.New: %v", err)
	}
	t.Cleanup(func() { db.Close() }) //nolint:errcheck
	return db
}
