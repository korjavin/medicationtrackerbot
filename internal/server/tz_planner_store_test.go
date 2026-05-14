package server

import (
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// testTZPlannerStore adapts *store.Repos to tzreschedule.PlannerStore for
// tests that wire a full tzupdate.Service. It delegates ListMedications /
// GetIntakeHistory to *medication.Repo and the plan CRUD to *tz.Repo.
type testTZPlannerStore struct {
	s *store.Repos
}

func (a *testTZPlannerStore) ListMedications(showArchived bool) ([]store.Medication, error) {
	return a.s.Medication.ListMedications(showArchived)
}
func (a *testTZPlannerStore) GetIntakeHistory(medID int, days int) ([]store.IntakeLog, error) {
	return a.s.Medication.GetIntakeHistory(medID, days)
}
func (a *testTZPlannerStore) GetPlanByHash(hash string) (*store.TZTransitionPlan, error) {
	return a.s.TZ.GetPlanByHash(hash)
}
func (a *testTZPlannerStore) GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error) {
	return a.s.TZ.GetLatestActiveOrPendingTZTransitionPlan()
}
func (a *testTZPlannerStore) UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
	return a.s.TZ.UpdateTZTransitionPlanStatus(id, newStatus, userAction, expectedStatus)
}
func (a *testTZPlannerStore) GetPendingStepsForPlan(planID int64) ([]store.TZTransitionStep, error) {
	return a.s.TZ.GetPendingStepsForPlan(planID)
}
func (a *testTZPlannerStore) CreateTZTransitionPlanWithSteps(plan *store.TZTransitionPlan, steps []store.TZTransitionStep) (int64, error) {
	return a.s.TZ.CreateTZTransitionPlanWithSteps(plan, steps)
}
