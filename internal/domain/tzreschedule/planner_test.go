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

func (m *mockPlannerStore) ListMedications(showArchived bool) ([]store.Medication, error) {
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

func (m *mockPlannerStore) GetIntakeHistory(medID int, days int) ([]store.IntakeLog, error) {
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

func (m *mockPlannerStore) GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error) {
	for i := len(m.plans) - 1; i >= 0; i-- {
		p := m.plans[i]
		if p.Status == "PENDING_APPROVAL" || p.Status == "NOTIFIED" || p.Status == "APPROVED" {
			return p, nil
		}
	}
	return nil, nil
}

func (m *mockPlannerStore) UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
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

func (m *mockPlannerStore) CreateTZTransitionPlan(plan *store.TZTransitionPlan) (int64, error) {
	plan.ID = m.nextPlanID
	plan.CreatedAt = time.Now()
	m.nextPlanID++
	m.plans = append(m.plans, plan)
	return plan.ID, nil
}

func (m *mockPlannerStore) CreateTZTransitionSteps(steps []store.TZTransitionStep) error {
	m.steps = append(m.steps, steps...)
	return nil
}

// --- helpers ---

func dailyMed(id int64, name, times string, policy string) store.Medication {
	return store.Medication{
		ID:           id,
		Name:         name,
		Schedule:     `{"type":"daily","times":["` + times + `"]}`,
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
	if err := svc.GenerateIfChanged("Europe/Berlin", "Europe/Berlin", time.Now()); err != nil {
		t.Fatalf("unexpected error: %v", err)
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
	if err := svc.GenerateIfChanged("UTC", "Asia/Tokyo", time.Now()); err != nil {
		t.Fatalf("unexpected error: %v", err)
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
	if err := svc.GenerateIfChanged("UTC", "Asia/Tokyo", now); err != nil {
		t.Fatalf("unexpected error: %v", err)
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
	if err := svc.GenerateIfChanged("UTC", "Asia/Tokyo", now); err != nil {
		t.Fatalf("first call error: %v", err)
	}
	if len(s.plans) != 1 {
		t.Fatalf("expected 1 plan after first call, got %d", len(s.plans))
	}

	// Second call with identical inputs within 24h — should be deduped.
	if err := svc.GenerateIfChanged("UTC", "Asia/Tokyo", now.Add(1*time.Minute)); err != nil {
		t.Fatalf("second call error: %v", err)
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
	if err := svc.GenerateIfChanged("UTC", "Asia/Tokyo", now); err != nil {
		t.Fatalf("first call: %v", err)
	}
	firstPlanStatus := s.plans[0].Status

	if firstPlanStatus != "PENDING_APPROVAL" {
		t.Fatalf("expected first plan PENDING_APPROVAL, got %q", firstPlanStatus)
	}

	// Simulate second TZ change 2h later with different destination — different hash.
	now2 := now.Add(2 * time.Hour)
	if err := svc.GenerateIfChanged("UTC", "America/New_York", now2); err != nil {
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

func TestGenerateIfChanged_LastIntakeLoadedIntoInputs(t *testing.T) {
	s := newMockPlannerStore()
	s.medications = []store.Medication{dailyMed(1, "Atorvastatin", "21:00", "strict")}
	anchor := time.Date(2024, 3, 10, 19, 0, 0, 0, time.UTC)
	s.intakes[1] = []store.IntakeLog{takenIntake(1, anchor)}

	svc := NewPlannerService(s)
	now := anchor.Add(2 * time.Hour)
	if err := svc.GenerateIfChanged("UTC", "Asia/Tokyo", now); err != nil {
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
