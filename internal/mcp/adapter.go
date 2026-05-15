package mcp

import (
	"context"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// storeAdapter aggregates per-domain repos to satisfy the mcp package's
// multi-repo narrow interfaces (HealthDataReader). It is constructed once in
// NewServer from a *store.Repos so the rest of mcp can keep using a single
// `data` handle after the per-domain split. AdminStore and APITokenStore stay
// single-repo (auth) — they are wired to *store.Repos.Auth directly.
type storeAdapter struct {
	s *store.Repos
}

func newStoreAdapter(s *store.Repos) *storeAdapter { return &storeAdapter{s: s} }

func (a *storeAdapter) GetBloodPressureEnabled(ctx context.Context) (bool, error) {
	return a.s.Settings.GetBloodPressureEnabled(ctx)
}
func (a *storeAdapter) GetWeightEnabled(ctx context.Context) (bool, error) {
	return a.s.Settings.GetWeightEnabled(ctx)
}
func (a *storeAdapter) GetMedicationEnabled(ctx context.Context) (bool, error) {
	return a.s.Settings.GetMedicationEnabled(ctx)
}
func (a *storeAdapter) GetWorkoutEnabled(ctx context.Context) (bool, error) {
	return a.s.Settings.GetWorkoutEnabled(ctx)
}
func (a *storeAdapter) GetFoodIntakeEnabled(ctx context.Context) (bool, error) {
	return a.s.Settings.GetFoodIntakeEnabled(ctx)
}
func (a *storeAdapter) GetBloodPressureReadings(ctx context.Context, userID int64, since time.Time) ([]store.BloodPressure, error) {
	return a.s.BP.GetBloodPressureReadings(ctx, userID, since)
}
func (a *storeAdapter) GetWeightLogs(ctx context.Context, userID int64, since time.Time) ([]store.WeightLog, error) {
	return a.s.Weight.GetWeightLogs(ctx, userID, since)
}
func (a *storeAdapter) ListIntakesSince(since time.Time) ([]store.IntakeWithMedication, error) {
	return a.s.Medication.ListIntakesSince(since)
}
func (a *storeAdapter) GetWorkoutHistory(userID int64, limit int) ([]store.WorkoutSession, error) {
	return a.s.Workout.GetWorkoutHistory(userID, limit)
}
func (a *storeAdapter) GetWorkoutGroup(groupID int64) (*store.WorkoutGroup, error) {
	return a.s.Workout.GetWorkoutGroup(groupID)
}
func (a *storeAdapter) GetWorkoutVariant(variantID int64) (*store.WorkoutVariant, error) {
	return a.s.Workout.GetWorkoutVariant(variantID)
}
func (a *storeAdapter) GetExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error) {
	return a.s.Workout.GetExerciseLogs(sessionID)
}
func (a *storeAdapter) GetSleepLogs(ctx context.Context, userID int64, since time.Time) ([]store.SleepLog, error) {
	return a.s.Vitals.GetSleepLogs(ctx, userID, since)
}
func (a *storeAdapter) GetFoodLogs(ctx context.Context, userID int64, date time.Time, days int) ([]store.FoodLog, error) {
	return a.s.Food.GetFoodLogs(ctx, userID, date, days)
}
func (a *storeAdapter) GetFoodTargets(ctx context.Context) (store.FoodTargets, error) {
	return a.s.Food.GetFoodTargets(ctx)
}
func (a *storeAdapter) GetDayStats(ctx context.Context, userID int64, since time.Time) ([]store.DayStat, error) {
	return a.s.Vitals.GetDayStats(ctx, userID, since)
}
func (a *storeAdapter) GetVitalsHeart(ctx context.Context, userID int64, start, end time.Time) ([]store.VitalsHeartLog, error) {
	return a.s.Vitals.GetVitalsHeart(ctx, userID, start, end)
}
func (a *storeAdapter) GetVitalsSpO2(ctx context.Context, userID int64, start, end time.Time) ([]store.VitalsSpO2Log, error) {
	return a.s.Vitals.GetVitalsSpO2(ctx, userID, start, end)
}
func (a *storeAdapter) GetVitalsStress(ctx context.Context, userID int64, start, end time.Time) ([]store.VitalsStressLog, error) {
	return a.s.Vitals.GetVitalsStress(ctx, userID, start, end)
}
func (a *storeAdapter) ListMiBandWorkouts(ctx context.Context, userID int64, limit int) ([]store.MiBandWorkout, error) {
	return a.s.Workout.ListMiBandWorkouts(ctx, userID, limit)
}
func (a *storeAdapter) ListDiaryNotes(ctx context.Context, userID int64, since, until time.Time, limit int, beforeID int64) ([]store.DiaryNote, error) {
	return a.s.Diary.List(ctx, userID, since, until, limit, beforeID)
}
func (a *storeAdapter) List(showArchived bool) ([]store.Medication, error) {
	return a.s.Medication.List(showArchived)
}
