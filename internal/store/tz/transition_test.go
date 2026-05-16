package tz

import (
	"testing"
	"time"
)

func TestCreateAndGetTZTransitionPlan(t *testing.T) {
	r := setupTZRepo(t)

	plan := &TZTransitionPlan{
		OldTZ:      "America/New_York",
		NewTZ:      "Europe/Berlin",
		Status:     "PENDING_APPROVAL",
		StepsJSON:  `[]`,
		InputsJSON: `{"meds":[]}`,
		PlanHash:   "abc123",
	}
	id, err := r.CreateTZTransitionPlan(plan)
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	if id <= 0 {
		t.Errorf("expected positive ID, got %d", id)
	}

	got, err := r.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		t.Fatalf("GetLatestActiveOrPendingTZTransitionPlan: %v", err)
	}
	if got == nil {
		t.Fatal("expected plan, got nil")
	}
	if got.OldTZ != "America/New_York" {
		t.Errorf("OldTZ: got %q want %q", got.OldTZ, "America/New_York")
	}
	if got.NewTZ != "Europe/Berlin" {
		t.Errorf("NewTZ: got %q want %q", got.NewTZ, "Europe/Berlin")
	}
	if got.Status != "PENDING_APPROVAL" {
		t.Errorf("Status: got %q want %q", got.Status, "PENDING_APPROVAL")
	}
	if got.PlanHash != "abc123" {
		t.Errorf("PlanHash: got %q want %q", got.PlanHash, "abc123")
	}
}

func TestGetLatestActiveOrPendingTZTransitionPlan_NoneExists(t *testing.T) {
	r := setupTZRepo(t)

	got, err := r.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		t.Fatalf("GetLatestActiveOrPendingTZTransitionPlan: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil plan on empty table, got %+v", got)
	}
}

func TestGetLatestActiveOrPendingTZTransitionPlan_IgnoresTerminalStatus(t *testing.T) {
	r := setupTZRepo(t)

	for _, status := range []string{"REJECTED", "CANCELLED", "EXPIRED"} {
		plan := &TZTransitionPlan{
			OldTZ:      "America/New_York",
			NewTZ:      "Europe/Berlin",
			Status:     status,
			StepsJSON:  `[]`,
			InputsJSON: `{}`,
			PlanHash:   "hash-" + status,
		}
		if _, err := r.CreateTZTransitionPlan(plan); err != nil {
			t.Fatalf("CreateTZTransitionPlan status=%s: %v", status, err)
		}
	}

	got, err := r.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		t.Fatalf("GetLatestActiveOrPendingTZTransitionPlan: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil for terminal-status plans, got status=%s", got.Status)
	}
}

func TestUpdateTZTransitionPlanStatus(t *testing.T) {
	r := setupTZRepo(t)

	plan := &TZTransitionPlan{
		OldTZ:      "UTC",
		NewTZ:      "Asia/Tokyo",
		Status:     "PENDING_APPROVAL",
		StepsJSON:  `[]`,
		InputsJSON: `{}`,
		PlanHash:   "hash1",
	}
	id, err := r.CreateTZTransitionPlan(plan)
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	// Transition PENDING_APPROVAL → NOTIFIED with guard
	if err := r.UpdateTZTransitionPlanStatus(id, "NOTIFIED", "", "PENDING_APPROVAL"); err != nil {
		t.Fatalf("UpdateTZTransitionPlanStatus: %v", err)
	}

	got, err := r.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		t.Fatalf("GetLatestActiveOrPendingTZTransitionPlan: %v", err)
	}
	if got == nil {
		t.Fatal("expected plan after NOTIFIED transition")
	}
	if got.Status != "NOTIFIED" {
		t.Errorf("expected NOTIFIED, got %q", got.Status)
	}
}

func TestUpdateTZTransitionPlanStatus_GuardPreventsDoubleTransition(t *testing.T) {
	r := setupTZRepo(t)

	plan := &TZTransitionPlan{
		OldTZ:      "UTC",
		NewTZ:      "Asia/Tokyo",
		Status:     "NOTIFIED",
		StepsJSON:  `[]`,
		InputsJSON: `{}`,
		PlanHash:   "hash2",
	}
	id, err := r.CreateTZTransitionPlan(plan)
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	// Guard: expected status is PENDING_APPROVAL, but actual is NOTIFIED → no-op
	if err := r.UpdateTZTransitionPlanStatus(id, "NOTIFIED", "", "PENDING_APPROVAL"); err != nil {
		t.Fatalf("UpdateTZTransitionPlanStatus with wrong guard: %v", err)
	}

	// Status should remain NOTIFIED
	got, err := r.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		t.Fatalf("GetLatestActiveOrPendingTZTransitionPlan: %v", err)
	}
	if got == nil {
		t.Fatal("expected plan")
	}
	if got.Status != "NOTIFIED" {
		t.Errorf("expected NOTIFIED (guard prevented change), got %q", got.Status)
	}
}

