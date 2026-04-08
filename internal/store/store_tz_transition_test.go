package store

import (
	"testing"
	"time"
)

func TestCreateAndGetTZTransitionPlan(t *testing.T) {
	s := setupTestStore(t)

	plan := &TZTransitionPlan{
		OldTZ:      "America/New_York",
		NewTZ:      "Europe/Berlin",
		Status:     "PENDING_APPROVAL",
		StepsJSON:  `[]`,
		InputsJSON: `{"meds":[]}`,
		PlanHash:   "abc123",
	}
	id, err := s.CreateTZTransitionPlan(plan)
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}
	if id <= 0 {
		t.Errorf("expected positive ID, got %d", id)
	}

	got, err := s.GetLatestActiveOrPendingTZTransitionPlan()
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
	s := setupTestStore(t)

	got, err := s.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		t.Fatalf("GetLatestActiveOrPendingTZTransitionPlan: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil plan on empty table, got %+v", got)
	}
}

func TestGetLatestActiveOrPendingTZTransitionPlan_IgnoresTerminalStatus(t *testing.T) {
	s := setupTestStore(t)

	for _, status := range []string{"REJECTED", "CANCELLED", "EXPIRED"} {
		plan := &TZTransitionPlan{
			OldTZ:      "America/New_York",
			NewTZ:      "Europe/Berlin",
			Status:     status,
			StepsJSON:  `[]`,
			InputsJSON: `{}`,
			PlanHash:   "hash-" + status,
		}
		if _, err := s.CreateTZTransitionPlan(plan); err != nil {
			t.Fatalf("CreateTZTransitionPlan status=%s: %v", status, err)
		}
	}

	got, err := s.GetLatestActiveOrPendingTZTransitionPlan()
	if err != nil {
		t.Fatalf("GetLatestActiveOrPendingTZTransitionPlan: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil for terminal-status plans, got status=%s", got.Status)
	}
}

func TestUpdateTZTransitionPlanStatus(t *testing.T) {
	s := setupTestStore(t)

	plan := &TZTransitionPlan{
		OldTZ:      "UTC",
		NewTZ:      "Asia/Tokyo",
		Status:     "PENDING_APPROVAL",
		StepsJSON:  `[]`,
		InputsJSON: `{}`,
		PlanHash:   "hash1",
	}
	id, err := s.CreateTZTransitionPlan(plan)
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	// Transition PENDING_APPROVAL → NOTIFIED with guard
	if err := s.UpdateTZTransitionPlanStatus(id, "NOTIFIED", "", "PENDING_APPROVAL"); err != nil {
		t.Fatalf("UpdateTZTransitionPlanStatus: %v", err)
	}

	got, err := s.GetLatestActiveOrPendingTZTransitionPlan()
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
	s := setupTestStore(t)

	plan := &TZTransitionPlan{
		OldTZ:      "UTC",
		NewTZ:      "Asia/Tokyo",
		Status:     "NOTIFIED",
		StepsJSON:  `[]`,
		InputsJSON: `{}`,
		PlanHash:   "hash2",
	}
	id, err := s.CreateTZTransitionPlan(plan)
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	// Guard: expected status is PENDING_APPROVAL, but actual is NOTIFIED → no-op
	if err := s.UpdateTZTransitionPlanStatus(id, "NOTIFIED", "", "PENDING_APPROVAL"); err != nil {
		t.Fatalf("UpdateTZTransitionPlanStatus with wrong guard: %v", err)
	}

	// Status should remain NOTIFIED
	got, err := s.GetLatestActiveOrPendingTZTransitionPlan()
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
	s := setupTestStore(t)

	plan := &TZTransitionPlan{
		OldTZ:      "UTC",
		NewTZ:      "Europe/Paris",
		Status:     "PENDING_APPROVAL",
		StepsJSON:  `[]`,
		InputsJSON: `{"x":1}`,
		PlanHash:   "myhash",
	}
	if _, err := s.CreateTZTransitionPlan(plan); err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	got, err := s.GetPlanByHash("myhash")
	if err != nil {
		t.Fatalf("GetPlanByHash: %v", err)
	}
	if got == nil {
		t.Fatal("expected plan by hash, got nil")
	}
	if got.InputsJSON != `{"x":1}` {
		t.Errorf("InputsJSON: got %q", got.InputsJSON)
	}

	notFound, err := s.GetPlanByHash("nonexistent")
	if err != nil {
		t.Fatalf("GetPlanByHash nonexistent: %v", err)
	}
	if notFound != nil {
		t.Error("expected nil for nonexistent hash")
	}
}

