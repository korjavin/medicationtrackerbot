package store

import (
	"database/sql"
	"embed"
	"fmt"

	"github.com/korjavin/medicationtrackerbot/internal/store/auth"
	"github.com/korjavin/medicationtrackerbot/internal/store/bp"
	storedb "github.com/korjavin/medicationtrackerbot/internal/store/db"
	"github.com/korjavin/medicationtrackerbot/internal/store/diary"
	"github.com/korjavin/medicationtrackerbot/internal/store/food"
	"github.com/korjavin/medicationtrackerbot/internal/store/medication"
	"github.com/korjavin/medicationtrackerbot/internal/store/push"
	"github.com/korjavin/medicationtrackerbot/internal/store/settings"
	storetz "github.com/korjavin/medicationtrackerbot/internal/store/tz"
	"github.com/korjavin/medicationtrackerbot/internal/store/vitals"
	"github.com/korjavin/medicationtrackerbot/internal/store/weight"
	"github.com/korjavin/medicationtrackerbot/internal/store/workout"
)

//go:embed migrations/*.sql
var embedMigrations embed.FS

// Repos aggregates the per-domain repositories that replaced the legacy
// monolithic *Store. The composition root (cmd/bot, cmd/mcptool, cmd/seeddemo,
// cmd/bpimporter) opens a shared *db.DB and constructs one Repos that owns
// every repo. Callers reach into individual repos via the public fields:
//
//	r := store.New(":memory:")
//	med, err := r.Medication.Get(id)
//	bpState, err := r.BP.GetReminderState(userID)
//
// New code SHOULD NOT add methods to Repos. Each domain's methods live on its
// own *<domain>.Repo; reach them through the corresponding field.
type Repos struct {
	db *storedb.DB

	Medication *medication.Repo
	BP         *bp.Repo
	Weight     *weight.Repo
	Food       *food.Repo
	Workout    *workout.Repo
	Vitals     *vitals.Repo
	Diary      *diary.Repo
	TZ         *storetz.Repo
	Settings   *settings.Repo
	Auth       *auth.Repo
	Push       *push.Repo
}

// Store is a transitional alias for Repos kept so the ~50 production files
// and ~60 test files that still spell their store handle as *store.Store
// continue to compile. New code should use *store.Repos directly.
type Store = Repos

// -- Type aliases so existing store.XYZ references compile unchanged --
//
// Each per-domain package owns its own types. These aliases keep the legacy
// store.X spelling working while callers migrate to the per-domain spelling
// (e.g. medication.Medication). They are zero-cost at runtime.

// Medication-domain types.
type ScheduleConfig = medication.ScheduleConfig
type Medication = medication.Medication
type Restock = medication.Restock
type IntakeLog = medication.IntakeLog
type MedicationSchedule = medication.MedicationSchedule
type IntakeWithMedication = medication.IntakeWithMedication

// BP-domain types.
type BloodPressure = bp.BloodPressure
type BPGoal = bp.BPGoal
type BPStats = bp.BPStats
type BPPeriodStats = bp.BPPeriodStats
type BPReminderState = bp.BPReminderState

// Weight-domain types.
type WeightLog = weight.WeightLog
type WeightReminderState = weight.WeightReminderState
type WeightGoal = weight.WeightGoal

// Vitals-domain types.
type SleepLog = vitals.SleepLog
type DayStat = vitals.DayStat
type VitalsHeartLog = vitals.VitalsHeartLog
type VitalsSpO2Log = vitals.VitalsSpO2Log
type VitalsStressLog = vitals.VitalsStressLog

// Food-domain types.
type FoodLog = food.FoodLog
type FoodProduct = food.FoodProduct
type OpenFoodFact = food.OpenFoodFact
type FoodStats = food.FoodStats
type FoodProductsFilter = food.FoodProductsFilter
type FoodTargets = food.FoodTargets

// Diary-domain types.
type DiaryNote = diary.DiaryNote

// Push-domain types.
type PushSubscription = push.PushSubscription

// Auth-domain types.
type APIToken = auth.APIToken

// TZ-domain types.
type TZTransitionPlan = storetz.TZTransitionPlan
type TZTransitionStep = storetz.TZTransitionStep

// Workout-domain types.
type WorkoutGroup = workout.WorkoutGroup
type WorkoutVariant = workout.WorkoutVariant
type WorkoutExercise = workout.WorkoutExercise
type WorkoutSession = workout.WorkoutSession
type WorkoutExerciseLog = workout.WorkoutExerciseLog
type WorkoutRotationState = workout.WorkoutRotationState
type ExerciseStat = workout.ExerciseStat
type WorkoutScheduleSnapshot = workout.WorkoutScheduleSnapshot
type ExerciseLibraryItem = workout.ExerciseLibraryItem
type MiBandWorkout = workout.MiBandWorkout
type MiBandGPSPoint = workout.MiBandGPSPoint
type UpdateMiBandWorkoutFields = workout.UpdateMiBandWorkoutFields

// CalculateBPCategory forwards to bp.CalculateBPCategory.
// Deprecated: import internal/store/bp directly.
func CalculateBPCategory(systolic, diastolic int) string {
	return bp.CalculateBPCategory(systolic, diastolic)
}

// CategorySeverity forwards to bp.CategorySeverity.
// Deprecated: import internal/store/bp directly.
func CategorySeverity(category string) int {
	return bp.CategorySeverity(category)
}

// CalculateWeightTrend forwards to weight.CalculateWeightTrend.
// Deprecated: import internal/store/weight directly.
func CalculateWeightTrend(currentWeight float64, previousTrend *float64) float64 {
	return weight.CalculateWeightTrend(currentWeight, previousTrend)
}

// New opens a SQLite database at dbPath, runs all migrations, and returns a
// ready-to-use Repos. This is the convenience entry point for tests and the
// existing single-call command wiring.
func New(dbPath string) (*Repos, error) {
	d, err := storedb.Open(dbPath)
	if err != nil {
		return nil, err
	}
	return NewWithDB(d)
}

// NewWithDB wraps a caller-supplied *db.DB in a Repos and runs migrations.
// The composition root uses this so a single *db.DB can be shared across
// per-domain repositories. Migrations are idempotent — calling NewWithDB more
// than once against the same *db.DB is harmless.
func NewWithDB(d *storedb.DB) (*Repos, error) {
	if err := d.Migrate(embedMigrations, "migrations"); err != nil {
		return nil, fmt.Errorf("failed to migrate db: %w", err)
	}
	tzRepo := storetz.New(d)
	r := &Repos{
		db:         d,
		Diary:      diary.New(d),
		Push:       push.New(d),
		Auth:       auth.New(d),
		Vitals:     vitals.New(d),
		Settings:   settings.New(d),
		Weight:     weight.New(d),
		Food:       food.New(d),
		Workout:    workout.New(d),
		TZ:         tzRepo,
		Medication: medication.New(d),
		// bp.Repo needs a TimezoneLookup for day-boundary calculations in
		// GetDailyWeightedStats. The tz repo owns the timezone table.
		BP: bp.New(d, tzRepo),
	}
	return r, nil
}

// Close releases the underlying *db.DB connection pool.
func (r *Repos) Close() error {
	return r.db.Close()
}

// DB exposes the underlying *sql.DB for internal tooling (importers, the demo
// seeder) that needs to issue raw SQL the public API does not cover.
// Application code should use the typed methods on the per-domain repos instead.
func (r *Repos) DB() *sql.DB {
	return r.db.DB
}
