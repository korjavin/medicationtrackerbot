package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// triggerHelpers wraps the busywork around handleTriggerNextIntake into one
// place: parsing the response, fixing the clock the handler reads, and
// fetching the resulting intake state. Each subtest uses it so the tests
// stay readable.
type triggerCtx struct {
	t   *testing.T
	srv *Server
	db  *store.Store
	now time.Time
}

func newTriggerCtx(t *testing.T) *triggerCtx {
	t.Helper()
	srv, db := createGenericTestServer(t)
	t.Cleanup(func() { db.Close() }) //nolint:errcheck
	return &triggerCtx{t: t, srv: srv, db: db}
}

func (c *triggerCtx) setNow(now time.Time) {
	c.now = now
	c.srv.now = func() time.Time { return now }
}

// callTrigger fires POST /api/medications/trigger-next-intake against the
// fake clock and returns the parsed JSON response (or nil + status code).
func (c *triggerCtx) callTrigger(userID int64) (map[string]any, int) {
	c.t.Helper()
	req := httptest.NewRequest("POST", "/api/medications/trigger-next-intake", nil)
	req = withUser(req, userID)
	w := httptest.NewRecorder()
	c.srv.handleTriggerNextIntake(w, req)
	if w.Code != http.StatusOK {
		return nil, w.Code
	}
	var resp map[string]any
	_ = json.NewDecoder(w.Body).Decode(&resp)
	return resp, w.Code
}

func mustCreateMed(t *testing.T, db *store.Store, name, dosage, schedule, policy string) int64 {
	t.Helper()
	id, err := db.CreateMedication(name, dosage, schedule, nil, nil, "", "", policy)
	if err != nil {
		t.Fatalf("CreateMedication %s: %v", name, err)
	}
	// Anchor created_at safely in the past so target.Before(med.CreatedAt) checks pass.
	if err := db.UpdateMedicationCreatedAt(id, time.Now().AddDate(0, 0, -30)); err != nil {
		t.Fatalf("UpdateMedicationCreatedAt %s: %v", name, err)
	}
	return id
}

// TestHandleTriggerNextIntake_MorningClusterInWindow is the happy path: the
// upcoming morning batch is well inside the 12 h forecast window, all four
// medications fire the same target time, and "Take now" should mark all
// four TAKEN — not just the first one.
func TestHandleTriggerNextIntake_MorningClusterInWindow(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	la, _ := time.LoadLocation("America/Los_Angeles")
	c.setNow(time.Date(2026, 5, 4, 6, 0, 0, 0, la)) // 06:00 PDT — 2 h 20 m before 08:20

	// Four meds all with morning 08:20 schedule.
	mustCreateMed(t, c.db, "Allopurinol AL", "300mg", `{"type":"daily","times":["08:20"]}`, "flexible")
	mustCreateMed(t, c.db, "Bisoprolol", "2.5mg", `{"type":"daily","times":["08:20"]}`, "flexible")
	mustCreateMed(t, c.db, "Candecor comp", "16mg", `{"type":"daily","times":["08:20"]}`, "flexible")
	mustCreateMed(t, c.db, "Metformin", "1000mg", `{"type":"daily","times":["08:20","21:30"]}`, "flexible")

	resp, code := c.callTrigger(123456)
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d", code)
	}
	if got := int(resp["medication_count"].(float64)); got != 4 {
		t.Errorf("expected 4 medications taken, got %d (resp=%v)", got, resp)
	}
}

// TestHandleTriggerNextIntake_MorningPastEveningPicked reproduces the
// reported "I clicked Take now and it took 3 evening meds" surprise. The
// morning slot is in the past (so it must NOT be picked even if a stale
// frontend cache shows it), the evening slot is the next upcoming dose
// inside the 12 h window, and the handler picks the evening cluster.
func TestHandleTriggerNextIntake_MorningPastEveningPicked(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	la, _ := time.LoadLocation("America/Los_Angeles")
	c.setNow(time.Date(2026, 5, 4, 10, 0, 0, 0, la)) // 10:00 PDT — past 08:20, before 21:30

	mustCreateMed(t, c.db, "Allopurinol AL", "300mg", `{"type":"daily","times":["08:20"]}`, "flexible")     // morning only — no future window today
	mustCreateMed(t, c.db, "Candecor", "16mg", `{"type":"daily","times":["21:30"]}`, "flexible")           // evening only
	mustCreateMed(t, c.db, "Lercanidipin", "10mg", `{"type":"daily","times":["08:20","21:30"]}`, "medium") // both
	mustCreateMed(t, c.db, "Metformin", "1000mg", `{"type":"daily","times":["08:20","21:30"]}`, "flexible")

	resp, code := c.callTrigger(123456)
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d", code)
	}
	// Allopurinol AL has no future slot in window → only Candecor + Lercanidipin + Metformin.
	if got := int(resp["medication_count"].(float64)); got != 3 {
		t.Errorf("expected 3 evening medications taken, got %d (resp=%v)", got, resp)
	}
	// scheduled_at must be 21:30 PDT today — not the past 08:20.
	wantTime := time.Date(2026, 5, 4, 21, 30, 0, 0, la)
	if got, _ := time.Parse(time.RFC3339, resp["scheduled_at"].(string)); !got.Equal(wantTime) {
		t.Errorf("expected scheduled_at = %v, got %v", wantTime, got)
	}
}

