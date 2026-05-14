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
		db.Settings.SetMedicationEnabled(context.Background(), true) //nolint:errcheck
		if err := db.TZ.RecordTimezone("Asia/Yekaterinburg"); err != nil {
			t.Fatalf("RecordTimezone: %v", err)
		}

		id, err := db.Medication.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 4, 5, 0, 0, time.UTC)
		if err := db.Medication.UpdateMedicationCreatedAt(id, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		pending, _ := db.Medication.GetPendingIntakes()
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
		db.Settings.SetMedicationEnabled(context.Background(), true) //nolint:errcheck
		if err := db.TZ.RecordTimezone("Asia/Yekaterinburg"); err != nil {
			t.Fatalf("RecordTimezone: %v", err)
		}

		id, err := db.Medication.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 3, 55, 0, 0, time.UTC)
		if err := db.Medication.UpdateMedicationCreatedAt(id, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		pending, _ := db.Medication.GetPendingIntakes()
		if len(pending) != 0 {
			t.Errorf("expected 0 pending intakes (not yet due in user TZ), got %d", len(pending))
		}
	})

	t.Run("approved plan: step time used instead of normal schedule", func(t *testing.T) {
		// Medication normally at 09:00 UTC. An approved plan has a step at 11:00 UTC.
		// now = 11:05 UTC → plan step fires, normal schedule does not.
		db := mustNewDB(t)
		db.Settings.SetMedicationEnabled(context.Background(), true) //nolint:errcheck

		medID, err := db.Medication.CreateMedication("Warfarin", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 11, 5, 0, 0, time.UTC)
		if err := db.Medication.UpdateMedicationCreatedAt(medID, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		// Create approved plan.
		planID, err := db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
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
		if _, err := db.TZ.SetTZTransitionPlanApproved(planID, nowTime.Add(-5*time.Minute)); err != nil {
			t.Fatalf("SetTZTransitionPlanApproved: %v", err)
		}

		stepTime := time.Date(2024, 3, 15, 11, 0, 0, 0, time.UTC)
		if err := db.TZ.CreateTZTransitionSteps([]store.TZTransitionStep{
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

		pending, _ := db.Medication.GetPendingIntakes()
		if len(pending) != 1 {
			t.Errorf("expected 1 pending intake (from plan step), got %d", len(pending))
		}
		if len(pending) > 0 && !pending[0].ScheduledAt.Equal(stepTime) {
			t.Errorf("intake scheduled_at = %v, want %v", pending[0].ScheduledAt, stepTime)
		}

		// Verify the step was marked consumed.
		remaining, _ := db.TZ.GetPendingStepsForPlan(planID)
		if len(remaining) != 0 {
			t.Errorf("expected 0 pending steps after consumption, got %d", len(remaining))
		}
	})

	t.Run("approved plan: future step blocks normal scheduling", func(t *testing.T) {
		// Plan has a step for Warfarin at 14:00 UTC, but now is 09:05 UTC.
		// Normal schedule is also 09:00 UTC. The plan step is not yet due, but the
		// med is in the plan → normal scheduling must be suppressed.
		db := mustNewDB(t)
		db.Settings.SetMedicationEnabled(context.Background(), true) //nolint:errcheck

		medID, err := db.Medication.CreateMedication("Warfarin", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 9, 5, 0, 0, time.UTC)
		if err := db.Medication.UpdateMedicationCreatedAt(medID, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		planID, err := db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
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
		if _, err := db.TZ.SetTZTransitionPlanApproved(planID, nowTime.Add(-5*time.Minute)); err != nil {
			t.Fatalf("SetTZTransitionPlanApproved: %v", err)
		}

		futureStepTime := time.Date(2024, 3, 15, 14, 0, 0, 0, time.UTC)
		if err := db.TZ.CreateTZTransitionSteps([]store.TZTransitionStep{
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
		pending, _ := db.Medication.GetPendingIntakes()
		if len(pending) != 0 {
			t.Errorf("expected 0 pending intakes (plan suppresses normal schedule), got %d", len(pending))
		}
	})

	t.Run("partially consumed plan: only remaining steps used", func(t *testing.T) {
		// Plan has 2 steps. Step 1 already consumed. Step 2 at 14:00 UTC.
		// now = 14:05 UTC → only step 2 fires.
		db := mustNewDB(t)
		db.Settings.SetMedicationEnabled(context.Background(), true) //nolint:errcheck

		medID, err := db.Medication.CreateMedication("Warfarin", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 14, 5, 0, 0, time.UTC)
		if err := db.Medication.UpdateMedicationCreatedAt(medID, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		planID, err := db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
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
		if _, err := db.TZ.SetTZTransitionPlanApproved(planID, nowTime.Add(-6*time.Hour)); err != nil {
			t.Fatalf("SetTZTransitionPlanApproved: %v", err)
		}

		step1Time := time.Date(2024, 3, 15, 11, 0, 0, 0, time.UTC)
		step2Time := time.Date(2024, 3, 15, 14, 0, 0, 0, time.UTC)
		if err := db.TZ.CreateTZTransitionSteps([]store.TZTransitionStep{
			{PlanID: planID, MedicationID: medID, StepNumber: 1, ScheduledAt: step1Time, Note: "step 1"},
			{PlanID: planID, MedicationID: medID, StepNumber: 2, ScheduledAt: step2Time, Note: "step 2"},
		}); err != nil {
			t.Fatalf("CreateTZTransitionSteps: %v", err)
		}

		// Mark step 1 already consumed (and create its intake).
		steps, _ := db.TZ.GetPendingStepsForPlan(planID)
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
		if _, err := db.Medication.CreateIntake(medID, 123456, step1Time); err != nil {
			t.Fatalf("CreateIntake for step 1: %v", err)
		}
		if err := db.TZ.MarkStepConsumed(step1ID, step1Time.Add(2*time.Minute)); err != nil {
			t.Fatalf("MarkStepConsumed: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		pending, _ := db.Medication.GetPendingIntakes()
		// step 1 intake is in PENDING state; step 2 intake just created → 2 total
		if len(pending) != 2 {
			t.Errorf("expected 2 pending intakes (step1 existing + step2 new), got %d", len(pending))
		}

		// Verify step 2 was consumed.
		remaining, _ := db.TZ.GetPendingStepsForPlan(planID)
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
		db.Settings.SetMedicationEnabled(context.Background(), true) //nolint:errcheck
		if err := db.TZ.RecordTimezone("Europe/Berlin"); err != nil {
			t.Fatalf("RecordTimezone: %v", err)
		}

		medID, err := db.Medication.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 9, 5, 0, 0, time.UTC)
		if err := db.Medication.UpdateMedicationCreatedAt(medID, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		planID, err := db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
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

		pending, _ := db.Medication.GetPendingIntakes()
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
		db.Settings.SetMedicationEnabled(context.Background(), true) //nolint:errcheck
		// Pin the user TZ to UTC so the scheduler's no-plan branch — which
		// otherwise falls through to time.Local — interprets "09:00" as 09:00
		// UTC regardless of the test runner's local timezone. Other subtests
		// in this file do the same via RecordTimezone.
		if err := db.TZ.RecordTimezone("UTC"); err != nil {
			t.Fatalf("RecordTimezone: %v", err)
		}

		medID, err := db.Medication.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 9, 5, 0, 0, time.UTC)
		if err := db.Medication.UpdateMedicationCreatedAt(medID, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		// Create a CANCELLED plan (should be ignored).
		planID, err := db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
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
		if err := db.TZ.UpdateTZTransitionPlanStatus(planID, "CANCELLED", "superseded", "PENDING_APPROVAL"); err != nil {
			t.Fatalf("UpdateTZTransitionPlanStatus: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		pending, _ := db.Medication.GetPendingIntakes()
		if len(pending) != 1 {
			t.Errorf("expected 1 pending intake (normal scheduling resumed), got %d", len(pending))
		}
	})

	t.Run("idempotent: intake already exists for plan step", func(t *testing.T) {
		// An intake already exists at step.ScheduledAt. Running Check again should not
		// create a duplicate intake but should mark the step consumed.
		db := mustNewDB(t)
		db.Settings.SetMedicationEnabled(context.Background(), true) //nolint:errcheck

		medID, err := db.Medication.CreateMedication("Warfarin", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2024, 3, 15, 11, 5, 0, 0, time.UTC)
		if err := db.Medication.UpdateMedicationCreatedAt(medID, nowTime.Add(-48*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		planID, err := db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
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
		if _, err := db.TZ.SetTZTransitionPlanApproved(planID, nowTime.Add(-10*time.Minute)); err != nil {
			t.Fatalf("SetTZTransitionPlanApproved: %v", err)
		}

		stepTime := time.Date(2024, 3, 15, 11, 0, 0, 0, time.UTC)
		if err := db.TZ.CreateTZTransitionSteps([]store.TZTransitionStep{
			{PlanID: planID, MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step 1"},
		}); err != nil {
			t.Fatalf("CreateTZTransitionSteps: %v", err)
		}

		// Pre-create the intake (simulates a previous tick already creating it).
		if _, err := db.Medication.CreateIntake(medID, 123456, stepTime); err != nil {
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
		pending, _ := db.Medication.GetPendingIntakes()
		if len(pending) != 1 {
			t.Errorf("expected 1 pending intake (no duplicate), got %d", len(pending))
		}

		remaining, _ := db.TZ.GetPendingStepsForPlan(planID)
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
		db.Settings.SetMedicationEnabled(context.Background(), true) //nolint:errcheck
		if err := db.TZ.RecordTimezone("America/Los_Angeles"); err != nil {
			t.Fatalf("RecordTimezone: %v", err)
		}

		medID, err := db.Medication.CreateMedication("Metformin", "1000mg",
			`{"type":"daily","times":["08:20","21:30"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}

		la, _ := time.LoadLocation("America/Los_Angeles")
		// now = 21:35 PDT — past both 08:20 PDT and 21:30 PDT today.
		nowTime := time.Date(2024, 3, 15, 21, 35, 0, 0, la)
		if err := db.Medication.UpdateMedicationCreatedAt(medID, nowTime.Add(-30*24*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		planID, err := db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
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
		if _, err := db.TZ.SetTZTransitionPlanApproved(planID, nowTime.Add(-8*time.Hour)); err != nil {
			t.Fatalf("SetTZTransitionPlanApproved: %v", err)
		}

		// Single transition step at 14:18 PDT (the user-reported scenario).
		stepTime := time.Date(2024, 3, 15, 14, 18, 0, 0, la)
		if err := db.TZ.CreateTZTransitionSteps([]store.TZTransitionStep{
			{PlanID: planID, MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step 1"},
		}); err != nil {
			t.Fatalf("CreateTZTransitionSteps: %v", err)
		}
		// Mark step consumed: the user took it, the scheduler matched the
		// intake, and consumed_at was stamped.
		steps, _ := db.TZ.GetPendingStepsForPlan(planID)
		if len(steps) != 1 {
			t.Fatalf("expected 1 pending step, got %d", len(steps))
		}
		if _, err := db.Medication.CreateIntake(medID, 123456, stepTime); err != nil {
			t.Fatalf("CreateIntake for step: %v", err)
		}
		if err := db.TZ.MarkStepConsumed(steps[0].ID, stepTime.Add(2*time.Minute)); err != nil {
			t.Fatalf("MarkStepConsumed: %v", err)
		}
		// Mark the existing intake TAKEN so it is not in the PENDING set we
		// assert on below — this isolates the new-intake creation from the
		// pre-existing transition-step intake.
		stepIntake, err := db.Medication.GetIntakeBySchedule(medID, stepTime)
		if err != nil || stepIntake == nil {
			t.Fatalf("GetIntakeBySchedule for step: intake=%v err=%v", stepIntake, err)
		}
		if err := db.Medication.ConfirmIntake(stepIntake.ID, stepTime.Add(2*time.Minute)); err != nil {
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
		pending, _ := db.Medication.GetPendingIntakes()
		if len(pending) != 0 {
			for _, p := range pending {
				t.Logf("unexpected pending intake: med=%d scheduled=%v", p.MedicationID, p.ScheduledAt)
			}
			t.Errorf("expected 0 pending intakes (consumed-step guard suppresses both today targets), got %d", len(pending))
		}
	})
}

// TestMedicationCheckerCompletedPlanOverlapGuard pins the regression behind
// the duplicate "Time to take Candecor (21:30)" reminder the user got
// minutes after pressing "Take now". The previous tick consumed the plan's
// final step (22:30 PDT) and flipped status APPROVED → COMPLETED. The next
// tick used to lose the consumed-step times because the plan loader only
// returns ACTIVE/PENDING/APPROVED rows, so the now-superseded 21:30 PDT slot
// fired even though the user had already taken the corresponding dose.
func TestMedicationCheckerCompletedPlanOverlapGuard(t *testing.T) {
	db := mustNewDB(t)
	db.Settings.SetMedicationEnabled(context.Background(), true) //nolint:errcheck
	if err := db.TZ.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}

	medID, err := db.Medication.CreateMedication("Candecor", "16mg",
		`{"type":"daily","times":["21:30"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	la, _ := time.LoadLocation("America/Los_Angeles")
	// now = 22:11 PDT — past today's 21:30 PDT normal slot, just past the
	// 22:30 PDT step we already consumed below.
	nowTime := time.Date(2026, 5, 5, 22, 11, 0, 0, la)
	if err := db.Medication.UpdateMedicationCreatedAt(medID, nowTime.Add(-30*24*time.Hour)); err != nil {
		t.Fatalf("UpdateMedicationCreatedAt: %v", err)
	}

	planID, err := db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ:      "Europe/Copenhagen",
		NewTZ:      "America/Los_Angeles",
		Status:     "APPROVED",
		StepsJSON:  "[]",
		InputsJSON: "{}",
		PlanHash:   "testhash-completed-overlap",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	if _, err := db.TZ.SetTZTransitionPlanApproved(planID, nowTime.Add(-8*time.Hour)); err != nil {
		t.Fatalf("SetTZTransitionPlanApproved: %v", err)
	}

	stepTime := time.Date(2026, 5, 5, 22, 30, 0, 0, la)
	if err := db.TZ.CreateTZTransitionSteps([]store.TZTransitionStep{
		{PlanID: planID, MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "final"},
	}); err != nil {
		t.Fatalf("CreateTZTransitionSteps: %v", err)
	}
	steps, _ := db.TZ.GetPendingStepsForPlan(planID)
	if len(steps) != 1 {
		t.Fatalf("expected 1 pending step, got %d", len(steps))
	}
	// "Take now" path: create + immediately confirm the intake at the step
	// time, then mark the step consumed.
	stepIntakeID, err := db.Medication.CreateIntake(medID, 123456, stepTime)
	if err != nil {
		t.Fatalf("CreateIntake for step: %v", err)
	}
	if err := db.Medication.ConfirmIntake(stepIntakeID, nowTime); err != nil {
		t.Fatalf("ConfirmIntake: %v", err)
	}
	if err := db.TZ.MarkStepConsumed(steps[0].ID, nowTime); err != nil {
		t.Fatalf("MarkStepConsumed: %v", err)
	}
	// The previous scheduler tick noticed there were no remaining steps and
	// flipped the plan to COMPLETED.
	if err := db.TZ.UpdateTZTransitionPlanStatus(planID, "COMPLETED", "all-steps-consumed", "APPROVED"); err != nil {
		t.Fatalf("UpdateTZTransitionPlanStatus → COMPLETED: %v", err)
	}

	mock := &MockNotifier{}
	sched := New(db, 123456, []notifier.Notifier{mock})
	sched.MedicationChecker.now = func() time.Time { return nowTime }

	if err := sched.MedicationChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}
	time.Sleep(10 * time.Millisecond)

	// The TAKEN step intake should be the ONLY intake. No new PENDING row
	// should have been spawned at 21:30 PDT (the superseded normal slot) or
	// at 22:30 PDT (the just-consumed step's own slot).
	pending, _ := db.Medication.GetPendingIntakes()
	if len(pending) != 0 {
		for _, p := range pending {
			t.Logf("unexpected pending intake: med=%d scheduled=%v", p.MedicationID, p.ScheduledAt)
		}
		t.Errorf("expected 0 PENDING intakes after COMPLETED plan, got %d", len(pending))
	}

	// Sanity-check the bogus 21:30 PDT slot specifically — that was the
	// duplicate reminder the user reported.
	bogus := time.Date(2026, 5, 5, 21, 30, 0, 0, la)
	if got, _ := db.Medication.GetIntakeBySchedule(medID, bogus); got != nil {
		t.Errorf("unexpected intake at superseded 21:30 PDT slot: %+v", got)
	}
}

// TestScheduler_NoDuplicateIntakeAfterTZNameChangeSameOffset pins the headline
// regression behind the 2026-05-10 incident: the user flew from California
// (PDT, UTC-7) to Phoenix (MST, UTC-7) and accepted the timezone change. The
// 08:20 dose taken in LA was stored as scheduled_at = "… -0700 PDT" while the
// next scheduler tick built a Phoenix target whose driver-serialized form was
// "… -0700 MST". SQL text equality on `scheduled_at` missed the existing row
// because the TZ-name part of the string differed even though the absolute
// instant matched. Cutover to scheduled_at_unix (INTEGER) collapses the
// comparison to integer equality, so this test asserts no duplicate PENDING
// row is created when the user TZ name changes between ticks at the same
// offset.
func TestScheduler_NoDuplicateIntakeAfterTZNameChangeSameOffset(t *testing.T) {
	db := mustNewDB(t)
	db.Settings.SetMedicationEnabled(context.Background(), true) //nolint:errcheck
	if err := db.TZ.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone(LA): %v", err)
	}

	medID, err := db.Medication.CreateMedication("Metformin", "1000mg",
		`{"type":"daily","times":["08:20"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	la, _ := time.LoadLocation("America/Los_Angeles")
	phx, _ := time.LoadLocation("America/Phoenix")

	// The user took the dose at 08:20 LA earlier in the day. Write it as the
	// scheduler would: target time constructed in the user's location.
	doseTimeLA := time.Date(2026, 5, 10, 8, 20, 0, 0, la)
	if err := db.Medication.UpdateMedicationCreatedAt(medID, doseTimeLA.Add(-30*24*time.Hour)); err != nil {
		t.Fatalf("UpdateMedicationCreatedAt: %v", err)
	}
	intakeID, err := db.Medication.CreateIntake(medID, 123456, doseTimeLA)
	if err != nil {
		t.Fatalf("CreateIntake (LA dose): %v", err)
	}
	// Confirm it taken — the buggy scheduler was duplicating TAKEN doses with
	// fresh PENDING rows after the TZ name change.
	if err := db.Medication.ConfirmIntake(intakeID, doseTimeLA.Add(5*time.Minute)); err != nil {
		t.Fatalf("ConfirmIntake: %v", err)
	}

	// Now the user lands in Phoenix and the bot records the new TZ. Both
	// zones are UTC-7 on this date, so 08:20 Phoenix == 08:20 LA == 15:20 UTC.
	if err := db.TZ.RecordTimezone("America/Phoenix"); err != nil {
		t.Fatalf("RecordTimezone(Phoenix): %v", err)
	}

	// Run the scheduler tick at 09:00 Phoenix. This is past 08:20 Phoenix, so
	// medplan emits 08:20 Phoenix as a target and BatchGetIntakesBySchedule
	// must find the existing row (15:20 UTC) by integer equality.
	nowTime := time.Date(2026, 5, 10, 9, 0, 0, 0, phx)
	mock := &MockNotifier{}
	sched := New(db, 123456, []notifier.Notifier{mock})
	sched.MedicationChecker.now = func() time.Time { return nowTime }

	if err := sched.MedicationChecker.Check(context.Background()); err != nil {
		t.Fatalf("Check: %v", err)
	}
	time.Sleep(10 * time.Millisecond)

	// Pending = 0: the TAKEN dose covers the slot, no duplicate is created.
	pending, _ := db.Medication.GetPendingIntakes()
	if len(pending) != 0 {
		for _, p := range pending {
			t.Logf("unexpected pending intake: med=%d scheduled=%v status=%s",
				p.MedicationID, p.ScheduledAt, p.Status)
		}
		t.Errorf("expected 0 PENDING intakes after TZ-name change (LA→Phoenix), got %d", len(pending))
	}

	// Total intakes for the med should still be exactly one (the TAKEN row).
	hist, err := db.Medication.GetIntakeHistory(int(medID), 0)
	if err != nil {
		t.Fatalf("GetIntakeHistory: %v", err)
	}
	if len(hist) != 1 {
		t.Errorf("expected 1 intake total (no duplicate row), got %d", len(hist))
	}
	if len(hist) > 0 && hist[0].Status != "TAKEN" {
		t.Errorf("expected the surviving intake to be TAKEN, got %q", hist[0].Status)
	}
}

// TestStoreAdapter_GetPendingIntakesForMedication confirms the scheduler's
// store adapter forwards the per-med pending lookup to the underlying
// medication repo. Used by the plan-step near-match dedup in
// MedicationChecker.Check (see plan 2026-05-14-tz-plan-step-dedupe-near-match).
func TestStoreAdapter_GetPendingIntakesForMedication(t *testing.T) {
	db := mustNewDB(t)
	medID, err := db.Medication.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}
	if _, err := db.Medication.CreateIntake(medID, 1, time.Date(2026, 5, 14, 9, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("CreateIntake: %v", err)
	}

	adapter := newStoreAdapter(db)
	var ms MedicationStore = adapter
	got, err := ms.GetPendingIntakesForMedication(medID)
	if err != nil {
		t.Fatalf("adapter.GetPendingIntakesForMedication: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 pending intake via adapter, got %d", len(got))
	}
	if got[0].MedicationID != medID {
		t.Errorf("expected medication ID %d, got %d", medID, got[0].MedicationID)
	}
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
