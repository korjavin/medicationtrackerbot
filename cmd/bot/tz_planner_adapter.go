package main

import (
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// tzPlannerStore adapts *store.Repos to tzreschedule.PlannerStore. The
// interface spans medication.Repo (List, ListIntakeHistory,
// CountFuturePendingTZStepIntakesForPlan) and tz.Repo (plan CRUD) so we need
// a small aggregator at the composition root.
type tzPlannerStore struct {
	s *store.Repos
}

func newTZPlannerStore(s *store.Repos) *tzPlannerStore { return &tzPlannerStore{s: s} }

func (a *tzPlannerStore) List(showArchived bool) ([]store.Medication, error) {
	return a.s.Medication.List(showArchived)
}
func (a *tzPlannerStore) ListIntakeHistory(medID int, days int) ([]store.IntakeLog, error) {
	return a.s.Medication.ListIntakeHistory(medID, days)
}
func (a *tzPlannerStore) GetPlanByHash(hash string) (*store.TZTransitionPlan, error) {
	return a.s.TZ.GetPlanByHash(hash)
}
func (a *tzPlannerStore) GetLatestActiveOrPendingTransitionPlan() (*store.TZTransitionPlan, error) {
	return a.s.TZ.GetLatestActiveOrPendingTransitionPlan()
}
func (a *tzPlannerStore) UpdateTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
	return a.s.TZ.UpdateTransitionPlanStatus(id, newStatus, userAction, expectedStatus)
}
func (a *tzPlannerStore) CountFuturePendingTZStepIntakesForPlan(planID int64, asOf time.Time) (int, error) {
	return a.s.Medication.CountFuturePendingTZStepIntakesForPlan(planID, asOf)
}
func (a *tzPlannerStore) CreateTransitionPlanWithSteps(plan *store.TZTransitionPlan) (int64, error) {
	return a.s.TZ.CreateTransitionPlanWithSteps(plan)
}
func (a *tzPlannerStore) DeletePendingPreMaterializedIntakesForPlan(planID int64) error {
	return a.s.Medication.DeletePendingPreMaterializedIntakesForPlan(planID)
}
