package bot

import (
	"context"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// MedicationStore is the subset of store operations needed for medication bot commands.
type MedicationStore interface {
	GetMedicationEnabled(ctx context.Context) (bool, error)
	List(showArchived bool) ([]store.Medication, error)
	Get(id int64) (*store.Medication, error)
	CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error)
	CreateIntakeReminder(intakeID int64, msgID int) error
	GetIntake(id int64) (*store.IntakeLog, error)
	GetIntakeBySchedule(medID int64, scheduledAt time.Time) (*store.IntakeLog, error)
	ListLowOnStock(daysThreshold int) ([]store.Medication, error)
	GetDaysOfStockRemaining(m *store.Medication) *float64
	GetLastDownload() (time.Time, error)
	ListIntakesSince(since time.Time) ([]store.IntakeWithMedication, error)
	UpdateLastDownload(t time.Time) error
}

// BloodPressureStore is the subset of store operations needed for BP bot commands.
type BloodPressureStore interface {
	GetBloodPressureEnabled(ctx context.Context) (bool, error)
	CreateReading(ctx context.Context, bp *store.BloodPressure) (int64, error)
	ListReadings(ctx context.Context, userID int64, since time.Time) ([]store.BloodPressure, error)
	GetGoal() (*store.BPGoal, error)
	SetGoal(targetSystolic, targetDiastolic int) error
	SnoozeReminder(userID int64) error
	DontBugMeReminder(userID int64) error
}

// WeightStore is the subset of store operations needed for weight bot commands.
type WeightStore interface {
	GetWeightEnabled(ctx context.Context) (bool, error)
	GetLastWeightLog(ctx context.Context, userID int64) (*store.WeightLog, error)
	CreateWeightLog(ctx context.Context, w *store.WeightLog) (int64, error)
	GetWeightLogs(ctx context.Context, userID int64, since time.Time) ([]store.WeightLog, error)
	GetWeightGoal() (*store.WeightGoal, error)
	SetWeightGoal(weight float64, targetDate time.Time) error
	SnoozeWeightReminder(userID int64) error
	DontBugMeWeightReminder(userID int64) error
	GetWeightUnitPreference(ctx context.Context) (string, error)
	SetWeightUnitPreference(ctx context.Context, unit string) error
}

// WorkoutStore is the read-only subset of store operations needed for workout bot commands.
// Compound mutations (start, skip, complete, snooze, create ad-hoc) go through WorkoutService.
type WorkoutStore interface {
	GetWorkoutEnabled(ctx context.Context) (bool, error)
	GetSession(id int64) (*store.WorkoutSession, error)
	GetGroup(groupID int64) (*store.WorkoutGroup, error)
	GetVariant(variantID int64) (*store.WorkoutVariant, error)
	ListGroups(userID int64, activeOnly bool) ([]store.WorkoutGroup, error)
	GetSessionByGroupAndDate(groupID int64, scheduledDate time.Time) (*store.WorkoutSession, error)
	ListHistory(userID int64, limit int) ([]store.WorkoutSession, error)
	ListExercisesByVariant(variantID int64) ([]store.WorkoutExercise, error)
	GetExercise(id int64) (*store.WorkoutExercise, error)
	GetExerciseLibraryItem(id int64) (*store.ExerciseLibraryItem, error)
	ListExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error)
	ListAllUniqueExercises(userID int64) ([]store.WorkoutExercise, error)
}

// FoodStore is the subset of store operations needed for food bot commands.
type FoodStore interface {
	GetFoodIntakeEnabled(ctx context.Context) (bool, error)
	CreateFoodLog(ctx context.Context, f *store.FoodLog) (int64, error)
	DeleteFoodLog(ctx context.Context, id, userID int64) error
}

// ImportStore is the subset of store operations needed for sleep/vitals import.
type ImportStore interface {
	ImportSleepLogs(ctx context.Context, userID int64, logs []store.SleepLog) (int, int, error)
	ImportVitals(ctx context.Context, userID int64, heartLogs []store.VitalsHeartLog, spo2Logs []store.VitalsSpO2Log, stressLogs []store.VitalsStressLog) (int, int, error)
	ImportDayStats(ctx context.Context, userID int64, stats []store.DayStat) (int, int, error)
	ImportMiBand(ctx context.Context, workouts []store.MiBandWorkout, gpsTracks map[int64][]store.MiBandGPSPoint) (int, int, error)
	ListMiBand(ctx context.Context, userID int64, limit int) ([]store.MiBandWorkout, error)
}

// ActivityLogStore is the subset of store operations needed for ad-hoc activity logging.
type ActivityLogStore interface {
	LogExercise(sessionID, exerciseID int64, exerciseName string, setsCompleted, repsCompleted *int, weightKg *float64, status, notes string) (int64, error)
}

// ReminderStore is the subset of store operations needed for reminder operations.
type ReminderStore interface {
	SnoozeReminder(userID int64) error
	DontBugMeReminder(userID int64) error
	SnoozeWeightReminder(userID int64) error
	DontBugMeWeightReminder(userID int64) error
}

// SettingsChangeStore is the subset of settings operations needed by the
// background watcher that re-registers Telegram slash commands when feature
// flags toggle. The watcher polls ListChangedTagsSince so the bot can mirror
// /help into Telegram's setMyCommands menu without a direct callback wired
// from the HTTP transport.
type SettingsChangeStore interface {
	GetLatestChangeCursor(ctx context.Context) (int64, error)
	ListChangedTagsSince(ctx context.Context, since int64) (int64, []string, error)
}
