package bot

import (
	"context"
	"time"

	"github.com/korjavin/medicationtrackerbot/internal/store"
)

// MedicationStore is the subset of store operations needed for medication bot commands.
type MedicationStore interface {
	GetMedicationEnabled(ctx context.Context) (bool, error)
	ListMedications(showArchived bool) ([]store.Medication, error)
	GetMedication(id int64) (*store.Medication, error)
	CreateIntake(medID, userID int64, scheduledAt time.Time) (int64, error)
	ConfirmIntake(id int64, takenAt time.Time) error
	SkipIntake(id int64) error
	GetIntake(id int64) (*store.IntakeLog, error)
	GetIntakeBySchedule(medID int64, scheduledAt time.Time) (*store.IntakeLog, error)
	GetIntakeReminders(intakeID int64) ([]int, error)
	GetPendingIntakes() ([]store.IntakeLog, error)
	GetPendingIntakesBySchedule(userID int64, scheduledAt time.Time) ([]store.IntakeLog, error)
	ConfirmIntakesBySchedule(userID int64, scheduledAt time.Time, takenAt time.Time) error
	DecrementInventory(medID int64, qty int) error
	GetMedicationsLowOnStock(daysThreshold int) ([]store.Medication, error)
	GetDaysOfStockRemaining(m *store.Medication) *float64
	GetLastDownload() (time.Time, error)
	GetIntakesSince(since time.Time) ([]store.IntakeWithMedication, error)
	UpdateLastDownload(t time.Time) error
}

// BloodPressureStore is the subset of store operations needed for BP bot commands.
type BloodPressureStore interface {
	GetBloodPressureEnabled(ctx context.Context) (bool, error)
	CreateBloodPressureReading(ctx context.Context, bp *store.BloodPressure) (int64, error)
	GetBloodPressureReadings(ctx context.Context, userID int64, since time.Time) ([]store.BloodPressure, error)
	GetBPGoal() (*store.BPGoal, error)
	SetBPGoal(targetSystolic, targetDiastolic int) error
}

// WeightStore is the subset of store operations needed for weight bot commands.
type WeightStore interface {
	GetWeightEnabled(ctx context.Context) (bool, error)
	GetLastWeightLog(ctx context.Context, userID int64) (*store.WeightLog, error)
	CreateWeightLog(ctx context.Context, w *store.WeightLog) (int64, error)
	GetWeightLogs(ctx context.Context, userID int64, since time.Time) ([]store.WeightLog, error)
	GetWeightGoal() (*store.WeightGoal, error)
	SetWeightGoal(weight float64, targetDate time.Time) error
}

// WorkoutStore is the read-only subset of store operations needed for workout bot commands.
// Compound mutations (start, skip, complete, snooze, create ad-hoc) go through WorkoutService.
type WorkoutStore interface {
	GetWorkoutEnabled(ctx context.Context) (bool, error)
	GetWorkoutSession(id int64) (*store.WorkoutSession, error)
	GetWorkoutGroup(groupID int64) (*store.WorkoutGroup, error)
	GetWorkoutVariant(variantID int64) (*store.WorkoutVariant, error)
	ListWorkoutGroups(userID int64, activeOnly bool) ([]store.WorkoutGroup, error)
	GetSessionByGroupAndDate(groupID int64, scheduledDate time.Time) (*store.WorkoutSession, error)
	GetWorkoutHistory(userID int64, limit int) ([]store.WorkoutSession, error)
	ListExercisesByVariant(variantID int64) ([]store.WorkoutExercise, error)
	GetWorkoutExercise(id int64) (*store.WorkoutExercise, error)
	GetExerciseLogs(sessionID int64) ([]store.WorkoutExerciseLog, error)
	GetAllUniqueExercises(userID int64) ([]store.WorkoutExercise, error)
}

// FoodStore is the subset of store operations needed for food bot commands.
type FoodStore interface {
	GetFoodIntakeEnabled(ctx context.Context) (bool, error)
	CreateFoodLog(ctx context.Context, f *store.FoodLog) (int64, error)
}

// ImportStore is the subset of store operations needed for sleep/vitals import.
type ImportStore interface {
	ImportSleepLogs(ctx context.Context, userID int64, logs []store.SleepLog) (int, int, error)
	ImportVitals(ctx context.Context, userID int64, heartLogs []store.VitalsHeartLog, spo2Logs []store.VitalsSpO2Log, stressLogs []store.VitalsStressLog) (int, int, error)
	ImportDayStats(ctx context.Context, userID int64, stats []store.DayStat) (int, int, error)
	ImportMiBandWorkouts(ctx context.Context, workouts []store.MiBandWorkout, gpsTracks map[int64][]store.MiBandGPSPoint) (int, int, error)
}
