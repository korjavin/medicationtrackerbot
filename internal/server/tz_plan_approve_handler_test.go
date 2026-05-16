package server

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/domain/tzreschedule"
)

func itoa64(v int64) string { return strconv.FormatInt(v, 10) }

// TestHandleTZPlanApprove_RoutesThroughLifecycle pins Track D Task 10's
// CLAUDE.md-rule-#1 fix: the HTTP handler must NOT call SetTransitionPlanApproved
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
	medID, err := db.Medication.Create("Aspirin", "100mg", `{"type":"daily","times":["08:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// steps_json mirrors the PascalCase shape produced by
	// json.Marshal([]tzreschedule.TransitionStep); MaterializePlanStepsAsIntakesTx
	// reads from it post-Task-13 (the tz_transition_steps table is gone).
	stepsJSON := `[{"MedicationID":` + itoa64(medID) + `,"StepNumber":1,"ScheduledAt":"` +
		time.Date(2026, 5, 16, 7, 0, 0, 0, time.UTC).Format(time.RFC3339) + `","Note":"task10 step"}]`
	res, err := db.DB().Exec(
		`INSERT INTO tz_transition_plans (old_tz, new_tz, status, steps_json, inputs_json, plan_hash)
		 VALUES ('UTC', 'Europe/Berlin', 'PENDING_APPROVAL', ?, '{}', 'task10-handler')`,
		stepsJSON,
	)
	if err != nil {
		t.Fatalf("insert plan: %v", err)
	}
	planID, _ := res.LastInsertId()

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
// to fall back to the bare SetTransitionPlanApproved primitive when the
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
