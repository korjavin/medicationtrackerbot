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

func TestCreateAndGetTZTransitionSteps(t *testing.T) {
	r := setupTZRepo(t)

	plan := &TZTransitionPlan{
		OldTZ:      "UTC",
		NewTZ:      "Asia/Shanghai",
		Status:     "APPROVED",
		StepsJSON:  `[]`,
		InputsJSON: `{}`,
		PlanHash:   "hash4",
	}
	planID, err := r.CreateTZTransitionPlan(plan)
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	now := time.Now().UTC().Truncate(time.Second)
	steps := []TZTransitionStep{
		{PlanID: planID, MedicationID: 1, StepNumber: 1, ScheduledAt: now.Add(2 * time.Hour), Note: "step 1"},
		{PlanID: planID, MedicationID: 1, StepNumber: 2, ScheduledAt: now.Add(5 * time.Hour), Note: "step 2"},
		{PlanID: planID, MedicationID: 2, StepNumber: 1, ScheduledAt: now.Add(3 * time.Hour), Note: "med2 step 1"},
	}
	if err := r.CreateTZTransitionSteps(steps); err != nil {
		t.Fatalf("CreateTZTransitionSteps: %v", err)
	}

	pending, err := r.GetPendingStepsForPlan(planID)
	if err != nil {
		t.Fatalf("GetPendingStepsForPlan: %v", err)
	}
	if len(pending) != 3 {
		t.Fatalf("expected 3 pending steps, got %d", len(pending))
	}
	// Ordered by step_number ASC
	if pending[0].StepNumber != 1 {
		t.Errorf("first step has StepNumber %d, want 1", pending[0].StepNumber)
	}
}

func TestMarkStepConsumed(t *testing.T) {
	r := setupTZRepo(t)

	plan := &TZTransitionPlan{
		OldTZ:      "UTC",
		NewTZ:      "Asia/Shanghai",
		Status:     "APPROVED",
		StepsJSON:  `[]`,
		InputsJSON: `{}`,
		PlanHash:   "hash5",
	}
	planID, err := r.CreateTZTransitionPlan(plan)
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	now := time.Now().UTC().Truncate(time.Second)
	steps := []TZTransitionStep{
		{PlanID: planID, MedicationID: 1, StepNumber: 1, ScheduledAt: now.Add(time.Hour), Note: "step 1"},
		{PlanID: planID, MedicationID: 1, StepNumber: 2, ScheduledAt: now.Add(3 * time.Hour), Note: "step 2"},
	}
	if err := r.CreateTZTransitionSteps(steps); err != nil {
		t.Fatalf("CreateTZTransitionSteps: %v", err)
	}

	pending, err := r.GetPendingStepsForPlan(planID)
	if err != nil || len(pending) != 2 {
		t.Fatalf("expected 2 pending steps: err=%v len=%d", err, len(pending))
	}

	// Consume step 1
	if err := r.MarkStepConsumed(pending[0].ID, now); err != nil {
		t.Fatalf("MarkStepConsumed: %v", err)
	}

	// Now only 1 pending step remains
	remaining, err := r.GetPendingStepsForPlan(planID)
	if err != nil {
		t.Fatalf("GetPendingStepsForPlan after consume: %v", err)
	}
	if len(remaining) != 1 {
		t.Fatalf("expected 1 remaining step, got %d", len(remaining))
	}
	if remaining[0].StepNumber != 2 {
		t.Errorf("remaining step has StepNumber %d, want 2", remaining[0].StepNumber)
	}
}
