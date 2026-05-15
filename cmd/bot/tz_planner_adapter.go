package main

import (
	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// tzPlannerStore adapts *store.Repos to tzreschedule.PlannerStore. The
// interface spans medication.Repo (List, ListIntakeHistory) and
// tz.Repo (plan CRUD) so we need a small aggregator at the composition root.
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
func (a *tzPlannerStore) GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error) {
	return a.s.TZ.GetLatestActiveOrPendingTZTransitionPlan()
}
func (a *tzPlannerStore) UpdateTZTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
	return a.s.TZ.UpdateTZTransitionPlanStatus(id, newStatus, userAction, expectedStatus)
}
func (a *tzPlannerStore) GetPendingStepsForPlan(planID int64) ([]store.TZTransitionStep, error) {
	return a.s.TZ.GetPendingStepsForPlan(planID)
}
func (a *tzPlannerStore) CreateTZTransitionPlanWithSteps(plan *store.TZTransitionPlan, steps []store.TZTransitionStep) (int64, error) {
	return a.s.TZ.CreateTZTransitionPlanWithSteps(plan, steps)
}
