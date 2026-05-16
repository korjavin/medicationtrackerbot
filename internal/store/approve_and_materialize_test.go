package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	_ "modernc.org/sqlite"
)

// TestApproveAndMaterialize_FlipsAndMaterializes covers Track D Task 10's
// atomic approve+materialize contract: a single tx flips the plan to APPROVED
// and inserts one intake_log row per unconsumed step. A second call against
// the same plan (the user double-clicks approve, an auto-approve races a
// manual approve, etc.) returns (false, nil) without producing duplicate rows.
func TestApproveAndMaterialize_FlipsAndMaterializes(t *testing.T) {
	r := setupRepos(t)

	medID, err := r.Medication.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	planID := insertPlanWithSteps(t, r, "PENDING_APPROVAL", []seedStep{
		{medID: medID, stepNum: 1, scheduledAt: time.Date(2026, 5, 16, 6, 0, 0, 0, time.UTC)},
		{medID: medID, stepNum: 2, scheduledAt: time.Date(2026, 5, 16, 7, 0, 0, 0, time.UTC)},
	})

	approved, err := r.ApproveAndMaterialize(context.Background(), planID, 42, time.Date(2026, 5, 16, 5, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("ApproveAndMaterialize: %v", err)
	}
	if !approved {
		t.Fatalf("approved=false on first call; want true (was PENDING_APPROVAL)")
	}

	// Plan must be APPROVED now.
	var status string
	if err := r.DB().QueryRow(`SELECT status FROM tz_transition_plans WHERE id = ?`, planID).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if status != "APPROVED" {
		t.Errorf("status=%q want APPROVED", status)
	}

	// Two PENDING tz_step intake rows must exist (consumed step is skipped).
	var count int
	if err := r.DB().QueryRow(
		`SELECT COUNT(*) FROM intake_log WHERE tz_plan_id = ? AND source = 'tz_step' AND status = 'PENDING'`,
		planID,
	).Scan(&count); err != nil {
		t.Fatalf("count tz_step rows: %v", err)
	}
	if count != 2 {
		t.Errorf("PENDING tz_step rows=%d want 2", count)
	}

	// Idempotent re-approve: the second call sees APPROVED status, returns
	// (false, nil), and does not duplicate rows.
	approved2, err := r.ApproveAndMaterialize(context.Background(), planID, 42, time.Date(2026, 5, 16, 5, 0, 1, 0, time.UTC))
	if err != nil {
		t.Fatalf("ApproveAndMaterialize (re-call): %v", err)
	}
	if approved2 {
		t.Errorf("approved=true on re-call; want false (already past pending)")
	}

	var count2 int
	if err := r.DB().QueryRow(
		`SELECT COUNT(*) FROM intake_log WHERE tz_plan_id = ? AND source = 'tz_step'`, planID,
	).Scan(&count2); err != nil {
		t.Fatalf("count tz_step rows after re-call: %v", err)
	}
	if count2 != 2 {
		t.Errorf("PENDING tz_step rows after re-call=%d want 2 (no duplicates)", count2)
	}
}

// TestApproveAndMaterialize_MultiMedicationPlan covers the regression caught
// in code review: tzreschedule.GeneratePlan numbers steps per-medication
// starting at 1, so a plan touching N medications emits step_number=1 for
// each of them. An index keyed on only (tz_plan_id, tz_step_number) would
// collide across meds and let INSERT OR IGNORE silently drop every med
// after the first. Migration 067's unique index includes medication_id so
// every step lands.
func TestApproveAndMaterialize_MultiMedicationPlan(t *testing.T) {
	r := setupRepos(t)

	medA, err := r.Medication.CreateMedication("MedA", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication A: %v", err)
	}
	medB, err := r.Medication.CreateMedication("MedB", "200mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication B: %v", err)
	}

	// Mirror tzreschedule.GeneratePlan: each med independently numbered 1..K.
	planID := insertPlanWithSteps(t, r, "PENDING_APPROVAL", []seedStep{
		{medID: medA, stepNum: 1, scheduledAt: time.Date(2026, 5, 16, 6, 0, 0, 0, time.UTC)},
		{medID: medA, stepNum: 2, scheduledAt: time.Date(2026, 5, 16, 7, 0, 0, 0, time.UTC)},
		{medID: medB, stepNum: 1, scheduledAt: time.Date(2026, 5, 16, 6, 5, 0, 0, time.UTC)},
		{medID: medB, stepNum: 2, scheduledAt: time.Date(2026, 5, 16, 7, 5, 0, 0, time.UTC)},
	})

	if _, err := r.ApproveAndMaterialize(context.Background(), planID, 42, time.Date(2026, 5, 16, 5, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("ApproveAndMaterialize: %v", err)
	}

	var count int
	if err := r.DB().QueryRow(
		`SELECT COUNT(*) FROM intake_log WHERE tz_plan_id = ? AND source = 'tz_step' AND status = 'PENDING'`,
		planID,
	).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 4 {
		t.Errorf("multi-med materialize lost rows: got %d want 4 (2 meds × 2 steps each)", count)
	}

	var aCount, bCount int
	if err := r.DB().QueryRow(`SELECT COUNT(*) FROM intake_log WHERE tz_plan_id = ? AND medication_id = ?`, planID, medA).Scan(&aCount); err != nil {
		t.Fatalf("count medA: %v", err)
	}
	if err := r.DB().QueryRow(`SELECT COUNT(*) FROM intake_log WHERE tz_plan_id = ? AND medication_id = ?`, planID, medB).Scan(&bCount); err != nil {
		t.Fatalf("count medB: %v", err)
	}
	if aCount != 2 {
		t.Errorf("medA rows=%d want 2", aCount)
	}
	if bCount != 2 {
		t.Errorf("medB rows=%d want 2 (would be 0 if the unique index omitted medication_id)", bCount)
	}
}

// TestApproveAndMaterialize_RejectedPlanIsNoOp asserts that a plan that has
// already moved out of PENDING_APPROVAL/NOTIFIED (e.g. user rejected via the
// banner before the bot's auto-approve ran) is left alone — no status
// regression and no spurious intake rows.
func TestApproveAndMaterialize_RejectedPlanIsNoOp(t *testing.T) {
	r := setupRepos(t)
	medID, err := r.Medication.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}
	planID := insertPlanWithSteps(t, r, "REJECTED", []seedStep{
		{medID: medID, stepNum: 1, scheduledAt: time.Date(2026, 5, 16, 6, 0, 0, 0, time.UTC)},
	})

	approved, err := r.ApproveAndMaterialize(context.Background(), planID, 42, time.Now())
	if err != nil {
		t.Fatalf("ApproveAndMaterialize: %v", err)
	}
	if approved {
		t.Errorf("approved=true on rejected plan; want false (must not regress status)")
	}

	var status string
	if err := r.DB().QueryRow(`SELECT status FROM tz_transition_plans WHERE id = ?`, planID).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if status != "REJECTED" {
		t.Errorf("status=%q want REJECTED (must not have flipped)", status)
	}

	var count int
	if err := r.DB().QueryRow(
		`SELECT COUNT(*) FROM intake_log WHERE tz_plan_id = ?`, planID,
	).Scan(&count); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if count != 0 {
		t.Errorf("intake rows=%d want 0 (no materialization on rejected plan)", count)
	}
}

