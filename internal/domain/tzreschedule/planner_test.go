package tzreschedule

import (
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// mockPlannerStore is a simple in-memory mock of PlannerStore for unit tests.
type mockPlannerStore struct {
	medications []store.Medication
	intakes     map[int64][]store.IntakeLog // medID → intake history
	plans       []*store.TZTransitionPlan
	steps       []store.TZTransitionStep
	nextPlanID  int64
}

func newMockPlannerStore() *mockPlannerStore {
	return &mockPlannerStore{
		intakes:    make(map[int64][]store.IntakeLog),
		nextPlanID: 1,
	}
}

func (m *mockPlannerStore) List(showArchived bool) ([]store.Medication, error) {
	if showArchived {
		return m.medications, nil
	}
	var active []store.Medication
	for _, med := range m.medications {
		if !med.Archived {
			active = append(active, med)
		}
	}
	return active, nil
}

func (m *mockPlannerStore) ListIntakeHistory(medID int, days int) ([]store.IntakeLog, error) {
	return m.intakes[int64(medID)], nil
}

func (m *mockPlannerStore) GetPlanByHash(hash string) (*store.TZTransitionPlan, error) {
	for _, p := range m.plans {
		if p.PlanHash == hash {
			return p, nil
		}
	}
	return nil, nil
}

func (m *mockPlannerStore) GetLatestActiveOrPendingTransitionPlan() (*store.TZTransitionPlan, error) {
	for i := len(m.plans) - 1; i >= 0; i-- {
		p := m.plans[i]
		if p.Status == "PENDING_APPROVAL" || p.Status == "NOTIFIED" || p.Status == "APPROVED" {
			return p, nil
		}
	}
	return nil, nil
}

func (m *mockPlannerStore) UpdateTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
	for _, p := range m.plans {
		if p.ID == id {
			if expectedStatus != "" && p.Status != expectedStatus {
				return nil // guarded no-op
			}
			p.Status = newStatus
			p.UserAction = userAction
			return nil
		}
	}
	return nil
}

func (m *mockPlannerStore) ListPendingStepsForPlan(planID int64) ([]store.TZTransitionStep, error) {
	var pending []store.TZTransitionStep
	for _, s := range m.steps {
		if s.PlanID == planID && s.ConsumedAt == nil {
			pending = append(pending, s)
		}
	}
	return pending, nil
}

func (m *mockPlannerStore) CreateTransitionPlanWithSteps(plan *store.TZTransitionPlan, steps []store.TZTransitionStep) (int64, error) {
	// Mirror the real store: cancel all active plans within the transaction.
	for _, p := range m.plans {
		switch p.Status {
		case "PENDING_APPROVAL", "NOTIFIED", "APPROVED":
			p.Status = "CANCELLED"
			p.UserAction = "superseded"
		}
	}
	plan.ID = m.nextPlanID
	plan.CreatedAt = time.Now()
	m.nextPlanID++
	m.plans = append(m.plans, plan)
	// Set the PlanID on each step (mirrors the store's transaction behaviour).
	for i := range steps {
		steps[i].PlanID = plan.ID
	}
	m.steps = append(m.steps, steps...)
	return plan.ID, nil
}

// --- helpers ---

func dailyMed(id int64, name, times string, policy string) store.Medication {
	return store.Medication{
		ID:            id,
		Name:          name,
		Schedule:      `{"type":"daily","times":["` + times + `"]}`,
		TZShiftPolicy: policy,
	}
}

func takenIntake(medID int64, takenAt time.Time) store.IntakeLog {
	return store.IntakeLog{
		MedicationID: medID,
		Status:       "TAKEN",
		TakenAt:      &takenAt,
	}
}

// --- tests ---

func TestGenerateIfChanged_SameTZ_DoesNothing(t *testing.T) {
	s := newMockPlannerStore()
	svc := NewPlannerService(s)
	created, err := svc.GenerateIfChanged("Europe/Berlin", "Europe/Berlin", time.Now())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if created {
		t.Fatal("expected created=false for same TZ")
	}
	if len(s.plans) != 0 {
		t.Fatalf("expected no plans, got %d", len(s.plans))
	}
}

func TestGenerateIfChanged_NoDailyMeds_DoesNothing(t *testing.T) {
	s := newMockPlannerStore()
	// Only an as-needed med — should produce no steps.
	s.medications = []store.Medication{
		{ID: 1, Name: "Aspirin", Schedule: `{"type":"as_needed"}`, TZShiftPolicy: "flexible"},
	}
	svc := NewPlannerService(s)
	created, err := svc.GenerateIfChanged("UTC", "Asia/Tokyo", time.Now())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if created {
		t.Fatal("expected created=false for as-needed-only meds")
	}
	if len(s.plans) != 0 {
		t.Fatalf("expected no plans for as-needed-only meds, got %d", len(s.plans))
	}
}