func TestGetPlanByHash(t *testing.T) {
	r := setupTZRepo(t)

	plan := &TZTransitionPlan{
		OldTZ:      "UTC",
		NewTZ:      "Europe/Paris",
		Status:     "PENDING_APPROVAL",
		StepsJSON:  `[]`,
		InputsJSON: `{"x":1}`,
		PlanHash:   "myhash",
	}
	if _, err := r.CreateTZTransitionPlan(plan); err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	got, err := r.GetPlanByHash("myhash")
	if err != nil {
		t.Fatalf("GetPlanByHash: %v", err)
	}
	if got == nil {
		t.Fatal("expected plan by hash, got nil")
	}
	if got.InputsJSON != `{"x":1}` {
		t.Errorf("InputsJSON: got %q", got.InputsJSON)
	}

	notFound, err := r.GetPlanByHash("nonexistent")
	if err != nil {
		t.Fatalf("GetPlanByHash nonexistent: %v", err)
	}
	if notFound != nil {
		t.Error("expected nil for nonexistent hash")
	}
}

func TestSetTZTransitionPlanApproved(t *testing.T) {
	r := setupTZRepo(t)

	plan := &TZTransitionPlan{
		OldTZ:      "UTC",
		NewTZ:      "America/Chicago",
		Status:     "NOTIFIED",
		StepsJSON:  `[]`,
		InputsJSON: `{}`,
		PlanHash:   "hash3",
	}
	id, err := r.CreateTZTransitionPlan(plan)
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	approvedAt := time.Now().UTC().Truncate(time.Second)
	if _, err := r.SetTZTransitionPlanApproved(id, approvedAt); err != nil {
		t.Fatalf("SetTZTransitionPlanApproved: %v", err)
	}

	got, err := r.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		t.Fatalf("GetLatestActiveOrPendingTZTransitionPlan: %v", err)
	}
	if got == nil {
		t.Fatal("expected APPROVED plan")
	}
	if got.Status != "APPROVED" {
		t.Errorf("Status: got %q want APPROVED", got.Status)
	}
	if got.UserAction != "approved" {
		t.Errorf("UserAction: got %q want approved", got.UserAction)
	}
}