// --- helpers ---

type seedStep struct {
	medID       int64
	stepNum     int
	scheduledAt time.Time
}

func setupRepos(t *testing.T) *Repos {
	t.Helper()
	d, err := storedb.Open(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	r, err := NewWithDB(d)
	if err != nil {
		t.Fatalf("NewWithDB: %v", err)
	}
	return r
}

// approveFixtureStep mirrors the PascalCase JSON shape of
// tzreschedule.TransitionStep — what the planner writes into
// tz_transition_plans.steps_json. MaterializePlanStepsAsIntakesTx parses these
// keys at approve time.
type approveFixtureStep struct {
	MedicationID int64
	StepNumber   int
	ScheduledAt  time.Time
}

func insertPlanWithSteps(t *testing.T, r *Repos, status string, steps []seedStep) int64 {
	t.Helper()
	fixtures := make([]approveFixtureStep, len(steps))
	for i, s := range steps {
		fixtures[i] = approveFixtureStep{
			MedicationID: s.medID,
			StepNumber:   s.stepNum,
			ScheduledAt:  s.scheduledAt,
		}
	}
	blob, err := json.Marshal(fixtures)
	if err != nil {
		t.Fatalf("marshal steps: %v", err)
	}
	res, err := r.DB().Exec(
		`INSERT INTO tz_transition_plans (old_tz, new_tz, status, steps_json, inputs_json, plan_hash)
		 VALUES ('UTC', 'Europe/Berlin', ?, ?, '{}', ?)`,
		status, string(blob), "test-hash-"+status+"-"+time.Now().Format(time.RFC3339Nano),
	)
	if err != nil {
		t.Fatalf("insert plan: %v", err)
	}
	planID, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId(plan): %v", err)
	}
	return planID
}