func TestGenerateIfChanged_CreatesPlan(t *testing.T) {
	s := newMockPlannerStore()
	s.medications = []store.Medication{dailyMed(1, "Lisinopril", "08:00", "flexible")}
	now := time.Date(2024, 3, 10, 10, 0, 0, 0, time.UTC)
	s.intakes[1] = []store.IntakeLog{takenIntake(1, now.Add(-2*time.Hour))}

	svc := NewPlannerService(s)
	created, err := svc.GenerateIfChanged("UTC", "Asia/Tokyo", now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !created {
		t.Fatal("expected created=true")
	}
	if len(s.plans) != 1 {
		t.Fatalf("expected 1 plan, got %d", len(s.plans))
	}
	if s.plans[0].Status != "PENDING_APPROVAL" {
		t.Fatalf("expected PENDING_APPROVAL, got %q", s.plans[0].Status)
	}
	if len(s.steps) == 0 {
		t.Fatalf("expected steps to be saved")
	}
}

func TestGenerateIfChanged_HashDeduplication(t *testing.T) {
	s := newMockPlannerStore()
	s.medications = []store.Medication{dailyMed(1, "Lisinopril", "08:00", "flexible")}
	now := time.Date(2024, 3, 10, 10, 0, 0, 0, time.UTC)
	s.intakes[1] = []store.IntakeLog{takenIntake(1, now.Add(-2*time.Hour))}

	svc := NewPlannerService(s)
	// First call — should create.
	created, err := svc.GenerateIfChanged("UTC", "Asia/Tokyo", now)
	if err != nil {
		t.Fatalf("first call error: %v", err)
	}
	if !created {
		t.Fatal("expected created=true on first call")
	}
	if len(s.plans) != 1 {
		t.Fatalf("expected 1 plan after first call, got %d", len(s.plans))
	}

	// Second call with identical inputs within 24h — should be deduped.
	created, err = svc.GenerateIfChanged("UTC", "Asia/Tokyo", now.Add(1*time.Minute))
	if err != nil {
		t.Fatalf("second call error: %v", err)
	}
	if created {
		t.Fatal("expected created=false on deduped call")
	}
	if len(s.plans) != 1 {
		t.Fatalf("expected still 1 plan (deduped), got %d", len(s.plans))
	}
}

func TestGenerateIfChanged_CancelsActivePlanBeforeCreatingNew(t *testing.T) {
	s := newMockPlannerStore()
	s.medications = []store.Medication{dailyMed(1, "Metoprolol", "09:00", "medium")}
	now := time.Date(2024, 3, 10, 10, 0, 0, 0, time.UTC)
	s.intakes[1] = []store.IntakeLog{takenIntake(1, now.Add(-1*time.Hour))}

	svc := NewPlannerService(s)
	// Create first plan (UTC → Tokyo).
	if _, err := svc.GenerateIfChanged("UTC", "Asia/Tokyo", now); err != nil {
		t.Fatalf("first call: %v", err)
	}
	firstPlanStatus := s.plans[0].Status

	if firstPlanStatus != "PENDING_APPROVAL" {
		t.Fatalf("expected first plan PENDING_APPROVAL, got %q", firstPlanStatus)
	}

	// Simulate second TZ change 2h later with different destination — different hash.
	// The second call passes "UTC" as oldTZ (the stored value), but GenerateIfChanged
	// should detect the active PENDING_APPROVAL plan and use its OldTZ ("UTC") as
	// the real baseline.
	now2 := now.Add(2 * time.Hour)
	if _, err := svc.GenerateIfChanged("UTC", "America/New_York", now2); err != nil {
		t.Fatalf("second call: %v", err)
	}

	// The first plan should be cancelled.
	if s.plans[0].Status != "CANCELLED" {
		t.Fatalf("expected first plan CANCELLED, got %q", s.plans[0].Status)
	}
	if s.plans[0].UserAction != "superseded" {
		t.Fatalf("expected user_action=superseded, got %q", s.plans[0].UserAction)
	}
	if len(s.plans) != 2 {
		t.Fatalf("expected 2 plans total, got %d", len(s.plans))
	}
}

func TestGenerateIfChanged_SupersedingUsesActivePlanOldTZ(t *testing.T) {
	s := newMockPlannerStore()
	s.medications = []store.Medication{dailyMed(1, "Metoprolol", "09:00", "medium")}
	now := time.Date(2024, 3, 10, 10, 0, 0, 0, time.UTC)
	s.intakes[1] = []store.IntakeLog{takenIntake(1, now.Add(-1*time.Hour))}

	svc := NewPlannerService(s)

	// First plan: UTC → Asia/Tokyo (PENDING_APPROVAL). The scheduler stays on UTC.
	if _, err := svc.GenerateIfChanged("UTC", "Asia/Tokyo", now); err != nil {
		t.Fatalf("first call: %v", err)
	}
	if len(s.plans) != 1 || s.plans[0].Status != "PENDING_APPROVAL" {
		t.Fatalf("expected 1 PENDING_APPROVAL plan, got %d plans", len(s.plans))
	}

	// Second plan: stored TZ says "Asia/Tokyo" but the scheduler is still on "UTC".
	// GenerateIfChanged should detect the active plan and use its OldTZ ("UTC") as
	// the baseline, producing a plan from UTC → America/New_York.
	now2 := now.Add(2 * time.Hour)
	if _, err := svc.GenerateIfChanged("Asia/Tokyo", "America/New_York", now2); err != nil {
		t.Fatalf("second call: %v", err)
	}

	if len(s.plans) != 2 {
		t.Fatalf("expected 2 plans, got %d", len(s.plans))
	}
	// First plan cancelled.
	if s.plans[0].Status != "CANCELLED" {
		t.Fatalf("expected first plan CANCELLED, got %q", s.plans[0].Status)
	}
	// Second plan should use OldTZ=UTC (from the first plan), not Asia/Tokyo (stored).
	if s.plans[1].OldTZ != "UTC" {
		t.Fatalf("expected second plan OldTZ=UTC, got %q", s.plans[1].OldTZ)
	}
	if s.plans[1].NewTZ != "America/New_York" {
		t.Fatalf("expected second plan NewTZ=America/New_York, got %q", s.plans[1].NewTZ)
	}
}

func TestGenerateIfChanged_LastIntakeLoadedIntoInputs(t *testing.T) {
	s := newMockPlannerStore()
	s.medications = []store.Medication{dailyMed(1, "Atorvastatin", "21:00", "strict")}
	anchor := time.Date(2024, 3, 10, 19, 0, 0, 0, time.UTC)
	s.intakes[1] = []store.IntakeLog{takenIntake(1, anchor)}

	svc := NewPlannerService(s)
	now := anchor.Add(2 * time.Hour)
	if _, err := svc.GenerateIfChanged("UTC", "Asia/Tokyo", now); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(s.plans) == 0 {
		t.Fatalf("expected a plan")
	}

	// All steps should be anchored after the last intake time (anchor = 19:00 UTC).
	for _, step := range s.steps {
		if step.ScheduledAt.Before(anchor) {
			t.Fatalf("step ScheduledAt %v is before anchor %v", step.ScheduledAt, anchor)
		}
	}
}

func TestGenerateIfChanged_FirstSave_SameAsSystemTZ_DoesNothing(t *testing.T) {
	s := newMockPlannerStore()
	s.medications = []store.Medication{dailyMed(1, "Lisinopril", "08:00", "flexible")}
	svc := NewPlannerService(s)

	// When newTZ equals the effective system TZ, no plan should be created.
	localTZ := time.Local.String()
	if localTZ == "" || localTZ == "Local" {
		localTZ = "UTC"
	}
	if _, err := svc.GenerateIfChanged("", localTZ, time.Now()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(s.plans) != 0 {
		t.Fatalf("expected no plans when first-save TZ matches system TZ, got %d", len(s.plans))
	}
}

func TestGenerateIfChanged_FirstSave_DiffFromSystemTZ_CreatesPlan(t *testing.T) {
	s := newMockPlannerStore()
	s.medications = []store.Medication{dailyMed(1, "Lisinopril", "08:00", "flexible")}
	now := time.Date(2024, 3, 10, 10, 0, 0, 0, time.UTC)
	s.intakes[1] = []store.IntakeLog{takenIntake(1, now.Add(-2*time.Hour))}

	localTZ := time.Local.String()
	if localTZ == "" || localTZ == "Local" {
		// When the system timezone has no IANA name, plan generation is skipped
		// to avoid computing transition steps from the wrong baseline offset.
		svc := NewPlannerService(s)
		if _, err := svc.GenerateIfChanged("", "Asia/Tokyo", now); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(s.plans) != 0 {
			t.Fatalf("expected 0 plans when system TZ is unresolvable, got %d", len(s.plans))
		}
		return
	}
	// Pick a destination TZ that is guaranteed to differ from the system TZ.
	newTZ := "Asia/Tokyo"
	if localTZ == "Asia/Tokyo" {
		newTZ = "America/New_York"
	}

	svc := NewPlannerService(s)
	if _, err := svc.GenerateIfChanged("", newTZ, now); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(s.plans) != 1 {
		t.Fatalf("expected 1 plan for first-save when newTZ differs from system TZ, got %d", len(s.plans))
	}
	if s.plans[0].OldTZ != localTZ {
		t.Errorf("expected OldTZ=%q (system TZ), got %q", localTZ, s.plans[0].OldTZ)
	}
}

func TestCancelActivePlan_NoPlan(t *testing.T) {
	s := newMockPlannerStore()
	svc := NewPlannerService(s)
	// Should not return error when there is no active plan.
	if err := svc.CancelActivePlan("test"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCancelActivePlan_CancelsExisting(t *testing.T) {
	s := newMockPlannerStore()
	plan := &store.TZTransitionPlan{
		OldTZ:    "UTC",
		NewTZ:    "Asia/Tokyo",
		Status:   "NOTIFIED",
		PlanHash: "abc",
	}
	s.plans = append(s.plans, plan)
	plan.ID = 1
	s.nextPlanID = 2

	svc := NewPlannerService(s)
	if err := svc.CancelActivePlan("user_request"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s.plans[0].Status != "CANCELLED" {
		t.Fatalf("expected CANCELLED, got %q", s.plans[0].Status)
	}
}
