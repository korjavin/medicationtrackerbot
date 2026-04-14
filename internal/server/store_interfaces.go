package server

import (
	"context"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// MedicationStore is the subset of store operations needed for medication handlers.
type MedicationStore interface {
	ListMedications(showArchived bool) ([]store.Medication, error)
	CreateMedication(name, dosage, schedule string, startDate, endDate *time.Time, rxcui, normalizedName string, tzShiftPolicy string) (int64, error)
	SetMedicationSupplement(id int64, supplement bool) error
	GetMedication(id int64) (*store.Medication, error)
	UpdateMedication(id int64, name, dosage, schedule string, archived bool, startDate, endDate *time.Time, rxcui, normalizedName string, inventoryCount *int, tzShiftPolicy string) error
	DeleteMedication(id int64) error
	CanDeleteMedication(id int64) (bool, error)
	CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error)
	CreateManualIntake(medID, userID int64, takenAt time.Time) (int64, error)
	ConfirmIntake(id int64, takenAt time.Time) error
	UpdateIntake(id int64, takenAt time.Time, status string) error
	DeleteIntake(id int64) error
	GetIntake(id int64) (*store.IntakeLog, error)
	GetIntakeBySchedule(medID int64, scheduledAt time.Time) (*store.IntakeLog, error)
	GetIntakeHistory(medID int, days int) ([]store.IntakeLog, error)
	GetIntakeReminders(intakeID int64) ([]int, error)
	GetPendingIntakesForMedication(medID int64) ([]store.IntakeLog, error)
	DecrementInventory(medID int64, qty int) error
	IncrementInventory(medID int64, qty int) error
	AddRestock(medID int64, qty int, note string) error
	GetRestockHistory(medID int64) ([]store.Restock, error)
	GetMedicationsLowOnStock(daysThreshold int) ([]store.Medication, error)
	GetDaysOfStockRemaining(m *store.Medication) *float64
	ConfirmIntakesBySchedule(userID int64, scheduledAt time.Time, takenAt time.Time) ([]int64, error)
	GetPendingIntakesBySchedule(userID int64, scheduledAt time.Time) ([]store.IntakeLog, error)
	GetTakenIntakesBySchedule(userID int64, scheduledAt time.Time) ([]store.IntakeLog, error)
	GetIntakesSince(since time.Time) ([]store.IntakeWithMedication, error)
	GetLastDownload() (time.Time, error)
	UpdateLastDownload(t time.Time) error
	GetPendingIntakes() ([]store.IntakeLog, error)
	SnoozeIntake(id int64, snoozeUntil time.Time) error
	SkipIntake(id int64) error
}

// BloodPressureStore is the subset of store operations needed for BP handlers.
type BloodPressureStore interface {
	CreateBloodPressureReading(ctx context.Context, bp *store.BloodPressure) (int64, error)
	GetBloodPressureReadings(ctx context.Context, userID int64, since time.Time) ([]store.BloodPressure, error)
	DeleteBloodPressureReading(ctx context.Context, id, userID int64) error
	ImportBloodPressureReadings(ctx context.Context, userID int64, readings []store.BloodPressure) error
	GetBPGoal() (*store.BPGoal, error)
	SetBPGoal(targetSystolic, targetDiastolic int) error
	GetBPDailyWeightedStats(ctx context.Context, userID int64) (*store.BPStats, error)
	GetBPReminderState(userID int64) (*store.BPReminderState, error)
	SetBPReminderEnabled(userID int64, enabled bool) error
	SnoozeBPReminder(userID int64) error
	DontBugMeBPReminder(userID int64) error
	ClearBPReminderNotificationMessage(userID int64) error
}

// WeightStore is the subset of store operations needed for weight handlers.
type WeightStore interface {
	CreateWeightLog(ctx context.Context, w *store.WeightLog) (int64, error)
	GetWeightLogs(ctx context.Context, userID int64, since time.Time) ([]store.WeightLog, error)
	GetLastWeightLog(ctx context.Context, userID int64) (*store.WeightLog, error)
	DeleteWeightLog(ctx context.Context, id, userID int64) error
	GetWeightGoal() (*store.WeightGoal, error)
	SetWeightGoal(weight float64, targetDate time.Time) error
	GetHighestWeightRecord(ctx context.Context, userID int64) (*store.WeightLog, error)
	GetWeightReminderState(userID int64) (*store.WeightReminderState, error)
	SetWeightReminderEnabled(userID int64, enabled bool) error
	SnoozeWeightReminder(userID int64) error
	DontBugMeWeightReminder(userID int64) error
	ClearWeightReminderNotificationMessage(userID int64) error
}