func TestSetTZTransitionPlanApproved(t *testing.T) {
	s := setupTestStore(t)

	plan := &TZTransitionPlan{
		OldTZ:      "UTC",
		NewTZ:      "America/Chicago",
		Status:     "NOTIFIED",
		StepsJSON:  `[]`,
		InputsJSON: `{}`,
		PlanHash:   "hash3",
	}
	id, err := s.CreateTZTransitionPlan(plan)
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	approvedAt := time.Now().UTC().Truncate(time.Second)
	if _, err := s.SetTZTransitionPlanApproved(id, approvedAt); err != nil {
		t.Fatalf("SetTZTransitionPlanApproved: %v", err)
	}

	got, err := s.GetLatestActiveOrPendingTZTransitionPlan()
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
	s := setupTestStore(t)

	plan := &TZTransitionPlan{
		OldTZ:      "UTC",
		NewTZ:      "Asia/Shanghai",
		Status:     "APPROVED",
		StepsJSON:  `[]`,
		InputsJSON: `{}`,
		PlanHash:   "hash4",
	}
	planID, err := s.CreateTZTransitionPlan(plan)
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	now := time.Now().UTC().Truncate(time.Second)
	steps := []TZTransitionStep{
		{PlanID: planID, MedicationID: 1, StepNumber: 1, ScheduledAt: now.Add(2 * time.Hour), Note: "step 1"},
		{PlanID: planID, MedicationID: 1, StepNumber: 2, ScheduledAt: now.Add(5 * time.Hour), Note: "step 2"},
		{PlanID: planID, MedicationID: 2, StepNumber: 1, ScheduledAt: now.Add(3 * time.Hour), Note: "med2 step 1"},
	}
	if err := s.CreateTZTransitionSteps(steps); err != nil {
		t.Fatalf("CreateTZTransitionSteps: %v", err)
	}

	pending, err := s.GetPendingStepsForPlan(planID)
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
	s := setupTestStore(t)

	plan := &TZTransitionPlan{
		OldTZ:      "UTC",
		NewTZ:      "Asia/Shanghai",
		Status:     "APPROVED",
		StepsJSON:  `[]`,
		InputsJSON: `{}`,
		PlanHash:   "hash5",
	}
	planID, err := s.CreateTZTransitionPlan(plan)
	if err != nil {
		t.Fatalf("CreateTZTransitionPlan: %v", err)
	}

	now := time.Now().UTC().Truncate(time.Second)
	steps := []TZTransitionStep{
		{PlanID: planID, MedicationID: 1, StepNumber: 1, ScheduledAt: now.Add(time.Hour), Note: "step 1"},
		{PlanID: planID, MedicationID: 1, StepNumber: 2, ScheduledAt: now.Add(3 * time.Hour), Note: "step 2"},
	}
	if err := s.CreateTZTransitionSteps(steps); err != nil {
		t.Fatalf("CreateTZTransitionSteps: %v", err)
	}

	pending, err := s.GetPendingStepsForPlan(planID)
	if err != nil || len(pending) != 2 {
		t.Fatalf("expected 2 pending steps: err=%v len=%d", err, len(pending))
	}

	// Consume step 1
	if err := s.MarkStepConsumed(pending[0].ID, now); err != nil {
		t.Fatalf("MarkStepConsumed: %v", err)
	}

	// Now only 1 pending step remains
	remaining, err := s.GetPendingStepsForPlan(planID)
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

func TestMedicationTZShiftPolicyDefaultsToFlexible(t *testing.T) {
	s := setupTestStore(t)

	id, err := s.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	med, err := s.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedication: %v", err)
	}
	if med.TZShiftPolicy != "flexible" {
		t.Errorf("expected TZShiftPolicy=flexible, got %q", med.TZShiftPolicy)
	}
}

func TestMedicationTZShiftPolicyRoundTrip(t *testing.T) {
	s := setupTestStore(t)

	id, err := s.CreateMedication("TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "strict")
	if err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	med, err := s.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedication: %v", err)
	}
	if med.TZShiftPolicy != "strict" {
		t.Errorf("expected TZShiftPolicy=strict after create, got %q", med.TZShiftPolicy)
	}

	// Update to medium
	if err := s.UpdateMedication(id, "TestMed", "5mg", `{"type":"daily","times":["09:00"]}`, false, nil, nil, "", "", nil, "medium"); err != nil {
		t.Fatalf("UpdateMedication: %v", err)
	}

	med, err = s.GetMedication(id)
	if err != nil {
		t.Fatalf("GetMedication after update: %v", err)
	}
	if med.TZShiftPolicy != "medium" {
		t.Errorf("expected TZShiftPolicy=medium after update, got %q", med.TZShiftPolicy)
	}
}

func TestListMedicationsIncludesTZShiftPolicy(t *testing.T) {
	s := setupTestStore(t)

	if _, err := s.CreateMedication("MedA", "5mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "flexible"); err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}
	if _, err := s.CreateMedication("MedB", "10mg", `{"type":"daily","times":["09:00"]}`, nil, nil, "", "", "strict"); err != nil {
		t.Fatalf("CreateMedication: %v", err)
	}

	meds, err := s.ListMedications(false)
	if err != nil {
		t.Fatalf("ListMedications: %v", err)
	}
	if len(meds) != 2 {
		t.Fatalf("expected 2 meds, got %d", len(meds))
	}

	policies := map[string]string{}
	for _, m := range meds {
		policies[m.Name] = m.TZShiftPolicy
	}
	if policies["MedA"] != "flexible" {
		t.Errorf("MedA: expected flexible, got %q", policies["MedA"])
	}
	if policies["MedB"] != "strict" {
		t.Errorf("MedB: expected strict, got %q", policies["MedB"])
	}
}