// TestTZTransitionPlan_LifecycleTimestamps_UnixUTC pins Task 7's invariant:
// every plan-lifecycle timestamp setter (Create / MarkPlanNotified /
// SetTZTransitionPlanApproved / ResetPlanToPending) round-trips through
// unix-seconds-UTC storage so SQL equality is safe across server/user TZs.
// The struct's public time.Time fields stay UTC after read.
func TestTZTransitionPlan_LifecycleTimestamps_UnixUTC(t *testing.T) {
	r := setupTZRepo(t)

	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load LA: %v", err)
	}

	before := time.Now().UTC().Truncate(time.Second).Add(-time.Second)
	id, err := r.CreateTZTransitionPlan(&TZTransitionPlan{
		OldTZ:      "America/Los_Angeles",
		NewTZ:      "Europe/Berlin",
		Status:     "PENDING_APPROVAL",
		StepsJSON:  `[]`,
		InputsJSON: `{}`,
		PlanHash:   "lifecycle-hash",
	})
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	after := time.Now().UTC().Truncate(time.Second).Add(time.Second)

	// Create stamps created_at_unix via column default. Read back and verify
	// the time.Time is UTC and within the [before, after] window.
	got, err := r.GetPlanByHash("lifecycle-hash")
	if err != nil {
		t.Fatalf("GetPlanByHash: %v", err)
	}
	if got == nil {
		t.Fatal("plan not found")
	}
	if got.CreatedAt.Location() != time.UTC {
		t.Errorf("CreatedAt.Location()=%v, want UTC", got.CreatedAt.Location())
	}
	if got.CreatedAt.Before(before) || got.CreatedAt.After(after) {
		t.Errorf("CreatedAt=%s outside expected window [%s, %s]",
			got.CreatedAt.Format(time.RFC3339),
			before.Format(time.RFC3339), after.Format(time.RFC3339))
	}
	if got.NotifiedAt != nil {
		t.Errorf("NotifiedAt should be nil before MarkPlanNotified, got %v", got.NotifiedAt)
	}
	if got.ApprovedAt != nil {
		t.Errorf("ApprovedAt should be nil before SetTZTransitionPlanApproved, got %v", got.ApprovedAt)
	}

	// MarkPlanNotified stamps notified_at_unix.
	beforeN := time.Now().UTC().Truncate(time.Second).Add(-time.Second)
	won, err := r.MarkPlanNotified(id)
	if err != nil {
		t.Fatalf("MarkPlanNotified: %v", err)
	}
	if !won {
		t.Fatal("expected MarkPlanNotified to win the CAS on a fresh PENDING_APPROVAL plan")
	}
	afterN := time.Now().UTC().Truncate(time.Second).Add(time.Second)

	got, err = r.GetPlanByHash("lifecycle-hash")
	if err != nil {
		t.Fatalf("GetPlanByHash post-notify: %v", err)
	}
	if got.Status != "NOTIFIED" {
		t.Errorf("Status: got %q want NOTIFIED", got.Status)
	}
	if got.NotifiedAt == nil {
		t.Fatal("NotifiedAt should be populated after MarkPlanNotified")
	}
	if got.NotifiedAt.Location() != time.UTC {
		t.Errorf("NotifiedAt.Location()=%v, want UTC", got.NotifiedAt.Location())
	}
	if got.NotifiedAt.Before(beforeN) || got.NotifiedAt.After(afterN) {
		t.Errorf("NotifiedAt=%s outside expected window [%s, %s]",
			got.NotifiedAt.Format(time.RFC3339),
			beforeN.Format(time.RFC3339), afterN.Format(time.RFC3339))
	}

	// ResetPlanToPending clears notified_at_unix.
	if err := r.ResetPlanToPending(id); err != nil {
		t.Fatalf("ResetPlanToPending: %v", err)
	}
	got, err = r.GetPlanByHash("lifecycle-hash")
	if err != nil {
		t.Fatalf("GetPlanByHash post-reset: %v", err)
	}
	if got.Status != "PENDING_APPROVAL" {
		t.Errorf("Status: got %q want PENDING_APPROVAL", got.Status)
	}
	if got.NotifiedAt != nil {
		t.Errorf("NotifiedAt should be nil after ResetPlanToPending, got %v", got.NotifiedAt)
	}

	// Mark notified again so SetTZTransitionPlanApproved can transition NOTIFIED→APPROVED.
	if _, err := r.MarkPlanNotified(id); err != nil {
		t.Fatalf("MarkPlanNotified (second time): %v", err)
	}

	// Approve with a time.Time in a non-UTC location — the writer must
	// normalize to UTC unix seconds and the reader must return UTC.
	approveLA := time.Date(2026, 5, 10, 8, 35, 0, 0, la)
	wantApproveUnix := approveLA.UTC().Unix()
	ok, err := r.SetTZTransitionPlanApproved(id, approveLA)
	if err != nil {
		t.Fatalf("SetTZTransitionPlanApproved: %v", err)
	}
	if !ok {
		t.Fatal("expected SetTZTransitionPlanApproved to apply on NOTIFIED plan")
	}

	got, err = r.GetPlanByHash("lifecycle-hash")
	if err != nil {
		t.Fatalf("GetPlanByHash post-approve: %v", err)
	}
	if got.Status != "APPROVED" {
		t.Errorf("Status: got %q want APPROVED", got.Status)
	}
	if got.ApprovedAt == nil {
		t.Fatal("ApprovedAt should be populated after SetTZTransitionPlanApproved")
	}
	if got.ApprovedAt.Location() != time.UTC {
		t.Errorf("ApprovedAt.Location()=%v, want UTC", got.ApprovedAt.Location())
	}
	if got.ApprovedAt.Unix() != wantApproveUnix {
		t.Errorf("ApprovedAt.Unix()=%d want %d", got.ApprovedAt.Unix(), wantApproveUnix)
	}
	// Same instant in a different TZ name must compare equal as time.Time.
	if !got.ApprovedAt.Equal(approveLA) {
		t.Errorf("ApprovedAt=%s should be equal to input %s", got.ApprovedAt.Format(time.RFC3339), approveLA.Format(time.RFC3339))
	}
}

// TestCreateAndGetTZTransitionSteps and TestMarkStepConsumed lived here
// pre-Task-13 to pin the dedicated step-table lifecycle (bulk-insert,
// list-pending, mark-consumed). Track D Task 13 dropped the
// tz_transition_steps table; step data now lives entirely in
// tz_transition_plans.steps_json (audit blob) and intake_log rows with
// source='tz_step' (execution state). The Materialize path is covered by
// TestMaterializePlanStepsAsIntakesTx in internal/store/medication/, and the
// cancel-cleanup path by TestDeletePendingPreMaterializedIntakesForPlan there.