// WorkoutStore is the subset of store operations needed for workout handlers.
type WorkoutStore interface {
	ListWorkoutGroups(userID int64, activeOnly bool) ([]store.WorkoutGroup, error)
	CreateWorkoutGroup(name, description string, isRotating bool, userID int64, daysOfWeek string, scheduledTime string, notificationAdvance int) (*store.WorkoutGroup, error)
	UpdateWorkoutGroup(id int64, name, description string, isRotating bool, daysOfWeek string, scheduledTime string, notificationAdvance int, active bool) error
	DeleteWorkoutGroup(id int64) error
	CreateGroupSnapshot(groupID int64, snapshotData, changeReason string) error
	ListVariantsByGroup(groupID int64) ([]store.WorkoutVariant, error)
	CreateWorkoutVariant(groupID int64, name string, rotationOrder *int, description string) (*store.WorkoutVariant, error)
	UpdateWorkoutVariant(id int64, name string, rotationOrder *int, description string) error
	DeleteWorkoutVariant(id int64) error
	ListExercisesByVariant(variantID int64) ([]store.WorkoutExercise, error)
	AddExerciseToVariant(variantID int64, exerciseName string, targetSets, targetRepsMin int, targetRepsMax *int, targetWeightKg *float64, orderIndex int) (*store.WorkoutExercise, error)
	UpdateWorkoutExercise(id int64, exerciseName string, targetSets, targetRepsMin int, targetRepsMax *int, targetWeightKg *float64, orderIndex int) error
	DeleteWorkoutExercise(id int64) error
	GetWorkoutHistory(userID int64, limit int) ([]store.WorkoutSession, error)
	GetWorkoutGroup(groupID int64) (*store.WorkoutGroup, error)
	GetWorkoutVariant(variantID int64) (*store.WorkoutVariant, error)
	GetExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error)
	GetWorkoutSession(id int64) (*store.WorkoutSession, error)
	GetActiveSessions(userID int64, date time.Time) ([]store.WorkoutSession, error)
	GetSnoozedSessions(userID int64) ([]store.WorkoutSession, error)
	GetRotationState(groupID int64) (*store.WorkoutRotationState, error)
	InitializeRotation(groupID, startingVariantID int64) error
	AdvanceRotation(groupID int64) error
	CreateWorkoutSession(groupID, variantID, userID int64, scheduledDate time.Time, scheduledTime string) (*store.WorkoutSession, error)
	CreateAdHocWorkoutSession(userID int64, scheduledDate time.Time, scheduledTime string) (*store.WorkoutSession, error)
	GetSessionByGroupAndDate(groupID int64, scheduledDate time.Time) (*store.WorkoutSession, error)
	UpdateSessionStatus(id int64, status string) error
	StartSession(id int64) error
	SkipSession(id int64) error
	PreSkipSession(id int64) error
	CancelPreSkip(id int64) error
	DeleteSession(id int64) error
	SnoozeSession(id int64, snoozeDuration time.Duration) error
	ClearSnooze(id int64) error
	LogExercise(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes string) (int64, error)
	UpdateExerciseLog(id int64, setsCompleted, repsCompleted *int, weightKg *float64, notes string) error
	DeleteExerciseLog(id int64) error
	GetExerciseStats(userID int64) ([]store.ExerciseStat, error)
	GetAllUniqueExercises(userID int64) ([]store.WorkoutExercise, error)
	ListExerciseLibrary(userID int64) ([]store.ExerciseLibraryItem, error)
	CreateExerciseLibraryItem(userID int64, name string, sets, repsMin int, repsMax *int, weightKg *float64, notes string) (*store.ExerciseLibraryItem, error)
	UpdateExerciseLibraryItem(id int64, name string, sets, repsMin int, repsMax *int, weightKg *float64, notes string) error
	DeleteExerciseLibraryItem(id int64) error
	GetExerciseLogByID(id int64) (*store.WorkoutExerciseLog, error)
	PropagateExerciseToSchedule(sessionID, exerciseID int64, sets *int, reps *int, weight *float64) error
}

// FoodStore is the subset of store operations needed for food handlers.
type FoodStore interface {
	GetFoodIntakeEnabled(ctx context.Context) (bool, error)
	SetFoodIntakeEnabled(ctx context.Context, enabled bool) error
	CreateFoodLog(ctx context.Context, f *store.FoodLog) (int64, error)
	GetFoodLogs(ctx context.Context, userID int64, date time.Time, days int) ([]store.FoodLog, error)
	UpdateFoodLog(ctx context.Context, f *store.FoodLog) error
	DeleteFoodLog(ctx context.Context, id, userID int64) error
	GetFoodStats(ctx context.Context, userID int64, endDate time.Time, days int) (*store.FoodStats, error)
	GetFoodTargets(ctx context.Context) (store.FoodTargets, error)
	SetFoodTargets(ctx context.Context, targets store.FoodTargets) error
	UpsertFoodProduct(ctx context.Context, p *store.FoodProduct) error
	UpdateFoodProduct(ctx context.Context, p *store.FoodProduct) error
	DeleteFoodProduct(ctx context.Context, id, userID int64) error
	GetFoodProducts(ctx context.Context, userID int64, filter store.FoodProductsFilter) ([]store.FoodProduct, int, error)
	SearchFoodProducts(ctx context.Context, userID int64, queryStr string) ([]store.FoodProduct, error)
	SearchRemoteFoodAPI(ctx context.Context, query string) ([]store.FoodProduct, error)
	CreateMealFromLogs(ctx context.Context, userID int64, name string, logIDs []int64) (*store.FoodProduct, error)
}

