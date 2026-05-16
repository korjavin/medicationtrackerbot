package main

import (
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// tzPlannerStore adapts *store.Repos to tzreschedule.PlannerStore. The
// interface spans medication.Repo (ListMedications, GetIntakeHistory,
// CountFuturePendingTZStepIntakesForPlan) and tz.Repo (plan CRUD) so we need
// a small aggregator at the composition root.
type tzPlannerStore struct {
	s *store.Repos
}

func newTZPlannerStore(s *store.Repos) *tzPlannerStore { return &tzPlannerStore{s: s} }

func (a *tzPlannerStore) ListMedications(showArchived bool) ([]store.Medication, error) {
	return a.s.Medication.ListMedications(showArchived)
}
func (a *tzPlannerStore) GetIntakeHistory(medID int, days int) ([]store.IntakeLog, error) {
	return a.s.Medication.GetIntakeHistory(medID, days)
}
func (a *tzPlannerStore) GetPlanByHash(hash string) (*store.TZTransitionPlan, error) {
	return a.s.TZ.GetPlanByHash(hash)
}
func (a *tzPlannerStore) GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error) {
	return a.s.TZ.GetLatestActiveOrPendingTZTransitionPlan()
}
func (a *tzPlannerStore) UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
	return a.s.TZ.UpdateTZTransitionPlanStatus(id, newStatus, userAction, expectedStatus)
}
func (a *tzPlannerStore) CountFuturePendingTZStepIntakesForPlan(planID int64, asOf time.Time) (int, error) {
	return a.s.Medication.CountFuturePendingTZStepIntakesForPlan(planID, asOf)
}
func (a *tzPlannerStore) CreateTZTransitionPlanWithSteps(plan *store.TZTransitionPlan) (int64, error) {
	return a.s.TZ.CreateTZTransitionPlanWithSteps(plan)
}
func (a *tzPlannerStore) DeletePendingPreMaterializedIntakesForPlan(planID int64) error {
	return a.s.Medication.DeletePendingPreMaterializedIntakesForPlan(planID)
}
