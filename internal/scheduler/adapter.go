package scheduler

import (
	"context"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/korjavin/medicationtrackerbot/internal/store/bp"
	"github.com/korjavin/medicationtrackerbot/internal/store/medication"
	"github.com/korjavin/medicationtrackerbot/internal/store/settings"
	storetz "github.com/korjavin/medicationtrackerbot/internal/store/tz"
	"github.com/korjavin/medicationtrackerbot/internal/store/weight"
	"github.com/korjavin/medicationtrackerbot/internal/store/workout"
)

// storeAdapter is a thin per-repo aggregator that satisfies every narrow
// scheduler store interface (MedicationStore, WorkoutStore, BPReminderStore,
// WeightReminderStore, TZPlanNotifierStore). Each method delegates to the
// correct per-domain repository.
//
// This adapter exists so the scheduler keeps using its existing
// per-checker narrow interfaces after the *store.Store god-object was
// decomposed into per-domain repos (Task 13 of the per-domain split).
// It is constructed once in scheduler.New from a *store.Repos and reused
// by every checker.
type storeAdapter struct {
	med      *medication.Repo
	bp       *bp.Repo
	weight   *weight.Repo
	workout  *workout.Repo
	tz       *storetz.Repo
	settings *settings.Repo
}

func newStoreAdapter(s *store.Repos) *storeAdapter {
	return &storeAdapter{
		med:      s.Medication,
		bp:       s.BP,
		weight:   s.Weight,
		workout:  s.Workout,
		tz:       s.TZ,
		settings: s.Settings,
	}
}

// --- Medication (medication.Repo) ---

func (a *storeAdapter) List(archived bool) ([]store.Medication, error) {
	return a.med.List(archived)
}
func (a *storeAdapter) GetIntakeBySchedule(medID int64, scheduledAt time.Time) (*store.IntakeLog, error) {
	return a.med.GetIntakeBySchedule(medID, scheduledAt)
}
func (a *storeAdapter) BatchGetIntakesBySchedule(schedules []store.MedicationSchedule) (map[store.MedicationSchedule]*store.IntakeLog, error) {
	return a.med.BatchGetIntakesBySchedule(schedules)
}
func (a *storeAdapter) CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error) {
	return a.med.CreateIntake(medID, userID, scheduledAt)
}
func (a *storeAdapter) CreateIntakeReminder(intakeID int64, msgID int) error {
	return a.med.CreateIntakeReminder(intakeID, msgID)
}
func (a *storeAdapter) ListPendingIntakes() ([]store.IntakeLog, error) {
	return a.med.ListPendingIntakes()
}
func (a *storeAdapter) ListPendingIntakesForMedication(medID int64) ([]store.IntakeLog, error) {
	return a.med.ListPendingIntakesForMedication(medID)
}
func (a *storeAdapter) Get(id int64) (*store.Medication, error) {
	return a.med.Get(id)
}
func (a *storeAdapter) ListLowOnStock(days int) ([]store.Medication, error) {
	return a.med.ListLowOnStock(days)
}
func (a *storeAdapter) GetDaysOfStockRemaining(med *store.Medication) *float64 {
	return a.med.GetDaysOfStockRemaining(med)
}
func (a *storeAdapter) SnoozeIntake(id int64, snoozeUntil time.Time) error {
	return a.med.SnoozeIntake(id, snoozeUntil)
}

// --- Settings (settings.Repo) ---

func (a *storeAdapter) GetMedicationEnabled(ctx context.Context) (bool, error) {
	return a.settings.GetMedicationEnabled(ctx)
}
func (a *storeAdapter) GetWorkoutEnabled(ctx context.Context) (bool, error) {
	return a.settings.GetWorkoutEnabled(ctx)
}
func (a *storeAdapter) GetBloodPressureEnabled(ctx context.Context) (bool, error) {
	return a.settings.GetBloodPressureEnabled(ctx)
}
func (a *storeAdapter) GetWeightEnabled(ctx context.Context) (bool, error) {
	return a.settings.GetWeightEnabled(ctx)
}

// --- TZ (tz.Repo) ---

