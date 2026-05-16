package server

import (
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// testTZPlannerStore adapts *store.Repos to tzreschedule.PlannerStore for
// tests that wire a full tzupdate.Service. It delegates List /
// ListIntakeHistory / CountFuturePendingTZStepIntakesForPlan to *medication.Repo
// and the plan CRUD to *tz.Repo.
type testTZPlannerStore struct {
	s *store.Repos
}

func (a *testTZPlannerStore) List(showArchived bool) ([]store.Medication, error) {
	return a.s.Medication.List(showArchived)
}
func (a *testTZPlannerStore) ListIntakeHistory(medID int, days int) ([]store.IntakeLog, error) {
	return a.s.Medication.ListIntakeHistory(medID, days)
}
func (a *testTZPlannerStore) GetPlanByHash(hash string) (*store.TZTransitionPlan, error) {
	return a.s.TZ.GetPlanByHash(hash)
}
func (a *testTZPlannerStore) GetLatestActiveOrPendingTransitionPlan() (*store.TZTransitionPlan, error) {
	return a.s.TZ.GetLatestActiveOrPendingTransitionPlan()
}
func (a *testTZPlannerStore) UpdateTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
	return a.s.TZ.UpdateTransitionPlanStatus(id, newStatus, userAction, expectedStatus)
}
func (a *testTZPlannerStore) CountFuturePendingTZStepIntakesForPlan(planID int64, asOf time.Time) (int, error) {
	return a.s.Medication.CountFuturePendingTZStepIntakesForPlan(planID, asOf)
}
func (a *testTZPlannerStore) CreateTransitionPlanWithSteps(plan *store.TZTransitionPlan) (int64, error) {
	return a.s.TZ.CreateTransitionPlanWithSteps(plan)
}
func (a *testTZPlannerStore) DeletePendingPreMaterializedIntakesForPlan(planID int64) error {
	return a.s.Medication.DeletePendingPreMaterializedIntakesForPlan(planID)
}
