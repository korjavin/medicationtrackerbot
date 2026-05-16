package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
)

// TestHandleTZPlanApprove_RoutesThroughLifecycle pins Track D Task 10's
// CLAUDE.md-rule-#1 fix: the HTTP handler must NOT call SetTZTransitionPlanApproved
// directly. It must route through tzreschedule.LifecycleService so the plan
// transition and the pre-materialize step inserts share one transaction.
//
// We exercise the handler with a real wired server + store and assert that
// after a successful approve the plan is APPROVED *and* the plan's unconsumed
// step has been materialized as a PENDING source='tz_step' intake_log row.
func TestHandleTZPlanApprove_RoutesThroughLifecycle(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()
	srv.SetTZLifecycle(tzreschedule.NewLifecycleService(db, 123456))

	// Seed: one medication, one PENDING_APPROVAL plan with one unconsumed step.
	medID, err := db.Medication.CreateMedication("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}
	res, err := db.DB().Exec(
		`INSERT INTO tz_transition_plans (old_tz, new_tz, status, steps_json, inputs_json, plan_hash)
		 VALUES ('UTC', 'Europe/Berlin', 'PENDING_APPROVAL', '[]', '{}', 'task10-handler')`,
	)
	if err != nil {
		t.Fatalf("insert plan: %v", err)
	}
	planID, _ := res.LastInsertId()
	if _, err := db.DB().Exec(
		`INSERT INTO tz_transition_steps (plan_id, medication_id, step_number, scheduled_at, note)
		 VALUES (?, ?, 1, ?, 'task10 step')`,
		planID, medID, time.Date(2026, 5, 16, 7, 0, 0, 0, time.UTC),
	); err != nil {
		t.Fatalf("insert step: %v", err)
	}

	req := httptest.NewRequest("POST", "/api/tz-plan/0/approve", nil)
	req.SetPathValue("id", "1") // Plan ID 1 (first inserted).
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleTZPlanApprove(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d want 200; body=%s", w.Code, w.Body.String())
	}

	var status string
	if err := db.DB().QueryRow(`SELECT status FROM tz_transition_plans WHERE id = ?`, planID).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if status != "APPROVED" {
		t.Errorf("status=%q want APPROVED", status)
	}

	var count int
	if err := db.DB().QueryRow(
		`SELECT COUNT(*) FROM intake_log WHERE tz_plan_id = ? AND source = 'tz_step' AND status = 'PENDING'`,
		planID,
	).Scan(&count); err != nil {
		t.Fatalf("count tz_step rows: %v", err)
	}
	if count != 1 {
		t.Errorf("PENDING tz_step rows after approve=%d want 1 (handler must materialize via lifecycle service)", count)
	}
}

// TestHandleTZPlanApprove_NoLifecycleReturns503 asserts the handler refuses
// to fall back to the bare SetTZTransitionPlanApproved primitive when the
// lifecycle service hasn't been wired. Falling back would skip the
// materialize step and silently lose the plan's scheduling.
func TestHandleTZPlanApprove_NoLifecycleReturns503(t *testing.T) {
	srv, db := createBPTestServer(t)
	defer db.Close()
	// Deliberately do NOT wire the lifecycle service.

	req := httptest.NewRequest("POST", "/api/tz-plan/0/approve", nil)
	req.SetPathValue("id", "1")
	req = withUser(req, 123456)
	w := httptest.NewRecorder()
	srv.handleTZPlanApprove(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status=%d want 503 when lifecycle not wired; body=%s", w.Code, w.Body.String())
	}
}