func (a *storeAdapter) GetCurrent() (string, error) {
	return a.tz.GetCurrent()
}
func (a *storeAdapter) GetLatestActiveOrPendingTransitionPlan() (*store.TZTransitionPlan, error) {
	return a.tz.GetLatestActiveOrPendingTransitionPlan()
}
func (a *storeAdapter) GetLatestCompletedTransitionPlan() (*store.TZTransitionPlan, error) {
	return a.tz.GetLatestCompletedTransitionPlan()
}
func (a *storeAdapter) ListPendingStepsForPlan(planID int64) ([]store.TZTransitionStep, error) {
	return a.tz.ListPendingStepsForPlan(planID)
}
func (a *storeAdapter) GetLatestConsumedStepTimePerMed(planID int64) (map[int64]time.Time, error) {
	return a.tz.GetLatestConsumedStepTimePerMed(planID)
}
func (a *storeAdapter) MarkStepConsumed(stepID int64, consumedAt time.Time) error {
	return a.tz.MarkStepConsumed(stepID, consumedAt)
}
func (a *storeAdapter) UpdateTransitionPlanStatus(id int64, newStatus, userAction, expectedStatus string) error {
	return a.tz.UpdateTransitionPlanStatus(id, newStatus, userAction, expectedStatus)
}
func (a *storeAdapter) MarkPlanNotified(id int64) (bool, error) {
	return a.tz.MarkPlanNotified(id)
}
func (a *storeAdapter) ResetPlanToPending(id int64) error {
	return a.tz.ResetPlanToPending(id)
}
func (a *storeAdapter) SetTransitionPlanApproved(id int64, approvedAt time.Time) (bool, error) {
	return a.tz.SetTransitionPlanApproved(id, approvedAt)
}

// --- Workout (workout.Repo) ---

func (a *storeAdapter) ListHistory(userID int64, limit int) ([]store.WorkoutSession, error) {
	return a.workout.ListHistory(userID, limit)
}
func (a *storeAdapter) ListGroups(userID int64, activeOnly bool) ([]store.WorkoutGroup, error) {
	return a.workout.ListGroups(userID, activeOnly)
}
func (a *storeAdapter) GetRotationState(groupID int64) (*store.WorkoutRotationState, error) {
	return a.workout.GetRotationState(groupID)
}
func (a *storeAdapter) ListVariantsByGroup(groupID int64) ([]store.WorkoutVariant, error) {
	return a.workout.ListVariantsByGroup(groupID)
}
func (a *storeAdapter) InitializeRotation(groupID, variantID int64) error {
	return a.workout.InitializeRotation(groupID, variantID)
}
func (a *storeAdapter) GetSessionByGroupAndDate(groupID int64, date time.Time) (*store.WorkoutSession, error) {
	return a.workout.GetSessionByGroupAndDate(groupID, date)
}
func (a *storeAdapter) CreateSession(groupID, variantID, userID int64, date time.Time, scheduledTime string) (*store.WorkoutSession, error) {
	return a.workout.CreateSession(groupID, variantID, userID, date, scheduledTime)
}
func (a *storeAdapter) GetGroup(groupID int64) (*store.WorkoutGroup, error) {
	return a.workout.GetGroup(groupID)
}
func (a *storeAdapter) UpdateSessionStatus(sessionID int64, status string) error {
	return a.workout.UpdateSessionStatus(sessionID, status)
}
func (a *storeAdapter) UpdateSessionNotes(sessionID int64, notes string) error {
	return a.workout.UpdateSessionNotes(sessionID, notes)
}
func (a *storeAdapter) ClearSnooze(sessionID int64) error {
	return a.workout.ClearSnooze(sessionID)
}
func (a *storeAdapter) GetVariant(variantID int64) (*store.WorkoutVariant, error) {
	return a.workout.GetVariant(variantID)
}
func (a *storeAdapter) ListExercisesByVariant(variantID int64) ([]store.WorkoutExercise, error) {
	return a.workout.ListExercisesByVariant(variantID)
}
func (a *storeAdapter) SetSessionNotificationMessageID(sessionID int64, msgID int) error {
	return a.workout.SetSessionNotificationMessageID(sessionID, msgID)
}
func (a *storeAdapter) UpdateSessionVariant(sessionID int64, variantID int64) error {
	return a.workout.UpdateSessionVariant(sessionID, variantID)
}
func (a *storeAdapter) GetLatestSessionScheduledDate(groupID, userID int64) (time.Time, bool, error) {
	return a.workout.GetLatestSessionScheduledDate(groupID, userID)
}
func (a *storeAdapter) ListPendingAdHocSessions(userID int64, before time.Time) ([]store.WorkoutSession, error) {
	return a.workout.ListPendingAdHocSessions(userID, before)
}
func (a *storeAdapter) ListNotifiedAdHocSessions(userID int64) ([]store.WorkoutSession, error) {
	return a.workout.ListNotifiedAdHocSessions(userID)
}
func (a *storeAdapter) ListExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error) {
	return a.workout.ListExerciseLogs(sessionID)
}

// --- workoutsvc.WorkoutStore extra methods (used by workout svc inside checker) ---
//
// workoutsvc.New now also requires a workoutsvc.TZStore. We satisfy both
// interfaces from this adapter.

