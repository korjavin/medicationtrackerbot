package bot

import (
	"context"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
	"github.com/korjavin/medicationtrackerbot/internal/store/bp"
	"github.com/korjavin/medicationtrackerbot/internal/store/food"
	"github.com/korjavin/medicationtrackerbot/internal/store/medication"
	"github.com/korjavin/medicationtrackerbot/internal/store/settings"
	storetz "github.com/korjavin/medicationtrackerbot/internal/store/tz"
	"github.com/korjavin/medicationtrackerbot/internal/store/vitals"
	"github.com/korjavin/medicationtrackerbot/internal/store/weight"
	"github.com/korjavin/medicationtrackerbot/internal/store/workout"
)

// storeAdapter aggregates per-domain repos to satisfy the bot's multi-repo
// narrow interfaces (MedicationStore, BloodPressureStore, WeightStore,
// WorkoutStore, FoodStore, ImportStore, ActivityLogStore, ReminderStore,
// TimezoneStore). Each method delegates to the correct per-domain repo.
//
// This adapter is constructed once in bot.New from a *store.Repos and reused
// by all bot fields that need a multi-repo handle. It exists so the bot keeps
// using its narrow interfaces after the *store.Store god-object was
// decomposed into per-domain repos (Task 13 of the per-domain split).
type storeAdapter struct {
	med      *medication.Repo
	bp       *bp.Repo
	weight   *weight.Repo
	food     *food.Repo
	workout  *workout.Repo
	vitals   *vitals.Repo
	tz       *storetz.Repo
	settings *settings.Repo
}

func newStoreAdapter(s *store.Repos) *storeAdapter {
	return &storeAdapter{
		med:      s.Medication,
		bp:       s.BP,
		weight:   s.Weight,
		food:     s.Food,
		workout:  s.Workout,
		vitals:   s.Vitals,
		tz:       s.TZ,
		settings: s.Settings,
	}
}

// --- Settings (feature flags) ---

func (a *storeAdapter) GetMedicationEnabled(ctx context.Context) (bool, error) {
	return a.settings.GetMedicationEnabled(ctx)
}
func (a *storeAdapter) GetBloodPressureEnabled(ctx context.Context) (bool, error) {
	return a.settings.GetBloodPressureEnabled(ctx)
}
func (a *storeAdapter) GetWeightEnabled(ctx context.Context) (bool, error) {
	return a.settings.GetWeightEnabled(ctx)
}
func (a *storeAdapter) GetWorkoutEnabled(ctx context.Context) (bool, error) {
	return a.settings.GetWorkoutEnabled(ctx)
}
func (a *storeAdapter) GetFoodIntakeEnabled(ctx context.Context) (bool, error) {
	return a.settings.GetFoodIntakeEnabled(ctx)
}
func (a *storeAdapter) GetLastDownload() (time.Time, error) {
	return a.settings.GetLastDownload()
}
func (a *storeAdapter) UpdateLastDownload(t time.Time) error {
	return a.settings.UpdateLastDownload(t)
}

// --- Medication ---

func (a *storeAdapter) ListMedications(showArchived bool) ([]store.Medication, error) {
	return a.med.ListMedications(showArchived)
}
func (a *storeAdapter) GetMedication(id int64) (*store.Medication, error) {
	return a.med.GetMedication(id)
}
func (a *storeAdapter) CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error) {
	return a.med.CreateIntake(medID, userID, scheduledAt)
}
func (a *storeAdapter) AddIntakeReminder(intakeID int64, msgID int) error {
	return a.med.AddIntakeReminder(intakeID, msgID)
}
func (a *storeAdapter) GetIntake(id int64) (*store.IntakeLog, error) {
	return a.med.GetIntake(id)
}
func (a *storeAdapter) GetIntakeBySchedule(medID int64, scheduledAt time.Time) (*store.IntakeLog, error) {
	return a.med.GetIntakeBySchedule(medID, scheduledAt)
}
func (a *storeAdapter) GetMedicationsLowOnStock(daysThreshold int) ([]store.Medication, error) {
	return a.med.GetMedicationsLowOnStock(daysThreshold)
}
func (a *storeAdapter) GetDaysOfStockRemaining(m *store.Medication) *float64 {
	return a.med.GetDaysOfStockRemaining(m)
}
func (a *storeAdapter) GetIntakesSince(since time.Time) ([]store.IntakeWithMedication, error) {
	return a.med.GetIntakesSince(since)
}