// SettingsStore is the subset of store operations needed for feature toggles.
type SettingsStore interface {
	GetFoodIntakeEnabled(ctx context.Context) (bool, error)
	SetFoodIntakeEnabled(ctx context.Context, enabled bool) error
	GetBloodPressureEnabled(ctx context.Context) (bool, error)
	SetBloodPressureEnabled(ctx context.Context, enabled bool) error
	GetWeightEnabled(ctx context.Context) (bool, error)
	SetWeightEnabled(ctx context.Context, enabled bool) error
	GetMedicationEnabled(ctx context.Context) (bool, error)
	SetMedicationEnabled(ctx context.Context, enabled bool) error
	GetWorkoutEnabled(ctx context.Context) (bool, error)
	SetWorkoutEnabled(ctx context.Context, enabled bool) error
	GetHealthEnabled(ctx context.Context) (bool, error)
	SetHealthEnabled(ctx context.Context, enabled bool) error
	GetTabOrder(ctx context.Context) (string, error)
	SetTabOrder(ctx context.Context, order string) error
	GetCurrentTimezone() (string, error)
	RecordTimezone(tz string) error
}

// HealthStore is the subset of store operations needed for health/vitals handlers.
type HealthStore interface {
	GetVitalsHeart(ctx context.Context, userID int64, start, end time.Time) ([]store.VitalsHeartLog, error)
	GetVitalsSpO2(ctx context.Context, userID int64, start, end time.Time) ([]store.VitalsSpO2Log, error)
	GetVitalsStress(ctx context.Context, userID int64, start, end time.Time) ([]store.VitalsStressLog, error)
	GetSleepLogs(ctx context.Context, userID int64, since time.Time) ([]store.SleepLog, error)
	GetDayStats(ctx context.Context, userID int64, since time.Time) ([]store.DayStat, error)
}

// ChangeStore is the subset of store operations needed for change event streaming.
type ChangeStore interface {
	GetLatestChangeCursor(ctx context.Context) (int64, error)
	PruneChangeEvents(ctx context.Context, keepLast, maxAgeDays int) error
	GetChangedTagsSince(ctx context.Context, since int64) (int64, []string, error)
}

// PushStore is the subset of store operations needed for push subscription management.
type PushStore interface {
	CreatePushSubscription(userID int64, endpoint, auth, p256dh string) error
	DeletePushSubscription(endpoint string) error
	GetPushSubscriptions(userID int64) ([]store.PushSubscription, error)
}

// MiBandStore is the subset of store operations needed for Mi Band workout history.
type MiBandStore interface {
	ListMiBandWorkouts(ctx context.Context, userID int64, limit int) ([]store.MiBandWorkout, error)
	GetMiBandWorkout(ctx context.Context, id int64) (*store.MiBandWorkout, error)
	GetMiBandWorkoutGPS(ctx context.Context, workoutID int64) ([]store.MiBandGPSPoint, error)
	DeleteMiBandWorkout(ctx context.Context, id, userID int64) error
	UpdateMiBandWorkout(ctx context.Context, id, userID int64, fields store.UpdateMiBandWorkoutFields) error
	InsertMiBandWorkout(ctx context.Context, w *store.MiBandWorkout) (bool, error)
	CheckDuplicateMiBandWorkout(ctx context.Context, userID int64, startMsMin, startMsMax int64) (bool, error)
}


// TZPlanStore is the subset of store operations needed for timezone plan approval/rejection.
type TZPlanStore interface {
	SetTZTransitionPlanApproved(id int64, approvedAt time.Time) (bool, error)
	RejectTZTransitionPlanAndRevertTimezone(id int64) (bool, error)
	GetLatestActiveOrPendingTZTransitionPlan() (*store.TZTransitionPlan, error)
}

// DiaryNotesStore is the subset of store operations needed for diary note handlers.
type DiaryNotesStore interface {
	CreateDiaryNote(ctx context.Context, userID int64, content string) (*store.DiaryNote, error)
	ListDiaryNotes(ctx context.Context, userID int64, since, until time.Time, limit int, beforeID int64) ([]store.DiaryNote, error)
	DeleteDiaryNote(ctx context.Context, userID, noteID int64) error
}
