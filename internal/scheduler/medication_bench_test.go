package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

type mockMedStoreBench struct {
	store.Store
	getIntakesBySchedCalls int
}

func (m *mockMedStoreBench) GetMedicationEnabled(ctx context.Context) (bool, error) { return true, nil }
func (m *mockMedStoreBench) GetCurrentTimezone() (string, error)                    { return "UTC", nil }
func (m *mockMedStoreBench) GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error) {
	return nil, nil
}
func (m *mockMedStoreBench) ListMedications(archived bool) ([]store.Medication, error) {
	meds := make([]store.Medication, 1000)
	for i := range meds {
		meds[i] = store.Medication{
			ID:        int64(i + 1),
			Schedule:  `{"type":"daily","times":["08:00"]}`,
			CreatedAt: time.Now().Add(-24 * time.Hour),
		}
	}
	return meds, nil
}

func (m *mockMedStoreBench) BatchGetIntakesBySchedule(schedules []store.MedicationSchedule) (map[store.MedicationSchedule]*store.IntakeLog, error) {
	m.getIntakesBySchedCalls++
	return make(map[store.MedicationSchedule]*store.IntakeLog), nil
}
func (m *mockMedStoreBench) GetIntakeBySchedule(medID int64, scheduledAt time.Time) (*store.IntakeLog, error) {
	m.getIntakesBySchedCalls++
	return nil, nil // Not found
}
func (m *mockMedStoreBench) CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error) {
	return int64(medID), nil
}
func (m *mockMedStoreBench) GetPendingStepsForPlan(planID int64) ([]store.TZTransitionStep, error) {
	return nil, nil
}
func (m *mockMedStoreBench) MarkStepConsumed(stepID int64, consumedAt time.Time) error { return nil }
func (m *mockMedStoreBench) UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
	return nil
}
func (m *mockMedStoreBench) AddIntakeReminder(intakeID int64, msgID int) error { return nil }
func (m *mockMedStoreBench) GetPendingIntakes() ([]store.IntakeLog, error)     { return nil, nil }
func (m *mockMedStoreBench) GetMedication(id int64) (*store.Medication, error) { return nil, nil }
func (m *mockMedStoreBench) GetMedicationsLowOnStock(days int) ([]store.Medication, error) {
	return nil, nil
}
func (m *mockMedStoreBench) GetDaysOfStockRemaining(med *store.Medication) *float64 { return nil }
func (m *mockMedStoreBench) SnoozeIntake(id int64, snoozeUntil time.Time) error     { return nil }

func BenchmarkMedicationScheduler(b *testing.B) {
	mockStore := &mockMedStoreBench{}
	checker := &MedicationChecker{
		store: mockStore,
		now:   func() time.Time { return time.Date(2025, 1, 1, 8, 5, 0, 0, time.UTC) },
	}
	checker.allowedUserID = 1

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		mockStore.getIntakesBySchedCalls = 0
		checker.Check(context.Background())
	}
	b.ReportMetric(float64(mockStore.getIntakesBySchedCalls)/float64(b.N), "queries/op")
}