// Also satisfies domain.MedicationService's MedicationStore.

func (a *storeAdapter) GetIntakeReminders(intakeID int64) ([]int, error) {
	return a.med.GetIntakeReminders(intakeID)
}
func (a *storeAdapter) GetBatchIntakeReminders(intakeIDs []int64) (map[int64][]int, error) {
	return a.med.GetBatchIntakeReminders(intakeIDs)
}
func (a *storeAdapter) GetPendingIntakes() ([]store.IntakeLog, error) {
	return a.med.GetPendingIntakes()
}
func (a *storeAdapter) GetPendingIntakesBySchedule(userID int64, scheduledAt time.Time) ([]store.IntakeLog, error) {
	return a.med.GetPendingIntakesBySchedule(userID, scheduledAt)
}
func (a *storeAdapter) ConfirmIntake(id int64, takenAt time.Time) error {
	return a.med.ConfirmIntake(id, takenAt)
}
func (a *storeAdapter) ConfirmIntakesBySchedule(userID int64, scheduledAt time.Time, takenAt time.Time) ([]int64, error) {
	return a.med.ConfirmIntakesBySchedule(userID, scheduledAt, takenAt)
}
func (a *storeAdapter) SkipIntake(id int64) error                  { return a.med.SkipIntake(id) }
func (a *storeAdapter) SnoozeIntake(id int64, t time.Time) error    { return a.med.SnoozeIntake(id, t) }
func (a *storeAdapter) CreateManualIntake(medID, userID int64, takenAt time.Time) (int64, error) {
	return a.med.CreateManualIntake(medID, userID, takenAt)
}
func (a *storeAdapter) DecrementInventory(medID int64, qty int) error {
	return a.med.DecrementInventory(medID, qty)
}
func (a *storeAdapter) UpdateIntake(id int64, takenAt time.Time, status string) error {
	return a.med.UpdateIntake(id, takenAt, status)
}
func (a *storeAdapter) DeleteIntake(id int64) error { return a.med.DeleteIntake(id) }

// --- BP ---

func (a *storeAdapter) CreateBloodPressureReading(ctx context.Context, b *store.BloodPressure) (int64, error) {
	return a.bp.CreateBloodPressureReading(ctx, b)
}
func (a *storeAdapter) GetBloodPressureReadings(ctx context.Context, userID int64, since time.Time) ([]store.BloodPressure, error) {
	return a.bp.GetBloodPressureReadings(ctx, userID, since)
}
func (a *storeAdapter) GetBPGoal() (*store.BPGoal, error)                   { return a.bp.GetBPGoal() }
func (a *storeAdapter) SetBPGoal(s, d int) error                            { return a.bp.SetBPGoal(s, d) }
func (a *storeAdapter) SnoozeBPReminder(userID int64) error                 { return a.bp.SnoozeBPReminder(userID) }
func (a *storeAdapter) DontBugMeBPReminder(userID int64) error              { return a.bp.DontBugMeBPReminder(userID) }

// --- Weight ---

func (a *storeAdapter) GetLastWeightLog(ctx context.Context, userID int64) (*store.WeightLog, error) {
	return a.weight.GetLastWeightLog(ctx, userID)
}
func (a *storeAdapter) CreateWeightLog(ctx context.Context, w *store.WeightLog) (int64, error) {
	return a.weight.CreateWeightLog(ctx, w)
}
func (a *storeAdapter) GetWeightLogs(ctx context.Context, userID int64, since time.Time) ([]store.WeightLog, error) {
	return a.weight.GetWeightLogs(ctx, userID, since)
}
func (a *storeAdapter) GetWeightGoal() (*store.WeightGoal, error) { return a.weight.GetWeightGoal() }
func (a *storeAdapter) SetWeightGoal(w float64, td time.Time) error {
	return a.weight.SetWeightGoal(w, td)
}
func (a *storeAdapter) SnoozeWeightReminder(userID int64) error {
	return a.weight.SnoozeWeightReminder(userID)
}
func (a *storeAdapter) DontBugMeWeightReminder(userID int64) error {
	return a.weight.DontBugMeWeightReminder(userID)
}
func (a *storeAdapter) GetWeightUnitPreference(ctx context.Context) (string, error) {
	return a.weight.GetWeightUnitPreference(ctx)
}
func (a *storeAdapter) SetWeightUnitPreference(ctx context.Context, unit string) error {
	return a.weight.SetWeightUnitPreference(ctx, unit)
}

