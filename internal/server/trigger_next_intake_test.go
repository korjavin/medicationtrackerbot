package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/notifier"
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// planStepFixture mirrors the PascalCase JSON shape of
// tzreschedule.TransitionStep — the same blob the planner writes into
// tz_transition_plans.steps_json. Approve-time materialise reads from this
// column post-Task-13.
type planStepFixture struct {
	MedicationID int64
	StepNumber   int
	ScheduledAt  time.Time
	Note         string
}

// setPlanSteps overwrites tz_transition_plans.steps_json on the given plan
// with the serialised list of steps. Replaces the pre-Task-13 pattern of
// inserting rows into tz_transition_steps before calling ApproveAndMaterialize.
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
	id, err := db.Medication.CreateMedication(name, dosage, schedule, nil, nil, "", "", policy)
	if err != nil {
		t.Fatalf("CreateMedication %s: %v", name, err)
	}
	// Anchor created_at safely in the past so target.Before(med.CreatedAt) checks pass.
	if err := db.Medication.UpdateMedicationCreatedAt(id, time.Now().AddDate(0, 0, -30)); err != nil {
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
	if err := c.db.TZ.RecordTimezone("America/Los_Angeles"); err != nil {
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
	if err := c.db.TZ.RecordTimezone("America/Los_Angeles"); err != nil {
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
	if err := c.db.TZ.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	la, _ := time.LoadLocation("America/Los_Angeles")
	c.setNow(time.Date(2026, 5, 4, 13, 0, 0, 0, la)) // 13:00 PDT, plan step at 14:18 PDT

	medID := mustCreateMed(t, c.db, "Lercanidipin", "10mg", `{"type":"daily","times":["08:20","21:30"]}`, "medium")

	planID, err := c.db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "Europe/Copenhagen", NewTZ: "America/Los_Angeles",
		Status: "PENDING_APPROVAL", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "h",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	stepTime := time.Date(2026, 5, 4, 14, 18, 0, 0, la)
	setPlanSteps(t, c.db, planID, []planStepFixture{
		{MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step"},
	})
	if _, err := c.db.ApproveAndMaterialize(context.Background(), planID, 123456, c.now.Add(-time.Hour)); err != nil {
		t.Fatalf("ApproveAndMaterialize: %v", err)
	}

	resp, code := c.callTrigger(123456)
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d", code)
	}
	if got := int(resp["medication_count"].(float64)); got != 1 {
		t.Fatalf("expected 1 medication taken, got %d (resp=%v)", got, resp)
	}

	// Intake must exist at the STEP scheduled_at exactly, not at 21:30 PDT.
	intake, err := c.db.Medication.GetIntakeBySchedule(medID, stepTime)
	if err != nil || intake == nil {
		t.Fatalf("expected intake at step time, got intake=%v err=%v", intake, err)
	}
	if intake.Status != "TAKEN" {
		t.Errorf("expected status TAKEN, got %s", intake.Status)
	}
	if intake.Source != "tz_step" {
		t.Errorf("expected source=tz_step preserved on the pre-materialized row, got %q", intake.Source)
	}

	// And there must be NO intake at the bare 21:30 PDT clock target.
	bogus := time.Date(2026, 5, 4, 21, 30, 0, 0, la)
	if got, _ := c.db.Medication.GetIntakeBySchedule(medID, bogus); got != nil {
		t.Errorf("did not expect a clock-time 21:30 PDT intake, but found %+v", got)
	}
}

// TestHandleTriggerNextIntake_ClusterMixesStepAndNormal pins the
// fuzzy-cluster behaviour: a normal-schedule 08:20 PDT target and three
// plan-step targets at 08:22:06 PDT must group into one "Take now" cluster
// (within 10 min) so tapping the button materialises all four — the user
// reasonably perceives them as one morning batch.
func TestHandleTriggerNextIntake_ClusterMixesStepAndNormal(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.TZ.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	la, _ := time.LoadLocation("America/Los_Angeles")
	c.setNow(time.Date(2026, 5, 4, 6, 0, 0, 0, la))

	allopurinol := mustCreateMed(t, c.db, "Allopurinol AL", "300mg", `{"type":"daily","times":["08:20"]}`, "flexible")
	bisoprolol := mustCreateMed(t, c.db, "Bisoprolol", "2.5mg", `{"type":"daily","times":["08:20"]}`, "flexible")
	candecorComp := mustCreateMed(t, c.db, "Candecor comp", "16mg", `{"type":"daily","times":["08:20"]}`, "flexible")
	metformin := mustCreateMed(t, c.db, "Metformin", "1000mg", `{"type":"daily","times":["08:20","21:30"]}`, "flexible")

	planID, err := c.db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "Europe/Copenhagen", NewTZ: "America/Los_Angeles",
		Status: "PENDING_APPROVAL", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "hcluster",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	driftedStep := time.Date(2026, 5, 4, 8, 22, 6, 0, la) // 2 m 6 s drift
	// Three meds share a single step_number=1; pre-materialize one row per med
	// so the unique index (tz_plan_id, tz_step_number) doesn't collide.
	setPlanSteps(t, c.db, planID, []planStepFixture{
		{MedicationID: allopurinol, StepNumber: 1, ScheduledAt: driftedStep, Note: "step a"},
		{MedicationID: bisoprolol, StepNumber: 2, ScheduledAt: driftedStep, Note: "step b"},
		{MedicationID: candecorComp, StepNumber: 3, ScheduledAt: driftedStep, Note: "step c"},
	})
	if _, err := c.db.ApproveAndMaterialize(context.Background(), planID, 123456, c.now.Add(-time.Hour)); err != nil {
		t.Fatalf("ApproveAndMaterialize: %v", err)
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
	if intake, _ := c.db.Medication.GetIntakeBySchedule(metformin, metformTarget); intake == nil || intake.Status != "TAKEN" {
		t.Errorf("expected Metformin TAKEN at 08:20 PDT, got %+v", intake)
	}
	// The three plan-step meds at the drifted step time.
	for _, id := range []int64{allopurinol, bisoprolol, candecorComp} {
		if intake, _ := c.db.Medication.GetIntakeBySchedule(id, driftedStep); intake == nil || intake.Status != "TAKEN" {
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
	if err := c.db.TZ.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	la, _ := time.LoadLocation("America/Los_Angeles")
	c.setNow(time.Date(2026, 5, 4, 13, 0, 0, 0, la))

	medID := mustCreateMed(t, c.db, "Lercanidipin", "10mg", `{"type":"daily","times":["08:20","21:30"]}`, "medium")

	planID, err := c.db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "Europe/Copenhagen", NewTZ: "America/Los_Angeles",
		Status: "PENDING_APPROVAL", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "hcancel",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	stepTime := time.Date(2026, 5, 4, 14, 18, 0, 0, la)
	setPlanSteps(t, c.db, planID, []planStepFixture{
		{MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step"},
	})
	if _, err := c.db.ApproveAndMaterialize(context.Background(), planID, 123456, c.now.Add(-time.Hour)); err != nil {
		t.Fatalf("ApproveAndMaterialize: %v", err)
	}

	resp, code := c.callTrigger(123456)
	if code != http.StatusOK {
		t.Fatalf("trigger: expected 200, got %d", code)
	}
	intakeIDsAny := resp["medication_count"].(float64)
	_ = intakeIDsAny

	intake, _ := c.db.Medication.GetIntakeBySchedule(medID, stepTime)
	if intake == nil {
		t.Fatalf("expected intake created at step time")
	}

	// Now cancel via the medication service (same path as the Telegram
	// "Cancel (Undo)" callback).
	if _, _, err := c.srv.medSvc.CancelIntake(intake.ID); err != nil {
		t.Fatalf("CancelIntake: %v", err)
	}

	reverted, _ := c.db.Medication.GetIntake(intake.ID)
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
	if other, _ := c.db.Medication.GetIntakeBySchedule(medID, bogus); other != nil {
		t.Errorf("found unexpected PENDING intake at bare 21:30 clock time: %+v", other)
	}

	_ = context.TODO
}

// TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ pins the regression
// behind the "scheduled for 05:30" surprise: when the only target is a plan
// step whose ScheduledAt round-trips through SQLite as a UTC time.Time, the
// "Medication taken early" notification used to format that UTC value
// directly with "15:04", showing 05:30 to a user whose own clock read 22:30.
// The fix anchors the format in the user's stored timezone.
func TestHandleTriggerNextIntake_EarlyNotifFormatsInUserTZ(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.TZ.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	la, _ := time.LoadLocation("America/Los_Angeles")
	// 22:10 PDT — 20 min before the plan step at 22:30 PDT.
	c.setNow(time.Date(2026, 5, 5, 22, 10, 0, 0, la))

	mock := &mockNotifier{}
	c.srv.SetNotifiers([]notifier.Notifier{mock})

	medID := mustCreateMed(t, c.db, "Candecor", "16mg", `{"type":"daily","times":["21:30"]}`, "medium")

	planID, err := c.db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "Europe/Copenhagen", NewTZ: "America/Los_Angeles",
		Status: "PENDING_APPROVAL", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "h-tz-fmt",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	// 22:30 PDT == 05:30 UTC the next day — exactly the value persisted on
	// the production row that produced the bad notification.
	stepUTC := time.Date(2026, 5, 6, 5, 30, 0, 0, time.UTC)
	setPlanSteps(t, c.db, planID, []planStepFixture{
		{MedicationID: medID, StepNumber: 1, ScheduledAt: stepUTC, Note: "step"},
	})
	if _, err := c.db.ApproveAndMaterialize(context.Background(), planID, 123456, c.now.Add(-time.Hour)); err != nil {
		t.Fatalf("ApproveAndMaterialize: %v", err)
	}

	resp, code := c.callTrigger(123456)
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d", code)
	}
	if got := int(resp["medication_count"].(float64)); got != 1 {
		t.Fatalf("expected 1 medication taken, got %d (resp=%v)", got, resp)
	}

	// notifyWithAutoDelete dispatches via a goroutine, so the assertion
	// must wait for the worker to record the call rather than racing it.
	var notif string
	var sent []string
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		sent = mock.Sent()
		for _, s := range sent {
			if strings.Contains(s, "Medication taken early") {
				notif = s
				break
			}
		}
		if notif != "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if notif == "" {
		t.Fatalf("did not find Medication-taken-early notification in sent=%v", sent)
	}
	if !strings.Contains(notif, "scheduled for 22:30") {
		t.Errorf("expected notification to mention 22:30 PT, got %q", notif)
	}
	if strings.Contains(notif, "scheduled for 05:30") {
		t.Errorf("notification still showing UTC 05:30: %q", notif)
	}
}

// TestHandleTriggerNextIntake_PreMaterializedTZStepRowSurfaces pins Task 12 of
// docs/plans/20260508-simplify-medication-scheduling-utc-and-pre-materialized-steps.md:
// a PENDING intake_log row with source='tz_step' (the shape that
// ApproveAndMaterialize produces, and the shape that survives once Task 13
// drops tz_transition_steps) must show up in the trigger-next-intake cluster
// window even when nothing in tz_transition_steps would surface it via the
// legacy pendingSteps path. The handler's union with intake_log is the only
// thing that closes this gap post-Task-13.
func TestHandleTriggerNextIntake_PreMaterializedTZStepRowSurfaces(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.TZ.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	la, _ := time.LoadLocation("America/Los_Angeles")
	// 13:00 PDT — 08:20 slot is past, 21:30 slot is ~8.5h ahead (in window),
	// pre-materialized tz_step row sits at 14:18 PDT (closer and earliest).
	c.setNow(time.Date(2026, 5, 4, 13, 0, 0, 0, la))

	medID := mustCreateMed(t, c.db, "Lercanidipin", "10mg", `{"type":"daily","times":["08:20","21:30"]}`, "medium")

	// Pre-materialize a PENDING tz_step intake_log row at 14:18 PDT without a
	// matching tz_transition_steps entry — only the Task 12 union path can
	// surface it, since the handler's legacy pendingSteps lookup returns nil.
	// The plan-status gate in GetPendingIntakesInWindow requires the owning
	// plan to be APPROVED/COMPLETED, so create a real APPROVED plan row.
	planID, err := c.db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "Europe/Copenhagen", NewTZ: "America/Los_Angeles",
		Status: "APPROVED", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "h-pre-mat-surfaces",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	stepTime := time.Date(2026, 5, 4, 14, 18, 0, 0, la)
	if _, err := c.db.DB().Exec(`
		INSERT INTO intake_log
			(medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		VALUES (?, ?, ?, 'PENDING', 'tz_step', ?, ?)`,
		medID, int64(123456), stepTime.UTC().Unix(), planID, int64(1)); err != nil {
		t.Fatalf("pre-materialize tz_step intake row: %v", err)
	}

	resp, code := c.callTrigger(123456)
	if code != http.StatusOK {
		t.Fatalf("expected 200, got %d", code)
	}
	if got := int(resp["medication_count"].(float64)); got != 1 {
		t.Fatalf("expected 1 medication taken, got %d (resp=%v)", got, resp)
	}

	// The pre-materialized row must now be TAKEN, retaining its source/plan
	// metadata so downstream paths (CountFuturePendingTZStepIntakesForPlan,
	// scheduler COMPLETED check) still recognise it as a tz_step row.
	intake, err := c.db.Medication.GetIntakeBySchedule(medID, stepTime)
	if err != nil || intake == nil {
		t.Fatalf("expected intake at step time, got intake=%v err=%v", intake, err)
	}
	if intake.Status != "TAKEN" {
		t.Errorf("expected status TAKEN, got %s", intake.Status)
	}
	if intake.Source != "tz_step" {
		t.Errorf("expected source=tz_step preserved, got %q", intake.Source)
	}

	// And the bare 21:30 PDT clock slot must NOT have been picked — it is
	// 7+ hours from the 14:18 PDT cluster anchor, well outside the 10-minute
	// cluster window, so the planner's normal-schedule target must stay
	// untouched by this call.
	bareEvening := time.Date(2026, 5, 4, 21, 30, 0, 0, la)
	if got, _ := c.db.Medication.GetIntakeBySchedule(medID, bareEvening); got != nil {
		t.Errorf("did not expect a 21:30 PDT intake, but found %+v", got)
	}

	// Response's scheduled_at should match the pre-materialized row's time so
	// the Telegram early-take notification labels the right slot.
	gotTime, _ := time.Parse(time.RFC3339, resp["scheduled_at"].(string))
	if !gotTime.Equal(stepTime) {
		t.Errorf("expected scheduled_at = %v, got %v", stepTime, gotTime)
	}
}

// TestHandleTriggerNextIntake_CancelledPlanLeftoverNotSurfaced is the
// defense-in-depth companion to the scheduler-side "cancelled plan: leftover
// tz_step row does not fire" case in medication_tz_test.go. The planner's
// cancel cleanup (DeletePendingPreMaterializedIntakesForPlan) is best-effort:
// if it fails after the plan status flip, leftover PENDING source='tz_step'
// rows survive. GetPendingIntakesInWindow must refuse to surface those rows
// in the forecast / Take-next paths — otherwise the cancelled plan's
// orphan step would suppress the normal-schedule target via
// suppressNormalsCoveredByStep and let the user confirm it.
func TestHandleTriggerNextIntake_CancelledPlanLeftoverNotSurfaced(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.TZ.RecordTimezone("America/Los_Angeles"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	la, _ := time.LoadLocation("America/Los_Angeles")
	// 13:00 PDT — bare 21:30 PDT slot is the only legitimate target. The
	// orphan tz_step row at 14:18 PDT must NOT win.
	c.setNow(time.Date(2026, 5, 4, 13, 0, 0, 0, la))

	medID := mustCreateMed(t, c.db, "Lercanidipin", "10mg", `{"type":"daily","times":["08:20","21:30"]}`, "medium")

	planID, err := c.db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "Europe/Copenhagen", NewTZ: "America/Los_Angeles",
		Status: "PENDING_APPROVAL", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "h-cancel-leak",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	stepTime := time.Date(2026, 5, 4, 14, 18, 0, 0, la)
	setPlanSteps(t, c.db, planID, []planStepFixture{
		{MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step"},
	})
	if _, err := c.db.ApproveAndMaterialize(context.Background(), planID, 123456, c.now.Add(-time.Hour)); err != nil {
		t.Fatalf("ApproveAndMaterialize: %v", err)
	}

	// Simulate the cancel-then-delete-fails scenario: plan is flipped to
	// CANCELLED but the PENDING tz_step intake_log row survives.
	if err := c.db.TZ.UpdateTZTransitionPlanStatus(planID, "CANCELLED", "test", "APPROVED"); err != nil {
		t.Fatalf("UpdateTZTransitionPlanStatus: %v", err)
	}

	resp, code := c.callTrigger(123456)
	if code != http.StatusOK {
		t.Fatalf("expected 200 (normal 21:30 slot still in window), got %d", code)
	}

	// scheduled_at must be 21:30 PDT (the legitimate normal target), not
	// 14:18 PDT (the orphan tz_step row from the cancelled plan).
	wantTime := time.Date(2026, 5, 4, 21, 30, 0, 0, la)
	gotTime, _ := time.Parse(time.RFC3339, resp["scheduled_at"].(string))
	if !gotTime.Equal(wantTime) {
		t.Errorf("expected scheduled_at = %v (bare evening slot), got %v (orphan tz_step row surfaced)", wantTime, gotTime)
	}

	// The orphan tz_step row must remain PENDING — the handler refused to
	// confirm it. GetIntakeBySchedule hides orphan PENDING tz_step rows via
	// tzStepPlanStatusGateForDedup, so query intake_log directly to verify
	// physical persistence.
	var stepIntakeStatus string
	if err := c.db.DB().QueryRow(`
		SELECT status FROM intake_log
		WHERE medication_id = ? AND scheduled_at_unix = ? AND source = 'tz_step'`,
		medID, stepTime.UTC().Unix()).Scan(&stepIntakeStatus); err != nil {
		t.Fatalf("expected leftover tz_step intake row to still exist: %v", err)
	}
	if stepIntakeStatus != "PENDING" {
		t.Errorf("expected leftover tz_step row to remain PENDING, got %q", stepIntakeStatus)
	}
}

// TestHandleTriggerNextIntake_OrphanTZStepSameTimeAsNormalDoesNotBlock pins
// the codex-flagged exact-time collision: when an orphan PENDING source='tz_step'
// row from a CANCELLED plan shares (medication_id, scheduled_at_unix) with the
// legitimate normal-schedule target, GetIntakeBySchedule used to return the
// orphan, ConfirmIntake rejected it via the plan-status gate, and the handler
// `continue`d without creating/confirming the normal slot — leaving the user
// unable to "Take next" that dose. With the dedup gate applied to
// GetIntakeBySchedule, the orphan is invisible to the handler, it creates a
// fresh normal-schedule intake at that slot and confirms it.
func TestHandleTriggerNextIntake_OrphanTZStepSameTimeAsNormalDoesNotBlock(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.TZ.RecordTimezone("UTC"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	// now = 08:55 UTC — the 09:00 UTC normal slot is 5 minutes ahead, in
	// window, and is also where the orphan tz_step row sits.
	c.setNow(time.Date(2026, 5, 4, 8, 55, 0, 0, time.UTC))
	collisionTime := time.Date(2026, 5, 4, 9, 0, 0, 0, time.UTC)

	medID := mustCreateMed(t, c.db, "Aspirin", "100mg",
		`{"type":"daily","times":["09:00"]}`, "medium")
	initialStock := 30
	if err := c.db.Medication.UpdateMedication(medID, "Aspirin", "100mg",
		`{"type":"daily","times":["09:00"]}`, false, nil, nil, "", "", &initialStock, ""); err != nil {
		t.Fatalf("UpdateMedication (set inventory): %v", err)
	}

	planID, err := c.db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "UTC", NewTZ: "Asia/Tokyo",
		Status: "PENDING_APPROVAL", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "h-collision",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	setPlanSteps(t, c.db, planID, []planStepFixture{
		{MedicationID: medID, StepNumber: 1, ScheduledAt: collisionTime, Note: "step"},
	})
	if _, err := c.db.ApproveAndMaterialize(context.Background(), planID, 123456, c.now.Add(-time.Hour)); err != nil {
		t.Fatalf("ApproveAndMaterialize: %v", err)
	}
	// Cancel the plan but leave the materialized PENDING tz_step row in
	// place (simulates DeletePendingPreMaterializedIntakesForPlan failing
	// after the status flip).
	if err := c.db.TZ.UpdateTZTransitionPlanStatus(planID, "CANCELLED", "test", "APPROVED"); err != nil {
		t.Fatalf("UpdateTZTransitionPlanStatus: %v", err)
	}

	resp, code := c.callTrigger(123456)
	if code != http.StatusOK {
		t.Fatalf("expected 200 (orphan must not block the legitimate normal slot), got %d", code)
	}
	if got := int(resp["medication_count"].(float64)); got != 1 {
		t.Fatalf("expected 1 medication taken, got %d (resp=%v)", got, resp)
	}

	// A new normal-schedule intake at 09:00 UTC must exist and be TAKEN. The
	// orphan tz_step row still physically exists alongside it.
	var normalStatus, normalSource string
	if err := c.db.DB().QueryRow(`
		SELECT status, source FROM intake_log
		WHERE medication_id = ? AND scheduled_at_unix = ? AND source = 'schedule'`,
		medID, collisionTime.UTC().Unix()).Scan(&normalStatus, &normalSource); err != nil {
		t.Fatalf("expected a new normal-schedule intake at the collision slot: %v", err)
	}
	if normalStatus != "TAKEN" {
		t.Errorf("expected fresh normal intake to be TAKEN, got %q", normalStatus)
	}

	var orphanStatus string
	if err := c.db.DB().QueryRow(`
		SELECT status FROM intake_log
		WHERE medication_id = ? AND scheduled_at_unix = ? AND source = 'tz_step'`,
		medID, collisionTime.UTC().Unix()).Scan(&orphanStatus); err != nil {
		t.Fatalf("orphan tz_step row should still exist physically: %v", err)
	}
	if orphanStatus != "PENDING" {
		t.Errorf("orphan tz_step row must remain PENDING (gate blocks confirm), got %q", orphanStatus)
	}

	// Inventory decremented exactly once — for the legitimate normal slot,
	// not for the orphan.
	med, _ := c.db.Medication.GetMedication(medID)
	if med == nil || med.InventoryCount == nil || *med.InventoryCount != initialStock-1 {
		t.Errorf("expected inventory %d (one decrement for the legit slot), got %+v", initialStock-1, med)
	}
}

// TestHandleTriggerNextIntake_ApprovedTZStepSameTimeAsNormalStillSurfaces
// pins the codex-flagged regression where the intake_log + medplan union
// would seed dedup from medplan first: when an APPROVED plan's
// pre-materialized tz_step row lands on the exact same
// (medication_id, scheduled_at_unix) as the med's normal-schedule slot,
// the step row was skipped via dedup AND the normal target was then
// dropped by plannedOwnedMeds suppression (because the plan still owns
// the med). Result: the dose vanished from the cluster entirely. With the
// fix the intake_log row wins the dedup so the SourceTransitionStep entry
// survives suppression and the user can take the dose.
func TestHandleTriggerNextIntake_ApprovedTZStepSameTimeAsNormalStillSurfaces(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.TZ.RecordTimezone("UTC"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	// now = 08:55 UTC — the 09:00 UTC slot is 5 minutes ahead, in window.
	c.setNow(time.Date(2026, 5, 4, 8, 55, 0, 0, time.UTC))
	collisionTime := time.Date(2026, 5, 4, 9, 0, 0, 0, time.UTC)
	// A second future step keeps the med "plan-owned" (plannedOwnedMeds
	// looks for any future PENDING tz_step row, not just the colliding
	// one). Without this distant step the suppression would short-circuit
	// and the bug would not reproduce.
	futureStep := time.Date(2026, 5, 4, 18, 0, 0, 0, time.UTC)

	medID := mustCreateMed(t, c.db, "Aspirin", "100mg",
		`{"type":"daily","times":["09:00"]}`, "medium")

	planID, err := c.db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "UTC", NewTZ: "Asia/Tokyo",
		Status: "APPROVED", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "h-approved-collision",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	if _, err := c.db.DB().Exec(`
		INSERT INTO intake_log
			(medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		VALUES (?, ?, ?, 'PENDING', 'tz_step', ?, 1)`,
		medID, int64(123456), collisionTime.UTC().Unix(), planID); err != nil {
		t.Fatalf("pre-materialize colliding tz_step row: %v", err)
	}
	if _, err := c.db.DB().Exec(`
		INSERT INTO intake_log
			(medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		VALUES (?, ?, ?, 'PENDING', 'tz_step', ?, 2)`,
		medID, int64(123456), futureStep.UTC().Unix(), planID); err != nil {
		t.Fatalf("pre-materialize plan-owned future tz_step row: %v", err)
	}

	resp, code := c.callTrigger(123456)
	if code != http.StatusOK {
		t.Fatalf("expected 200 (the colliding step must remain visible), got %d", code)
	}
	if got := int(resp["medication_count"].(float64)); got != 1 {
		t.Fatalf("expected 1 medication taken, got %d (resp=%v) — the colliding tz_step row was hidden by dedup + plannedOwnedMeds suppression", got, resp)
	}

	// The pre-materialized tz_step row must be the one that got confirmed,
	// retaining its source/plan metadata. A new source='schedule' row at
	// the same slot would mean the medplan target won the dedup instead.
	var status, source string
	if err := c.db.DB().QueryRow(`
		SELECT status, source FROM intake_log
		WHERE medication_id = ? AND scheduled_at_unix = ? AND tz_plan_id = ?`,
		medID, collisionTime.UTC().Unix(), planID).Scan(&status, &source); err != nil {
		t.Fatalf("lookup colliding tz_step row: %v", err)
	}
	if status != "TAKEN" {
		t.Errorf("colliding tz_step row status=%q, want TAKEN", status)
	}
	if source != "tz_step" {
		t.Errorf("colliding row source=%q, want tz_step (provenance must survive the dedup)", source)
	}

	// There must NOT also be a separate source='schedule' row at the same
	// slot — if there were, the medplan target won dedup and we created a
	// duplicate normal intake on top of the existing tz_step row.
	var dupCount int
	if err := c.db.DB().QueryRow(`
		SELECT COUNT(*) FROM intake_log
		WHERE medication_id = ? AND scheduled_at_unix = ? AND source = 'schedule'`,
		medID, collisionTime.UTC().Unix()).Scan(&dupCount); err != nil {
		t.Fatalf("dup-check query: %v", err)
	}
	if dupCount != 0 {
		t.Errorf("found %d duplicate source='schedule' rows at the collision slot — tz_step must win the dedup", dupCount)
	}
}

// TestHandleTriggerNextIntake_DualRowCollisionPrefersTZStep pins the
// codex-flagged regression where intake_log holds BOTH a pre-existing
// source='schedule' PENDING row and a source='tz_step' PENDING row from an
// APPROVED plan at the exact same (medication_id, scheduled_at_unix). This
// can arise when the medication scheduler fires the normal slot at T just
// before the user approves a plan whose snap-to-clock final step also
// landed at T. Without source-priority ordering in GetPendingIntakesInWindow
// and GetIntakeBySchedule, the older schedule row wins the forecast dedup,
// gets marked SourceNormalSchedule, and is then dropped by
// suppressNormalsCoveredByStep because the plan still owns the med — the
// dose disappears entirely. The fix orders rows so the tz_step row wins.
func TestHandleTriggerNextIntake_DualRowCollisionPrefersTZStep(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.TZ.RecordTimezone("UTC"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	c.setNow(time.Date(2026, 5, 4, 8, 55, 0, 0, time.UTC))
	collisionTime := time.Date(2026, 5, 4, 9, 0, 0, 0, time.UTC)
	futureStep := time.Date(2026, 5, 4, 18, 0, 0, 0, time.UTC)

	medID := mustCreateMed(t, c.db, "Aspirin", "100mg",
		`{"type":"daily","times":["09:00"]}`, "medium")

	planID, err := c.db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "UTC", NewTZ: "Asia/Tokyo",
		Status: "APPROVED", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "h-dual-row-collision",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	// Insert the source='schedule' row FIRST — it gets the lower id, which
	// is the worst case for SQLite's natural ordering: without the fix it
	// would win the no-ORDER-BY query and shadow the tz_step row.
	scheduleRowID, err := c.db.Medication.CreateIntake(medID, int64(123456), collisionTime)
	if err != nil {
		t.Fatalf("CreateIntake (schedule row): %v", err)
	}

	// Materialize the tz_step row at the same instant. The unique partial
	// index in migration 067 only covers (tz_plan_id, medication_id,
	// tz_step_number), so a same-slot schedule row does not block it.
	if _, err := c.db.DB().Exec(`
		INSERT INTO intake_log
			(medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		VALUES (?, ?, ?, 'PENDING', 'tz_step', ?, 1)`,
		medID, int64(123456), collisionTime.UTC().Unix(), planID); err != nil {
		t.Fatalf("pre-materialize colliding tz_step row: %v", err)
	}
	// A future plan-owned step keeps plannedOwnedMeds suppression active —
	// without it the bug would not reproduce.
	if _, err := c.db.DB().Exec(`
		INSERT INTO intake_log
			(medication_id, user_id, scheduled_at_unix, status, source, tz_plan_id, tz_step_number)
		VALUES (?, ?, ?, 'PENDING', 'tz_step', ?, 2)`,
		medID, int64(123456), futureStep.UTC().Unix(), planID); err != nil {
		t.Fatalf("pre-materialize plan-owned future tz_step row: %v", err)
	}

	resp, code := c.callTrigger(123456)
	if code != http.StatusOK {
		t.Fatalf("expected 200 (the colliding tz_step must win dedup and surface), got %d", code)
	}
	if got := int(resp["medication_count"].(float64)); got != 1 {
		t.Fatalf("expected 1 medication taken, got %d (resp=%v) — dose vanished from dedup/suppression", got, resp)
	}

	// The tz_step row must be the one that got confirmed.
	var status, source string
	if err := c.db.DB().QueryRow(`
		SELECT status, source FROM intake_log
		WHERE medication_id = ? AND scheduled_at_unix = ? AND tz_plan_id = ?`,
		medID, collisionTime.UTC().Unix(), planID).Scan(&status, &source); err != nil {
		t.Fatalf("lookup colliding tz_step row: %v", err)
	}
	if status != "TAKEN" {
		t.Errorf("tz_step row status=%q, want TAKEN (confirmation must target the plan-owned row)", status)
	}
	if source != "tz_step" {
		t.Errorf("confirmed row source=%q, want tz_step", source)
	}

	// And the pre-existing schedule row must NOT have been touched by the
	// handler — its status stays PENDING physically. It is a dead row from
	// the perspective of the active plan (the tz_step row owns the dose
	// going forward) and is hidden from user-action surfaces by
	// scheduleNotShadowedByTZStepGate: MedicationReminderChecker's
	// GetPendingIntakes scan skips it, ConfirmIntakesBySchedule's
	// confirm_schedule:<unix> path skips it, and the next scheduler tick
	// sees the tz_step row in BatchGet so it does not re-fire the slot. The
	// row therefore cannot be double-confirmed for a second inventory
	// decrement.
	var schedStatus string
	if err := c.db.DB().QueryRow(`SELECT status FROM intake_log WHERE id = ?`, scheduleRowID).Scan(&schedStatus); err != nil {
		t.Fatalf("lookup schedule row: %v", err)
	}
	if schedStatus != "PENDING" {
		t.Errorf("schedule row status=%q, want PENDING (handler must target the tz_step row, not the schedule row)", schedStatus)
	}

	// The shadowed schedule row must be invisible to MedicationReminderChecker
	// (which scans GetPendingIntakes) — otherwise the user gets a second
	// reminder for the dose they already took via the tz_step row and a
	// confirm_intake click decrements inventory a second time.
	pending, err := c.db.Medication.GetPendingIntakes()
	if err != nil {
		t.Fatalf("GetPendingIntakes after trigger: %v", err)
	}
	for _, p := range pending {
		if p.ID == scheduleRowID {
			t.Errorf("shadowed schedule row %d still returned by GetPendingIntakes — reminder checker would fire it for a second inventory decrement", scheduleRowID)
		}
	}

	// confirm_schedule:<unix> must not surface the shadowed schedule row either.
	bySched, err := c.db.Medication.GetPendingIntakesBySchedule(123456, collisionTime)
	if err != nil {
		t.Fatalf("GetPendingIntakesBySchedule after trigger: %v", err)
	}
	for _, p := range bySched {
		if p.ID == scheduleRowID {
			t.Errorf("shadowed schedule row %d still returned by GetPendingIntakesBySchedule — confirm_schedule batch would double-confirm the dose", scheduleRowID)
		}
	}
}

// TestHandleTriggerNextIntake_PlanOwnsMedSuppressesDistantWindowNormal pins
// the Take-next analogue of the scheduler's "plan owns this med while steps
// remain" rule. An APPROVED plan has a single PENDING tz_step for the med
// well beyond the 12h look-ahead window. The med's normal-schedule slot is
// inside the window — without the plan-owned suppression the handler would
// surface and confirm a bare clock-time dose for a medication the scheduler
// considers fully governed by the plan, producing a phantom intake at the
// wrong instant.
func TestHandleTriggerNextIntake_PlanOwnsMedSuppressesDistantWindowNormal(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.TZ.RecordTimezone("UTC"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	// now = 12:00 UTC today — the 20:00 UTC normal slot is 8h away (in
	// window) but the next plan step is 24h away (out of window).
	c.setNow(time.Date(2026, 5, 4, 12, 0, 0, 0, time.UTC))

	medID := mustCreateMed(t, c.db, "Metformin", "1000mg",
		`{"type":"daily","times":["20:00"]}`, "flexible")

	planID, err := c.db.TZ.CreateTZTransitionPlan(&store.TZTransitionPlan{
		OldTZ: "UTC", NewTZ: "Asia/Tokyo",
		Status: "PENDING_APPROVAL", StepsJSON: "[]", InputsJSON: "{}", PlanHash: "h-plan-owns-distant",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	stepTime := time.Date(2026, 5, 5, 12, 0, 0, 0, time.UTC) // 24h ahead, outside 12h window
	setPlanSteps(t, c.db, planID, []planStepFixture{
		{MedicationID: medID, StepNumber: 1, ScheduledAt: stepTime, Note: "step"},
	})
	if _, err := c.db.ApproveAndMaterialize(context.Background(), planID, 123456, c.now.Add(-time.Hour)); err != nil {
		t.Fatalf("ApproveAndMaterialize: %v", err)
	}

	// No other med exists, so with plan-owned suppression there is no
	// upcoming dose in window and the handler must say 404 — not pick the
	// med's normal-schedule slot just because the plan step itself sits
	// outside the look-ahead window.
	_, code := c.callTrigger(123456)
	if code != http.StatusNotFound {
		t.Errorf("expected 404 (plan owns this med, no upcoming target in window), got %d — handler surfaced the bare normal-schedule slot for a plan-owned med", code)
	}
}

// TestHandleTriggerNextIntake_NoneInWindowReturns404 is the negative path:
// when no medication has any future scheduled dose inside the look-ahead
// window the handler must say "nothing to take" rather than silently
// reaching back into past targets or into the next 24h.
func TestHandleTriggerNextIntake_NoneInWindowReturns404(t *testing.T) {
	c := newTriggerCtx(t)
	if err := c.db.TZ.RecordTimezone("UTC"); err != nil {
		t.Fatalf("RecordTimezone: %v", err)
	}
	c.setNow(time.Date(2026, 5, 4, 9, 0, 0, 0, time.UTC)) // past 08:00; next slot 24 h away

	mustCreateMed(t, c.db, "Once", "10mg", `{"type":"daily","times":["08:00"]}`, "flexible")

	_, code := c.callTrigger(123456)
	if code != http.StatusNotFound {
		t.Errorf("expected 404 when no upcoming intake, got %d", code)
	}
}
