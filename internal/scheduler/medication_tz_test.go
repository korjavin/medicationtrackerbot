package scheduler

import (
	"context"
	"encoding/json"
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
		// now = 11:05 UTC → plan step fires (pre-materialized at approve time),
		// the 09:00 normal slot is suppressed by the symmetric ±minInterval dedup
		// against the step intake (2h apart, well inside flexible 14.4h).
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

		// Create pending plan, register steps, then approve+materialize via
		// the lifecycle path so the step lands as a PENDING source='tz_step'
		// intake_log row.
		planID, err := db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
			OldTZ:      "UTC",
			NewTZ:      "Europe/Berlin",
			Status:     "PENDING_APPROVAL",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-approved",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		stepTime := time.Date(2024, 3, 15, 11, 0, 0, 0, time.UTC)
		setPlanSteps(t, db, planID, []planStepFixture{
			{MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step 1"},
		})
		if _, err := db.ApproveAndMaterialize(context.Background(), planID, 123456, nowTime.Add(-5*time.Minute)); err != nil {
			t.Fatalf("ApproveAndMaterialize: %v", err)
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
		if len(pending) > 0 && pending[0].Source != "tz_step" {
			t.Errorf("intake source = %q, want tz_step", pending[0].Source)
		}

		// All step times have arrived: the scheduler tick must have flipped
		// the plan to COMPLETED.
		got, err := db.TZ.GetTZTransitionPlan(planID)
		if err != nil || got == nil {
			t.Fatalf("GetTZTransitionPlan: plan=%v err=%v", got, err)
		}
		if got.Status != "COMPLETED" {
			t.Errorf("plan status = %s, want COMPLETED", got.Status)
		}
	})

	t.Run("approved plan: future step blocks normal scheduling", func(t *testing.T) {
		// Plan has a step for Warfarin at 14:00 UTC, but now is 09:05 UTC.
		// Normal schedule is also 09:00 UTC. After approve+materialize, the
		// future step lives in intake_log as PENDING source='tz_step'; the
		// scheduler tick at 09:05 must NOT spawn a normal-schedule intake
		// for 09:00 (suppressed by the symmetric ±minInterval dedup against
		// the 14:00 step row — 5h apart, well inside flexible 14.4h).
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
			Status:     "PENDING_APPROVAL",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-future",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		futureStepTime := time.Date(2024, 3, 15, 14, 0, 0, 0, time.UTC)
		setPlanSteps(t, db, planID, []planStepFixture{
			{MedicationID: medID, StepNumber: 1, ScheduledAt: futureStepTime, Note: "future step"},
		})
		if _, err := db.ApproveAndMaterialize(context.Background(), planID, 123456, nowTime.Add(-5*time.Minute)); err != nil {
			t.Fatalf("ApproveAndMaterialize: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		// Only the pre-materialized future step is in PENDING. The 09:00
		// normal target is suppressed by the symmetric dedup; no second row
		// at 09:00 UTC was created.
		pending, _ := db.Medication.GetPendingIntakes()
		if len(pending) != 1 {
			t.Errorf("expected 1 pending intake (the pre-materialized future step), got %d", len(pending))
		}
		if len(pending) > 0 {
			if !pending[0].ScheduledAt.Equal(futureStepTime) {
				t.Errorf("intake scheduled_at = %v, want %v (future step)", pending[0].ScheduledAt, futureStepTime)
			}
			if pending[0].Source != "tz_step" {
				t.Errorf("intake source = %q, want tz_step", pending[0].Source)
			}
		}
	})

	t.Run("partially consumed plan: only remaining steps used", func(t *testing.T) {
		// Plan has 2 steps. After approve+materialize both step rows live in
		// intake_log as PENDING source='tz_step'. The user takes step 1 (the
		// intake is flipped to TAKEN). now = 14:05 UTC → step 2 (at 14:00)
		// fires this tick.
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
			Status:     "PENDING_APPROVAL",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-partial",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		step1Time := time.Date(2024, 3, 15, 11, 0, 0, 0, time.UTC)
		step2Time := time.Date(2024, 3, 15, 14, 0, 0, 0, time.UTC)
		setPlanSteps(t, db, planID, []planStepFixture{
			{MedicationID: medID, StepNumber: 1, ScheduledAt: step1Time, Note: "step 1"},
			{MedicationID: medID, StepNumber: 2, ScheduledAt: step2Time, Note: "step 2"},
		})
		if _, err := db.ApproveAndMaterialize(context.Background(), planID, 123456, nowTime.Add(-6*time.Hour)); err != nil {
			t.Fatalf("ApproveAndMaterialize: %v", err)
		}

		// Simulate the user having already taken step 1: flip its
		// pre-materialized intake_log row to TAKEN.
		step1Intake, err := db.Medication.GetIntakeBySchedule(medID, step1Time)
		if err != nil || step1Intake == nil {
			t.Fatalf("GetIntakeBySchedule(step1): intake=%v err=%v", step1Intake, err)
		}
		if err := db.Medication.ConfirmIntake(step1Intake.ID, step1Time.Add(2*time.Minute)); err != nil {
			t.Fatalf("ConfirmIntake(step1): %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		// Step 1 = TAKEN, step 2 = PENDING (its time arrived this tick).
		pending, _ := db.Medication.GetPendingIntakes()
		if len(pending) != 1 {
			t.Errorf("expected 1 pending intake (step 2 only; step 1 already taken), got %d", len(pending))
		}
		if len(pending) > 0 && !pending[0].ScheduledAt.Equal(step2Time) {
			t.Errorf("pending scheduled_at = %v, want %v", pending[0].ScheduledAt, step2Time)
		}

		// All step times have arrived → plan COMPLETED.
		got, err := db.TZ.GetTZTransitionPlan(planID)
		if err != nil || got == nil {
			t.Fatalf("GetTZTransitionPlan: plan=%v err=%v", got, err)
		}
		if got.Status != "COMPLETED" {
			t.Errorf("plan status = %s, want COMPLETED", got.Status)
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

	t.Run("idempotent: re-running scheduler does not duplicate the materialized step intake", func(t *testing.T) {
		// After approve+materialize a single step intake exists at 11:00 UTC.
		// Calling Check twice (simulating a restart) must not produce a
		// second intake_log row: the row is already in PENDING state, so the
		// second tick's tz_step-due query finds it again but does not insert.
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
			Status:     "PENDING_APPROVAL",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-idempotent",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		stepTime := time.Date(2024, 3, 15, 11, 0, 0, 0, time.UTC)
		setPlanSteps(t, db, planID, []planStepFixture{
			{MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step 1"},
		})
		if _, err := db.ApproveAndMaterialize(context.Background(), planID, 123456, nowTime.Add(-10*time.Minute)); err != nil {
			t.Fatalf("ApproveAndMaterialize: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		// Two ticks in a row.
		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check (1): %v", err)
		}
		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check (2): %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		// Still exactly one intake_log row at the step time.
		hist, err := db.Medication.GetIntakeHistory(int(medID), 0)
		if err != nil {
			t.Fatalf("GetIntakeHistory: %v", err)
		}
		if len(hist) != 1 {
			t.Errorf("expected 1 intake_log row (no duplicate from repeated ticks), got %d", len(hist))
		}
		if len(hist) > 0 {
			if !hist[0].ScheduledAt.Equal(stepTime) {
				t.Errorf("intake scheduled_at = %v, want %v", hist[0].ScheduledAt, stepTime)
			}
			if hist[0].Source != "tz_step" {
				t.Errorf("intake source = %q, want tz_step", hist[0].Source)
			}
		}
	})

	t.Run("approved plan: consumed step suppresses overlapping normal doses", func(t *testing.T) {
		// Reproduces the user-reported "duplicate evening dose" after a westbound
		// flight: a flexible-policy single-step plan was approved+materialized
		// and the user took the transition step (intake_log row at 14:18 PDT
		// is TAKEN). Two normal targets land inside the new symmetric
		// ±minInterval dedup window:
		//   * 08:20 PDT today is 5h58m BEFORE the step → suppressed (in band).
		//   * 21:30 PDT today is exactly minInterval (7h12m for flexible 12h
		//     interval) after the step → suppressed.
		// The tomorrow morning 08:20 PDT slot is well outside the window.
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
			Status:     "PENDING_APPROVAL",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-overlap-guard",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		// Single transition step at 14:18 PDT (the user-reported scenario).
		stepTime := time.Date(2024, 3, 15, 14, 18, 0, 0, la)
		setPlanSteps(t, db, planID, []planStepFixture{
			{MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step 1"},
		})
		if _, err := db.ApproveAndMaterialize(context.Background(), planID, 123456, nowTime.Add(-8*time.Hour)); err != nil {
			t.Fatalf("ApproveAndMaterialize: %v", err)
		}

		// The user took the step: flip the materialized intake to TAKEN.
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

		// Both today's 08:20 PDT and 21:30 PDT normal slots must be
		// suppressed by the new symmetric ±minInterval dedup against the
		// TAKEN step row. No NEW PENDING intake landed.
		pending, _ := db.Medication.GetPendingIntakes()
		if len(pending) != 0 {
			for _, p := range pending {
				t.Logf("unexpected pending intake: med=%d scheduled=%v", p.MedicationID, p.ScheduledAt)
			}
			t.Errorf("expected 0 pending intakes (dedup suppresses both today targets), got %d", len(pending))
		}
	})

	t.Run("approved plan: past step coexists with pre-existing normal intake", func(t *testing.T) {
		// Pre-Task-11 the scheduler's "near-match merge" fallback would have
		// consumed a step at 02:28:24 UTC against a pre-existing normal
		// intake at 02:30 UTC, leaving a single row. With pre-materialization
		// (Task 10) the step row is inserted at approve time without
		// consulting pre-existing rows, so two intake rows now coexist —
		// the pre-existing 02:30 normal row and the materialized 02:28:24
		// tz_step row. The scheduler's symmetric dedup still prevents a new
		// normal-schedule 02:30 row from being created on later ticks.
		db := mustNewDB(t)
		db.Settings.SetMedicationEnabled(context.Background(), true) //nolint:errcheck
		if err := db.TZ.RecordTimezone("UTC"); err != nil {
			t.Fatalf("RecordTimezone: %v", err)
		}

		medID, err := db.Medication.CreateMedication("Candecor", "16mg",
			`{"type":"daily","times":["02:30"]}`, nil, nil, "", "", "medium")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2026, 5, 14, 5, 27, 0, 0, time.UTC)
		if err := db.Medication.UpdateMedicationCreatedAt(medID, nowTime.Add(-30*24*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		// Pre-existing PENDING intake at 02:30:00 UTC today.
		normalSlot := time.Date(2026, 5, 14, 2, 30, 0, 0, time.UTC)
		existingID, err := db.Medication.CreateIntake(medID, 123456, normalSlot)
		if err != nil {
			t.Fatalf("CreateIntake (pre-existing): %v", err)
		}

		planID, err := db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
			OldTZ:      "America/Chicago",
			NewTZ:      "Europe/Berlin",
			Status:     "PENDING_APPROVAL",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-near-match-A",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		stepTime := time.Date(2026, 5, 14, 2, 28, 24, 0, time.UTC)
		setPlanSteps(t, db, planID, []planStepFixture{
			{MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step 1"},
		})
		if _, err := db.ApproveAndMaterialize(context.Background(), planID, 123456, nowTime.Add(-10*time.Minute)); err != nil {
			t.Fatalf("ApproveAndMaterialize: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		// Two intake_log rows: pre-existing normal + materialized tz_step.
		hist, err := db.Medication.GetIntakeHistory(int(medID), 0)
		if err != nil {
			t.Fatalf("GetIntakeHistory: %v", err)
		}
		if len(hist) != 2 {
			for _, h := range hist {
				t.Logf("intake row: id=%d scheduled=%v source=%s status=%s", h.ID, h.ScheduledAt, h.Source, h.Status)
			}
			t.Errorf("expected 2 intake_log rows (pre-existing + materialized step), got %d", len(hist))
		}
		// Pre-existing row survives.
		if got, _ := db.Medication.GetIntakeBySchedule(medID, normalSlot); got == nil || got.ID != existingID {
			t.Errorf("pre-existing 02:30 row missing or replaced: got %+v want id=%d", got, existingID)
		}
		// The step row lives at the step's exact 02:28:24 UTC time.
		if got, _ := db.Medication.GetIntakeBySchedule(medID, stepTime); got == nil || got.Source != "tz_step" {
			t.Errorf("expected tz_step row at step time %v, got %+v", stepTime, got)
		}
	})

	t.Run("approved plan: step outside minInterval creates its own intake row", func(t *testing.T) {
		// A pre-existing 02:30 UTC normal intake and a step at 20:30 UTC
		// (18h delta — far outside any minInterval) coexist after
		// pre-materialization. The scheduler tick at 21:00 UTC fires the
		// 20:30 step row; no new normal intake is created.
		db := mustNewDB(t)
		db.Settings.SetMedicationEnabled(context.Background(), true) //nolint:errcheck
		if err := db.TZ.RecordTimezone("UTC"); err != nil {
			t.Fatalf("RecordTimezone: %v", err)
		}

		medID, err := db.Medication.CreateMedication("Candecor", "16mg",
			`{"type":"daily","times":["02:30"]}`, nil, nil, "", "", "")
		if err != nil {
			t.Fatalf("CreateMedication: %v", err)
		}
		nowTime := time.Date(2026, 5, 14, 21, 0, 0, 0, time.UTC)
		if err := db.Medication.UpdateMedicationCreatedAt(medID, nowTime.Add(-30*24*time.Hour)); err != nil {
			t.Fatalf("UpdateMedicationCreatedAt: %v", err)
		}

		normalSlot := time.Date(2026, 5, 14, 2, 30, 0, 0, time.UTC)
		if _, err := db.Medication.CreateIntake(medID, 123456, normalSlot); err != nil {
			t.Fatalf("CreateIntake (pre-existing): %v", err)
		}

		planID, err := db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
			OldTZ:      "America/Chicago",
			NewTZ:      "Europe/Berlin",
			Status:     "PENDING_APPROVAL",
			StepsJSON:  "[]",
			InputsJSON: "{}",
			PlanHash:   "testhash-near-match-B",
		})
		if err != nil {
			t.Fatalf("CreateTZTransitionPlan: %v", err)
		}
		stepTime := time.Date(2026, 5, 14, 20, 30, 0, 0, time.UTC) // 18h after 02:30
		setPlanSteps(t, db, planID, []planStepFixture{
			{MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step 1"},
		})
		if _, err := db.ApproveAndMaterialize(context.Background(), planID, 123456, nowTime.Add(-10*time.Minute)); err != nil {
			t.Fatalf("ApproveAndMaterialize: %v", err)
		}

		mock := &MockNotifier{}
		sched := New(db, 123456, []notifier.Notifier{mock})
		sched.MedicationChecker.now = func() time.Time { return nowTime }

		if err := sched.MedicationChecker.Check(context.Background()); err != nil {
			t.Fatalf("Check: %v", err)
		}
		time.Sleep(10 * time.Millisecond)

		// Two intakes: pre-existing 02:30 and materialized 20:30 step.
		hist, err := db.Medication.GetIntakeHistory(int(medID), 0)
		if err != nil {
			t.Fatalf("GetIntakeHistory: %v", err)
		}
		if len(hist) != 2 {
			for _, h := range hist {
				t.Logf("intake row: id=%d scheduled=%v source=%s status=%s", h.ID, h.ScheduledAt, h.Source, h.Status)
			}
			t.Fatalf("expected 2 intake_log rows (pre-existing + step), got %d", len(hist))
		}
		if got, _ := db.Medication.GetIntakeBySchedule(medID, stepTime); got == nil {
			t.Errorf("expected intake at step time %v, got none", stepTime)
		}
	})
}

// TestMedicationCheckerCompletedPlanOverlapGuard pins the regression behind
// the duplicate "Time to take Candecor (21:30)" reminder the user got
// minutes after pressing "Take now". The previous tick consumed the plan's
// final step (22:30 PDT) and flipped status APPROVED → COMPLETED. The next
// tick used to lose the consumed-step times via the legacy guard; in the
// Task 11 world the TAKEN intake row at 22:30 PDT directly suppresses the
// 21:30 PDT normal target via the symmetric ±minInterval dedup against
// intake_log, no plan lookup required.
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
		Status:     "PENDING_APPROVAL",
		StepsJSON:  "[]",
		InputsJSON: "{}",
		PlanHash:   "testhash-completed-overlap",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	stepTime := time.Date(2026, 5, 5, 22, 30, 0, 0, la)
	setPlanSteps(t, db, planID, []planStepFixture{
		{MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "final"},
	})
	if _, err := db.ApproveAndMaterialize(context.Background(), planID, 123456, nowTime.Add(-8*time.Hour)); err != nil {
		t.Fatalf("ApproveAndMaterialize: %v", err)
	}
	// "Take now" path: confirm the materialized step intake immediately.
	stepIntake, err := db.Medication.GetIntakeBySchedule(medID, stepTime)
	if err != nil || stepIntake == nil {
		t.Fatalf("GetIntakeBySchedule for step: intake=%v err=%v", stepIntake, err)
	}
	if err := db.Medication.ConfirmIntake(stepIntake.ID, nowTime); err != nil {
		t.Fatalf("ConfirmIntake: %v", err)
	}
	// The previous scheduler tick observed all step times had arrived and
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
	// should have been spawned at 21:30 PDT (the superseded normal slot) —
	// the symmetric dedup against the TAKEN row at 22:30 PDT catches it.
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

// planStepFixture mirrors the PascalCase JSON shape of
// tzreschedule.TransitionStep — the same blob the planner writes into
// tz_transition_plans.steps_json. The medication-repo's MaterializePlanStepsAsIntakesTx
// parses these keys at approve time.
type planStepFixture struct {
	MedicationID int64
	StepNumber   int
	ScheduledAt  time.Time
	Note         string
}

// setPlanSteps overwrites tz_transition_plans.steps_json for the given plan
// with the serialised list of steps. Used in scheduler tests that previously
// inserted rows into the now-dropped tz_transition_steps table — Track D
// Task 13 made steps_json the single source of truth for materialisation.
func setPlanSteps(t *testing.T, db *store.Store, planID int64, steps []planStepFixture) {
	t.Helper()
	blob, err := json.Marshal(steps)
	if err != nil {
		t.Fatalf("marshal steps: %v", err)
	}
	if _, err := db.DB().Exec(`UPDATE tz_transition_plans SET steps_json = ? WHERE id = ?`, string(blob), planID); err != nil {
		t.Fatalf("update steps_json: %v", err)
	}
}