// --- Food ---

func (a *storeAdapter) CreateFoodLog(ctx context.Context, f *store.FoodLog) (int64, error) {
	return a.food.CreateFoodLog(ctx, f)
}
func (a *storeAdapter) DeleteFoodLog(ctx context.Context, id, userID int64) error {
	return a.food.DeleteFoodLog(ctx, id, userID)
}

// --- Workout ---

func (a *storeAdapter) GetWorkoutSession(id int64) (*store.WorkoutSession, error) {
	return a.workout.GetWorkoutSession(id)
}
func (a *storeAdapter) GetWorkoutGroup(groupID int64) (*store.WorkoutGroup, error) {
	return a.workout.GetWorkoutGroup(groupID)
}
func (a *storeAdapter) GetWorkoutVariant(variantID int64) (*store.WorkoutVariant, error) {
	return a.workout.GetWorkoutVariant(variantID)
}
func (a *storeAdapter) ListWorkoutGroups(userID int64, activeOnly bool) ([]store.WorkoutGroup, error) {
	return a.workout.ListWorkoutGroups(userID, activeOnly)
}
func (a *storeAdapter) GetSessionByGroupAndDate(groupID int64, scheduledDate time.Time) (*store.WorkoutSession, error) {
	return a.workout.GetSessionByGroupAndDate(groupID, scheduledDate)
}
func (a *storeAdapter) GetWorkoutHistory(userID int64, limit int) ([]store.WorkoutSession, error) {
	return a.workout.GetWorkoutHistory(userID, limit)
}
func (a *storeAdapter) ListExercisesByVariant(variantID int64) ([]store.WorkoutExercise, error) {
	return a.workout.ListExercisesByVariant(variantID)
}
func (a *storeAdapter) GetWorkoutExercise(id int64) (*store.WorkoutExercise, error) {
	return a.workout.GetWorkoutExercise(id)
}
func (a *storeAdapter) GetExerciseLibraryItem(id int64) (*store.ExerciseLibraryItem, error) {
	return a.workout.GetExerciseLibraryItem(id)
}
func (a *storeAdapter) GetExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error) {
	return a.workout.GetExerciseLogs(sessionID)
}
func (a *storeAdapter) GetAllUniqueExercises(userID int64) ([]store.WorkoutExercise, error) {
	return a.workout.GetAllUniqueExercises(userID)
}
func (a *storeAdapter) LogExercise(sessionID, exerciseID int64, name string, sets, reps *int, weightKg *float64, status, notes string) (int64, error) {
	return a.workout.LogExercise(sessionID, exerciseID, name, sets, reps, weightKg, status, notes)
}
func (a *storeAdapter) LogExerciseWithSource(sessionID, exerciseID int64, name string, sets, reps *int, weightKg *float64, status, notes, source string) (int64, error) {
	return a.workout.LogExerciseWithSource(sessionID, exerciseID, name, sets, reps, weightKg, status, notes, source)
}
func (a *storeAdapter) GetExerciseLogBySessionAndExercise(sessionID, exerciseID int64) (*store.WorkoutExerciseLog, error) {
	return a.workout.GetExerciseLogBySessionAndExercise(sessionID, exerciseID)
}
func (a *storeAdapter) GetExerciseLogBySessionExerciseSource(sessionID, exerciseID int64, source string) (*store.WorkoutExerciseLog, error) {
	return a.workout.GetExerciseLogBySessionExerciseSource(sessionID, exerciseID, source)
}
func (a *storeAdapter) UpdateExerciseLog(id int64, sets, reps *int, weightKg *float64, notes string) error {
	return a.workout.UpdateExerciseLog(id, sets, reps, weightKg, notes)
}
func (a *storeAdapter) UpdateExerciseLogStatus(id int64, status string) error {
	return a.workout.UpdateExerciseLogStatus(id, status)
}