// TestHandleTriggerNextIntake_PendingPlanStepUsedNotClockTime is the
// regression for the medplan unification: when a med has an APPROVED plan
// step pending at e.g. 14:18 PDT, "Take now" must use that step time as
// the intake's scheduled_at, NOT the medication's bare 08:20+21:30 clock
// schedule. Otherwise tapping the button creates an intake with a
// scheduled_at that the scheduler will never re-fire and that the cancel
// flow can leave dangling as PENDING at the wrong moment.
func TestHandleTriggerNextIntake_PendingPlanStepUsedNotClockTime(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	la, _ := time.LoadLocation("America/Los_Angeles")
	c.setNow(time.Date(2026, 5, 4, 13, 0, 0, 0, la)) // 13:00 PDT, plan step at 14:18 PDT

	medID := mustCreateMed(t, c.db, "Lercanidipin", "10mg", `{"type":"daily","times":["08:20","21:30"]}`, "medium")

	planID, err := c.db.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "Europe/Copenhagen", NewTZ: "America/Los_Angeles",
		Status: "APPROVED", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "h",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	if _, err := c.db.SetTZTransitionPlanApproved(planID, c.now.Add(-time.Hour)); err != nil {
		t.Fatalf("SetTZTransitionPlanApproved: %v", err)
	}
	stepTime := time.Date(2026, 5, 4, 14, 18, 0, 0, la)
	if err := c.db.CreateTZTransitionSteps([]store.TZTransitionStep{
		{PlanID: planID, MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step"},
	}); err != nil {
		t.Fatalf("CreateTZTransitionSteps: %v", err)
	}

	resp, code := c.callTrigger(123456)
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d", code)
	}
	if got := int(resp["medication_count"].(float64)); got != 1 {
		t.Fatalf("expected 1 medication taken, got %d (resp=%v)", got, resp)
	}

	// Intake must exist at the STEP scheduled_at exactly, not at 21:30 PDT.
	intake, err := c.db.GetIntakeBySchedule(medID, stepTime)
	if err != nil || intake == nil {
		t.Fatalf("expected intake at step time, got intake=%v err=%v", intake, err)
	}
	if intake.Status != "TAKEN" {
		t.Errorf("expected status TAKEN, got %s", intake.Status)
	}

	// And there must be NO intake at the bare 21:30 PDT clock target.
	bogus := time.Date(2026, 5, 4, 21, 30, 0, 0, la)
	if got, _ := c.db.GetIntakeBySchedule(medID, bogus); got != nil {
		t.Errorf("did not expect a clock-time 21:30 PDT intake, but found %+v", got)
	}

	// And the step must be marked consumed.
	pending, _ := c.db.GetPendingStepsForPlan(planID)
	if len(pending) != 0 {
		t.Errorf("expected step marked consumed, got %d still pending", len(pending))
	}
}

// TestHandleTriggerNextIntake_ClusterMixesStepAndNormal pins the
// fuzzy-cluster behaviour: a normal-schedule 08:20 PDT target and three
// plan-step targets at 08:22:06 PDT must group into one "Take now" cluster
// (within 10 min) so tapping the button materialises all four — the user
// reasonably perceives them as one morning batch.
func TestHandleTriggerNextIntake_ClusterMixesStepAndNormal(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	la, _ := time.LoadLocation("America/Los_Angeles")
	c.setNow(time.Date(2026, 5, 4, 6, 0, 0, 0, la))

	allopurinol := mustCreateMed(t, c.db, "Allopurinol AL", "300mg", `{"type":"daily","times":["08:20"]}`, "flexible")
	bisoprolol := mustCreateMed(t, c.db, "Bisoprolol", "2.5mg", `{"type":"daily","times":["08:20"]}`, "flexible")
	candecorComp := mustCreateMed(t, c.db, "Candecor comp", "16mg", `{"type":"daily","times":["08:20"]}`, "flexible")
	metformin := mustCreateMed(t, c.db, "Metformin", "1000mg", `{"type":"daily","times":["08:20","21:30"]}`, "flexible")

	planID, err := c.db.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "Europe/Copenhagen", NewTZ: "America/Los_Angeles",
		Status: "APPROVED", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "hcluster",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	if _, err := c.db.SetTZTransitionPlanApproved(planID, c.now.Add(-time.Hour)); err != nil {
		t.Fatalf("SetTZTransitionPlanApproved: %v", err)
	}
	driftedStep := time.Date(2026, 5, 4, 8, 22, 6, 0, la) // 2 m 6 s drift
	if err := c.db.CreateTZTransitionSteps([]store.TZTransitionStep{
		{PlanID: planID, MedicationID: allopurinol, StepNumber: 1, ScheduledAt: driftedStep, Note: "step a"},
		{PlanID: planID, MedicationID: bisoprolol, StepNumber: 1, ScheduledAt: driftedStep, Note: "step b"},
		{PlanID: planID, MedicationID: candecorComp, StepNumber: 1, ScheduledAt: driftedStep, Note: "step c"},
	}); err != nil {
		t.Fatalf("CreateTZTransitionSteps: %v", err)
	}

	resp, code := c.callTrigger(123456)
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d", code)
	}
	if got := int(resp["medication_count"].(float64)); got != 4 {
		t.Errorf("expected all 4 cluster members taken, got %d", got)
	}

	// Metformin's intake at clock-aligned 08:20.
	metformTarget := time.Date(2026, 5, 4, 8, 20, 0, 0, la)
	if intake, _ := c.db.GetIntakeBySchedule(metformin, metformTarget); intake == nil || intake.Status != "TAKEN" {
		t.Errorf("expected Metformin TAKEN at 08:20 PDT, got %+v", intake)
	}
	// The three plan-step meds at the drifted step time.
	for _, id := range []int64{allopurinol, bisoprolol, candecorComp} {
		if intake, _ := c.db.GetIntakeBySchedule(id, driftedStep); intake == nil || intake.Status != "TAKEN" {
			t.Errorf("expected med %d TAKEN at step time, got %+v", id, intake)
		}
	}
}