func (a *storeAdapter) GetSession(id int64) (*store.WorkoutSession, error) {
	return a.workout.GetSession(id)
}
func (a *storeAdapter) StartSession(id int64) error                                { return a.workout.StartSession(id) }
func (a *storeAdapter) SnoozeSession(id int64, dur time.Duration) error            { return a.workout.SnoozeSession(id, dur) }
func (a *storeAdapter) SkipSession(id int64) error                                 { return a.workout.SkipSession(id) }
func (a *storeAdapter) CompleteSession(id int64) error                             { return a.workout.CompleteSession(id) }
func (a *storeAdapter) AdvanceRotation(groupID int64) error                        { return a.workout.AdvanceRotation(groupID) }
func (a *storeAdapter) CreateAdHocSession(userID int64, d time.Time, t string) (*store.WorkoutSession, error) {
	return a.workout.CreateAdHocSession(userID, d, t)
}
func (a *storeAdapter) CreatePlannedAdHocSession(userID int64, d time.Time, t string) (*store.WorkoutSession, error) {
	return a.workout.CreatePlannedAdHocSession(userID, d, t)
}
func (a *storeAdapter) LogExerciseWithSource(sessionID, exerciseID int64, name string, sets, reps *int, weightKg *float64, status, notes, source string) (int64, error) {
	return a.workout.LogExerciseWithSource(sessionID, exerciseID, name, sets, reps, weightKg, status, notes, source)
}
func (a *storeAdapter) DeleteSession(id int64) error { return a.workout.DeleteSession(id) }

// --- BP (bp.Repo) ---

func (a *storeAdapter) ListUsersForReminders() ([]int64, error) {
	return a.bp.ListUsersForReminders()
}
func (a *storeAdapter) GetReminderState(userID int64) (*store.BPReminderState, error) {
	return a.bp.GetReminderState(userID)
}
func (a *storeAdapter) BatchGetReminderStates(ctx context.Context, userIDs []int64) (map[int64]*store.BPReminderState, error) {
	return a.bp.BatchGetReminderStates(ctx, userIDs)
}
func (a *storeAdapter) GetLastReading(ctx context.Context, userID int64) (*store.BloodPressure, error) {
	return a.bp.GetLastReading(ctx, userID)
}
func (a *storeAdapter) BatchGetLastReadings(ctx context.Context, userIDs []int64) (map[int64]*store.BloodPressure, error) {
	return a.bp.BatchGetLastReadings(ctx, userIDs)
}
func (a *storeAdapter) CalculatePreferredReminderHour(ctx context.Context, userID int64) (int, error) {
	return a.bp.CalculatePreferredReminderHour(ctx, userID)
}
func (a *storeAdapter) UpdatePreferredReminderHour(userID int64, hour int) error {
	return a.bp.UpdatePreferredReminderHour(userID, hour)
}
func (a *storeAdapter) GetDominantCategory(ctx context.Context, userID int64) (string, error) {
	return a.bp.GetDominantCategory(ctx, userID)
}
func (a *storeAdapter) UpdateReminderNotificationSent(userID int64, messageID *int) error {
	return a.bp.UpdateReminderNotificationSent(userID, messageID)
}

// --- Weight (weight.Repo) ---
//
// Adapter method names keep the "Weight" disambiguator so the scheduler's
// WeightReminderStore can coexist with BPReminderStore on this single struct.
// Each method bridges to the renamed weight.Repo method.

func (a *storeAdapter) GetUsersForWeightReminders() ([]int64, error) {
	return a.weight.ListUsersForReminders()
}
func (a *storeAdapter) GetWeightReminderState(userID int64) (*store.WeightReminderState, error) {
	return a.weight.GetReminderState(userID)
}
func (a *storeAdapter) GetWeightReminderStates(ctx context.Context) (map[int64]*store.WeightReminderState, error) {
	return a.weight.ListReminderStates(ctx)
}
func (a *storeAdapter) GetLastWeightLog(ctx context.Context, userID int64) (*store.WeightLog, error) {
	return a.weight.GetLastLog(ctx, userID)
}
func (a *storeAdapter) BatchGetLastWeightLogs(ctx context.Context, userIDs []int64) (map[int64]*store.WeightLog, error) {
	return a.weight.BatchGetLastLogs(ctx, userIDs)
}
func (a *storeAdapter) CalculatePreferredWeightReminderHour(ctx context.Context, userID int64) (int, error) {
	return a.weight.CalculatePreferredReminderHour(ctx, userID)
}
func (a *storeAdapter) UpdatePreferredWeightReminderHour(userID int64, hour int) error {
	return a.weight.UpdatePreferredReminderHour(userID, hour)
}
func (a *storeAdapter) UpdateWeightReminderNotificationSent(userID int64, messageID *int) error {
	return a.weight.UpdateReminderNotificationSent(userID, messageID)
}