// workoutsvc.WorkoutStore extras
func (a *storeAdapter) StartSession(id int64) error                                { return a.workout.StartSession(id) }
func (a *storeAdapter) ClearSnooze(id int64) error                                 { return a.workout.ClearSnooze(id) }
func (a *storeAdapter) SnoozeSession(id int64, dur time.Duration) error            { return a.workout.SnoozeSession(id, dur) }
func (a *storeAdapter) SkipSession(id int64) error                                 { return a.workout.SkipSession(id) }
func (a *storeAdapter) CompleteSession(id int64) error                             { return a.workout.CompleteSession(id) }
func (a *storeAdapter) AdvanceRotation(groupID int64) error                        { return a.workout.AdvanceRotation(groupID) }
func (a *storeAdapter) CreateAdHocWorkoutSession(userID int64, d time.Time, t string) (*store.WorkoutSession, error) {
	return a.workout.CreateAdHocWorkoutSession(userID, d, t)
}
func (a *storeAdapter) CreatePlannedAdHocSession(userID int64, d time.Time, t string) (*store.WorkoutSession, error) {
	return a.workout.CreatePlannedAdHocSession(userID, d, t)
}
func (a *storeAdapter) DeleteSession(id int64) error { return a.workout.DeleteSession(id) }

// --- Import (vitals + miband) ---

func (a *storeAdapter) ImportSleepLogs(ctx context.Context, userID int64, logs []store.SleepLog) (int, int, error) {
	return a.vitals.ImportSleepLogs(ctx, userID, logs)
}
func (a *storeAdapter) ImportVitals(ctx context.Context, userID int64, heart []store.VitalsHeartLog, spo2 []store.VitalsSpO2Log, stress []store.VitalsStressLog) (int, int, error) {
	return a.vitals.ImportVitals(ctx, userID, heart, spo2, stress)
}
func (a *storeAdapter) ImportDayStats(ctx context.Context, userID int64, stats []store.DayStat) (int, int, error) {
	return a.vitals.ImportDayStats(ctx, userID, stats)
}
func (a *storeAdapter) ImportMiBandWorkouts(ctx context.Context, workouts []store.MiBandWorkout, gpsTracks map[int64][]store.MiBandGPSPoint) (int, int, error) {
	return a.workout.ImportMiBandWorkouts(ctx, workouts, gpsTracks)
}
func (a *storeAdapter) ListMiBandWorkouts(ctx context.Context, userID int64, limit int) ([]store.MiBandWorkout, error) {
	return a.workout.ListMiBandWorkouts(ctx, userID, limit)
}

// --- TZ ---

func (a *storeAdapter) GetCurrentTimezone() (string, error) { return a.tz.GetCurrentTimezone() }
func (a *storeAdapter) RecordTimezone(tz string) error      { return a.tz.RecordTimezone(tz) }

// TZPlanCallbackStore needs:
func (a *storeAdapter) SetTZTransitionPlanApproved(id int64, approvedAt time.Time) (bool, error) {
	return a.tz.SetTZTransitionPlanApproved(id, approvedAt)
}
func (a *storeAdapter) RejectTZTransitionPlanAndRevertTimezone(id int64) (bool, error) {
	return a.tz.RejectTZTransitionPlanAndRevertTimezone(id)
}
func (a *storeAdapter) GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error) {
	return a.tz.GetLatestActiveOrPendingTZTransitionPlan()
}
func (a *storeAdapter) GetPendingStepsForPlan(planID int64) ([]store.TZTransitionStep, error) {
	return a.tz.GetPendingStepsForPlan(planID)
}
func (a *storeAdapter) GetLatestConsumedStepTimePerMed(planID int64) (map[int64]time.Time, error) {
	return a.tz.GetLatestConsumedStepTimePerMed(planID)
}
func (a *storeAdapter) MarkStepConsumed(stepID int64, consumedAt time.Time) error {
	return a.tz.MarkStepConsumed(stepID, consumedAt)
}