// TestHandleTriggerNextIntake_CancelRevertsToCorrectScheduledAt closes the
// loop on the original report: after Take now the cancel flow must revert
// the intake to PENDING at the SAME scheduled_at it was created with, not
// at some unrelated bare clock time. Without the per-cluster-member
// scheduled_at fix above, the cancel left a "ghost" PENDING intake at the
// wrong moment that the user could not get rid of.
func TestHandleTriggerNextIntake_CancelRevertsToCorrectScheduledAt(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	la, _ := time.LoadLocation("America/Los_Angeles")
	c.setNow(time.Date(2026, 5, 4, 13, 0, 0, 0, la))

	medID := mustCreateMed(t, c.db, "Lercanidipin", "10mg", `{"type":"daily","times":["08:20","21:30"]}`, "medium")

	planID, err := c.db.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "Europe/Copenhagen", NewTZ: "America/Los_Angeles",
		Status: "APPROVED", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "hcancel",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	if _, err := c.db.SetTZTransitionPlanApproved(planID, c.now.Add(-time.Hour)); err != nil {
		t.Fatalf("SetTZTransitionPlanApproved: %v", err)
	}
	stepTime := time.Date(2026, 5, 4, 14, 18, 0, 0, la)
	if err := c.db.CreateTZTransitionSteps([]store.TZTransitionStep{
		{PlanID: planID, MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step"},
	}); err != nil {
		t.Fatalf("CreateTZTransitionSteps: %v", err)
	}

	resp, code := c.callTrigger(123456)
	if code != http.StatusOK {
		t.Fatalf("trigger: expected 200, got %d", code)
	}
	intakeIDsAny := resp["medication_count"].(float64)
	_ = intakeIDsAny

	intake, _ := c.db.GetIntakeBySchedule(medID, stepTime)
	if intake == nil {
		t.Fatalf("expected intake created at step time")
	}

	// Now cancel via the medication service (same path as the Telegram
	// "Cancel (Undo)" callback).
	if _, _, err := c.srv.medSvc.CancelIntake(intake.ID); err != nil {
		t.Fatalf("CancelIntake: %v", err)
	}

	reverted, _ := c.db.GetIntake(intake.ID)
	if reverted == nil {
		t.Fatalf("intake disappeared after cancel")
	}
	if reverted.Status != "PENDING" {
		t.Errorf("expected PENDING after cancel, got %s", reverted.Status)
	}
	if !reverted.ScheduledAt.Equal(stepTime) {
		t.Errorf("expected reverted scheduled_at = step time %v, got %v", stepTime, reverted.ScheduledAt)
	}

	// And no other PENDING intake should have been spawned at the bare
	// 21:30 PDT clock time — that was the user-visible symptom.
	bogus := time.Date(2026, 5, 4, 21, 30, 0, 0, la)
	if other, _ := c.db.GetIntakeBySchedule(medID, bogus); other != nil {
		t.Errorf("found unexpected PENDING intake at bare 21:30 clock time: %+v", other)
	}

	_ = context.TODO
}

// TestHandleTriggerNextIntake_NoneInWindowReturns404 is the negative path:
// when no medication has any future scheduled dose inside the look-ahead
// window the handler must say "nothing to take" rather than silently
// reaching back into past targets or into the next 24h.
func TestHandleTriggerNextIntake_NoneInWindowReturns404(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.RecordTimezone("UTC"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	c.setNow(time.Date(2026, 5, 4, 9, 0, 0, 0, time.UTC)) // past 08:00; next slot 24 h away

	mustCreateMed(t, c.db, "Once", "10mg", `{"type":"daily","times":["08:00"]}`, "flexible")

	_, code := c.callTrigger(123456)
	if code != http.StatusNotFound {
		t.Errorf("expected 404 when no upcoming intake, got %d", code)
	}
}
